"""GET /backup/export, POST /backup/import."""

from __future__ import annotations

import pytest


async def test_export_import_round_trip_append(
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

    ex = await client.get("/backup/export")
    assert ex.status_code == 200, ex.text
    payload = ex.json()
    assert payload["format"] == "foodcal-backup"
    assert payload["version"] == 1
    assert "exported_at" in payload
    assert len(payload["entries"]) == 1
    e0 = payload["entries"][0]
    assert e0["date_iso"] == today_iso
    assert "chicken" in e0["raw_text"].lower() or "breast" in e0["raw_text"].lower()
    assert len(e0["items"]) >= 1
    assert any("chicken" in str(i.get("label", "")).lower() for i in e0["items"])

    imp = await client.post(
        "/backup/import",
        json={
            "format": "foodcal-backup",
            "version": 1,
            "entries": payload["entries"],
            "mode": "append",
        },
    )
    assert imp.status_code == 200, imp.text
    assert imp.json()["inserted_entries"] == 1
    assert imp.json()["mode"] == "append"

    ex2 = await client.get("/backup/export")
    assert len(ex2.json()["entries"]) == 2


async def test_import_replace_clears_then_restores(
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
    ex = await client.get("/backup/export")
    payload = ex.json()

    await client.post(
        "/log-meal",
        json={"text": "100g rice", "date": today_iso},
    )
    mid = await client.get("/backup/export")
    assert len(mid.json()["entries"]) == 2

    rep = await client.post(
        "/backup/import",
        json={
            "format": "foodcal-backup",
            "version": 1,
            "entries": payload["entries"],
            "mode": "replace",
        },
    )
    assert rep.status_code == 200, rep.text
    assert rep.json()["inserted_entries"] == 1

    final = await client.get("/backup/export")
    assert len(final.json()["entries"]) == 1


async def test_import_rejects_bad_format(client) -> None:
    r = await client.post(
        "/backup/import",
        json={"format": "wrong", "version": 1, "entries": []},
    )
    assert r.status_code == 422
