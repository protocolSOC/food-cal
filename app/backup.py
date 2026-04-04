"""Full-fidelity export/import of meal history (entries + items)."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

from app import db
from app.meals import validate_date_iso


BACKUP_FORMAT = "foodcal-backup"
BACKUP_VERSION = 1


class BackupItemExport(BaseModel):
    label: str
    grams: float | None = None
    calories_allocated: float | None = None
    food_name: str | None = None


class BackupEntryExport(BaseModel):
    date_iso: str
    total_calories: float
    total_protein_g: float | None = None
    estimate_type: str | None = None
    calories_likely: float | None = None
    calories_low: float | None = None
    calories_high: float | None = None
    raw_text: str
    created_at: str | None = None
    items: list[BackupItemExport] = Field(default_factory=list)


class BackupImportBody(BaseModel):
    format: Literal["foodcal-backup"]
    version: Literal[1]
    entries: list[BackupEntryExport]
    mode: Literal["append", "replace"] = "append"
    exported_at: str | None = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def export_backup() -> dict[str, Any]:
    conn = db.get_connection()
    rows = conn.execute(
        """
        SELECT id, date_iso, total_calories, total_protein_g, estimate_type,
               calories_likely, calories_low, calories_high, raw_text, created_at
        FROM entries
        ORDER BY date_iso ASC, id ASC
        """
    ).fetchall()

    entries_out: list[dict[str, Any]] = []
    for r in rows:
        eid = int(r["id"])
        tc = r["total_calories"]
        if tc is None:
            continue
        item_rows = conn.execute(
            """
            SELECT i.label, i.grams, i.calories_allocated, f.name AS food_name
            FROM items i
            LEFT JOIN foods f ON f.id = i.food_id
            WHERE i.entry_id = ?
            ORDER BY i.id ASC
            """,
            (eid,),
        ).fetchall()
        items: list[dict[str, Any]] = []
        for ir in item_rows:
            fn = ir["food_name"]
            items.append(
                {
                    "label": str(ir["label"]),
                    "grams": float(ir["grams"]) if ir["grams"] is not None else None,
                    "calories_allocated": float(ir["calories_allocated"])
                    if ir["calories_allocated"] is not None
                    else None,
                    "food_name": str(fn) if fn is not None else None,
                }
            )

        tp = r["total_protein_g"]
        ent: dict[str, Any] = {
            "date_iso": str(r["date_iso"]),
            "total_calories": float(tc),
            "raw_text": str(r["raw_text"] or ""),
            "items": items,
        }
        if tp is not None:
            ent["total_protein_g"] = float(tp)
        if r["estimate_type"] is not None:
            ent["estimate_type"] = str(r["estimate_type"])
        if r["calories_likely"] is not None:
            ent["calories_likely"] = float(r["calories_likely"])
        if r["calories_low"] is not None:
            ent["calories_low"] = float(r["calories_low"])
        if r["calories_high"] is not None:
            ent["calories_high"] = float(r["calories_high"])
        if r["created_at"] is not None:
            ent["created_at"] = str(r["created_at"])
        entries_out.append(ent)

    return {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exported_at": _utc_now_iso(),
        "entries": entries_out,
    }


def _finite_nonneg(name: str, v: float | None, *, allow_none: bool = True) -> None:
    if v is None:
        if allow_none:
            return
        raise ValueError(f"{name} is required")
    if not math.isfinite(v) or v < 0:
        raise ValueError(f"{name} must be a non-negative finite number")


def import_backup(body: BackupImportBody) -> dict[str, Any]:
    inserted_entries = 0
    inserted_items = 0

    with db.transaction() as conn:
        if body.mode == "replace":
            conn.execute("DELETE FROM entries")

        for ent in body.entries:
            validate_date_iso(ent.date_iso)
            _finite_nonneg("total_calories", ent.total_calories, allow_none=False)
            if ent.total_protein_g is not None:
                _finite_nonneg("total_protein_g", ent.total_protein_g, allow_none=False)
            for est in (ent.calories_likely, ent.calories_low, ent.calories_high):
                if est is not None:
                    _finite_nonneg("estimate_calories", est, allow_none=False)

            raw = ent.raw_text.strip() if ent.raw_text else ""
            if not raw:
                raise ValueError("each entry requires non-empty raw_text")

            created = ent.created_at.strip() if ent.created_at else None
            cur = conn.execute(
                """
                INSERT INTO entries (
                    date_iso, total_calories, total_protein_g,
                    estimate_type, calories_likely, calories_low, calories_high,
                    raw_text, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
                """,
                (
                    ent.date_iso,
                    round(float(ent.total_calories), 1),
                    round(float(ent.total_protein_g), 2) if ent.total_protein_g is not None else None,
                    ent.estimate_type,
                    round(float(ent.calories_likely), 1) if ent.calories_likely is not None else None,
                    round(float(ent.calories_low), 1) if ent.calories_low is not None else None,
                    round(float(ent.calories_high), 1) if ent.calories_high is not None else None,
                    raw,
                    created,
                ),
            )
            eid = int(cur.lastrowid or 0)
            inserted_entries += 1

            for it in ent.items:
                lab = it.label.strip()
                if not lab:
                    raise ValueError("each item requires a non-empty label")
                grams = it.grams
                if grams is not None and (not math.isfinite(grams) or grams < 0):
                    raise ValueError("item grams must be non-negative finite or null")
                cal_al = it.calories_allocated
                if cal_al is not None and (not math.isfinite(cal_al) or cal_al < 0):
                    raise ValueError("item calories_allocated must be non-negative finite or null")

                conn.execute(
                    """
                    INSERT INTO items (entry_id, label, grams, food_id, calories_allocated)
                    VALUES (?, ?, ?, NULL, ?)
                    """,
                    (
                        eid,
                        lab[:500] if len(lab) > 500 else lab,
                        grams,
                        round(float(cal_al), 1) if cal_al is not None else None,
                    ),
                )
                inserted_items += 1

    return {
        "status": "ok",
        "mode": body.mode,
        "inserted_entries": inserted_entries,
        "inserted_items": inserted_items,
    }
