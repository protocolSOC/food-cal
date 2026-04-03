"""Log meals: local DB resolution first, LLM fallback for vague input."""

from __future__ import annotations

import math
import re
import sqlite3
from datetime import datetime
from typing import Any

import app.llm as llm_mod
from app import db
from app.food_resolve import resolve_food_row
from app.food_servings import bare_serving_grams
from app.hebrew_lexicon import (
    english_bare_query_name,
    english_counted_bare_query,
    english_food_query_for_hebrew_bare,
)
from app.nutrition import kcal_and_protein
from app.debug_agent_log import agent_log
from app.parse_local import meal_needs_estimate_heuristic, parse_local_meal

_DATE_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def validate_date_iso(date_iso: str) -> str:
    s = date_iso.strip()
    if not _DATE_ISO_RE.match(s):
        raise ValueError("date must be YYYY-MM-DD")
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError as e:
        raise ValueError("invalid calendar date") from e
    return s


def _parse_created_at_to_ms(created_at: str | None, entry_id: int) -> int:
    if not created_at:
        return entry_id * 1_000_000
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(created_at.strip(), fmt)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return entry_id * 1_000_000


def _display_name_for_entry(
    conn: sqlite3.Connection, entry_id: int, raw_text: str
) -> str:
    rows = conn.execute(
        "SELECT label FROM items WHERE entry_id = ? ORDER BY id",
        (entry_id,),
    ).fetchall()
    if rows:
        joined = ", ".join(str(r["label"]) for r in rows if r["label"])
        if joined:
            return joined[:120]
    return (raw_text or "").strip()[:120] or "Meal"


def _baseline_serving_grams(conn: sqlite3.Connection, normalized_name: str) -> float | None:
    row = db.get_food_baseline(conn, normalized_name)
    if row is None:
        return None
    raw = row["default_serving_grams"]
    if raw is None:
        return None
    try:
        g = float(raw)
    except (TypeError, ValueError):
        return None
    if g <= 0:
        return None
    return g


def _bare_serving_with_baseline(conn: sqlite3.Connection, normalized_name: str, row: sqlite3.Row) -> float | None:
    g = bare_serving_grams(row)
    if g is not None:
        return g
    return _baseline_serving_grams(conn, normalized_name)


def _llm_required_float(field: str, raw: Any) -> float:
    if raw is None:
        raise ValueError(f"LLM JSON missing numeric {field}")
    try:
        v = float(raw)
    except (TypeError, ValueError) as e:
        raise ValueError(f"LLM JSON {field} must be a number, got {raw!r}") from e
    if not math.isfinite(v):
        raise ValueError(f"LLM JSON {field} must be a finite number, got {raw!r}")
    return v


def _llm_optional_float(field: str, raw: Any) -> float | None:
    if raw is None:
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError) as e:
        raise ValueError(f"LLM JSON {field} must be a number or null, got {raw!r}") from e
    if not math.isfinite(v):
        raise ValueError(f"LLM JSON {field} must be a finite number or null, got {raw!r}")
    return v


def _fetch_entry(conn: sqlite3.Connection, entry_id: int) -> dict[str, Any]:
    ent = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if ent is None:
        raise ValueError(f"No entry row for id={entry_id}")
    rows = conn.execute(
        "SELECT label, grams, calories_allocated FROM items WHERE entry_id = ? ORDER BY id",
        (entry_id,),
    ).fetchall()
    items = [
        {
            "label": r["label"],
            "grams": r["grams"],
            **({"calories": r["calories_allocated"]} if r["calories_allocated"] is not None else {}),
        }
        for r in rows
    ]
    tc = ent["total_calories"]
    if tc is None:
        raise ValueError("Stored entry has null total_calories (invalid or legacy row)")
    out: dict[str, Any] = {
        "total_calories": float(tc),
        "items": items,
    }
    if ent["total_protein_g"] is not None:
        out["total_protein_g"] = float(ent["total_protein_g"])
    if ent["estimate_type"] is not None:
        out["estimate_type"] = ent["estimate_type"]
    if ent["calories_likely"] is not None:
        out["calories_likely"] = float(ent["calories_likely"])
    if ent["calories_low"] is not None:
        out["calories_low"] = float(ent["calories_low"])
    if ent["calories_high"] is not None:
        out["calories_high"] = float(ent["calories_high"])
    return out


def _persist_structured_entry(
    conn: sqlite3.Connection,
    date_iso: str,
    raw_text: str,
    resolved: list[tuple[float, str, sqlite3.Row]],
) -> dict[str, Any]:
    total_kcal = 0.0
    total_prot = 0.0
    lines: list[tuple[float, str, int, float]] = []
    for grams, name, food_row in resolved:
        k, p = kcal_and_protein(
            grams,
            float(food_row["kcal_per_100g"]),
            float(food_row["protein_per_100g"]),
        )
        total_kcal += k
        total_prot += p
        lines.append((grams, name, int(food_row["id"]), k))

    with db.transaction() as c:
        cur = c.execute(
            """
            INSERT INTO entries (
                date_iso, total_calories, total_protein_g,
                estimate_type, calories_likely, calories_low, calories_high,
                raw_text, created_at
            ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, datetime('now'))
            """,
            (
                date_iso,
                round(total_kcal, 1),
                round(total_prot, 2),
                raw_text,
            ),
        )
        eid = cur.lastrowid
        for grams, name, fid, k in lines:
            c.execute(
                """
                INSERT INTO items (entry_id, label, grams, food_id, calories_allocated)
                VALUES (?, ?, ?, ?, ?)
                """,
                (eid, name, grams, fid, round(k, 1)),
            )

    return _fetch_entry(conn, int(eid))


async def log_meal(text: str, date_iso: str) -> dict[str, Any]:
    conn = db.get_connection()
    needs_h = meal_needs_estimate_heuristic(text)
    local = None if needs_h else parse_local_meal(text)
    # region agent log
    agent_log(
        "meals.py:log_meal",
        "after_local_parse",
        {
            "needs_heuristic": needs_h,
            "local_segments": None if local is None else len(local),
        },
        "H1",
    )
    # endregion
    resolved: list[tuple[float, str, sqlite3.Row]] = []

    if local is not None:
        for grams, name in local:
            row = await resolve_food_row(conn, name)
            if row is None:
                break
            resolved.append((grams, name, row))
        else:
            return _persist_structured_entry(conn, date_iso, text, resolved)

    if not meal_needs_estimate_heuristic(text):
        en_query = english_food_query_for_hebrew_bare(text)
        if en_query:
            row = await resolve_food_row(conn, en_query)
            if row is not None:
                grams_bare = _bare_serving_with_baseline(conn, en_query, row)
                if grams_bare is not None:
                    bare_resolved = [(grams_bare, en_query, row)]
                    return _persist_structured_entry(conn, date_iso, text, bare_resolved)
        bare_en = english_bare_query_name(text)
        if bare_en is not None:
            row = await resolve_food_row(conn, bare_en)
            if row is not None:
                grams_bare = _bare_serving_with_baseline(conn, bare_en, row)
                if grams_bare is not None:
                    bare_resolved = [(grams_bare, bare_en, row)]
                    return _persist_structured_entry(conn, date_iso, text, bare_resolved)
        counted = english_counted_bare_query(text)
        if counted is not None:
            count, candidates = counted
            for candidate in candidates:
                row = await resolve_food_row(conn, candidate)
                if row is None:
                    continue
                grams_bare = _bare_serving_with_baseline(conn, candidate, row)
                if grams_bare is None:
                    continue
                counted_resolved = [(grams_bare * count, candidate, row)]
                return _persist_structured_entry(conn, date_iso, text, counted_resolved)

    # region agent log
    agent_log("meals.py:log_meal", "calling_llm", {"text_len": len(text)}, "H2")
    # endregion
    llm_data = await llm_mod.parse_meal_with_llm(text)
    # region agent log
    agent_log(
        "meals.py:log_meal",
        "llm_returned",
        {"keys": list(llm_data.keys())},
        "H5",
    )
    # endregion
    likely = _llm_required_float("calories_likely", llm_data.get("calories_likely"))
    est = str(llm_data.get("estimate_type", "estimated"))
    low = _llm_optional_float("calories_low", llm_data.get("calories_low"))
    high = _llm_optional_float("calories_high", llm_data.get("calories_high"))
    prot_raw = llm_data.get("total_protein_g")
    protein_g = (
        round(_llm_required_float("total_protein_g", prot_raw), 2) if prot_raw is not None else None
    )

    with db.transaction() as c:
        cur = c.execute(
            """
            INSERT INTO entries (
                date_iso, total_calories, total_protein_g,
                estimate_type, calories_likely, calories_low, calories_high,
                raw_text, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                date_iso,
                likely,
                protein_g,
                est,
                likely,
                low,
                high,
                text,
            ),
        )
        eid = cur.lastrowid
        for it in llm_data.get("items", []) or []:
            if not isinstance(it, dict):
                continue
            label = str(it.get("food", "")).strip()
            g = it.get("grams")
            try:
                grams_f = float(g) if g is not None else None
            except (TypeError, ValueError):
                grams_f = None
            c.execute(
                """
                INSERT INTO items (entry_id, label, grams, food_id, calories_allocated)
                VALUES (?, ?, ?, NULL, NULL)
                """,
                (eid, label or "unknown", grams_f),
            )

    return _fetch_entry(conn, int(eid))


def daily_summary(date_iso: str) -> dict[str, Any]:
    conn = db.get_connection()
    rows = conn.execute(
        "SELECT total_calories, total_protein_g FROM entries WHERE date_iso = ?",
        (date_iso,),
    ).fetchall()
    total_cal = sum(float(r["total_calories"] or 0.0) for r in rows)
    has_protein = any(r["total_protein_g"] is not None for r in rows)
    total_prot = sum(float(r["total_protein_g"] or 0.0) for r in rows)
    out: dict[str, Any] = {"total_calories": round(total_cal, 1)}
    if has_protein:
        out["total_protein_g"] = round(total_prot, 2)
    return out


def list_entries_for_date(date_iso: str) -> list[dict[str, Any]]:
    conn = db.get_connection()
    date_iso = validate_date_iso(date_iso)
    rows = conn.execute(
        """
        SELECT id, total_calories, total_protein_g, raw_text, created_at
        FROM entries
        WHERE date_iso = ?
        ORDER BY id DESC
        """,
        (date_iso,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        eid = int(r["id"])
        tc = r["total_calories"]
        if tc is None:
            continue
        name = _display_name_for_entry(conn, eid, str(r["raw_text"] or ""))
        tp = r["total_protein_g"]
        protein = round(float(tp)) if tp is not None else 0
        created = r["created_at"]
        ts = _parse_created_at_to_ms(created, eid)
        out.append(
            {
                "id": eid,
                "name": name,
                "calories": round(float(tc)),
                "protein": protein,
                "timestamp": ts,
            }
        )
    return out


def delete_entry(entry_id: int) -> bool:
    with db.transaction() as c:
        cur = c.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        return cur.rowcount > 0


def entries_rollups(start_iso: str, end_iso: str) -> list[dict[str, Any]]:
    start_iso = validate_date_iso(start_iso)
    end_iso = validate_date_iso(end_iso)
    if start_iso > end_iso:
        raise ValueError("start must be on or before end")

    conn = db.get_connection()
    rows = conn.execute(
        """
        SELECT
            date_iso,
            SUM(total_calories) AS sum_cal,
            SUM(CASE WHEN total_protein_g IS NULL THEN 0.0 ELSE total_protein_g END) AS sum_prot,
            MAX(CASE WHEN total_protein_g IS NULL THEN 0 ELSE 1 END) AS has_any_protein,
            COUNT(*) AS meal_count
        FROM entries
        WHERE date_iso >= ? AND date_iso <= ?
        GROUP BY date_iso
        ORDER BY date_iso
        """,
        (start_iso, end_iso),
    ).fetchall()

    result: list[dict[str, Any]] = []
    for r in rows:
        d: dict[str, Any] = {
            "date": str(r["date_iso"]),
            "total_calories": round(float(r["sum_cal"] or 0), 1),
            "meals": int(r["meal_count"] or 0),
        }
        if int(r["has_any_protein"] or 0):
            d["total_protein_g"] = round(float(r["sum_prot"] or 0), 2)
        result.append(d)
    return result
