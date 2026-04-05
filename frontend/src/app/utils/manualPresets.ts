/** Browser-local saved manual entry presets (not synced to the server). */

const STORAGE_KEY = 'foodcal-manual-presets';
/** Max presets stored and max rows shown in browse-all dropdown. */
export const MAX_PRESETS = 100;

export type ManualFoodPreset = {
  id: string;
  name: string;
  grams: number;
  protein: number;
  calories: number;
  savedAt: number;
};

function presetSignature(p: Pick<ManualFoodPreset, 'name' | 'grams' | 'protein' | 'calories'>): string {
  const n = p.name.trim().toLowerCase();
  return `${n}|${p.grams}|${p.protein}|${p.calories}`;
}

function readRaw(): ManualFoodPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isManualFoodPreset);
  } catch {
    return [];
  }
}

function isManualFoodPreset(x: unknown): x is ManualFoodPreset {
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.grams === 'number' &&
    typeof o.protein === 'number' &&
    typeof o.calories === 'number' &&
    typeof o.savedAt === 'number'
  );
}

function writeAll(list: ManualFoodPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Match presets whose name contains `q` (case-insensitive). When `requiredWords` is set, each
 * word must also appear in the name — so "לאפה ש" requires "לאפה" in the name, not only "ש".
 * Newest first.
 */
export function matchManualPresets(q: string, limit: number, requiredWords: string[] = []): ManualFoodPreset[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 1) return [];
  const reqs = requiredWords.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
  const list = readRaw()
    .filter((p) => {
      const name = p.name.toLowerCase();
      if (!reqs.every((rw) => name.includes(rw))) return false;
      return name.includes(needle);
    })
    .sort((a, b) => b.savedAt - a.savedAt);
  return list.slice(0, Math.max(0, limit));
}

/** All saved presets (newest first), for browse-on-focus UI. */
export function listAllManualPresets(limit: number): ManualFoodPreset[] {
  return readRaw()
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, Math.max(0, limit));
}

export type SavePresetResult = { ok: true; updated: boolean } | { ok: false; reason: 'invalid' };

/**
 * Saves or updates a preset with the same macro signature. Drops oldest when over cap.
 */
export function saveManualPreset(data: {
  name: string;
  grams: number;
  protein: number;
  calories: number;
}): SavePresetResult {
  const name = data.name.trim();
  if (!name) return { ok: false, reason: 'invalid' };

  const sig = presetSignature({
    name,
    grams: data.grams,
    protein: data.protein,
    calories: data.calories,
  });

  let list = readRaw();
  const existingIdx = list.findIndex((p) => presetSignature(p) === sig);

  const now = Date.now();
  if (existingIdx >= 0) {
    const cur = list[existingIdx]!;
    list[existingIdx] = { ...cur, savedAt: now };
    writeAll(list);
    return { ok: true, updated: true };
  }

  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `preset-${now}-${Math.random().toString(36).slice(2, 9)}`;

  const next: ManualFoodPreset = {
    id,
    name,
    grams: data.grams,
    protein: data.protein,
    calories: data.calories,
    savedAt: now,
  };

  list = [next, ...list.filter((p) => p.id !== id)];
  if (list.length > MAX_PRESETS) {
    list = list.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_PRESETS);
  }
  writeAll(list);
  return { ok: true, updated: false };
}

/** Removes a preset by id. Returns whether an entry was removed. */
export function deleteManualPreset(id: string): boolean {
  const list = readRaw();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  writeAll(next);
  return true;
}
