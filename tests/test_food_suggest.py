"""GET /food-suggest — USDA search name hints."""

from __future__ import annotations

import pytest


async def test_food_suggest_returns_suggestions(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_search(q: str, *, page_size: int = 12) -> list[str]:
        assert q == "apple"
        assert page_size == 12
        return ["Apples, raw, with skin", "Apples, raw, red delicious"]

    monkeypatch.setattr("app.main.search_food_names_usda", fake_search)

    r = await client.get("/food-suggest", params={"q": "apple"})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "suggestions": ["Apples, raw, with skin", "Apples, raw, red delicious"],
    }


async def test_food_suggest_empty_query(client) -> None:
    r = await client.get("/food-suggest", params={"q": ""})
    assert r.status_code == 200, r.text
    assert r.json() == {"suggestions": []}


async def test_food_suggest_q_too_long(client) -> None:
    r = await client.get("/food-suggest", params={"q": "x" * 121})
    assert r.status_code == 400


async def test_food_suggest_limit_bounds(client) -> None:
    r = await client.get("/food-suggest", params={"q": "a", "limit": 0})
    assert r.status_code == 400
    r2 = await client.get("/food-suggest", params={"q": "a", "limit": 26})
    assert r2.status_code == 400
