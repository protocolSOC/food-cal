function lastCommaSegment(value: string): string {
  const lastComma = value.lastIndexOf(',');
  return lastComma === -1 ? value : value.slice(lastComma + 1);
}

/** Last comma-separated segment, then last whitespace token — min length 1 to query. */
export function activeSearchQuery(value: string): string | null {
  const segment = lastCommaSegment(value);
  const m = segment.match(/(\S+)$/);
  if (!m) return null;
  const q = m[1];
  return q.length >= 1 ? q : null;
}

export type PresetSuggestionMode =
  | { kind: 'browse' }
  | { kind: 'filter'; q: string; requiredWords: string[] };

function segmentTokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter((t) => t.length > 0);
}

function filterModeFromTokens(tokens: string[]): PresetSuggestionMode {
  if (tokens.length === 0) return { kind: 'browse' };
  const q = tokens[tokens.length - 1]!;
  const requiredWords = tokens.length > 1 ? tokens.slice(0, -1) : [];
  return { kind: 'filter', q, requiredWords };
}

/**
 * Preset list behavior: "browse" only when the active segment is empty.
 * When the cursor is after a space (no trailing token), filter by the last completed word
 * — e.g. "D " uses "D", not the full saved list.
 * When there are several words (e.g. "לאפה ש"), every word before the last must appear in the
 * preset name so we do not match only on the final partial token ("ש" → שמן).
 */
export function getPresetSuggestionMode(value: string): PresetSuggestionMode {
  const segment = lastCommaSegment(value);
  if (segment.trim() === '') {
    return { kind: 'browse' };
  }
  const active = activeSearchQuery(value);
  if (active !== null) {
    return filterModeFromTokens(segmentTokens(segment));
  }
  const trimmedEnd = segment.trimEnd();
  const m = trimmedEnd.match(/(\S+)$/);
  if (m && m[1].length >= 1) {
    return filterModeFromTokens(segmentTokens(trimmedEnd));
  }
  return { kind: 'browse' };
}

/** For USDA hints: non-null when there is a filter query (active or last completed word). */
export function effectiveSearchQuery(value: string): string | null {
  const mode = getPresetSuggestionMode(value);
  return mode.kind === 'filter' ? mode.q : null;
}

/** Replace the last token in the last segment with `replacement`. */
export function replaceActiveToken(value: string, replacement: string): string {
  const lastComma = value.lastIndexOf(',');
  const prefix = lastComma === -1 ? '' : value.slice(0, lastComma + 1);
  const segment = lastComma === -1 ? value : value.slice(lastComma + 1);
  const m = segment.match(/^(.*?)(\S+)$/);
  if (!m) return prefix + replacement;
  return prefix + m[1] + replacement;
}
