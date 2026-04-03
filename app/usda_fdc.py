"""USDA FoodData Central — nutrients per 100 g + portion grams from `foodPortions`.

FDC does **not** expose a single canonical “unit” per food: each food document lists **multiple**
`foodPortions` (different household measures and gram weights). Nutrients are typically per 100 g.
We pick **one** portion row by scoring **only fields returned by FDC** (descriptions, gramWeight,
amount). That is not a second calorie source — kcal/protein still come from `foodNutrients`.

Requires USDA_FDC_API_KEY (https://fdc.nal.usda.gov/api-key-signup).
"""

from __future__ import annotations

import os
import re
from typing import Any

import httpx

from app.food_types import FoodLookupResult

FDC_BASE = "https://api.nal.usda.gov/fdc/v1"
FDC_PROTEIN_ID = 1003
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _f(x: Any) -> float | None:
    if x is None:
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _nutrients_per_100g(food: dict[str, Any]) -> tuple[float, float] | None:
    kcal: float | None = None
    kcal_atwater: float | None = None
    prot: float | None = None
    for item in food.get("foodNutrients") or []:
        if not isinstance(item, dict):
            continue
        nut = item.get("nutrient") or {}
        nid = nut.get("id") or item.get("nutrientId")
        amt = _f(item.get("amount"))
        if amt is None:
            continue
        if nid == FDC_PROTEIN_ID:
            prot = amt
        elif nid == 1008:
            kcal = amt
        elif nid in (2047, 2048):
            kcal_atwater = amt
    if kcal is None:
        kcal = kcal_atwater
    if kcal is None or kcal <= 0:
        return None
    if prot is None:
        prot = 0.0
    elif prot < 0:
        return None
    return (round(kcal, 3), round(prot, 3))


def _portion_grams(food: dict[str, Any]) -> float | None:
    """Pick one row from FDC `foodPortions` (the API returns many; we must choose one)."""
    portions = food.get("foodPortions") or []
    if not isinstance(portions, list):
        return None

    scored: list[tuple[int, float]] = []  # lower score is better, grams per one logical unit

    for p in portions:
        if not isinstance(p, dict):
            continue
        g_total = _f(p.get("gramWeight"))
        if g_total is None or not (10.0 <= g_total <= 800.0):
            continue
        amt = _f(p.get("amount"))
        if amt is None or amt <= 0:
            amt = 1.0
        per_unit = g_total / amt
        if per_unit < 5.0:
            continue

        mu = p.get("measureUnit")
        mu_name = ""
        if isinstance(mu, dict):
            mu_name = str(mu.get("name") or mu.get("abbreviation") or "").lower()
        desc = str(p.get("portionDescription") or "").lower()
        blob = f"{desc} {mu_name}".strip()

        score = 80
        if abs(amt - 1.0) < 1e-6:
            score -= 35

        # Common nutrition-table column: 100 g with amount matching grams → per_unit ≈ 1 g (skipped) or amount 1 & 100 g total
        if abs(g_total - 100.0) < 0.5 and abs(amt - 1.0) < 1e-6:
            score += 45
        if abs(g_total - 100.0) < 0.5 and amt >= 50.0:
            score += 40
        if "100 g" in blob or "100g" in blob.replace(" ", "") or "100 gram" in blob:
            score += 35
        # Bare mass measure with large amount → weighed column, not one item
        if amt >= 50 and any(x == mu_name.strip() for x in ("g", "gram", "grams")):
            score += 25

        # Discrete-portion language from FDC (sizes, counts, household measures)
        if any(
            w in blob
            for w in (
                "medium",
                "large",
                "small",
                "whole",
                "piece",
                "fruit",
                "slice",
                "cup",
                "tbsp",
                "tablespoon",
                "tsp",
                "teaspoon",
                "nlea",
                "serving",
            )
        ):
            score -= 12

        scored.append((score, per_unit))

    if not scored:
        return None
    scored.sort(key=lambda t: (t[0], t[1]))
    return float(scored[0][1])


def _fdc_data_type_rank(data_type: str | None) -> int:
    """Prefer Foundation / survey reference foods over branded when disambiguating."""
    if not data_type:
        return 5
    d = data_type.lower()
    if "foundation" in d:
        return 0
    if "survey" in d or "sr legacy" in d or "sr_legacy" in d:
        return 1
    return 3


def _serving_preference_rank(g: float | None) -> tuple[int, float]:
    """Prefer candidates with a serving size; among those, prefer larger grams (more informative unit)."""
    if g is None:
        return (1, 0.0)
    return (0, -float(g))


def _normalize_text(s: str) -> str:
    return " ".join(str(s).strip().lower().split())


def _tokenize(s: str) -> set[str]:
    return set(_TOKEN_RE.findall(_normalize_text(s)))


def _name_rank(query_norm: str, query_tokens: set[str], candidate_desc: str) -> tuple[int, int, int]:
    desc = _normalize_text(candidate_desc)
    if not desc:
        return (3, 1000, 1000)
    desc_tokens = _tokenize(desc)
    if desc == query_norm:
        return (0, 0, len(desc_tokens))
    if desc.startswith(query_norm + " "):
        return (1, 0, len(desc_tokens))
    missing = len(query_tokens - desc_tokens)
    extra = len(desc_tokens - query_tokens)
    return (2, missing, extra)


def _pick_best_usda_candidate(
    query: str,
    pool: list[tuple[FoodLookupResult, str | None, str, int]],
) -> FoodLookupResult:
    """Rank API candidates by portion plausibility and FDC data type, not minimum kcal/100g."""
    query_norm = _normalize_text(query)
    query_tokens = _tokenize(query_norm)

    def sort_key(item: tuple[FoodLookupResult, str | None, str, int]) -> tuple:
        r, data_type, desc, idx = item
        return (
            _name_rank(query_norm, query_tokens, desc),
            _serving_preference_rank(r.default_serving_grams),
            _fdc_data_type_rank(data_type),
            idx,  # keep USDA relevance order as the final tie-breaker
        )

    return sorted(pool, key=sort_key)[0][0]


def _filter_pool_by_fdc_fruit_category(
    pool: list[tuple[FoodLookupResult, str | None, str, int]],
) -> list[tuple[FoodLookupResult, str | None, str, int]]:
    """If any hit is in FDC Fruits, drop dairy/bakery noise (e.g. banana yogurt vs raw banana)."""
    fruit_rows = [x for x in pool if x[0].food_category == "fruit"]
    return fruit_rows if fruit_rows else pool


def _fdc_coarse_category(food: dict[str, Any]) -> str | None:
    fc = food.get("foodCategory")
    if not isinstance(fc, dict):
        return None
    d = (fc.get("description") or "").lower()
    if "fruit" in d:
        return "fruit"
    if "vegetable" in d:
        return "vegetable"
    if "dairy" in d or "milk" in d or "egg" in d:
        return "dairy"
    if any(x in d for x in ("cereal", "grain", "rice", "pasta", "bakery", "bread")):
        return "grain"
    if any(x in d for x in ("poultry", "meat", "fish", "seafood", "legume", "nut")):
        return "protein"
    return None


async def search_food_names_usda(query: str, *, page_size: int = 12) -> list[str]:
    """USDA FDC search only — descriptions from `foods/search`, no per-food GET (for autocomplete)."""
    api_key = (os.environ.get("USDA_FDC_API_KEY") or "").strip()
    if not api_key:
        return []
    if os.environ.get("USDA_FDC_DISABLED", "").lower() in ("1", "true", "yes"):
        return []

    q = query.strip()
    if not q:
        return []

    n = max(1, min(int(page_size), 25))
    payload = {
        "query": q,
        "pageSize": n,
        "dataType": ["SR Legacy", "Foundation", "Survey (FNDDS)"],
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            sr = await client.post(
                f"{FDC_BASE}/foods/search",
                params={"api_key": api_key},
                json=payload,
            )
            sr.raise_for_status()
            data = sr.json()
            foods = data.get("foods") or []
            if not isinstance(foods, list) or not foods:
                return []
            seen: set[str] = set()
            out: list[str] = []
            for hit in foods:
                if not isinstance(hit, dict):
                    continue
                desc = str(hit.get("description") or "").strip()
                if not desc:
                    continue
                key = desc.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append(desc)
                if len(out) >= n:
                    break
            return out
    except (httpx.HTTPError, ValueError, TypeError):
        return []


async def lookup_food_usda(query: str) -> FoodLookupResult | None:
    api_key = (os.environ.get("USDA_FDC_API_KEY") or "").strip()
    if not api_key:
        return None
    if os.environ.get("USDA_FDC_DISABLED", "").lower() in ("1", "true", "yes"):
        return None

    q = query.strip()
    if not q:
        return None

    payload = {
        "query": q,
        "pageSize": 20,
        "dataType": ["SR Legacy", "Foundation", "Survey (FNDDS)"],
    }
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            sr = await client.post(
                f"{FDC_BASE}/foods/search",
                params={"api_key": api_key},
                json=payload,
            )
            sr.raise_for_status()
            data = sr.json()
            foods = data.get("foods") or []
            if not isinstance(foods, list) or not foods:
                return None
            pool: list[tuple[FoodLookupResult, str | None, str, int]] = []
            for idx, hit in enumerate(foods):
                if not isinstance(hit, dict):
                    continue
                fdc_id = hit.get("fdcId")
                if fdc_id is None:
                    continue
                desc = str(hit.get("description") or "")
                data_type = hit.get("dataType")
                if data_type is not None and not isinstance(data_type, str):
                    data_type = str(data_type)
                fr = await client.get(
                    f"{FDC_BASE}/food/{fdc_id}",
                    params={"api_key": api_key},
                )
                fr.raise_for_status()
                detail = fr.json()
                if not isinstance(detail, dict):
                    continue
                np = _nutrients_per_100g(detail)
                if np is None:
                    continue
                kcal, ptot = np
                cat = _fdc_coarse_category(detail)
                serving = _portion_grams(detail)
                pool.append(
                    (
                        FoodLookupResult(kcal, ptot, serving, cat),
                        data_type if isinstance(data_type, str) else None,
                        desc,
                        idx,
                    )
                )
            if not pool:
                return None
            pool = _filter_pool_by_fdc_fruit_category(pool)
            return _pick_best_usda_candidate(q, pool)
    except (httpx.HTTPError, ValueError, TypeError):
        return None

    return None
