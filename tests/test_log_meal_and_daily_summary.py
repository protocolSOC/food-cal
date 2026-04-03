"""API contract: POST /log-meal then GET /get-daily-summary for `today`.

These tests are expected to fail until routes, DB, and parsers exist (TDD red).
"""

from __future__ import annotations

import pytest

from app import llm as llm_mod
from app import db
from tests.conftest import FAKE_SHAWARMA_LLM_RESPONSE


@pytest.mark.parametrize(
    "meal_text",
    [
        "200g chicken breast",
        "200g chicken breast, 50g rice",
    ],
)
async def test_specific_meal_updates_today_summary(
    client,
    today_iso: str,
    meal_text: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Structured grams → local parse + DB; daily summary must match logged primary total."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run for structured gram meals")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": meal_text, "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert "total_calories" in logged
    assert logged["total_calories"] > 0
    assert "items" in logged and len(logged["items"]) >= 1

    sum_r = await client.get("/get-daily-summary", params={"date": today_iso})
    assert sum_r.status_code == 200, sum_r.text
    summary = sum_r.json()
    assert summary.get("total_calories") == logged["total_calories"]
    if "total_protein_g" in logged:
        assert summary.get("total_protein_g") == logged["total_protein_g"]


async def test_vague_meal_with_patched_llm_updates_today_summary(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Restaurant-style text uses LLM JSON; summary uses the same primary calories as the log."""

    async def fake_llm(text: str) -> dict:
        _ = text
        return FAKE_SHAWARMA_LLM_RESPONSE

    monkeypatch.setattr("app.llm.parse_meal_with_llm", fake_llm)

    meal_text = "shawarma in laffa from restaurant"
    log_r = await client.post(
        "/log-meal",
        json={"text": meal_text, "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()

    assert logged.get("estimate_type") == "range"
    assert logged.get("calories_likely") == FAKE_SHAWARMA_LLM_RESPONSE["calories_likely"]
    assert logged.get("calories_low") == FAKE_SHAWARMA_LLM_RESPONSE["calories_low"]
    assert logged.get("calories_high") == FAKE_SHAWARMA_LLM_RESPONSE["calories_high"]
    assert "total_calories" in logged
    assert logged["total_calories"] == logged["calories_likely"]
    assert logged.get("total_protein_g") == FAKE_SHAWARMA_LLM_RESPONSE["total_protein_g"]

    sum_r = await client.get("/get-daily-summary", params={"date": today_iso})
    assert sum_r.status_code == 200, sum_r.text
    summary = sum_r.json()
    assert summary["total_calories"] == logged["total_calories"]
    assert summary.get("total_protein_g") == logged.get("total_protein_g")


async def test_english_bare_apple_resolves_without_llm(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Single English 'apple' → DB/OFF path (~100 kcal typical portion); LLM must not run."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM should not be called for bare English apple")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "apple", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") is None
    assert logged["total_calories"] == pytest.approx(100, abs=10)


async def test_english_bare_banana_resolves_without_llm(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Single English 'banana' → DB/stub path; LLM must not run."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM should not be called for bare English banana")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "banana", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") is None
    # Stub: 120 g × 89 kcal/100g
    assert logged["total_calories"] == pytest.approx(106.8, abs=1.0)


async def test_english_counted_bananas_resolve_without_llm(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`2 bananas` should use deterministic count*serving and avoid meal LLM."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM should not be called for counted bare bananas")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "2 bananas", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") is None
    assert logged["items"][0]["grams"] == pytest.approx(240.0, abs=0.1)
    # 240 g × 89 kcal/100g = 213.6
    assert logged["total_calories"] == pytest.approx(213.6, abs=0.2)


async def test_english_bare_tomato_resolves_without_llm(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Single English 'tomato' uses deterministic medium-unit serving from resolver path."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM should not be called for bare English tomato")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "tomato", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") is None
    # Stub: 123 g × 18 kcal/100g
    assert logged["total_calories"] == pytest.approx(22.1, abs=0.2)


async def test_structured_grams_apple_resolves_without_llm(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`200g apple` → local parse + resolve; LLM must not run."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM should not be called for structured apple grams")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "200g apple", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") is None
    assert logged["total_calories"] == 104.0


async def test_hebrew_bare_apple_resolves_without_llm(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Single Hebrew token in lexicon → OFF/DB path; LLM must not run."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM should not be called for bare lexicon Hebrew")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "תפוח", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") is None
    assert "total_protein_g" in logged
    # Bare apple: `fruit` category default 185 g × stub 52 kcal/100g
    assert logged["total_calories"] == 96.2
    assert logged["total_protein_g"] == 0.56


async def test_stale_cached_apple_row_is_repaired_without_llm(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If API lookup fails, stale cache outlier is repaired from baseline (macros + serving)."""

    async def no_lookup(_query: str):
        return None

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM should not be called for repaired stale apple row")

    monkeypatch.setattr("app.off_foods.lookup_food", no_lookup)
    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    with db.transaction() as c:
        c.execute(
            """
            INSERT INTO foods (name, kcal_per_100g, protein_per_100g, default_serving_grams, food_category)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("apple", 25.0, 0.6, 50.0, "fruit"),
        )

    log_r = await client.post(
        "/log-meal",
        json={"text": "apple", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") is None
    assert logged["total_calories"] == pytest.approx(96.2, abs=0.2)
    assert logged["items"][0]["grams"] == pytest.approx(185.0, abs=0.2)


async def test_sanity_guardrail_disabled_does_not_call_nano(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def suspicious_lookup(_query: str):
        return llm_mod.FoodLookupResult(52.0, 0.3, 20.0, "fruit")

    async def boom_nano(*_args, **_kwargs):
        raise AssertionError("Nano sanity check should not be called when disabled")

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("Meal LLM should not be called for bare apple")

    monkeypatch.setenv("LLM_SANITY_CHECK_ENABLED", "0")
    monkeypatch.setattr("app.off_foods.lookup_food", suspicious_lookup)
    monkeypatch.setattr("app.llm.validate_food_result_with_llm", boom_nano)
    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post("/log-meal", json={"text": "apple", "date": today_iso})
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged["total_calories"] == pytest.approx(10.4, abs=0.2)
    assert logged["items"][0]["grams"] == pytest.approx(20.0, abs=0.2)


async def test_sanity_guardrail_enabled_high_confidence_applies_correction(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def suspicious_lookup(_query: str):
        return llm_mod.FoodLookupResult(52.0, 0.3, 20.0, "fruit")

    async def good_nano(*_args, **_kwargs):
        return llm_mod.FoodSanityVerdict(
            is_plausible=False,
            confidence=0.95,
            corrected_kcal_per_100g=52.0,
            corrected_serving_grams=185.0,
            reason="Serving is implausibly small for a whole apple",
        )

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("Meal LLM should not be called for bare apple")

    monkeypatch.setenv("LLM_SANITY_CHECK_ENABLED", "1")
    monkeypatch.setenv("LLM_SANITY_MIN_CONFIDENCE", "0.8")
    monkeypatch.setattr("app.off_foods.lookup_food", suspicious_lookup)
    monkeypatch.setattr("app.llm.validate_food_result_with_llm", good_nano)
    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post("/log-meal", json={"text": "apple", "date": today_iso})
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged["total_calories"] == pytest.approx(96.2, abs=0.2)
    assert logged["items"][0]["grams"] == pytest.approx(185.0, abs=0.2)


async def test_sanity_guardrail_enabled_low_confidence_is_ignored(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def suspicious_lookup(_query: str):
        return llm_mod.FoodLookupResult(52.0, 0.3, 20.0, "fruit")

    async def low_conf_nano(*_args, **_kwargs):
        return llm_mod.FoodSanityVerdict(
            is_plausible=False,
            confidence=0.4,
            corrected_kcal_per_100g=52.0,
            corrected_serving_grams=185.0,
            reason="Low confidence correction",
        )

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("Meal LLM should not be called for bare apple")

    monkeypatch.setenv("LLM_SANITY_CHECK_ENABLED", "1")
    monkeypatch.setenv("LLM_SANITY_MIN_CONFIDENCE", "0.8")
    monkeypatch.setattr("app.off_foods.lookup_food", suspicious_lookup)
    monkeypatch.setattr("app.llm.validate_food_result_with_llm", low_conf_nano)
    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post("/log-meal", json={"text": "apple", "date": today_iso})
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged["total_calories"] == pytest.approx(10.4, abs=0.2)
    assert logged["items"][0]["grams"] == pytest.approx(20.0, abs=0.2)


async def test_sanity_guardrail_enabled_error_is_ignored(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def suspicious_lookup(_query: str):
        return llm_mod.FoodLookupResult(52.0, 0.3, 20.0, "fruit")

    async def bad_nano(*_args, **_kwargs):
        raise RuntimeError("OpenRouter sanity unavailable")

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("Meal LLM should not be called for bare apple")

    monkeypatch.setenv("LLM_SANITY_CHECK_ENABLED", "1")
    monkeypatch.setattr("app.off_foods.lookup_food", suspicious_lookup)
    monkeypatch.setattr("app.llm.validate_food_result_with_llm", bad_nano)
    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    log_r = await client.post("/log-meal", json={"text": "apple", "date": today_iso})
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged["total_calories"] == pytest.approx(10.4, abs=0.2)
    assert logged["items"][0]["grams"] == pytest.approx(20.0, abs=0.2)


async def test_chicken_with_oil_uses_llm_not_plain_db_row(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prep/fat wording must force LLM estimate, not plain `chicken breast` DB math (165 kcal / 100 g)."""

    async def fake_llm(text: str) -> dict:
        assert "chicken" in text.lower()
        return {
            "items": [{"food": "chicken breast with oil", "grams": 200}],
            "estimate_type": "range",
            "calories_likely": 450,
            "calories_low": 380,
            "calories_high": 520,
            "total_protein_g": 52.0,
        }

    monkeypatch.setattr("app.llm.parse_meal_with_llm", fake_llm)

    log_r = await client.post(
        "/log-meal",
        json={"text": "200g chicken breast on a pan with a bit of oil", "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    assert logged.get("estimate_type") == "range"
    assert logged["total_calories"] == 450
    assert logged["total_calories"] != 330.0


async def test_two_meals_same_day_calories_sum(
    client,
    today_iso: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Second log on the same day adds to the running daily total."""

    async def boom_llm(_text: str) -> dict:
        raise AssertionError("LLM must not run for structured chicken + rice")

    monkeypatch.setattr("app.llm.parse_meal_with_llm", boom_llm)

    first_r = await client.post(
        "/log-meal",
        json={"text": "200g chicken breast", "date": today_iso},
    )
    assert first_r.status_code == 200, first_r.text
    first = first_r.json()

    second_r = await client.post(
        "/log-meal",
        json={"text": "50g rice", "date": today_iso},
    )
    assert second_r.status_code == 200, second_r.text
    second = second_r.json()

    expected_total = first["total_calories"] + second["total_calories"]

    sum_r = await client.get("/get-daily-summary", params={"date": today_iso})
    assert sum_r.status_code == 200, sum_r.text
    summary = sum_r.json()
    assert summary["total_calories"] == expected_total
