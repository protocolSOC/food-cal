import { useState, useEffect, useMemo, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, Calendar, ChevronRight, Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import {
  addCalendarDaysIso,
  dateFromIsoMiddayUtc,
  formatLocaleDateMedium,
  getOfflineLogs,
  getOfflineDayLog,
  getTodayDate,
  replaceOfflineLogs,
  type DayLog,
} from '../utils/foodData';
import {
  fetchBackupExport,
  fetchEntryRollups,
  postBackupImport,
  type BackupImportMode,
  type RollupDay,
} from '../utils/api';

const HISTORY_WINDOW_DAYS = 365;

type HistoryRow = {
  date: string;
  totalCalories: number;
  totalProtein: number;
  meals: number;
};

function calendarDaysBetweenEarlierAndLater(earlierIso: string, laterIso: string): number {
  const a = dateFromIsoMiddayUtc(earlierIso).getTime();
  const b = dateFromIsoMiddayUtc(laterIso).getTime();
  return Math.round((b - a) / 86_400_000);
}

function relativeDayBadge(iso: string): string {
  const today = getTodayDate();
  const daysAgo = calendarDaysBetweenEarlierAndLater(iso, today);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo >= 2 && daysAgo < 7) return `${daysAgo} days ago`;
  return '';
}

function buildHistoryRows(
  rollups: RollupDay[],
  offlineByDate: ReturnType<typeof getOfflineLogs>,
  start: string,
  end: string,
): HistoryRow[] {
  const rollupMap = new Map(rollups.map((r) => [r.date, r]));
  const dateSet = new Set<string>();
  for (const r of rollups) {
    if (r.date >= start && r.date <= end) dateSet.add(r.date);
  }
  for (const d of Object.keys(offlineByDate)) {
    if (d >= start && d <= end) dateSet.add(d);
  }

  const rows: HistoryRow[] = [];
  for (const date of dateSet) {
    const r = rollupMap.get(date);
    const off = getOfflineDayLog(date);
    const totalCalories = Math.round((r?.total_calories ?? 0) + off.totalCalories);
    const totalProtein = Math.round((r?.total_protein_g ?? 0) + off.totalProtein);
    const meals = (r?.meals ?? 0) + off.entries.length;
    if (meals > 0) {
      rows.push({ date, totalCalories, totalProtein, meals });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows;
}

function isBackupShape(x: unknown): x is { format: string; version: number; entries: unknown[] } {
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return o.format === 'foodcal-backup' && o.version === 1 && Array.isArray(o.entries);
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function History() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const importModeRef = useRef<BackupImportMode>('append');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { start, end } = useMemo(() => {
    const e = getTodayDate();
    const s = addCalendarDaysIso(e, -(HISTORY_WINDOW_DAYS - 1));
    return { start: s, end: e };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const offlineByDate = getOfflineLogs();
      try {
        const { days: rollups } = await fetchEntryRollups(start, end);
        if (!cancelled) {
          setRows(buildHistoryRows(rollups, offlineByDate, start, end));
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setRows(buildHistoryRows([], offlineByDate, start, end));
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [start, end, refreshTick]);

  function openImportPicker(mode: BackupImportMode) {
    importModeRef.current = mode;
    fileInputRef.current?.click();
  }

  async function handleExportBackup() {
    try {
      const server = await fetchBackupExport();
      const merged = {
        ...server,
        offline: getOfflineLogs(),
        client_merged_at: new Date().toISOString(),
      };
      downloadJson(`foodcal-backup-${getTodayDate()}.json`, merged);
      toast.success('Backup downloaded (server history and offline-only meals in this browser).');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onBackupFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const mode = importModeRef.current;

    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (!isBackupShape(parsed)) {
        toast.error('Not a valid foodcal backup (expected format foodcal-backup, version 1).');
        return;
      }
      const record = parsed as Record<string, unknown>;

      if (mode === 'replace') {
        const ok = window.confirm(
          'Replace mode deletes every meal stored on the server, then imports this file. This cannot be undone. Continue?',
        );
        if (!ok) return;
      }

      let applyOffline = false;
      if (record.offline !== undefined && record.offline !== null) {
        applyOffline = window.confirm(
          'This file includes offline-only meals from another session or browser. Replace the offline-only data stored in this browser?',
        );
      }

      await postBackupImport({
        format: 'foodcal-backup',
        version: 1,
        entries: record.entries as unknown[],
        mode,
        exported_at: typeof record.exported_at === 'string' ? record.exported_at : null,
      });

      if (applyOffline && record.offline !== null && typeof record.offline === 'object') {
        replaceOfflineLogs(record.offline as Record<string, DayLog>);
      }

      toast.success(
        mode === 'append'
          ? 'Import complete. Importing the same file again will duplicate server meals.'
          : 'Import complete. Server history was replaced from the file.',
      );
      setRefreshTick((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-col gap-4 mb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
                <ArrowLeft className="size-5" />
              </Button>

              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold">History</h1>
                <p className="text-sm text-muted-foreground">View all your logged days (including today)</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center sm:justify-end">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleExportBackup()}>
                <Download className="size-3.5" />
                Export backup
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openImportPicker('append')}>
                <Upload className="size-3.5" />
                Import (append)
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => openImportPicker('replace')}
              >
                <Upload className="size-3.5" />
                Import (replace server)
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-hidden
                onChange={onBackupFileSelected}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground pl-0 sm:pl-14 max-w-2xl">
            Back up includes all dates stored on the server plus offline-only entries saved in this browser. Use append to add
            meals; replace clears the server first, then restores from the file.
          </p>
        </div>

        {loadError && (
          <p className="text-sm text-amber-700 mb-4 rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
            Could not load history from the server ({loadError}). Showing offline-only days if any.
          </p>
        )}

        <div className="space-y-3">
          {rows.length === 0 ? (
            <Card className="bg-white/60 backdrop-blur">
              <CardContent className="p-12 text-center">
                <Calendar className="size-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground">No days logged yet.</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Start tracking your meals to see your history!
                </p>
              </CardContent>
            </Card>
          ) : (
            rows.map((log) => {
              const badge = relativeDayBadge(log.date);
              return (
                <Card
                  key={log.date}
                  className="bg-white/80 backdrop-blur cursor-pointer hover:shadow-lg transition-all hover:-translate-y-0.5"
                  onClick={() => navigate(`/day/${log.date}`)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-semibold">{formatLocaleDateMedium(log.date)}</h3>
                          {badge ? (
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                              {badge}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {log.meals} meal{log.meals !== 1 ? 's' : ''} logged
                        </p>

                        <div className="flex gap-6 mt-3">
                          <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground">Calories</span>
                            <span className="text-lg font-semibold text-orange-600">{log.totalCalories}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground">Protein</span>
                            <span className="text-lg font-semibold text-blue-600">{log.totalProtein}g</span>
                          </div>
                        </div>
                      </div>

                      <ChevronRight className="size-5 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
