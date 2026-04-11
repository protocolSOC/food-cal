"""Async FIFO queue for meal log jobs.

Flow:
  POST /log-meal/jobs  → insert row (queued) → push id onto queue → return job_id
  Worker loop          → pop id → set processing → await log_meal → set done/failed
  GET  /log-meal/jobs/{id} → read status + entry_id

One worker task (sequential FIFO) avoids overlapping log_meal calls against the
shared SQLite connection.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import datetime, timezone
from typing import Any

from app import db

log = logging.getLogger("app.meal_jobs")

# Singleton queue shared between the route handlers and the worker task.
_queue: asyncio.Queue[int] = asyncio.Queue()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _job_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "job_id": row["id"],
        "status": row["status"],
        "date_iso": row["date_iso"],
        "raw_text": row["raw_text"],
        "entry_id": row["entry_id"],
        "error": row["error_detail"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# ---------------------------------------------------------------------------
# DB helpers (all synchronous — called from async routes via thread-safe conn)
# ---------------------------------------------------------------------------

def create_job(date_iso: str, raw_text: str, llm_fallback: bool) -> dict[str, Any]:
    now = _utc_now()
    conn = db.get_connection()
    with db.transaction() as c:
        cur = c.execute(
            """
            INSERT INTO meal_log_jobs
                (date_iso, raw_text, llm_fallback, status, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?)
            """,
            (date_iso, raw_text, int(llm_fallback), now, now),
        )
        job_id = cur.lastrowid

    row = conn.execute("SELECT * FROM meal_log_jobs WHERE id = ?", (job_id,)).fetchone()
    return _job_row_to_dict(row)


def get_job(job_id: int) -> dict[str, Any] | None:
    conn = db.get_connection()
    row = conn.execute("SELECT * FROM meal_log_jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        return None
    return _job_row_to_dict(row)


def list_active_jobs_for_date(date_iso: str) -> list[dict[str, Any]]:
    """Return queued/processing jobs for a date (for UI recovery on page load)."""
    conn = db.get_connection()
    rows = conn.execute(
        "SELECT * FROM meal_log_jobs WHERE date_iso = ? AND status IN ('queued', 'processing') ORDER BY id",
        (date_iso,),
    ).fetchall()
    return [_job_row_to_dict(r) for r in rows]


def _set_job_processing(job_id: int) -> None:
    with db.transaction() as c:
        c.execute(
            "UPDATE meal_log_jobs SET status = 'processing', updated_at = ? WHERE id = ?",
            (_utc_now(), job_id),
        )


def _set_job_done(job_id: int, entry_id: int) -> None:
    with db.transaction() as c:
        c.execute(
            "UPDATE meal_log_jobs SET status = 'done', entry_id = ?, updated_at = ? WHERE id = ?",
            (entry_id, _utc_now(), job_id),
        )


def _set_job_failed(job_id: int, error: str) -> None:
    with db.transaction() as c:
        c.execute(
            "UPDATE meal_log_jobs SET status = 'failed', error_detail = ?, updated_at = ? WHERE id = ?",
            (error[:1000], _utc_now(), job_id),
        )


def _get_job_payload(job_id: int) -> dict[str, Any] | None:
    conn = db.get_connection()
    row = conn.execute("SELECT * FROM meal_log_jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        return None
    return {
        "date_iso": row["date_iso"],
        "raw_text": row["raw_text"],
        "llm_fallback": bool(row["llm_fallback"]),
    }


# ---------------------------------------------------------------------------
# Queue interface
# ---------------------------------------------------------------------------

def enqueue(job_id: int) -> None:
    _queue.put_nowait(job_id)


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

async def _run_worker() -> None:
    """Single-consumer FIFO worker. Runs for the lifetime of the FastAPI process."""
    # Import here to avoid circular imports at module load time.
    from app.meals import log_meal

    log.info("meal_jobs worker started")
    while True:
        job_id = await _queue.get()
        payload = _get_job_payload(job_id)
        if payload is None:
            log.warning("meal_jobs: job %d not found in DB — skipping", job_id)
            _queue.task_done()
            continue

        _set_job_processing(job_id)
        log.debug("meal_jobs: processing job %d (%r)", job_id, payload["raw_text"][:60])
        try:
            result = await log_meal(
                payload["raw_text"],
                payload["date_iso"],
                llm_fallback=payload["llm_fallback"],
            )
            entry_id = int(result["id"])
            _set_job_done(job_id, entry_id)
            log.debug("meal_jobs: job %d done → entry %d", job_id, entry_id)
        except Exception as exc:
            msg = f"{type(exc).__name__}: {exc}"
            _set_job_failed(job_id, msg)
            log.warning("meal_jobs: job %d failed: %s", job_id, msg)
        finally:
            _queue.task_done()


def start_worker() -> asyncio.Task:
    """Create and return the background worker task (call from lifespan)."""
    return asyncio.create_task(_run_worker(), name="meal_jobs_worker")
