/** Call FastAPI backend (hybrid DB + LLM). */

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

export async function logMealToBackend(text: string, date: string): Promise<LogMealResponse> {
  const base = getApiBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/log-meal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), date }),
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
    throw new Error(formatApiError(res.status, errText));
  }
  return res.json() as Promise<LogMealResponse>;
}

export type ApiEntryRow = {
  id: number;
  name: string;
  calories: number;
  protein: number;
  timestamp: number;
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
};

/** USDA FDC search suggestions for meal input; returns [] on error (no throw). */
export async function fetchFoodSuggestions(q: string, limit = 12): Promise<string[]> {
  const base = getApiBaseUrl();
  const params = new URLSearchParams({ q, limit: String(limit) });
  try {
    const res = await fetch(`${base}/food-suggest?${params}`);
    if (!res.ok) return [];
    const data = (await res.json()) as FoodSuggestResponse;
    return Array.isArray(data.suggestions) ? data.suggestions : [];
  } catch {
    return [];
  }
}
