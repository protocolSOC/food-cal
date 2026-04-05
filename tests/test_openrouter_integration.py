"""Live OpenRouter (meal LLM / OPENROUTER_MODEL, e.g. gpt-5.4-mini).

These are **not** USDA tests. They intentionally call `parse_meal_with_llm` over HTTP.

Requires both `OPENROUTER_API_KEY` and explicit opt-in so a normal `pytest` run with `.env`
loaded does not burn two+ mini calls (e.g. smoke + Hebrew band tests).
"""

from __future__ import annotations

import os

import pytest

from app.llm import parse_meal_with_llm


pytestmark = [pytest.mark.integration, pytest.mark.live_openrouter]

_KEY = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
_OPT_IN = os.environ.get("RUN_LIVE_OPENROUTER", "").lower() in ("1", "true", "yes")
_SKIP = not _KEY or not _OPT_IN
_SKIP_REASON = (
    "Set OPENROUTER_API_KEY and RUN_LIVE_OPENROUTER=1 to run live meal-LLM (mini) integration tests"
)

# Veal shawarma in laffa with fries — expected plausible band from product / nutrition discussion.
VEAL_SHAWARMA_LAFFA_FRIES_HE = "שוווארמה עגל בלאפה עם ציפס בפנים"
EXPECTED_CAL_MIN = 900
EXPECTED_CAL_MAX = 1300
EXPECTED_PROTEIN_MIN = 40
# LLM variance: target copy is ~40–60 g; allow a few grams over when portions are large.
EXPECTED_PROTEIN_MAX = 65


@pytest.mark.skipif(_SKIP, reason=_SKIP_REASON)
async def test_parse_meal_with_llm_live_smoke() -> None:
    data = await parse_meal_with_llm("small banana")
    assert isinstance(data.get("items"), list)
    assert len(data["items"]) >= 1
    assert "calories_likely" in data


@pytest.mark.skipif(_SKIP, reason=_SKIP_REASON)
async def test_hebrew_veal_shawarma_live_llm_calories_and_protein_in_band() -> None:
    """Real model output: meal totals should sit near 900–1300 kcal and ~40–60 g protein."""
    data = await parse_meal_with_llm(VEAL_SHAWARMA_LAFFA_FRIES_HE)
    likely = float(data["calories_likely"])
    assert EXPECTED_CAL_MIN <= likely <= EXPECTED_CAL_MAX, (
        f"calories_likely={likely} outside [{EXPECTED_CAL_MIN}, {EXPECTED_CAL_MAX}]; full={data!r}"
    )
    prot_raw = data.get("total_protein_g")
    assert prot_raw is not None, f"missing total_protein_g: {data!r}"
    prot = float(prot_raw)
    assert EXPECTED_PROTEIN_MIN <= prot <= EXPECTED_PROTEIN_MAX, (
        f"total_protein_g={prot} outside [{EXPECTED_PROTEIN_MIN}, {EXPECTED_PROTEIN_MAX}]; full={data!r}"
    )


@pytest.mark.skipif(_SKIP, reason=_SKIP_REASON)
async def test_hebrew_veal_shawarma_live_post_log_meal_end_to_end(
    client,
    today_iso: str,
) -> None:
    """POST /log-meal with vague Hebrew — same bands via API + DB path (no mocks)."""
    log_r = await client.post(
        "/log-meal",
        json={"text": VEAL_SHAWARMA_LAFFA_FRIES_HE, "date": today_iso},
    )
    assert log_r.status_code == 200, log_r.text
    logged = log_r.json()
    likely = float(logged["calories_likely"])
    assert EXPECTED_CAL_MIN <= likely <= EXPECTED_CAL_MAX, (
        f"calories_likely={likely} outside band; logged={logged!r}"
    )
    prot = float(logged["total_protein_g"])
    assert EXPECTED_PROTEIN_MIN <= prot <= EXPECTED_PROTEIN_MAX, (
        f"total_protein_g={prot} outside band; logged={logged!r}"
    )
