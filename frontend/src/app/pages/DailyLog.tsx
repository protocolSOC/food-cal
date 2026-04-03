import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeft, Calendar as CalendarIcon, MessageSquare } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Calendar } from '../components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { ChatInput } from '../components/ChatInput';
import { FoodEntry as FoodEntryCard } from '../components/FoodEntry';
import {
  getOfflineDayLog,
  addOfflineFoodEntry,
  deleteOfflineFoodEntry,
  parseFoodInput,
  formatDate,
  getTodayDate,
  type FoodEntry,
} from '../utils/foodData';
import { logMealToBackend, fetchEntriesForDate, deleteEntryRemote } from '../utils/api';
import { toast } from 'sonner';

export default function DailyLog() {
  const { date } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState<Date>(date ? new Date(date) : new Date());
  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showChat, setShowChat] = useState(false);

  const dateStr = formatDate(selectedDate);

  useEffect(() => {
    navigate(`/day/${dateStr}`, { replace: true });
  }, [dateStr, navigate]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const ds = formatDate(selectedDate);
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
        }));
        if (!cancelled) {
          setEntries([...merged, ...offline].sort((a, b) => b.timestamp - a.timestamp));
          setLoadError(null);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          setEntries([...offline].sort((a, b) => b.timestamp - a.timestamp));
          setLoadError(msg);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedDate, refreshKey]);

  const totals = useMemo(() => {
    const totalCalories = entries.reduce((sum, e) => sum + e.calories, 0);
    const totalProtein = entries.reduce((sum, e) => sum + e.protein, 0);
    return { totalCalories, totalProtein, count: entries.length };
  }, [entries]);

  const handleChatSubmit = async (text: string) => {
    const ds = dateStr;

    let apiMessage: string | null = null;
    try {
      await logMealToBackend(text, ds);
      setRefreshKey((k) => k + 1);
      toast.success('Meal logged!');
      setShowChat(false);
      return;
    } catch (e) {
      apiMessage = e instanceof Error ? e.message : String(e);
    }

    const parsed = parseFoodInput(text);

    if (parsed && parsed.name) {
      addOfflineFoodEntry(ds, {
        name: parsed.name,
        calories: parsed.calories || 0,
        protein: parsed.protein || 0,
      });

      setRefreshKey((k) => k + 1);
      toast.success(`Added ${parsed.name}! (saved in this browser only — not in the database)`);
      if (apiMessage) toast.info(`API unavailable: ${apiMessage}`);
      setShowChat(false);
    } else {
      toast.error(
        apiMessage ||
          "Couldn't log that meal. Start the API and ensure .env in the project root has OPENROUTER_API_KEY for vague foods. Try e.g. 200g chicken breast.",
      );
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    if (entryId.startsWith('offline-')) {
      deleteOfflineFoodEntry(dateStr, entryId);
      setRefreshKey((k) => k + 1);
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
      setRefreshKey((k) => k + 1);
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
            <p className="text-sm text-muted-foreground">
              {selectedDate.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
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
          <Card className="mb-6 bg-white/80 backdrop-blur">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="size-5" />
                Add Food
              </CardTitle>
              <CardDescription>
                Type or speak what you ate (e.g., &quot;chicken breast&quot;, &quot;banana&quot;, &quot;oatmeal&quot;)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChatInput onSubmit={handleChatSubmit} />
              <Button variant="ghost" className="w-full mt-2" onClick={() => setShowChat(false)}>
                Cancel
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Button className="w-full mb-6 h-14 text-lg" onClick={() => setShowChat(true)}>
            <MessageSquare className="size-5 mr-2" />
            Add Food via Chat
          </Button>
        )}

        <div className="space-y-3">
          {entries.length === 0 ? (
            <Card className="bg-white/60 backdrop-blur">
              <CardContent className="p-12 text-center">
                <p className="text-muted-foreground">No meals logged for this day yet.</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Click &quot;Add Food via Chat&quot; to get started!
                </p>
              </CardContent>
            </Card>
          ) : (
            entries.map((entry) => (
              <FoodEntryCard key={entry.id} entry={entry} onDelete={handleDeleteEntry} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
