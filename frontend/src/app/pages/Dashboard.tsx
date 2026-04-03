import { useState, useEffect } from 'react';
import { Calendar, PlusCircle, BarChart3, History } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { useNavigate } from 'react-router';
import { getTodayDate, getOfflineDayLog } from '../utils/foodData';
import { fetchEntriesForDate } from '../utils/api';

export default function Dashboard() {
  const navigate = useNavigate();
  const today = getTodayDate();
  const [todayLog, setTodayLog] = useState({
    totalCalories: 0,
    totalProtein: 0,
    mealCount: 0,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const offline = getOfflineDayLog(today);
      try {
        const { entries } = await fetchEntriesForDate(today);
        const apiCal = entries.reduce((s, e) => s + e.calories, 0);
        const apiProt = entries.reduce((s, e) => s + e.protein, 0);
        if (!cancelled) {
          setTodayLog({
            totalCalories: apiCal + offline.totalCalories,
            totalProtein: apiProt + offline.totalProtein,
            mealCount: entries.length + offline.entries.length,
          });
        }
      } catch {
        if (!cancelled) {
          setTodayLog({
            totalCalories: offline.totalCalories,
            totalProtein: offline.totalProtein,
            mealCount: offline.entries.length,
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [today]);

  const quickActions = [
    {
      title: 'Log Food Today',
      description: 'Add what you ate today',
      icon: PlusCircle,
      color: 'bg-green-100 text-green-700',
      action: () => navigate(`/day/${today}`),
    },
    {
      title: 'View History',
      description: 'See past days',
      icon: History,
      color: 'bg-blue-100 text-blue-700',
      action: () => navigate(`/day/${today}`),
    },
    {
      title: 'View Summary',
      description: 'Check your stats',
      icon: BarChart3,
      color: 'bg-purple-100 text-purple-700',
      action: () => navigate('/summary'),
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
            Food Tracker
          </h1>
          <p className="text-muted-foreground">Track your meals with ease</p>
        </div>

        {/* Today's Summary Card */}
        <Card className="mb-6 bg-white/80 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="size-5" />
              Today's Summary
            </CardTitle>
            <CardDescription>{new Date().toLocaleDateString('en-US', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-4 bg-orange-50 rounded-lg">
                <div className="text-2xl font-bold text-orange-600">{todayLog.totalCalories}</div>
                <div className="text-sm text-muted-foreground">Calories</div>
              </div>
              <div className="text-center p-4 bg-blue-50 rounded-lg">
                <div className="text-2xl font-bold text-blue-600">{todayLog.totalProtein}g</div>
                <div className="text-sm text-muted-foreground">Protein</div>
              </div>
              <div className="text-center p-4 bg-green-50 rounded-lg">
                <div className="text-2xl font-bold text-green-600">{todayLog.mealCount}</div>
                <div className="text-sm text-muted-foreground">Meals</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <div className="grid md:grid-cols-3 gap-4">
          {quickActions.map((action, index) => (
            <Card 
              key={index}
              className="cursor-pointer hover:shadow-lg transition-all hover:-translate-y-1 bg-white/80 backdrop-blur"
              onClick={action.action}
            >
              <CardContent className="p-6">
                <div className={`inline-flex p-3 rounded-lg ${action.color} mb-4`}>
                  <action.icon className="size-6" />
                </div>
                <h3 className="font-semibold mb-1">{action.title}</h3>
                <p className="text-sm text-muted-foreground">{action.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Quick Tips */}
        <Card className="mt-6 bg-gradient-to-r from-green-500 to-blue-500 text-white">
          <CardContent className="p-6">
            <h3 className="font-semibold mb-2">💡 Pro Tip</h3>
            <p className="text-sm text-white/90">
              Use the chat interface to quickly log your meals! Just type or speak what you ate, 
              like "chicken breast and rice" and we'll track the calories and protein for you.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
