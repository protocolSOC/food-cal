"""GET /entries, DELETE /entries/{id}, GET /entries-rollups."""

from __future__ import annotations

import pytest


async def test_get_entries_lists_logged_meal(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "200g chicken breast", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text

    r = await client.get("/entries", params={"date": today_iso})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "entries" in body
    assert len(body["entries"]) == 1
    e = body["entries"][0]
    assert e["id"] >= 1
    assert "chicken" in e["name"].lower() or "breast" in e["name"].lower()
    assert e["calories"] > 0
    assert "timestamp" in e


async def test_delete_entry_removes_row(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    await client.post(
        "/log-meal",
        json={"text": "200g chicken breast", "date": today_iso},
    )
    list_r = await client.get("/entries", params={"date": today_iso})
    eid = list_r.json()["entries"][0]["id"]

    del_r = await client.delete(f"/entries/{eid}")
    assert del_r.status_code == 200, del_r.text

    again = await client.get("/entries", params={"date": today_iso})
    assert again.json()["entries"] == []

    missing = await client.delete(f"/entries/{eid}")
    assert missing.status_code == 404


async def test_entries_invalid_date(client) -> None:
    r = await client.get("/entries", params={"date": "2024-13-40"})
    assert r.status_code == 400


async def test_entries_rollups_groups_by_day(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    await client.post(
        "/log-meal",
        json={"text": "200g chicken breast", "date": "2026-04-01"},
    )
    await client.post(
        "/log-meal",
        json={"text": "200g chicken breast", "date": "2026-04-02"},
    )

    r = await client.get(
        "/entries-rollups",
        params={"start": "2026-04-01", "end": "2026-04-02"},
    )
    assert r.status_code == 200, r.text
    days = r.json()["days"]
    assert len(days) == 2
    assert {d["date"] for d in days} == {"2026-04-01", "2026-04-02"}
    for d in days:
        assert d["meals"] == 1
        assert d["total_calories"] > 0
