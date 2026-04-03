"""Resolve a normalized food name: SQLite cache kept in sync with USDA + Open Food Facts."""

from __future__ import annotations

import sqlite3

import app.llm as llm_mod
import app.off_foods as off_foods
from app import db
from app.food_types import FoodLookupResult


def _row_as_lookup(row: sqlite3.Row) -> FoodLookupResult:
    raw_cat = row["food_category"]
    cat = str(raw_cat).strip().lower() if raw_cat is not None else None
    return FoodLookupResult(
        float(row["kcal_per_100g"]),
        float(row["protein_per_100g"]),
        float(row["default_serving_grams"]) if row["default_serving_grams"] is not None else None,
        cat,
    )


def _maybe_repair_cached_row(
    conn: sqlite3.Connection,
    normalized_name: str,
    row: sqlite3.Row,
) -> sqlite3.Row:
    repaired = off_foods.repair_hit_with_baseline_anchor(normalized_name, _row_as_lookup(row))
    unchanged = (
        abs(float(row["kcal_per_100g"]) - repaired.kcal_per_100g) < 1e-9
        and abs(float(row["protein_per_100g"]) - repaired.protein_per_100g) < 1e-9
        and (
            (row["default_serving_grams"] is None and repaired.default_serving_grams is None)
            or (
                row["default_serving_grams"] is not None
                and repaired.default_serving_grams is not None
                and abs(float(row["default_serving_grams"]) - repaired.default_serving_grams) < 1e-9
            )
        )
        and row["food_category"] == repaired.food_category
    )
    if unchanged:
        return row
    with db.transaction() as c:
        c.execute(
            """
            UPDATE foods SET
                kcal_per_100g = ?,
                protein_per_100g = ?,
                default_serving_grams = ?,
                food_category = ?
            WHERE id = ?
            """,
            (
                repaired.kcal_per_100g,
                repaired.protein_per_100g,
                repaired.default_serving_grams,
                repaired.food_category,
                int(row["id"]),
            ),
        )
    fixed = db.find_food_by_name(conn, normalized_name)
    return fixed if fixed is not None else row


def _apply_sanity_verdict(meta: FoodLookupResult, verdict: llm_mod.FoodSanityVerdict) -> FoodLookupResult:
    kcal = meta.kcal_per_100g
    serving = meta.default_serving_grams
    if verdict.corrected_kcal_per_100g is not None and verdict.corrected_kcal_per_100g > 0:
        kcal = round(verdict.corrected_kcal_per_100g, 3)
    if verdict.corrected_serving_grams is not None and verdict.corrected_serving_grams > 0:
        serving = round(verdict.corrected_serving_grams, 3)
    return FoodLookupResult(kcal, meta.protein_per_100g, serving, meta.food_category)


async def _maybe_apply_llm_sanity_guardrail(
    normalized_name: str,
    meta: FoodLookupResult,
) -> FoodLookupResult:
    if not llm_mod.sanity_check_enabled():
        return meta
    if not off_foods.needs_llm_sanity_check(normalized_name, meta):
        return meta
    try:
        verdict = await llm_mod.validate_food_result_with_llm(
            normalized_name,
            meta,
            off_foods.baseline_context(normalized_name),
        )
    except Exception:
        return meta
    if verdict.is_plausible:
        return meta
    if verdict.confidence < llm_mod.sanity_min_confidence():
        return meta
    return _apply_sanity_verdict(meta, verdict)


async def resolve_food_row(conn: sqlite3.Connection, normalized_name: str) -> sqlite3.Row | None:
    """Return a `foods` row, refreshing from APIs whenever `lookup_food` succeeds.

    Stale rows (e.g. dairy yogurt matched for ``banana`` before USDA fruit filtering) are overwritten
    on the next log — we only skipped refresh when `food_category` was null, which kept bad rows forever.
    If `lookup_food` fails (offline), the last cached row is still returned.
    """
    meta = await off_foods.lookup_food(normalized_name)
    if meta is None:
        cached = db.find_food_by_name(conn, normalized_name)
        if cached is None:
            return None
        return _maybe_repair_cached_row(conn, normalized_name, cached)
    meta = off_foods.repair_hit_with_baseline_anchor(normalized_name, meta)
    meta = await _maybe_apply_llm_sanity_guardrail(normalized_name, meta)

    row = db.find_food_by_name(conn, normalized_name)
    if row is None:
        try:
            with db.transaction() as c:
                c.execute(
                    """
                    INSERT INTO foods (name, kcal_per_100g, protein_per_100g, default_serving_grams, food_category)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        normalized_name,
                        meta.kcal_per_100g,
                        meta.protein_per_100g,
                        meta.default_serving_grams,
                        meta.food_category,
                    ),
                )
        except sqlite3.IntegrityError:
            with db.transaction() as c:
                c.execute(
                    """
                    UPDATE foods SET
                        kcal_per_100g = ?,
                        protein_per_100g = ?,
                        default_serving_grams = ?,
                        food_category = ?
                    WHERE lower(name) = lower(?)
                    """,
                    (
                        meta.kcal_per_100g,
                        meta.protein_per_100g,
                        meta.default_serving_grams,
                        meta.food_category,
                        normalized_name,
                    ),
                )
    else:
        with db.transaction() as c:
            c.execute(
                """
                UPDATE foods SET
                    kcal_per_100g = ?,
                    protein_per_100g = ?,
                    default_serving_grams = ?,
                    food_category = ?
                WHERE id = ?
                """,
                (
                    meta.kcal_per_100g,
                    meta.protein_per_100g,
                    meta.default_serving_grams,
                    meta.food_category,
                    int(row["id"]),
                ),
            )

    return db.find_food_by_name(conn, normalized_name)
