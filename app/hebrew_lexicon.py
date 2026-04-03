"""Hebrew food phrases → English canonical name for DB lookup (avoids LLM for simple logs).

Structured lines like `100 גרם תפוח` still use user-provided grams via parse_local. Bare Hebrew/English
uses `foods` row (from USDA/OFF) and `food_servings.bare_serving_grams` for bare portions.
"""

from __future__ import annotations

import re
import unicodedata

# Extend freely; longest multi-word keys should appear before shorter keys sharing words (dict order; bare lookup is exact key only).
HEBREW_TO_ENGLISH_FOOD_QUERY: dict[str, str] = {
    "פילה סלמון": "salmon",
    "סלמון": "salmon",
    "תפוח עץ": "apple",
    "תפוח": "apple",
    "בננה": "banana",
    "אורז": "rice",
    "אורז מבושל": "rice cooked",
    "לחם": "bread",
    "חלב": "milk",
    "ביצה": "egg",
    "עגבנייה": "tomato",
    "מלפפון": "cucumber",
    "גזר": "carrot",
    "עוף": "chicken breast",
    "חזה עוף": "chicken breast",
    "טונה": "tuna",
    "גבינה": "cheese",
    "יוגורט": "yogurt",
    "שיבולת שועל": "oats",
    "פסטה": "pasta",
    "תפוח אדמה": "potato",
    "בטטה": "sweet potato",
}

_LATIN = re.compile(r"[A-Za-z]")
_COUNTED_LATIN_BARE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z\-]*)\s*$")


def normalize_food_input(text: str) -> str:
    """NFC, strip formatting controls, collapse whitespace — for reliable Hebrew dict matches."""
    t = unicodedata.normalize("NFC", (text or "").strip())
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Cf")
    return " ".join(t.split())


def english_food_query_for_hebrew_bare(text: str) -> str | None:
    """If `text` is exactly one known Hebrew food phrase (no Latin), return English search name; else None."""
    t = normalize_food_input(text)
    if not t:
        return None
    if _LATIN.search(t):
        return None
    return HEBREW_TO_ENGLISH_FOOD_QUERY.get(t)


def english_bare_query_name(text: str) -> str | None:
    """Single-token Latin input (e.g. `apple`) → lowercase canonical query for `foods` / OFF. Minimum 2 chars."""
    t = normalize_food_input(text)
    if len(t) < 2 or " " in t:
        return None
    if not _LATIN.search(t):
        return None
    return t.lower()


def _singular_candidates(word: str) -> list[str]:
    w = word.strip().lower()
    out: list[str] = []
    if len(w) > 3 and w.endswith("ies"):
        out.append(w[:-3] + "y")
    if len(w) > 3 and w.endswith("es"):
        out.append(w[:-2])
    if len(w) > 2 and w.endswith("s"):
        out.append(w[:-1])
    out.append(w)
    seen: set[str] = set()
    uniq: list[str] = []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def english_counted_bare_query(text: str) -> tuple[float, list[str]] | None:
    """Parse `2 bananas` style input into count + normalized query candidates.

    Returns (count, [candidate_names]) where candidates include simple plural-normalized
    forms (e.g. bananas -> banana). Returns None for non-matching shapes.
    """
    t = normalize_food_input(text)
    m = _COUNTED_LATIN_BARE.match(t)
    if m is None:
        return None
    count = float(m.group(1))
    if count <= 0:
        return None
    token = m.group(2).lower()
    return (count, _singular_candidates(token))
