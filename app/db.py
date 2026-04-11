"""SQLite schema, seed rows, and shared connection."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

# No bundled nutrition rows — foods table is filled from Open Food Facts on demand (+ cache).
SEED_FOODS: list[tuple[str, float, float]] = []
SEED_FOOD_BASELINES: list[tuple[str, float, float, str | None, float | None]] = [
    ("apple", 52.0, 0.3, "fruit", 185.0),
    ("banana", 89.0, 1.1, "fruit", 118.0),
    ("bread", 265.0, 9.0, "grain", None),
    ("carrot", 41.0, 0.9, "vegetable", 61.0),
    ("cheese", 350.0, 23.0, "dairy", None),
    ("chicken breast", 165.0, 31.0, "protein", None),
    ("cucumber", 16.0, 0.7, "vegetable", 200.0),
    ("egg", 143.0, 12.6, "protein", 50.0),
    ("milk", 42.0, 3.4, "dairy", None),
    ("orange", 47.0, 0.9, "fruit", 140.0),
    ("oats", 389.0, 17.0, "grain", None),
    ("pasta", 131.0, 5.0, "grain", None),
    ("potato", 77.0, 2.0, "vegetable", 173.0),
    ("rice", 130.0, 2.7, "grain", None),
    ("rice cooked", 130.0, 2.3, "grain", None),
    ("salmon", 206.0, 22.0, "protein", None),
    ("sweet potato", 86.0, 1.6, "vegetable", 130.0),
    ("tomato", 18.0, 0.9, "vegetable", 123.0),
    ("tuna", 144.0, 23.0, "protein", None),
    ("yogurt", 59.0, 10.0, "dairy", None),
]

# Bone-in / as-weighed → approximate edible fraction (yield) for gram-based kcal when labels match.
SEED_PORTION_YIELD_RULES: list[tuple[str, float, int]] = [
    ("chicken wings", 0.6, 1),
    ("chicken drumstick", 0.7, 1),
    ("chicken thigh with bone", 0.75, 1),
    ("whole fish with bones", 0.55, 1),
]

_conn: sqlite3.Connection | None = None


def _db_path() -> str:
    return os.environ.get("SQLITE_PATH", str(Path("data") / "app.db"))


def get_connection() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        path = _db_path()
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(path, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
        _init_schema(_conn)
        _seed_if_empty(_conn)
        _conn.commit()
    return _conn


def reset_for_testing() -> None:
    """Close and drop the singleton so the next get_connection() is fresh (for :memory: isolation)."""
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


def _foods_column_names(conn: sqlite3.Connection) -> set[str]:
    cur = conn.execute("PRAGMA table_info(foods)")
    return {str(r[1]) for r in cur.fetchall()}


def _food_baselines_column_names(conn: sqlite3.Connection) -> set[str]:
    cur = conn.execute("PRAGMA table_info(food_baselines)")
    return {str(r[1]) for r in cur.fetchall()}


def _migrate_foods(conn: sqlite3.Connection) -> None:
    cols = _foods_column_names(conn)
    if "default_serving_grams" not in cols:
        conn.execute("ALTER TABLE foods ADD COLUMN default_serving_grams REAL")
    if "food_category" not in cols:
        conn.execute("ALTER TABLE foods ADD COLUMN food_category TEXT")


def _migrate_food_baselines(conn: sqlite3.Connection) -> None:
    cols = _food_baselines_column_names(conn)
    if "default_serving_grams" not in cols:
        conn.execute("ALTER TABLE food_baselines ADD COLUMN default_serving_grams REAL")


def _entries_column_names(conn: sqlite3.Connection) -> set[str]:
    cur = conn.execute("PRAGMA table_info(entries)")
    return {str(r[1]) for r in cur.fetchall()}


def _migrate_entries(conn: sqlite3.Connection) -> None:
    cols = _entries_column_names(conn)
    if "created_at" not in cols:
        conn.execute("ALTER TABLE entries ADD COLUMN created_at TEXT")


def _migrate_meal_log_jobs(conn: sqlite3.Connection) -> None:
    """Ensure meal_log_jobs table exists (for DBs created before this feature)."""
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='meal_log_jobs'")
    if cur.fetchone() is None:
        conn.execute(
            """
            CREATE TABLE meal_log_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date_iso TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                llm_fallback INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'queued',
                error_detail TEXT,
                entry_id INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE SET NULL
            )
            """
        )


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS foods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            kcal_per_100g REAL NOT NULL,
            protein_per_100g REAL NOT NULL,
            default_serving_grams REAL,
            food_category TEXT
        );

        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_iso TEXT NOT NULL,
            total_calories REAL NOT NULL,
            total_protein_g REAL,
            estimate_type TEXT,
            calories_likely REAL,
            calories_low REAL,
            calories_high REAL,
            raw_text TEXT NOT NULL,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id INTEGER NOT NULL,
            label TEXT NOT NULL,
            grams REAL,
            food_id INTEGER,
            calories_allocated REAL,
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
            FOREIGN KEY (food_id) REFERENCES foods(id)
        );

        CREATE TABLE IF NOT EXISTS food_baselines (
            name TEXT PRIMARY KEY,
            kcal_per_100g REAL NOT NULL,
            protein_per_100g REAL NOT NULL,
            food_category TEXT,
            default_serving_grams REAL
        );

        CREATE TABLE IF NOT EXISTS portion_yield_rules (
            phrase TEXT PRIMARY KEY,
            edible_ratio REAL NOT NULL,
            bone_in INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meal_log_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_iso TEXT NOT NULL,
            raw_text TEXT NOT NULL,
            llm_fallback INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'queued',
            error_detail TEXT,
            entry_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE SET NULL
        );
        """
    )
    _migrate_foods(conn)
    _migrate_food_baselines(conn)
    _migrate_entries(conn)
    _migrate_meal_log_jobs(conn)


def _seed_if_empty(conn: sqlite3.Connection) -> None:
    if SEED_FOODS:
        row = conn.execute("SELECT COUNT(*) AS c FROM foods").fetchone()
        if row and row["c"] == 0:
            conn.executemany(
                "INSERT INTO foods (name, kcal_per_100g, protein_per_100g) VALUES (?, ?, ?)",
                SEED_FOODS,
            )

    if not SEED_FOOD_BASELINES:
        return
    conn.executemany(
        """
        INSERT OR IGNORE INTO food_baselines (
            name, kcal_per_100g, protein_per_100g, food_category, default_serving_grams
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        SEED_FOOD_BASELINES,
    )
    for name, _kcal, _protein, category, serving in SEED_FOOD_BASELINES:
        conn.execute(
            """
            UPDATE food_baselines
            SET
                food_category = COALESCE(food_category, ?),
                default_serving_grams = COALESCE(default_serving_grams, ?)
            WHERE lower(name) = lower(?)
            """,
            (category, serving, name),
        )

    if SEED_PORTION_YIELD_RULES:
        conn.executemany(
            """
            INSERT OR IGNORE INTO portion_yield_rules (phrase, edible_ratio, bone_in)
            VALUES (lower(?), ?, ?)
            """,
            [(p, r, b) for p, r, b in SEED_PORTION_YIELD_RULES],
        )
        for phrase, ratio, bone in SEED_PORTION_YIELD_RULES:
            conn.execute(
                """
                UPDATE portion_yield_rules
                SET edible_ratio = ?, bone_in = ?
                WHERE lower(phrase) = lower(?)
                """,
                (ratio, bone, phrase),
            )


def find_food_by_name(conn: sqlite3.Connection, normalized_name: str) -> sqlite3.Row | None:
    cur = conn.execute(
        "SELECT * FROM foods WHERE lower(name) = ?",
        (normalized_name,),
    )
    return cur.fetchone()


def get_food_baseline(conn: sqlite3.Connection, normalized_name: str) -> sqlite3.Row | None:
    cur = conn.execute(
        "SELECT * FROM food_baselines WHERE lower(name) = ?",
        (normalized_name.strip().lower(),),
    )
    return cur.fetchone()


@contextmanager
def transaction():
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
