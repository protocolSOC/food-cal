import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeft, Calendar as CalendarIcon, Edit3, MessageSquare, Sparkles } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Calendar } from '../components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { ChatInput } from '../components/ChatInput';
import { ManualFoodInput, type ManualFoodFormData } from '../components/ManualFoodInput';
import { FoodEntry as FoodEntryCard } from '../components/FoodEntry';
import { PendingFoodEntryCard } from '../components/PendingFoodEntryCard';
import {
  getOfflineDayLog,
  addOfflineFoodEntry,
  deleteOfflineFoodEntry,
  parseFoodInput,
  formatDate,
  getTodayDate,
  formatLocaleDateMedium,
  dateFromIsoMiddayUtc,
  type FoodEntry,
} from '../utils/foodData';
import {
  logManualMealToBackend,
  fetchEntriesForDate,
  deleteEntryRemote,
  ApiError,
  readLlmFallbackPreference,
  writeLlmFallbackPreference,
  enqueueLogMealJob,
  getMealJobStatus,
  listActiveMealJobs,
  type MealJob,
} from '../utils/api';
import { toast } from 'sonner';

async function mergeDayEntriesForDate(
  ds: string,
): Promise<{ merged: FoodEntry[]; loadError: string | null }> {
  const offline = getOfflineDayLog(ds).entries;
  try {
    const { entries: apiRows } = await fetchEntriesForDate(ds);
    const merged: FoodEntry[] = apiRows.map((e) => ({
      id: String(e.id),
      date: ds,
      name: e.name,
      calories: e.calories,
      protein: e.protein,
      timestamp: e.timestamp,
      gramsTotal: e.grams_total ?? null,
      gramsPartial: e.grams_partial ?? false,
    }));
    return {
      merged: [...merged, ...offline].sort((a, b) => b.timestamp - a.timestamp),
      loadError: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      merged: [...offline].sort((a, b) => b.timestamp - a.timestamp),
      loadError: msg,
    };
  }
}

export default function DailyLog() {
  const { date } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState<Date>(() =>
    date ? dateFromIsoMiddayUtc(date) : new Date(),
  );

  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setSelectedDate(dateFromIsoMiddayUtc(date));
    }
  }, [date]);
  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  type PendingJob = {
    localId: string;
    jobId: number;
    preview: string;
    mode: 'chat' | 'manual';
    error?: string;
  };
  const [pendingJobs, setPendingJobs] = useState<PendingJob[]>([]);
  // Track active polling intervals keyed by localId so we can cancel on unmount.
  const pollRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const [showChat, setShowChat] = useState(false);
  const [inputMode, setInputMode] = useState<'chat' | 'manual'>('chat');
  const [llmFallback, setLlmFallback] = useState(() => readLlmFallbackPreference());

  const dateStr = formatDate(selectedDate);

  useEffect(() => {
    navigate(`/day/${dateStr}`, { replace: true });
  }, [dateStr, navigate]);

  const loadDayEntries = useCallback(
    async (opts?: { signal?: AbortSignal }) => {
      const ds = formatDate(selectedDate);
      const { merged, loadError: err } = await mergeDayEntriesForDate(ds);
      if (opts?.signal?.aborted) return;
      setEntries(merged);
      setLoadError(err);
    },
    [selectedDate],
  );

  useEffect(() => {
    const ac = new AbortController();
    void loadDayEntries({ signal: ac.signal });
    return () => ac.abort();
  }, [selectedDate, loadDayEntries]);

  // Clean up all polling intervals on unmount.
  useEffect(() => {
    const refs = pollRefs.current;
    return () => {
      refs.forEach((id) => clearInterval(id));
      refs.clear();
    };
  }, []);

  // Recover in-flight jobs when the user navigates to a date (e.g. browser refresh).
  useEffect(() => {
    const ds = formatDate(selectedDate);
    void listActiveMealJobs(ds).then((jobs) => {
      if (jobs.length === 0) return;
      const recovered: PendingJob[] = jobs.map((j: MealJob) => ({
        localId: `recovered-${j.job_id}`,
        jobId: j.job_id,
        preview: j.raw_text.slice(0, 80),
        mode: 'chat' as const,
      }));
      setPendingJobs((prev) => {
        const existingJobIds = new Set(prev.map((p) => p.jobId));
        const toAdd = recovered.filter((r) => !existingJobIds.has(r.jobId));
        if (toAdd.length === 0) return prev;
        toAdd.forEach((r) => startPolling(r.localId, r.jobId, ds));
        return [...prev, ...toAdd];
      });
    });
    // startPolling is stable (defined with useCallback below); disable exhaustive-deps here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const totals = useMemo(() => {
    const totalCalories = entries.reduce((sum, e) => sum + e.calories, 0);
    const totalProtein = entries.reduce((sum, e) => sum + e.protein, 0);
    return { totalCalories, totalProtein, count: entries.length };
  }, [entries]);

  // Start polling a job until it reaches a terminal state, then refresh entries.
  const startPolling = useCallback(
    (localId: string, jobId: number, ds: string) => {
      // Exponential backoff: start at 1s, cap at 4s.
      let interval = 1000;
      const tick = async () => {
        try {
          const job = await getMealJobStatus(jobId);
          if (job.status === 'done') {
            clearInterval(pollRefs.current.get(localId));
            pollRefs.current.delete(localId);
            setPendingJobs((prev) => prev.filter((p) => p.localId !== localId));
            await loadDayEntries({ signal: undefined });
            toast.success('Meal logged!');
          } else if (job.status === 'failed') {
            clearInterval(pollRefs.current.get(localId));
            pollRefs.current.delete(localId);
            const errMsg = job.error ?? 'Could not log meal';
            setPendingJobs((prev) =>
              prev.map((p) => (p.localId === localId ? { ...p, error: errMsg } : p)),
            );
            toast.error(errMsg);
            // Remove the failed card after 6s so the list doesn't stay cluttered.
            setTimeout(() => {
              setPendingJobs((prev) => prev.filter((p) => p.localId !== localId));
            }, 6000);
          }
          // Still queued/processing — back off gently.
          if (interval < 4000) interval = Math.min(interval * 1.5, 4000);
        } catch {
          // Network hiccup — keep polling.
        }
      };
      const id = setInterval(() => void tick(), interval);
      pollRefs.current.set(localId, id);
    },
    [loadDayEntries],
  );

  const handleChatSubmit = async (text: string) => {
    const ds = dateStr;
    const trimmed = text.trim();
    const preview = trimmed.slice(0, 80);

    try {
      const job = await enqueueLogMealJob(text, ds, llmFallback);
      const localId = `job-${job.job_id}-${Date.now()}`;
      setPendingJobs((prev) => [
        { localId, jobId: job.job_id, preview, mode: 'chat' },
        ...prev,
      ]);
      startPolling(localId, job.job_id, ds);
      setShowChat(false);
    } catch (e) {
      // Enqueue itself failed — API is unreachable; fall back to offline.
      if (e instanceof ApiError && e.status === 422) {
        toast.error(e.message);
        return;
      }
      const apiMessage = e instanceof Error ? e.message : String(e);
      const parsed = parseFoodInput(text);
      if (parsed && parsed.name) {
        addOfflineFoodEntry(ds, {
          name: parsed.name,
          calories: parsed.calories || 0,
          protein: parsed.protein || 0,
        });
        await loadDayEntries();
        toast.success(`Added ${parsed.name}! (saved in this browser only — not in the database)`);
        if (apiMessage) toast.info(`API unavailable: ${apiMessage}`);
        setShowChat(false);
      } else {
        toast.error(
          apiMessage ||
            "Couldn't log that meal. Start the API and ensure .env in the project root has OPENROUTER_API_KEY for vague foods. Try e.g. 200g chicken breast.",
        );
      }
    }
  };

  const handleManualSubmit = async (data: ManualFoodFormData) => {
    const ds = dateStr;
    const preview = data.name.trim().slice(0, 80);
    const localId = `manual-${Date.now()}`;
    setPendingJobs((prev) => [{ localId, jobId: -1, preview, mode: 'manual' }, ...prev]);
    try {
      await logManualMealToBackend(ds, data);
      await loadDayEntries();
      toast.success('Food entry added!');
      setShowChat(false);
    } catch (e) {
      if (e instanceof ApiError) {
        toast.error(e.message);
      } else {
        toast.error(e instanceof Error ? e.message : 'Could not add entry');
      }
    } finally {
      setPendingJobs((prev) => prev.filter((p) => p.localId !== localId));
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    if (entryId.startsWith('offline-')) {
      deleteOfflineFoodEntry(dateStr, entryId);
      await loadDayEntries();
      toast.success('Entry deleted');
      return;
    }
    const id = parseInt(entryId, 10);
    if (Number.isNaN(id)) {
      toast.error('Invalid entry');
      return;
    }
    try {
      await deleteEntryRemote(id);
      await loadDayEntries();
      toast.success('Entry deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete entry');
    }
  };

  const isToday = dateStr === getTodayDate();

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="size-5" />
          </Button>

          <div className="flex-1">
            <h1 className="text-2xl font-bold">
              {isToday ? "Today's Log" : 'Daily Log'}
            </h1>
            <p className="text-sm text-muted-foreground">{formatLocaleDateMedium(selectedDate)}</p>
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon">
                <CalendarIcon className="size-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(d) => d && setSelectedDate(d)}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        </div>

        {loadError && (
          <p className="text-sm text-amber-700 mb-4 rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
            Could not load meals from the server ({loadError}). Showing offline-only entries if any.
          </p>
        )}

        <Card className="mb-6 bg-white/80 backdrop-blur">
          <CardContent className="p-6">
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center">
                <div className="text-3xl font-bold text-orange-600">{totals.totalCalories}</div>
                <div className="text-sm text-muted-foreground">Total Calories</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-blue-600">{totals.totalProtein}g</div>
                <div className="text-sm text-muted-foreground">Total Protein</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-green-600">{totals.count}</div>
                <div className="text-sm text-muted-foreground">Meals Logged</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {showChat ? (
          <Tabs
            value={inputMode}
            onValueChange={(v) => setInputMode(v as 'chat' | 'manual')}
            className="relative z-10 mb-6"
          >
            <Card className="bg-white/80 backdrop-blur">
              <CardHeader>
                <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {inputMode === 'chat' ? (
                        <MessageSquare className="size-5" />
                      ) : (
                        <Edit3 className="size-5" />
                      )}
                      Add Food
                    </CardTitle>
                    <CardDescription>
                      {inputMode === 'chat'
                        ? 'Type or speak what you ate (e.g., chicken breast, banana, oatmeal)'
                        : 'Enter food details manually'}
                    </CardDescription>
                  </div>
                  {inputMode === 'chat' && (
                    <div className="flex shrink-0 items-center gap-2 rounded-lg border border-purple-200 bg-gradient-to-r from-purple-50 to-blue-50 px-3 py-2 dark:border-purple-900/50 dark:from-purple-950/40 dark:to-blue-950/40">
                      <Sparkles
                        className={`size-4 shrink-0 ${llmFallback ? 'text-purple-600 dark:text-purple-400' : 'text-muted-foreground'}`}
                        aria-hidden
                      />
                      <Label htmlFor="llm-toggle" className="cursor-pointer text-xs font-medium">
                        AI Assist
                      </Label>
                      <Switch
                        id="llm-toggle"
                        checked={llmFallback}
                        onCheckedChange={(checked) => {
                          setLlmFallback(checked);
                          writeLlmFallbackPreference(checked);
                        }}
                      />
                    </div>
                  )}
                </div>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="chat" className="gap-2">
                    <MessageSquare className="size-4" />
                    Chat Mode
                  </TabsTrigger>
                  <TabsTrigger value="manual" className="gap-2">
                    <Edit3 className="size-4" />
                    Manual Input
                  </TabsTrigger>
                </TabsList>
              </CardHeader>
              <CardContent>
                <TabsContent value="chat" className="mt-0">
                  <ChatInput
                    onSubmit={handleChatSubmit}
                    onSubmitPreset={(p) =>
                      handleManualSubmit({
                        name: p.name,
                        grams: p.grams,
                        protein: p.protein,
                        calories: p.calories,
                      })
                    }
                  />
                </TabsContent>
                <TabsContent value="manual" className="mt-0">
                  <ManualFoodInput onSubmit={handleManualSubmit} />
                </TabsContent>
                <Button variant="ghost" className="mt-4 w-full" onClick={() => setShowChat(false)}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          </Tabs>
        ) : (
          <div className="mb-6 space-y-1">
            <Button className="h-14 w-full text-lg" onClick={() => setShowChat(true)}>
              <MessageSquare className="mr-2 size-5" />
              Add food
            </Button>
            <p className="text-center text-xs text-muted-foreground">Chat or manual entry</p>
          </div>
        )}

        <div className="space-y-3">
          {pendingJobs.map((job) => (
            <PendingFoodEntryCard
              key={job.localId}
              mode={job.mode}
              preview={job.preview}
              error={job.error}
            />
          ))}
          {entries.length === 0 && pendingJobs.length === 0 ? (
            <Card className="bg-white/60 backdrop-blur">
              <CardContent className="p-12 text-center">
                <p className="text-muted-foreground">No meals logged for this day yet.</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Tap Add food, then choose chat mode or manual input.
                </p>
              </CardContent>
            </Card>
          ) : entries.length > 0 ? (
            entries.map((entry) => (
              <FoodEntryCard key={entry.id} entry={entry} onDelete={handleDeleteEntry} />
            ))
          ) : null}
        </div>
      </div>
    </div>
  );
}
