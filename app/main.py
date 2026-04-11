import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import logging
import sqlite3

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError, ResponseValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.requests import Request

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_PROJECT_ROOT / ".env")

from pydantic import BaseModel, field_validator

from app import db
from app.backup import BackupImportBody, export_backup, import_backup
from app.debug_agent_log import agent_log
from app.usda_fdc import search_food_names_usda, usda_fdc_suggest_enabled
from app.meals import (
    daily_summary,
    delete_entry,
    entries_rollups,
    list_entries_for_date,
    log_manual_meal,
    log_meal,
    validate_date_iso,
)
import app.meal_jobs as meal_jobs


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.get_connection()
    worker_task = meal_jobs.start_worker()
    yield
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Hybrid Calorie App", lifespan=lifespan)


@app.middleware("http")
async def expose_unhandled_errors(request: Request, call_next):
    """Return JSON {detail: ...} for bugs instead of a blank 500 (helps UI + debug)."""
    try:
        return await call_next(request)
    except HTTPException:
        raise
    except (RequestValidationError, ResponseValidationError):
        raise
    except Exception as e:
        logging.getLogger("app.main").exception("Unhandled request error")
        return JSONResponse(
            status_code=500,
            content={"detail": f"{type(e).__name__}: {str(e)}"},
        )


@app.get("/")
async def root() -> dict[str, str]:
    """API-only server: there is no HTML app on this port. Use the Vite dev server for the UI."""
    return {
        "service": "Hybrid Calorie App API",
        "docs": "/docs",
        "log_meal": "POST /log-meal",
        "log_meal_async": "POST /log-meal/jobs",
        "log_meal_manual": "POST /log-meal-manual",
        "daily_summary": "GET /get-daily-summary?date=YYYY-MM-DD",
        "entries": "GET /entries?date=YYYY-MM-DD",
        "delete_entry": "DELETE /entries/{entry_id}",
        "entries_rollups": "GET /entries-rollups?start=YYYY-MM-DD&end=YYYY-MM-DD",
        "food_suggest": "GET /food-suggest?q=...&limit=12",
        "backup_export": "GET /backup/export",
        "backup_import": "POST /backup/import",
    }


class FoodSuggestResponse(BaseModel):
    suggestions: list[str]
    usda_enabled: bool


@app.get("/food-suggest")
async def get_food_suggest(q: str = "", limit: int = 12) -> FoodSuggestResponse:
    """USDA FDC search hit descriptions for meal input autocomplete (search-only)."""
    q = q.strip()
    if len(q) > 120:
        raise HTTPException(status_code=400, detail="q must be at most 120 characters")
    if limit < 1 or limit > 25:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 25")
    enabled = usda_fdc_suggest_enabled()
    if not q:
        return FoodSuggestResponse(suggestions=[], usda_enabled=enabled)
    suggestions = await search_food_names_usda(q, page_size=limit)
    return FoodSuggestResponse(suggestions=suggestions, usda_enabled=enabled)


app.add_middleware(
    CORSMiddleware,
    # IPv6 loopback ([::1]) is common when the dev server is opened as localhost.
    allow_origin_regex=r"http://(\[::1\]|127\.0\.0\.1|localhost)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LogMealBody(BaseModel):
    text: str
    date: str
    llm_fallback: bool = True

    @field_validator("text")
    @classmethod
    def strip_text(cls, v: str) -> str:
        return v.strip()


class LogMealManualBody(BaseModel):
    date: str
    name: str
    grams: float
    calories: float
    protein: float

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        return v.strip()


@app.post("/log-meal-manual")
async def post_log_meal_manual(body: LogMealManualBody) -> dict:
    try:
        return log_manual_meal(
            body.date,
            body.name,
            body.grams,
            body.calories,
            body.protein,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except sqlite3.IntegrityError as e:
        raise HTTPException(status_code=502, detail=f"Database constraint: {e}") from e
    except TypeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except HTTPException:
        raise


@app.post("/log-meal")
async def post_log_meal(body: LogMealBody) -> dict:
    # region agent log
    agent_log(
        "main.py:post_log_meal",
        "entry",
        {"text_len": len(body.text), "date": body.date},
        "H1",
    )
    # endregion
    if not body.text:
        raise HTTPException(status_code=400, detail="text is required")
    try:
        return await log_meal(body.text, body.date, llm_fallback=body.llm_fallback)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except sqlite3.IntegrityError as e:
        raise HTTPException(status_code=502, detail=f"Database constraint: {e}") from e
    except TypeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        # region agent log
        agent_log(
            "main.py:post_log_meal",
            "unhandled_exception",
            {"exc_type": type(e).__name__, "exc_msg": str(e)[:500]},
            "H1",
        )
        # endregion
        raise


class EnqueueJobBody(BaseModel):
    text: str
    date: str
    llm_fallback: bool = True

    @field_validator("text")
    @classmethod
    def strip_text(cls, v: str) -> str:
        return v.strip()


@app.post("/log-meal/jobs")
async def enqueue_log_meal_job(body: EnqueueJobBody) -> dict:
    """Enqueue a meal for async processing. Returns immediately with a job_id."""
    if not body.text:
        raise HTTPException(status_code=400, detail="text is required")
    try:
        validate_date_iso(body.date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    job = meal_jobs.create_job(body.date, body.text, body.llm_fallback)
    meal_jobs.enqueue(job["job_id"])
    return job


@app.get("/log-meal/jobs")
async def list_active_meal_jobs(date: str) -> dict[str, list]:
    """Return queued/processing jobs for a date (for UI recovery on reload)."""
    try:
        validate_date_iso(date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"jobs": meal_jobs.list_active_jobs_for_date(date)}


@app.get("/log-meal/jobs/{job_id}")
async def get_meal_job_status(job_id: int) -> dict:
    """Poll job status. Returns status, entry_id (when done), or error (when failed)."""
    job = meal_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.get("/get-daily-summary")
async def get_daily_summary(date: str) -> dict:
    return daily_summary(date)


@app.get("/entries")
async def get_entries(date: str) -> dict[str, list]:
    try:
        validate_date_iso(date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"entries": list_entries_for_date(date)}


@app.delete("/entries/{entry_id}")
async def remove_entry(entry_id: int) -> dict[str, str]:
    if entry_id < 1:
        raise HTTPException(status_code=400, detail="invalid entry id")
    if not delete_entry(entry_id):
        raise HTTPException(status_code=404, detail="entry not found")
    return {"status": "ok"}


@app.get("/backup/export")
async def get_backup_export() -> dict:
    return export_backup()


@app.post("/backup/import")
async def post_backup_import(body: BackupImportBody) -> dict:
    try:
        return import_backup(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/entries-rollups")
async def get_entries_rollups(start: str, end: str) -> dict[str, list]:
    try:
        validate_date_iso(start)
        validate_date_iso(end)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        return {"days": entries_rollups(start, end)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
