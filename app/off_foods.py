"""Look up kcal, protein, optional serving, and category via Open Food Facts (+ fallback)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

from app import db
from app.food_types import FoodLookupResult

SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl"
USER_AGENT = os.environ.get(
    "OPENFOODFACTS_USER_AGENT",
    "HybridCalorieApp/0.1 (local; https://github.com/hybrid-calorie-app)",
)

_GRAMS_IN_STRING = re.compile(r"(\d+(?:\.\d+)?)\s*g(?:ram)?s?\b", re.IGNORECASE)
_TOKEN_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class BaselineMeta:
    kcal_per_100g: float
    protein_per_100g: float
    food_category: str | None
    default_serving_grams: float | None


def _f(x: Any) -> float | None:
    if x is None:
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _norm_text(s: str) -> str:
    return " ".join(s.strip().lower().split())


def _tokenize(s: str) -> set[str]:
    return set(_TOKEN_RE.findall(_norm_text(s)))


def _baseline_row(query: str):
    normalized = _norm_text(query)
    if not normalized:
        return None
    conn = db.get_connection()
    return db.get_food_baseline(conn, normalized)


def _baseline_meta(query: str) -> BaselineMeta | None:
    row = _baseline_row(query)
    if row is None:
        return None
    raw_cat = row["food_category"]
    cat = str(raw_cat).strip().lower() if raw_cat is not None else None
    serving = _f(row["default_serving_grams"])
    if serving is not None and serving <= 0:
        serving = None
    return BaselineMeta(
        float(row["kcal_per_100g"]),
        float(row["protein_per_100g"]),
        cat,
        serving,
    )


def _fallback_lookup(query: str) -> FoodLookupResult | None:
    baseline = _baseline_meta(query)
    if baseline is None:
        return None
    return FoodLookupResult(
        round(baseline.kcal_per_100g, 3),
        round(baseline.protein_per_100g, 3),
        default_serving_grams=baseline.default_serving_grams,
        food_category=baseline.food_category,
    )


def _off_name_for_ranking(product: dict[str, Any]) -> str:
    raw = (
        product.get("product_name_en")
        or product.get("product_name")
        or product.get("generic_name_en")
        or product.get("generic_name")
        or ""
    )
    return _norm_text(str(raw))


def _pick_nutrients(nut: dict[str, Any]) -> tuple[float, float] | None:
    kcal = _f(nut.get("energy-kcal_100g"))
    if kcal is None:
        kj = _f(nut.get("energy_100g"))
        if kj is not None and kj > 0:
            kcal = kj / 4.184
    if kcal is None or kcal <= 0:
        return None
    prot = _f(nut.get("proteins_100g"))
    if prot is None:
        prot = 0.0
    if prot < 0:
        prot = 0.0
    return (round(kcal, 3), round(prot, 3))


def _extract_serving_grams(product: dict[str, Any]) -> float | None:
    for field in ("serving_size", "nutriment_serving_size"):
        val = product.get(field)
        if isinstance(val, str):
            m = _GRAMS_IN_STRING.search(val)
            if m:
                g = float(m.group(1))
                if 10.0 <= g <= 800.0:
                    return g
    sq = _f(product.get("serving_quantity"))
    su = (product.get("serving_quantity_unit") or "").lower()
    if sq is not None and su in ("g", "gram", "grams") and 10.0 <= sq <= 800.0:
        return sq
    return None


def _category_from_off_product(product: dict[str, Any]) -> str | None:
    tags = product.get("categories_tags") or []
    if not isinstance(tags, list):
        return None
    blob = " ".join(str(t).lower() for t in tags)
    if "en:vegetables" in blob:
        return "vegetable"
    if "en:fruits" in blob:
        return "fruit"
    if "en:dairies" in blob or "en:dairy" in blob:
        return "dairy"
    if any(x in blob for x in ("en:breads", "en:cereals", "en:rice", "en:pastas")):
        return "grain"
    if any(x in blob for x in ("en:meats", "en:poultry", "en:fish", "en:seafood", "en:eggs")):
        return "protein"
    return None


def _category_match_penalty(expected: str | None, actual: str | None) -> int:
    if expected is None or actual is None:
        return 0
    return 0 if expected == actual else 1


def _name_rank(query_norm: str, query_tokens: set[str], candidate_name: str) -> tuple[int, int, int]:
    if not candidate_name:
        return (3, 1000, 1000)
    cand_tokens = _tokenize(candidate_name)
    if candidate_name == query_norm:
        return (0, 0, len(cand_tokens))
    if candidate_name.startswith(query_norm + " "):
        return (1, 0, len(cand_tokens))
    missing = len(query_tokens - cand_tokens)
    extra = len(cand_tokens - query_tokens)
    return (2, missing, extra)


def _kcal_anchor_penalty(anchor_kcal: float | None, kcal_per_100g: float) -> float:
    if anchor_kcal is None:
        return 0.0
    if anchor_kcal <= 0:
        return 0.0
    # Smooth relative penalty for outliers while still allowing real-world variance.
    return abs(kcal_per_100g - anchor_kcal) / anchor_kcal


def _pick_best_off_product(query: str, products: list[dict[str, Any]]) -> FoodLookupResult | None:
    query_norm = _norm_text(query)
    query_tokens = _tokenize(query_norm)
    baseline = _baseline_meta(query_norm)
    expected_category = baseline.food_category if baseline is not None else None
    anchor_kcal: float | None = baseline.kcal_per_100g if baseline is not None else None
    ranked: list[tuple[tuple[Any, ...], FoodLookupResult]] = []

    for p in products:
        if not isinstance(p, dict):
            continue
        nut = p.get("nutriments")
        if not isinstance(nut, dict):
            continue
        picked = _pick_nutrients(nut)
        if picked is None:
            continue
        kcal, prot = picked
        serving = _extract_serving_grams(p)
        category = _category_from_off_product(p)
        result = FoodLookupResult(kcal, prot, serving, category)
        scans = _f(p.get("unique_scans_n"))
        if scans is None or scans < 0:
            scans = 0.0
        name_rank = _name_rank(query_norm, query_tokens, _off_name_for_ranking(p))
        key: tuple[Any, ...] = (
            name_rank,
            _category_match_penalty(expected_category, category),
            _kcal_anchor_penalty(anchor_kcal, kcal),
            -float(scans),
        )
        ranked.append((key, result))

    if not ranked:
        return None
    ranked.sort(key=lambda x: x[0])
    return ranked[0][1]


def _merge_servings(a: float | None, b: float | None) -> float | None:
    """Primary (USDA) grams when present; Open Food Facts only fills gaps.

    No cross-source “smart” blending: both APIs can report different household units; we do not
    invent thresholds. Calories and protein always come from the primary row’s per-100g values.
    """
    if a is not None:
        return a
    return b


def _merge_lookup(primary: FoodLookupResult, secondary: FoodLookupResult | None) -> FoodLookupResult:
    if secondary is None:
        return FoodLookupResult(
            primary.kcal_per_100g,
            primary.protein_per_100g,
            primary.default_serving_grams,
            primary.food_category,
        )
    serving = _merge_servings(primary.default_serving_grams, secondary.default_serving_grams)
    cat = primary.food_category if primary.food_category is not None else secondary.food_category
    return FoodLookupResult(primary.kcal_per_100g, primary.protein_per_100g, serving, cat)


def _relative_kcal_distance(anchor: float, kcal: float) -> float:
    if anchor <= 0:
        return float("inf")
    return abs(kcal - anchor) / anchor


def _choose_primary_by_anchor(
    query: str,
    usda_hit: FoodLookupResult,
    off_hit: FoodLookupResult | None,
) -> tuple[FoodLookupResult, FoodLookupResult | None]:
    """Choose the macro source that is closer to the known per-100g anchor for common foods.

    This keeps deterministic rows robust when one API returns a semantically different product
    for a short query (e.g., a low-calorie drink variant for a whole-food noun).
    """
    baseline = _baseline_meta(query)
    if baseline is None:
        return (usda_hit, off_hit)
    anchor_kcal = baseline.kcal_per_100g
    usda_d = _relative_kcal_distance(anchor_kcal, float(usda_hit.kcal_per_100g))
    # If OFF is unavailable and USDA is a clear outlier, keep USDA serving/category but
    # use the known generic per-100g anchor to avoid implausible deterministic results.
    if off_hit is None and usda_d >= 0.45:
        cat = usda_hit.food_category if usda_hit.food_category is not None else baseline.food_category
        anchor_protein = baseline.protein_per_100g
        serving = baseline.default_serving_grams
        if serving is None:
            serving = usda_hit.default_serving_grams
        return (
            FoodLookupResult(
                round(anchor_kcal, 3),
                round(anchor_protein, 3),
                serving,
                cat,
            ),
            None,
        )
    if off_hit is None:
        return (usda_hit, off_hit)
    off_d = _relative_kcal_distance(anchor_kcal, float(off_hit.kcal_per_100g))
    if off_d + 1e-9 < usda_d:
        return (off_hit, usda_hit)
    return (usda_hit, off_hit)


def repair_hit_with_baseline_anchor(query: str, hit: FoodLookupResult) -> FoodLookupResult:
    """Repair severe outlier cache/API hits using baseline macros + serving when available."""
    baseline = _baseline_meta(query)
    if baseline is None:
        return hit
    rel_dist = _relative_kcal_distance(baseline.kcal_per_100g, float(hit.kcal_per_100g))
    if rel_dist < 0.45:
        return hit
    serving = baseline.default_serving_grams
    if serving is None:
        serving = hit.default_serving_grams
    cat = hit.food_category if hit.food_category is not None else baseline.food_category
    return FoodLookupResult(
        round(baseline.kcal_per_100g, 3),
        round(baseline.protein_per_100g, 3),
        serving,
        cat,
    )


def baseline_context(query: str) -> dict[str, Any] | None:
    baseline = _baseline_meta(query)
    if baseline is None:
        return None
    return {
        "kcal_per_100g": baseline.kcal_per_100g,
        "protein_per_100g": baseline.protein_per_100g,
        "default_serving_grams": baseline.default_serving_grams,
        "food_category": baseline.food_category,
    }


def needs_llm_sanity_check(query: str, hit: FoodLookupResult) -> bool:
    """True when deterministic result is still suspicious after baseline repair."""
    baseline = _baseline_meta(query)
    if baseline is None:
        return False
    kcal_dist = _relative_kcal_distance(baseline.kcal_per_100g, float(hit.kcal_per_100g))
    if kcal_dist >= 0.45:
        return True
    baseline_serving = baseline.default_serving_grams
    if baseline_serving is None:
        return False
    if hit.default_serving_grams is None:
        return True
    if hit.default_serving_grams <= 0:
        return True
    ratio = float(hit.default_serving_grams) / float(baseline_serving)
    if ratio < 0.5 or ratio > 2.0:
        return True
    return False


async def _lookup_open_food_facts(query: str) -> FoodLookupResult | None:
    params = {
        "action": "process",
        "search_terms": query.strip(),
        "json": "true",
        "page_size": "15",
        "sort_by": "unique_scans_n",
    }
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(SEARCH_URL, params=params, headers=headers)
            r.raise_for_status()
            data = r.json()
    except (httpx.HTTPError, ValueError, TypeError):
        return None

    products = data.get("products") or []
    if not isinstance(products, list):
        return None
    return _pick_best_off_product(query, products)


async def lookup_food(query: str) -> FoodLookupResult | None:
    if not query.strip():
        return None

    from app import usda_fdc

    usda_hit = await usda_fdc.lookup_food_usda(query)
    off_disabled = os.environ.get("OPENFOODFACTS_DISABLED", "").lower() in ("1", "true", "yes")

    off_hit: FoodLookupResult | None = None
    if not off_disabled:
        off_hit = await _lookup_open_food_facts(query)

    if usda_hit is not None:
        primary, secondary = _choose_primary_by_anchor(query, usda_hit, off_hit)
        return _merge_lookup(primary, secondary)

    if off_hit is not None:
        return off_hit

    return _fallback_lookup(query)


async def search_nutrition_per_100g(query: str) -> tuple[float, float] | None:
    meta = await lookup_food(query)
    if meta is None:
        return None
    return (meta.kcal_per_100g, meta.protein_per_100g)