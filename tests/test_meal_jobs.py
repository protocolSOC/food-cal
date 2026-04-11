"""Tests for the async meal log job queue: POST/GET /log-meal/jobs."""

from __future__ import annotations

import pytest

import app.meal_jobs as meal_jobs
from app.meals import log_meal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _drain_queue() -> None:
    """Remove any leftover items from the module-level queue (test isolation)."""
    while not meal_jobs._queue.empty():
        try:
            meal_jobs._queue.get_nowait()
            meal_jobs._queue.task_done()
        except Exception:
            break


async def _process_one_job(job_id: int) -> None:
    """Simulate the worker processing a single job (no running worker task needed)."""
    payload = meal_jobs._get_job_payload(job_id)
    assert payload is not None, f"Job {job_id} not found in DB"
    meal_jobs._set_job_processing(job_id)
    try:
        result = await log_meal(
            payload["raw_text"],
            payload["date_iso"],
            llm_fallback=payload["llm_fallback"],
        )
        meal_jobs._set_job_done(job_id, int(result["id"]))
    except Exception as exc:
        meal_jobs._set_job_failed(job_id, f"{type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_enqueue_returns_job_queued(client, today_iso: str) -> None:
    """POST /log-meal/jobs returns job_id and status=queued immediately."""
    _drain_queue()
    r = await client.post(
        "/log-meal/jobs",
        json={"text": "200g chicken breast", "date": today_iso},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "queued"
    assert isinstance(body["job_id"], int)
    assert body["entry_id"] is None


async def test_get_job_status_queued(client, today_iso: str) -> None:
    """GET /log-meal/jobs/{id} returns the job row."""
    _drain_queue()
    create_r = await client.post(
        "/log-meal/jobs",
        json={"text": "100g rice", "date": today_iso},
    )
    assert create_r.status_code == 200
    job_id = create_r.json()["job_id"]

    status_r = await client.get(f"/log-meal/jobs/{job_id}")
    assert status_r.status_code == 200, status_r.text
    body = status_r.json()
    assert body["job_id"] == job_id
    assert body["status"] == "queued"
    assert body["entry_id"] is None
    assert body["error"] is None


async def test_get_job_not_found(client) -> None:
    """GET /log-meal/jobs/{id} returns 404 for unknown id."""
    r = await client.get("/log-meal/jobs/99999")
    assert r.status_code == 404


async def test_enqueue_rejects_empty_text(client, today_iso: str) -> None:
    """POST /log-meal/jobs rejects blank text with 400."""
    r = await client.post(
        "/log-meal/jobs",
        json={"text": "   ", "date": today_iso},
    )
    assert r.status_code == 400


async def test_enqueue_rejects_bad_date(client) -> None:
    """POST /log-meal/jobs rejects invalid date with 400."""
    r = await client.post(
        "/log-meal/jobs",
        json={"text": "apple", "date": "not-a-date"},
    )
    assert r.status_code == 400


async def test_job_done_after_processing(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After the worker processes a job, status becomes done and entry_id is set."""
    _drain_queue()

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run for structured gram meals")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    create_r = await client.post(
        "/log-meal/jobs",
        json={"text": "200g chicken breast", "date": today_iso},
    )
    assert create_r.status_code == 200
    job_id = create_r.json()["job_id"]

    # Pop the job from the queue and process it directly.
    popped = meal_jobs._queue.get_nowait()
    assert popped == job_id
    meal_jobs._queue.task_done()

    await _process_one_job(job_id)

    status_r = await client.get(f"/log-meal/jobs/{job_id}")
    assert status_r.status_code == 200
    body = status_r.json()
    assert body["status"] == "done"
    assert isinstance(body["entry_id"], int)


async def test_job_done_entry_appears_in_entries(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After job is done, the resulting entry appears in GET /entries."""
    _drain_queue()

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    create_r = await client.post(
        "/log-meal/jobs",
        json={"text": "100g rice", "date": today_iso},
    )
    job_id = create_r.json()["job_id"]
    meal_jobs._queue.get_nowait()
    meal_jobs._queue.task_done()

    await _process_one_job(job_id)

    status_r = await client.get(f"/log-meal/jobs/{job_id}")
    entry_id = status_r.json()["entry_id"]

    entries_r = await client.get(f"/entries?date={today_iso}")
    assert entries_r.status_code == 200
    ids = [e["id"] for e in entries_r.json()["entries"]]
    assert entry_id in ids


async def test_list_active_jobs_for_date(client, today_iso: str) -> None:
    """GET /log-meal/jobs?date=... returns queued/processing jobs for that date."""
    _drain_queue()

    for text in ("apple", "banana"):
        r = await client.post(
            "/log-meal/jobs",
            json={"text": text, "date": today_iso},
        )
        assert r.status_code == 200

    list_r = await client.get(f"/log-meal/jobs?date={today_iso}")
    assert list_r.status_code == 200
    jobs = list_r.json()["jobs"]
    assert len(jobs) == 2
    assert all(j["status"] == "queued" for j in jobs)


async def test_multiple_jobs_independent(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two jobs are enqueued and processed; both end up done with their own entry_id."""
    _drain_queue()

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    job_ids = []
    for text in ("200g chicken breast", "100g rice"):
        r = await client.post(
            "/log-meal/jobs",
            json={"text": text, "date": today_iso},
        )
        assert r.status_code == 200
        job_ids.append(r.json()["job_id"])

    # Process both in FIFO order.
    for jid in job_ids:
        meal_jobs._queue.get_nowait()
        meal_jobs._queue.task_done()
        await _process_one_job(jid)

    entry_ids = set()
    for jid in job_ids:
        status_r = await client.get(f"/log-meal/jobs/{jid}")
        body = status_r.json()
        assert body["status"] == "done", body
        assert body["entry_id"] not in entry_ids
        entry_ids.add(body["entry_id"])

    assert len(entry_ids) == 2
