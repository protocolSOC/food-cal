import { Trash2, Apple, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { FoodEntry as FoodEntryType, APP_TIME_ZONE } from '../utils/foodData';
import { saveManualPreset } from '../utils/manualPresets';

interface FoodEntryProps {
  entry: FoodEntryType;
  onDelete: (id: string) => void;
}

export function FoodEntry({ entry, onDelete }: FoodEntryProps) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  });

  const gramsKnown = entry.gramsTotal != null;
  const gramsTitle = !gramsKnown
    ? 'No gram amounts stored for this meal'
    : entry.gramsPartial
      ? 'Some items have no gram amount; total is incomplete'
      : undefined;

  const savePresetDisabledTitle =
    'Weight (grams) is required to save this meal as a reusable preset';

  const handleSavePreset = () => {
    if (!gramsKnown || entry.gramsTotal == null) {
      toast.error('Weight (grams) is required to save a preset.');
      return;
    }
    const result = saveManualPreset({
      name: entry.name,
      grams: entry.gramsTotal,
      protein: entry.protein,
      calories: entry.calories,
    });
    if (!result.ok) {
      toast.error('Could not save preset.');
      return;
    }
    toast.success(result.updated ? 'Saved preset updated.' : 'Saved for reuse in this browser.');
  };

  return (
    <Card className="p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start gap-3">
        <div className="mt-1 p-2 bg-green-100 rounded-lg">
          <Apple className="size-5 text-green-700" />
        </div>
        
        <div className="flex-1 min-w-0">
          <h3 className="font-medium truncate">{entry.name}</h3>
          <p className="text-sm text-muted-foreground">{time}</p>
          
          <div className="flex flex-wrap gap-4 mt-2">
            <div className="flex flex-col min-w-[4.5rem]">
              <span className="text-xs text-muted-foreground">Calories</span>
              <span className="text-sm font-semibold text-orange-600">{entry.calories} kcal</span>
            </div>
            <div className="flex flex-col min-w-[4.5rem]">
              <span className="text-xs text-muted-foreground">Protein</span>
              <span className="text-sm font-semibold text-blue-600">{entry.protein}g</span>
            </div>
            <div className="flex flex-col min-w-[4.5rem]" title={gramsTitle}>
              <span className="text-xs text-muted-foreground">Grams</span>
              <span className="text-sm font-semibold text-emerald-700">
                {gramsKnown ? (
                  <>
                    {entry.gramsTotal} g
                    {entry.gramsPartial ? (
                      <span className="text-muted-foreground font-normal" aria-hidden>
                        {' '}
                        *
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground font-normal">—</span>
                )}
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex shrink-0 flex-col gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(entry.id)}
            className="text-destructive hover:text-destructive"
            aria-label="Delete entry"
          >
            <Trash2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleSavePreset}
            disabled={!gramsKnown}
            title={!gramsKnown ? savePresetDisabledTitle : undefined}
            className="text-teal-700 hover:text-teal-800 dark:text-teal-400 dark:hover:text-teal-300"
            aria-label={gramsKnown ? 'Save as preset' : savePresetDisabledTitle}
          >
            <Save className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
