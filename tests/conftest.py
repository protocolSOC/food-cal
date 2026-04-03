"""Shared fixtures and fake LLM payload for vague-meal tests."""

import os

from dotenv import load_dotenv

load_dotenv()
# Tests always use an isolated in-memory DB (ignore SQLITE_PATH from .env).
os.environ["SQLITE_PATH"] = ":memory:"

from collections.abc import AsyncIterator
from datetime import date

import httpx
import pytest

from app.db import reset_for_testing
from app.main import app
from app.food_types import FoodLookupResult


@pytest.fixture(autouse=True)
def _isolate_sqlite() -> None:
    reset_for_testing()
    yield


@pytest.fixture(autouse=True)
def _default_disable_sanity_guardrail(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_SANITY_CHECK_ENABLED", "0")
    monkeypatch.delenv("LLM_SANITY_MIN_CONFIDENCE", raising=False)


@pytest.fixture(autouse=True)
def _stub_open_food_facts(
    request: pytest.FixtureRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tests stay offline; deterministic lookup (macros + category for bare servings).

    Tests marked ``live_usda`` use real ``lookup_food`` (USDA + OFF + fallback).
    """
    if request.node.get_closest_marker("live_usda"):
        return

    async def fake_lookup(query: str) -> FoodLookupResult | None:
        q = query.lower().strip()
        canned = {
            "chicken breast": FoodLookupResult(165.0, 31.0, 150.0, "protein"),
            "rice": FoodLookupResult(130.0, 2.7, 150.0, "grain"),
            "salmon": FoodLookupResult(206.0, 22.0, 150.0, "protein"),
            "apple": FoodLookupResult(52.0, 0.3, 185.0, "fruit"),
            "banana": FoodLookupResult(89.0, 1.1, 120.0, "fruit"),
            "tomato": FoodLookupResult(18.0, 0.9, 123.0, "vegetable"),
        }
        return canned.get(q)

    async def fake_search(query: str) -> tuple[float, float] | None:
        meta = await fake_lookup(query)
        if meta is None:
            return None
        return (meta.kcal_per_100g, meta.protein_per_100g)

    monkeypatch.setattr("app.off_foods.lookup_food", fake_lookup)
    monkeypatch.setattr("app.off_foods.search_nutrition_per_100g", fake_search)

# Fixed JSON shape for "shawarma in laffa" — patch `app.llm.parse_meal_with_llm` to return this.
FAKE_SHAWARMA_LLM_RESPONSE: dict = {
    "items": [
        {"food": "chicken shawarma", "grams": 180},
        {"food": "laffa bread", "grams": 100},
        {"food": "tahini", "grams": 30},
    ],
    "estimate_type": "range",
    "calories_likely": 800,
    "calories_low": 650,
    "calories_high": 950,
    "total_protein_g": 42.0,
}


@pytest.fixture
def today_iso() -> str:
    return date.today().isoformat()


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
