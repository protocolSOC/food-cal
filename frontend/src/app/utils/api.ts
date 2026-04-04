/** Call FastAPI backend (hybrid DB + LLM). */

const LLM_FALLBACK_STORAGE_KEY = 'foodcal-llm-fallback';

export function readLlmFallbackPreference(): boolean {
  try {
    const v = localStorage.getItem(LLM_FALLBACK_STORAGE_KEY);
    if (v === null) return true;
    return v === '1' || v === 'true';
  } catch {
    return true;
  }
}

export function writeLlmFallbackPreference(enabled: boolean): void {
  try {
    localStorage.setItem(LLM_FALLBACK_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type LogMealItem = {
  label: string;
  grams?: number;
  calories?: number;
};

export type LogMealResponse = {
  total_calories: number;
  total_protein_g?: number;
  items: LogMealItem[];
  estimate_type?: string;
  calories_likely?: number;
  calories_low?: number;
  calories_high?: number;
};

export function getApiBaseUrl(): string {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (typeof v === 'string' && v.length > 0) {
    return v.replace(/\/$/, '');
  }
  // Dev: use relative URLs so Vite proxies to FastAPI (see vite.config.ts server.proxy).
  if (import.meta.env.DEV) {
    return '';
  }
  return 'http://127.0.0.1:8000';
}

function formatApiError(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as { detail?: string | Array<{ msg?: string }> };
    if (typeof j.detail === 'string') return j.detail;
    if (Array.isArray(j.detail) && j.detail[0]?.msg) return String(j.detail[0].msg);
  } catch {
    /* not JSON */
  }
  if (body.length > 0 && body.length < 400) return body;
  return `${status} ${status === 503 ? 'Service unavailable' : 'Request failed'}`;
}

export async function logMealToBackend(
  text: string,
  date: string,
  llmFallback = true,
): Promise<LogMealResponse> {
  const base = getApiBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/log-meal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), date, llm_fallback: llmFallback }),
    });
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? `Cannot reach API at ${base}. Start from the project folder: python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
        : String(e);
    throw new Error(msg);
  }
  if (!res.ok) {
    const errText = await res.text();
    // #region agent log
    fetch('http://127.0.0.1:7473/ingest/4471e92a-deb6-43c4-9671-85467c465a8c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'fcca48'},body:JSON.stringify({sessionId:'fcca48',location:'api.ts:logMealToBackend',message:'log-meal non-OK',data:{status:res.status,bodyPreview:errText.slice(0,400)},timestamp:Date.now(),hypothesisId:'H3',runId:'pre'})}).catch(()=>{});
    // #endregion
    throw new ApiError(formatApiError(res.status, errText), res.status);
  }
  return res.json() as Promise<LogMealResponse>;
}

export type ManualMealPayload = {
  name: string;
  grams: number;
  calories: number;
  protein: number;
};

export async function logManualMealToBackend(
  date: string,
  payload: ManualMealPayload,
): Promise<LogMealResponse> {
  const base = getApiBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/log-meal-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date,
        name: payload.name.trim(),
        grams: payload.grams,
        calories: payload.calories,
        protein: payload.protein,
      }),
    });
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? `Cannot reach API at ${base}. Start from the project folder: python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
        : String(e);
    throw new Error(msg);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new ApiError(formatApiError(res.status, errText), res.status);
  }
  return res.json() as Promise<LogMealResponse>;
}

export type ApiEntryRow = {
  id: number;
  name: string;
  calories: number;
  protein: number;
  timestamp: number;
  /** Sum of non-null line-item grams; omitted or null if every item has no grams. */
  grams_total?: number | null;
  /** True when some items have grams and some do not (total is incomplete). */
  grams_partial?: boolean;
};

export type EntriesResponse = {
  entries: ApiEntryRow[];
};

export async function fetchEntriesForDate(date: string): Promise<EntriesResponse> {
  const base = getApiBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/entries?date=${encodeURIComponent(date)}`);
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? `Cannot reach API at ${base}. Start the backend (e.g. uvicorn app.main:app).`
        : String(e);
    throw new Error(msg);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(formatApiError(res.status, errText));
  }
  return res.json() as Promise<EntriesResponse>;
}

export async function deleteEntryRemote(entryId: number): Promise<void> {
  const base = getApiBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/entries/${entryId}`, { method: 'DELETE' });
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? `Cannot reach API at ${base}.`
        : String(e);
    throw new Error(msg);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(formatApiError(res.status, errText));
  }
}

export type RollupDay = {
  date: string;
  total_calories: number;
  meals: number;
  total_protein_g?: number;
};

export type EntryRollupsResponse = {
  days: RollupDay[];
};

export async function fetchEntryRollups(start: string, end: string): Promise<EntryRollupsResponse> {
  const base = getApiBaseUrl();
  const q = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  let res: Response;
  try {
    res = await fetch(`${base}/entries-rollups?${q}`);
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? `Cannot reach API at ${base}.`
        : String(e);
    throw new Error(msg);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(formatApiError(res.status, errText));
  }
  return res.json() as Promise<EntryRollupsResponse>;
}

export type FoodSuggestResponse = {
  suggestions: string[];
  usda_enabled: boolean;
};

export type FoodSuggestResult = {
  suggestions: string[];
  usdaEnabled: boolean;
};

/** USDA FDC search suggestions for meal input; returns [] on error (no throw). */
export async function fetchFoodSuggestions(q: string, limit = 12): Promise<FoodSuggestResult> {
  const base = getApiBaseUrl();
  const params = new URLSearchParams({ q, limit: String(limit) });
  try {
    const res = await fetch(`${base}/food-suggest?${params}`);
    if (!res.ok) {
      return { suggestions: [], usdaEnabled: true };
    }
    const data = (await res.json()) as FoodSuggestResponse;
    return {
      suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
      usdaEnabled: Boolean(data.usda_enabled),
    };
  } catch {
    return { suggestions: [], usdaEnabled: true };
  }
}

export type BackupServerPayload = {
  format: 'foodcal-backup';
  version: 1;
  exported_at: string;
  entries: unknown[];
};

export type BackupImportMode = 'append' | 'replace';

export type BackupImportResult = {
  status: string;
  mode: string;
  inserted_entries: number;
  inserted_items: number;
};

export async function fetchBackupExport(): Promise<BackupServerPayload> {
  const base = getApiBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/backup/export`);
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? `Cannot reach API at ${base}. Start the backend (e.g. uvicorn app.main:app).`
        : String(e);
    throw new Error(msg);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(formatApiError(res.status, errText));
  }
  return res.json() as Promise<BackupServerPayload>;
}

export async function postBackupImport(
  payload: {
    format: 'foodcal-backup';
    version: 1;
    entries: unknown[];
    mode: BackupImportMode;
    exported_at?: string | null;
  },
): Promise<BackupImportResult> {
  const base = getApiBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? `Cannot reach API at ${base}.`
        : String(e);
    throw new Error(msg);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(formatApiError(res.status, errText));
  }
  return res.json() as Promise<BackupImportResult>;
}
