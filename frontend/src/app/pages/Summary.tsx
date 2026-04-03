import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, TrendingUp, Calendar } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatDate } from '../utils/foodData';
import { fetchEntryRollups } from '../utils/api';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

type ChartDay = {
  date: string;
  fullDate: string;
  calories: number;
  protein: number;
  meals: number;
};

export default function Summary() {
  const navigate = useNavigate();
  const [timeRange, setTimeRange] = useState<'week' | 'month'>('week');
  const [chartData, setChartData] = useState<ChartDay[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const today = new Date();
      const days = timeRange === 'week' ? 7 : 30;
      const end = formatDate(today);
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (days - 1));
      const start = formatDate(startDate);
      try {
        const { days: rollups } = await fetchEntryRollups(start, end);
        const byDate = new Map(rollups.map((d) => [d.date, d]));
        const data: ChartDay[] = [];
        for (let i = days - 1; i >= 0; i--) {
          const date = new Date(today);
          date.setDate(date.getDate() - i);
          const dateString = formatDate(date);
          const r = byDate.get(dateString);
          data.push({
            date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            fullDate: dateString,
            calories: r?.total_calories ?? 0,
            protein: r?.total_protein_g ?? 0,
            meals: r?.meals ?? 0,
          });
        }
        if (!cancelled) {
          setChartData(data);
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setChartData([]);
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [timeRange]);

  const totalDays = chartData.filter((d) => d.meals > 0).length;
  const avgCalories =
    totalDays > 0 ? Math.round(chartData.reduce((sum, d) => sum + d.calories, 0) / totalDays) : 0;
  const avgProtein =
    totalDays > 0 ? Math.round(chartData.reduce((sum, d) => sum + d.protein, 0) / totalDays) : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="size-5" />
          </Button>

          <div className="flex-1">
            <h1 className="text-2xl font-bold">Summary & Analytics</h1>
            <p className="text-sm text-muted-foreground">Track your progress over time</p>
          </div>
        </div>

        {loadError && (
          <p className="text-sm text-amber-700 mb-4 rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
            Could not load summary from the server ({loadError}).
          </p>
        )}

        <Tabs value={timeRange} onValueChange={(v) => setTimeRange(v as 'week' | 'month')} className="mb-6">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="week">Last 7 Days</TabsTrigger>
            <TabsTrigger value="month">Last 30 Days</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid md:grid-cols-3 gap-4 mb-6">
          <Card className="bg-white/80 backdrop-blur">
            <CardHeader>
              <CardDescription>Days Logged</CardDescription>
              <CardTitle className="text-3xl text-green-600">{totalDays}</CardTitle>
            </CardHeader>
          </Card>

          <Card className="bg-white/80 backdrop-blur">
            <CardHeader>
              <CardDescription>Avg. Calories/Day</CardDescription>
              <CardTitle className="text-3xl text-orange-600">{avgCalories}</CardTitle>
            </CardHeader>
          </Card>

          <Card className="bg-white/80 backdrop-blur">
            <CardHeader>
              <CardDescription>Avg. Protein/Day</CardDescription>
              <CardTitle className="text-3xl text-blue-600">{avgProtein}g</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card className="mb-6 bg-white/80 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="size-5" />
              Daily Calories
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="calories" fill="#ea580c" name="Calories" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="mb-6 bg-white/80 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="size-5" />
              Daily Protein
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="protein" stroke="#2563eb" strokeWidth={2} name="Protein (g)" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="bg-white/80 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="size-5" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {chartData
                .filter((d) => d.meals > 0)
                .reverse()
                .slice(0, 7)
                .map((day) => (
                  <div
                    key={day.fullDate}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer transition-colors"
                    onClick={() => navigate(`/day/${day.fullDate}`)}
                  >
                    <div>
                      <div className="font-medium">{day.date}</div>
                      <div className="text-sm text-muted-foreground">{day.meals} meals</div>
                    </div>
                    <div className="flex gap-6 text-sm">
                      <div className="text-orange-600 font-semibold">{day.calories} cal</div>
                      <div className="text-blue-600 font-semibold">{day.protein}g protein</div>
                    </div>
                  </div>
                ))}
              {chartData.filter((d) => d.meals > 0).length === 0 && !loadError && (
                <div className="text-center py-8 text-muted-foreground">
                  No activity recorded yet. Start logging your meals!
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
