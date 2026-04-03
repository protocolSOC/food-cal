"""LLM meal-parse via OpenRouter; tests monkeypatch `parse_meal_with_llm`."""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

from app.debug_agent_log import agent_log
from app.food_types import FoodLookupResult

_JSON_FENCE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)


def _openrouter_http_error_message(response: httpx.Response) -> str:
    """Short, user-safe detail from OpenRouter error responses (no secrets)."""
    try:
        data = response.json()
    except ValueError:
        t = (response.text or "").strip()
        return t[:400] if t else response.reason_phrase
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:500]
        if isinstance(err, str):
            return err[:500]
    return str(data)[:400]

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_SYSTEM_PROMPT = """You parse meal descriptions into strict JSON only (no markdown, no prose).
Input may be in Hebrew, English, or other languages — understand semantics, respond in the same JSON shape.
Infer a realistic meal total from the description (e.g. "falafel" implies a typical portion, not 1 chickpea).
The user may give vague restaurant-style text. Respond with JSON matching this shape:
{
  "items": [ {"food": string, "grams": number } ],
  "estimate_type": "exact" | "estimated" | "range",
  "calories_likely": number,
  "calories_low": number,
  "calories_high": number,
  "total_protein_g": number
}
Use estimate_type "range" for restaurant or uncertain portions. calories_low/high bound plausible totals.
total_protein_g is your best estimate of total dietary protein for the whole meal in grams.
For a typical Israeli full serving (e.g. shawarma in laffa with fries inside), treat calories_likely as roughly 900–1300 kcal and total_protein_g around 40–60 unless the user clearly indicates a snack or half portion.
Include all JSON keys even if uncertain; guess grams, calories, and protein responsibly.
Reply with JSON only — no prose before or after the object."""

_SANITY_SYSTEM_PROMPT = """You are a nutrition sanity checker for a calorie app.
Given one food query, a candidate deterministic result, and an optional baseline reference,
return strict JSON only with this schema:
{
  "is_plausible": boolean,
  "confidence": number,
  "corrected_kcal_per_100g": number | null,
  "corrected_serving_grams": number | null,
  "reason": string
}
Rules:
- confidence is 0..1
- Prefer deterministic baseline-compatible corrections for obvious outliers
- If candidate seems plausible, set is_plausible=true and leave corrected_* as null
- Never include markdown/prose outside JSON
"""


@dataclass(frozen=True)
class FoodSanityVerdict:
    is_plausible: bool
    confidence: float
    corrected_kcal_per_100g: float | None
    corrected_serving_grams: float | None
    reason: str


def sanity_check_enabled() -> bool:
    return os.environ.get("LLM_SANITY_CHECK_ENABLED", "").lower() in ("1", "true", "yes")


def sanity_min_confidence() -> float:
    raw = os.environ.get("LLM_SANITY_MIN_CONFIDENCE", "0.8")
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return 0.8
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _sanity_optional_float(raw: Any) -> float | None:
    if raw is None:
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return v


def _parse_sanity_verdict(parsed: dict[str, Any]) -> FoodSanityVerdict:
    if not isinstance(parsed.get("is_plausible"), bool):
        raise ValueError("LLM sanity JSON missing boolean is_plausible")
    confidence_raw = parsed.get("confidence")
    try:
        confidence = float(confidence_raw)
    except (TypeError, ValueError) as e:
        raise ValueError(f"LLM sanity JSON confidence must be numeric, got {confidence_raw!r}") from e
    if not math.isfinite(confidence):
        raise ValueError("LLM sanity JSON confidence must be finite")
    if confidence < 0.0:
        confidence = 0.0
    if confidence > 1.0:
        confidence = 1.0
    return FoodSanityVerdict(
        is_plausible=bool(parsed["is_plausible"]),
        confidence=confidence,
        corrected_kcal_per_100g=_sanity_optional_float(parsed.get("corrected_kcal_per_100g")),
        corrected_serving_grams=_sanity_optional_float(parsed.get("corrected_serving_grams")),
        reason=str(parsed.get("reason") or "").strip(),
    )


async def validate_food_result_with_llm(
    query: str,
    candidate: FoodLookupResult,
    baseline: dict[str, Any] | None,
) -> FoodSanityVerdict:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set; cannot run LLM sanity check")
    model = os.environ.get("LLM_SANITY_MODEL", "openai/gpt-5-nano")
    referer = os.environ.get("OPENROUTER_HTTP_REFERER", "https://github.com/hybrid-calorie-app")
    app_name = os.environ.get("OPENROUTER_APP_NAME", "Hybrid Calorie App")
    max_tokens_raw = os.environ.get("LLM_SANITY_MAX_TOKENS", "400")
    try:
        max_tokens = int(max_tokens_raw)
    except ValueError:
        max_tokens = 400
    if max_tokens < 128:
        max_tokens = 128
    payload = {
        "query": query.strip().lower(),
        "candidate": {
            "kcal_per_100g": float(candidate.kcal_per_100g),
            "protein_per_100g": float(candidate.protein_per_100g),
            "default_serving_grams": candidate.default_serving_grams,
            "food_category": candidate.food_category,
        },
        "baseline": baseline,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": app_name,
    }
    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SANITY_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    try:
        async with httpx.AsyncClient(timeout=35.0) as client:
            r = await client.post(OPENROUTER_URL, headers=headers, json=body)
            r.raise_for_status()
    except httpx.HTTPStatusError as e:
        msg = _openrouter_http_error_message(e.response)
        raise RuntimeError(f"OpenRouter sanity HTTP {e.response.status_code}: {msg}") from e
    except httpx.RequestError as e:
        raise RuntimeError(f"OpenRouter sanity request failed: {e}") from e
    try:
        data = r.json()
        choice0 = data["choices"][0]
        message = choice0["message"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise ValueError("Unexpected OpenRouter sanity response shape") from e
    if not isinstance(message, dict):
        raise ValueError("Unexpected OpenRouter sanity message shape")
    text_out = _extract_llm_reply_text(message, choice0.get("finish_reason"))
    parsed = _parse_json_payload(text_out)
    verdict = _parse_sanity_verdict(parsed)
    agent_log(
        "llm.py:validate_food_result_with_llm",
        "sanity_returned",
        {"is_plausible": verdict.is_plausible, "confidence": verdict.confidence},
        "H6",
    )
    return verdict


def _assistant_text(content: Any) -> str:
    """OpenRouter / newer models may return string content or a list of parts."""
    if content is None:
        raise ValueError("Assistant message content is null")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if len(content) == 0:
            raise ValueError("Assistant message content is an empty list")
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                t = part.get("text")
                if isinstance(t, str):
                    parts.append(t)
        if parts:
            return "".join(parts)
        raise ValueError("Assistant message content list had no text parts")
    raise ValueError(f"Unsupported assistant content shape: {type(content)!r}")


def _extract_llm_reply_text(message: dict[str, Any], finish_reason: Any) -> str:
    """Recover parseable text from OpenRouter/OpenAI-shaped assistant messages."""
    content = message.get("content")
    trial: list[str] = []
    try:
        if content is not None and content != []:
            t = _assistant_text(content)
            if t.strip():
                trial.append(t)
    except ValueError:
        pass
    for key in ("reasoning", "reasoning_content"):
        chunk = message.get(key)
        if isinstance(chunk, str) and chunk.strip():
            trial.append(chunk.strip())
    for raw in trial:
        if raw.strip():
            return raw
    refusal = message.get("refusal")
    if isinstance(refusal, str) and refusal.strip():
        raise ValueError(f"Model refused to respond: {refusal}")
    raise ValueError(
        "OpenRouter returned no assistant text to parse as JSON. "
        "If your API key is not restricted to localhost, set OPENROUTER_HTTP_REFERER in .env "
        "to a real https URL (OpenRouter may omit message content otherwise). "
        "You can also try a different OPENROUTER_MODEL. "
        f"finish_reason={finish_reason!r}; message_keys={sorted(message.keys())!r}"
    )


def _first_json_object(raw: str) -> dict[str, Any] | None:
    """If the model emits reasoning then JSON, take the first balanced `{...}` that parses."""
    for i, ch in enumerate(raw):
        if ch != "{":
            continue
        depth = 0
        for j in range(i, len(raw)):
            if raw[j] == "{":
                depth += 1
            elif raw[j] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(raw[i : j + 1])
                    except json.JSONDecodeError:
                        break
                    break
    return None


def _parse_json_payload(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    m = _JSON_FENCE.search(raw)
    if m:
        raw = m.group(1).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                pass
        nested = _first_json_object(raw)
        if nested is not None:
            return nested
        raise ValueError(f"Model output is not valid JSON: {raw[:800]!r}")


async def parse_meal_with_llm(text: str) -> dict[str, Any]:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set; cannot parse vague meal without LLM")

    model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-5-mini")
    referer = os.environ.get("OPENROUTER_HTTP_REFERER", "https://github.com/hybrid-calorie-app")
    app_name = os.environ.get("OPENROUTER_APP_NAME", "Hybrid Calorie App")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": app_name,
    }
    # Completion budget (not input length). OpenRouter rejects the call if balance cannot cover *up to*
    # this many output tokens — even if the reply is short. Override OPENROUTER_MAX_TOKENS if low balance.
    max_tokens = int(os.environ.get("OPENROUTER_MAX_TOKENS", "3000"))
    if max_tokens < 256:
        max_tokens = 256

    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens,
        # OpenRouter/OpenAI-compatible: keep meal parses machine-readable (no reasoning-only prose).
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(OPENROUTER_URL, headers=headers, json=body)
            r.raise_for_status()
    except httpx.HTTPStatusError as e:
        msg = _openrouter_http_error_message(e.response)
        raise RuntimeError(
            f"OpenRouter HTTP {e.response.status_code}: {msg}. "
            "Check OPENROUTER_API_KEY, account credits, and OPENROUTER_MODEL."
        ) from e
    except httpx.RequestError as e:
        raise RuntimeError(f"OpenRouter request failed (network): {e}") from e

    # region agent log
    agent_log(
        "llm.py:parse_meal_with_llm",
        "http_ok",
        {"status_code": r.status_code},
        "H2",
    )
    # endregion
    try:
        data = r.json()
    except ValueError as e:
        raise ValueError(f"OpenRouter response is not valid JSON: {e}") from e

    try:
        choice0 = data["choices"][0]
        message = choice0["message"]
    except (KeyError, IndexError, TypeError) as e:
        raise ValueError(f"Unexpected OpenRouter response: {data!r}") from e
    if not isinstance(message, dict):
        raise ValueError(f"Unexpected OpenRouter message shape: {message!r}")

    text_out = _extract_llm_reply_text(message, choice0.get("finish_reason"))

    parsed = _parse_json_payload(text_out)

    for key in ("items", "calories_likely"):
        if key not in parsed:
            raise ValueError(f"LLM JSON missing required key: {key}")

    if parsed.get("calories_likely") is None:
        raise ValueError("LLM JSON must include a numeric calories_likely (not null)")
    try:
        cl = float(parsed["calories_likely"])
    except (TypeError, ValueError) as e:
        raise ValueError(
            f"LLM JSON calories_likely must be a number, got {parsed.get('calories_likely')!r}"
        ) from e
    if not math.isfinite(cl):
        raise ValueError("LLM JSON calories_likely must be a finite number")

    return parsed
