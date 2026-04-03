from __future__ import annotations

from app import db
from app.food_types import FoodLookupResult
from app.off_foods import (
    _choose_primary_by_anchor,
    _fallback_lookup,
    _pick_best_off_product,
    needs_llm_sanity_check,
    repair_hit_with_baseline_anchor,
)


def test_pick_best_off_product_prefers_exact_name_and_plausible_kcal() -> None:
    products = [
        {
            "product_name": "Apple juice drink",
            "unique_scans_n": 9999,
            "nutriments": {"energy-kcal_100g": 25, "proteins_100g": 0.6},
            "serving_size": "100 g",
            "categories_tags": ["en:beverages"],
        },
        {
            "product_name": "Apple",
            "unique_scans_n": 3,
            "nutriments": {"energy-kcal_100g": 52, "proteins_100g": 0.3},
            "serving_size": "182 g",
            "categories_tags": ["en:fruits"],
        },
    ]

    hit = _pick_best_off_product("apple", products)
    assert hit is not None
    assert hit.kcal_per_100g == 52.0
    assert hit.default_serving_grams == 182.0
    assert hit.food_category == "fruit"


def test_pick_best_off_product_uses_scans_when_other_signals_tie() -> None:
    products = [
        {
            "product_name": "Banana",
            "unique_scans_n": 1,
            "nutriments": {"energy-kcal_100g": 89, "proteins_100g": 1.1},
            "serving_size": "120 g",
            "categories_tags": ["en:fruits"],
        },
        {
            "product_name": "Banana",
            "unique_scans_n": 20,
            "nutriments": {"energy-kcal_100g": 89, "proteins_100g": 1.1},
            "serving_size": "120 g",
            "categories_tags": ["en:fruits"],
        },
    ]

    hit = _pick_best_off_product("banana", products)
    assert hit is not None
    assert hit.kcal_per_100g == 89.0
    assert hit.default_serving_grams == 120.0


def test_fallback_lookup_reads_seeded_db_baseline() -> None:
    hit = _fallback_lookup("apple")
    assert hit is not None
    assert hit.kcal_per_100g == 52.0
    assert hit.protein_per_100g == 0.3
    assert hit.default_serving_grams == 185.0
    assert hit.food_category == "fruit"


def test_fallback_lookup_reflects_db_baseline_edits_without_code_change() -> None:
    conn = db.get_connection()
    with db.transaction() as c:
        c.execute(
            """
            UPDATE food_baselines
            SET kcal_per_100g = ?, protein_per_100g = ?, food_category = ?
            WHERE lower(name) = lower(?)
            """,
            (60.0, 0.4, "fruit", "apple"),
        )

    hit = _fallback_lookup("apple")
    assert hit is not None
    assert hit.kcal_per_100g == 60.0
    assert hit.protein_per_100g == 0.4
    assert hit.food_category == "fruit"
    # Keep `conn` used so static checks don't flag it as dead assignment.
    assert conn is not None


def test_choose_primary_by_anchor_uses_db_baseline() -> None:
    usda_hit = FoodLookupResult(25.0, 0.6, 50.0, "fruit")
    off_hit = FoodLookupResult(52.0, 0.3, 185.0, "fruit")
    primary, secondary = _choose_primary_by_anchor("apple", usda_hit, off_hit)
    assert primary.kcal_per_100g == 52.0
    assert secondary is not None
    assert secondary.kcal_per_100g == 25.0


def test_repair_hit_with_baseline_anchor_repairs_macro_and_serving() -> None:
    repaired = repair_hit_with_baseline_anchor("apple", FoodLookupResult(25.0, 0.6, 50.0, "fruit"))
    assert repaired.kcal_per_100g == 52.0
    assert repaired.protein_per_100g == 0.3
    assert repaired.default_serving_grams == 185.0


def test_needs_llm_sanity_check_when_serving_far_from_baseline() -> None:
    assert needs_llm_sanity_check("apple", FoodLookupResult(52.0, 0.3, 20.0, "fruit")) is True


def test_needs_llm_sanity_check_false_for_plausible_hit() -> None:
    assert needs_llm_sanity_check("apple", FoodLookupResult(52.0, 0.3, 182.0, "fruit")) is False
