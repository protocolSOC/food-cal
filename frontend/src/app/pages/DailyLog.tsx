import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeft, Calendar as CalendarIcon, Edit3, MessageSquare, Sparkles, Flame, Dumbbell, Utensils, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
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
  getOfflineDayLog, addOfflineFoodEntry, deleteOfflineFoodEntry,
  parseFoodInput, formatDate, getTodayDate, formatLocaleDateMedium,
  dateFromIsoMiddayUtc, type FoodEntry,
} from '../utils/foodData';
import {
  logMealToBackend, logManualMealToBackend, fetchEntriesForDate,
  deleteEntryRemote, ApiError, readLlmFallbackPreference, writeLlmFallbackPreference,
} from '../utils/api';
import { toast } from 'sonner';

async function mergeDayEntriesForDate(ds: string): Promise<{ merged: FoodEntry[]; loadError: string | null }> {
  const offline = getOfflineDayLog(ds).entries;
  try {
    const { entries: apiRows } = await fetchEntriesForDate(ds);
    const merged: FoodEntry[] = apiRows.map((e) => ({
      id: String(e.id), date: ds, name: e.name, calories: e.calories, protein: e.protein,
      timestamp: e.timestamp, gramsTotal: e.grams_total ?? null, gramsPartial: e.grams_partial ?? false,
    }));
    return { merged: [...merged, ...offline].sort((a, b) => b.timestamp - a.timestamp), loadError: null };
  } catch (e) {
    return { merged: [...offline].sort((a, b) => b.timestamp - a.timestamp), loadError: e instanceof Error ? e.message : String(e) };
  }
}

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { type: 'spring' as const, stiffness: 320, damping: 28, delay },
});

export default function DailyLog() {
  const { date } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState<Date>(() => date ? dateFromIsoMiddayUtc(date) : new Date());

  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setSelectedDate(dateFromIsoMiddayUtc(date));
  }, [date]);

  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingEntry, setPendingEntry] = useState<{ mode: 'chat' | 'manual'; preview?: string } | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [inputMode, setInputMode] = useState<'chat' | 'manual'>('chat');
  const [llmFallback, setLlmFallback] = useState(() => readLlmFallbackPreference());
  const dateStr = formatDate(selectedDate);

  useEffect(() => { navigate(`/day/${dateStr}`, { replace: true }); }, [dateStr, navigate]);

  const loadDayEntries = useCallback(async (opts?: { signal?: AbortSignal }) => {
    const ds = formatDate(selectedDate);
    const { merged, loadError: err } = await mergeDayEntriesForDate(ds);
    if (opts?.signal?.aborted) return;
    setEntries(merged);
    setLoadError(err);
  }, [selectedDate]);

  useEffect(() => {
    const ac = new AbortController();
    void loadDayEntries({ signal: ac.signal });
    return () => ac.abort();
  }, [selectedDate, loadDayEntries]);

  const totals = useMemo(() => ({
    totalCalories: entries.reduce((sum, e) => sum + e.calories, 0),
    totalProtein: entries.reduce((sum, e) => sum + e.protein, 0),
    count: entries.length,
  }), [entries]);

  const handleChatSubmit = async (text: string) => {
    const ds = dateStr;
    setPendingEntry({ mode: 'chat', preview: text.trim().slice(0, 80) || undefined });
    try {
      let apiMessage: string | null = null;
      try {
        await logMealToBackend(text, ds, llmFallback);
        await loadDayEntries(); toast.success('Meal logged!'); setShowChat(false); return;
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) { toast.error(e.message); return; }
        apiMessage = e instanceof Error ? e.message : String(e);
      }
      const parsed = parseFoodInput(text);
      if (parsed?.name) {
        addOfflineFoodEntry(ds, { name: parsed.name, calories: parsed.calories || 0, protein: parsed.protein || 0 });
        await loadDayEntries();
        toast.success(`Added ${parsed.name}! (saved offline only)`);
        if (apiMessage) toast.info(`API unavailable: ${apiMessage}`);
        setShowChat(false);
      } else {
        toast.error(apiMessage || "Couldn't log that meal. Try e.g. 200g chicken breast.");
      }
    } finally { setPendingEntry(null); }
  };

  const handleManualSubmit = async (data: ManualFoodFormData) => {
    const ds = dateStr;
    setPendingEntry({ mode: 'manual', preview: data.name.trim().slice(0, 80) || undefined });
    try {
      try {
        await logManualMealToBackend(ds, data);
        await loadDayEntries(); toast.success('Food entry added!'); setShowChat(false);
      } catch (e) {
        if (e instanceof ApiError) { toast.error(e.message); return; }
        toast.error(e instanceof Error ? e.message : 'Could not add entry');
      }
    } finally { setPendingEntry(null); }
  };

  const handleDeleteEntry = async (entryId: string) => {
    if (entryId.startsWith('offline-')) {
      deleteOfflineFoodEntry(dateStr, entryId);
      await loadDayEntries(); toast.success('Entry deleted'); return;
    }
    const id = parseInt(entryId, 10);
    if (Number.isNaN(id)) { toast.error('Invalid entry'); return; }
    try {
      await deleteEntryRemote(id); await loadDayEntries(); toast.success('Entry deleted');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not delete entry'); }
  };

  const isToday = dateStr === getTodayDate();

  return (
    <div className="min-h-screen bg-[#0d0d14] p-4 md:p-8">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-1/4 w-80 h-80 rounded-full bg-orange-600/8 blur-3xl" />
        <div className="absolute bottom-0 left-1/4 w-80 h-80 rounded-full bg-blue-600/8 blur-3xl" />
      </div>

      <div className="relative max-w-2xl mx-auto">

        {/* Header */}
        <motion.div {...fadeUp(0)} className="flex items-center gap-3 mb-5">
          <Button variant="ghost" size="icon" className="rounded-xl shrink-0 text-slate-400 hover:text-white hover:bg-white/10" onClick={() => navigate('/')}>
            <ArrowLeft className="size-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-white leading-tight">
              {isToday ? "Today's Log" : 'Daily Log'}
            </h1>
            <p className="text-sm text-slate-500">{formatLocaleDateMedium(selectedDate)}</p>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon" className="rounded-xl shrink-0 bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-white">
                <CalendarIcon className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar mode="single" selected={selectedDate} onSelect={(d) => d && setSelectedDate(d)} initialFocus />
            </PopoverContent>
          </Popover>
        </motion.div>

        {loadError && (
          <p className="text-sm text-amber-400 mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            Could not load meals from the server ({loadError}). Showing offline-only entries.
          </p>
        )}

        {/* Vivid stat strip */}
        <motion.div {...fadeUp(0.06)} className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: 'Calories', value: totals.totalCalories, suffix: '', gradient: 'from-orange-500 to-amber-400', icon: Flame },
            { label: 'Protein', value: totals.totalProtein, suffix: 'g', gradient: 'from-blue-600 to-cyan-400', icon: Dumbbell },
            { label: 'Meals', value: totals.count, suffix: '', gradient: 'from-emerald-500 to-teal-400', icon: Utensils },
          ].map(({ label, value, suffix, gradient, icon: Icon }, i) => (
            <motion.div key={label} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 350, damping: 26, delay: 0.1 + i * 0.06 }}
              className={`bg-gradient-to-br ${gradient} rounded-2xl p-4 shadow-lg text-center`}>
              <Icon className="size-4 text-white/70 mx-auto mb-1.5" />
              <div className="text-2xl font-black text-white leading-none">
                {value}<span className="text-sm font-semibold opacity-75">{suffix}</span>
              </div>
              <div className="text-xs text-white/60 mt-1 font-medium">{label}</div>
            </motion.div>
          ))}
        </motion.div>

        {/* Add Food */}
        <AnimatePresence mode="wait">
          {showChat ? (
            <motion.div key="form"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 28 } }}
              exit={{ opacity: 0, y: -8, transition: { type: 'tween', duration: 0.15, ease: 'easeOut' } }}
              className="mb-5">
              <Tabs value={inputMode} onValueChange={(v) => setInputMode(v as 'chat' | 'manual')}>
                <Card className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl overflow-hidden shadow-xl">
                  <CardHeader className="pb-3">
                    <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2 text-white">
                          {inputMode === 'chat' ? <MessageSquare className="size-4 text-orange-400" /> : <Edit3 className="size-4 text-blue-400" />}
                          Add Food
                        </CardTitle>
                        <CardDescription className="mt-0.5 text-slate-500">
                          {inputMode === 'chat' ? 'Type or speak what you ate' : 'Enter food details manually'}
                        </CardDescription>
                      </div>
                      {inputMode === 'chat' && (
                        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-purple-500/20 bg-purple-500/10 px-3 py-1.5">
                          <Sparkles className={`size-3.5 shrink-0 ${llmFallback ? 'text-purple-400' : 'text-slate-600'}`} aria-hidden />
                          <Label htmlFor="llm-toggle" className="cursor-pointer text-xs font-medium text-slate-400">AI Assist</Label>
                          <Switch id="llm-toggle" checked={llmFallback} onCheckedChange={(c) => { setLlmFallback(c); writeLlmFallbackPreference(c); }} />
                        </div>
                      )}
                    </div>
                    <TabsList className="grid w-full grid-cols-2 rounded-xl bg-white/5">
                      <TabsTrigger value="chat" className="gap-2 rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-slate-500">
                        <MessageSquare className="size-3.5" />Chat Mode
                      </TabsTrigger>
                      <TabsTrigger value="manual" className="gap-2 rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-slate-500">
                        <Edit3 className="size-3.5" />Manual Input
                      </TabsTrigger>
                    </TabsList>
                  </CardHeader>
                  <CardContent>
                    <TabsContent value="chat" className="mt-0">
                      <ChatInput onSubmit={handleChatSubmit} onSubmitPreset={(p) => handleManualSubmit({ name: p.name, grams: p.grams, protein: p.protein, calories: p.calories })} />
                    </TabsContent>
                    <TabsContent value="manual" className="mt-0">
                      <ManualFoodInput onSubmit={handleManualSubmit} />
                    </TabsContent>
                    <Button variant="ghost" className="mt-4 w-full text-slate-600 hover:text-slate-400 hover:bg-white/5 rounded-xl" onClick={() => setShowChat(false)}>Cancel</Button>
                  </CardContent>
                </Card>
              </Tabs>
            </motion.div>
          ) : (
            <motion.div key="cta"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 28 } }}
              exit={{ opacity: 0, y: -4, transition: { type: 'tween', duration: 0.15, ease: 'easeOut' } }}
              className="mb-5">
              <motion.button
                whileHover={{ scale: 1.02, y: -2 }} whileTap={{ scale: 0.97 }}
                className="w-full h-14 rounded-2xl bg-gradient-to-r from-orange-500 via-rose-500 to-pink-500 text-white font-bold text-base flex items-center justify-center gap-2.5 shadow-xl shadow-orange-900/40"
                onClick={() => setShowChat(true)}
              >
                <Plus className="size-5" />
                Add food
              </motion.button>
              <p className="text-center text-xs text-slate-600 mt-2">Chat or manual entry</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Food Entries */}
        <div className="space-y-2.5">
          {pendingEntry && <PendingFoodEntryCard mode={pendingEntry.mode} preview={pendingEntry.preview} />}
          {entries.length === 0 && !pendingEntry ? (
            <motion.div {...fadeUp(0.3)}
              className="bg-white/5 rounded-2xl border border-white/8 p-12 text-center">
              <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center mx-auto mb-4">
                <Utensils className="size-6 text-slate-600" />
              </div>
              <p className="font-semibold text-slate-500">No meals logged yet</p>
              <p className="mt-1 text-sm text-slate-600">Tap Add food to get started</p>
            </motion.div>
          ) : (
            <AnimatePresence initial={false}>
              {entries.map((entry, i) => (
                <motion.div key={entry.id}
                  initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 28, delay: i * 0.04 }}>
                  <FoodEntryCard entry={entry} onDelete={handleDeleteEntry} />
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>

      </div>
    </div>
  );
}
