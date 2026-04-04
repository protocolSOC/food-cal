import { useState, useRef, useEffect, useMemo, type FocusEvent, type KeyboardEvent } from 'react';
import { ChevronDown, Link2, Plus, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { cn } from './ui/utils';
import { fetchFoodSuggestions } from '../utils/api';
import { activeSearchQuery, replaceActiveToken } from '../utils/foodNameQuery';
import {
  deleteManualPreset,
  listAllManualPresets,
  matchManualPresets,
  MAX_PRESETS,
  saveManualPreset,
  type ManualFoodPreset,
} from '../utils/manualPresets';
import {
  evaluateManualNumber,
  expandGramsStarPrefix,
  parseSubmittableNumber,
  scaleLinkedMacros,
} from '../utils/manualNumericInput';

export type ManualFoodFormData = {
  name: string;
  grams: number;
  protein: number;
  calories: number;
};

interface ManualFoodInputProps {
  onSubmit: (data: ManualFoodFormData) => void;
}

type SuggestionRow =
  | { type: 'preset'; preset: ManualFoodPreset }
  | { type: 'usda'; name: string };

function formHasValidNumbers(name: string, grams: string, protein: string, calories: string): boolean {
  if (!name.trim() || !grams || !protein || !calories) return false;
  return (
    parseSubmittableNumber(grams) !== null &&
    parseSubmittableNumber(protein) !== null &&
    parseSubmittableNumber(calories) !== null
  );
}

export function ManualFoodInput({ onSubmit }: ManualFoodInputProps) {
  const [formData, setFormData] = useState({
    name: '',
    grams: '',
    protein: '',
    calories: '',
  });

  const [presetSuggestions, setPresetSuggestions] = useState<ManualFoodPreset[]>([]);
  const [usdaSuggestions, setUsdaSuggestions] = useState<string[]>([]);
  const [usdaEnabled, setUsdaEnabled] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  /** Open via chevron only — avoids covering weight/calories/protein on focus. */
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  /** When on, editing grams scales calories and protein by the same ratio. */
  const [portionLinkEnabled, setPortionLinkEnabled] = useState(false);
  /** Reference weight (grams) for linked ratio; avoids using previous expression value while typing (e.g. 70*2 → 70*20). */
  const linkedAnchorGramsRef = useRef<number | null>(null);
  /** Kcal and protein at anchor grams — scaling uses these, not current displayed values (fixes revert e.g. 50*2 → 50). */
  const linkedBaselineCaloriesRef = useRef<number | null>(null);
  const linkedBaselineProteinRef = useRef<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const suggestionRows = useMemo((): SuggestionRow[] => {
    const presetRows: SuggestionRow[] = presetSuggestions.map((p) => ({ type: 'preset', preset: p }));
    const usdaRows: SuggestionRow[] = usdaSuggestions.map((name) => ({ type: 'usda', name }));
    return [...presetRows, ...usdaRows];
  }, [presetSuggestions, usdaSuggestions]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!suggestionsOpen) {
      setPresetSuggestions([]);
      setUsdaSuggestions([]);
      setSelectedIndex(-1);
      return;
    }

    const q = activeSearchQuery(formData.name);

    if (q === null) {
      const all = listAllManualPresets(MAX_PRESETS);
      setPresetSuggestions(all);
      setUsdaSuggestions([]);
      setUsdaEnabled(true);
      setSelectedIndex(all.length > 0 ? 0 : -1);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void (async () => {
        const presets = matchManualPresets(q, 6);
        setPresetSuggestions(presets);
        const { suggestions: list, usdaEnabled: enabled } = await fetchFoodSuggestions(q, 6);
        setUsdaSuggestions(list);
        setUsdaEnabled(enabled);
        const total = presets.length + list.length;
        setSelectedIndex(total > 0 ? 0 : -1);
      })();
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [formData.name, suggestionsOpen]);

  const isValid = formHasValidNumbers(
    formData.name,
    formData.grams,
    formData.protein,
    formData.calories,
  );

  const clearLinkedPortionRefs = () => {
    linkedAnchorGramsRef.current = null;
    linkedBaselineCaloriesRef.current = null;
    linkedBaselineProteinRef.current = null;
  };

  const clearSuggestions = () => {
    setPresetSuggestions([]);
    setUsdaSuggestions([]);
    setSelectedIndex(-1);
    setSuggestionsOpen(false);
  };

  const applySuggestionRow = (row: SuggestionRow) => {
    if (row.type === 'preset') {
      const p = row.preset;
      linkedAnchorGramsRef.current = p.grams;
      linkedBaselineCaloriesRef.current = p.calories;
      linkedBaselineProteinRef.current = p.protein;
      setFormData({
        name: p.name,
        grams: String(p.grams),
        protein: String(p.protein),
        calories: String(p.calories),
      });
    } else {
      setFormData((prev) => ({ ...prev, name: replaceActiveToken(prev.name, row.name) }));
    }
    clearSuggestions();
  };

  const removePreset = (id: string) => {
    if (!deleteManualPreset(id)) return;
    const q = activeSearchQuery(formData.name);
    if (q === null) {
      const all = listAllManualPresets(MAX_PRESETS);
      setPresetSuggestions(all);
      setSelectedIndex(all.length > 0 ? 0 : -1);
    } else {
      setPresetSuggestions((prev) => {
        const next = prev.filter((p) => p.id !== id);
        const total = next.length + usdaSuggestions.length;
        setSelectedIndex(total > 0 ? 0 : -1);
        return next;
      });
    }
    toast.success('Removed from saved list');
  };

  const handleSubmit = () => {
    if (!isValid) return;
    const grams = parseSubmittableNumber(formData.grams);
    const protein = parseSubmittableNumber(formData.protein);
    const calories = parseSubmittableNumber(formData.calories);
    if (grams === null || protein === null || calories === null) return;
    onSubmit({
      name: formData.name.trim(),
      grams,
      protein,
      calories,
    });
    setFormData({
      name: '',
      grams: '',
      protein: '',
      calories: '',
    });
    setPortionLinkEnabled(false);
    clearLinkedPortionRefs();
    clearSuggestions();
  };

  const handleSavePreset = () => {
    if (!formData.name || !formData.grams || !formData.protein || !formData.calories) return;
    const grams = parseSubmittableNumber(formData.grams);
    const protein = parseSubmittableNumber(formData.protein);
    const calories = parseSubmittableNumber(formData.calories);
    if (grams === null || protein === null || calories === null) {
      toast.error('Enter valid numbers for weight, calories, and protein.');
      return;
    }
    const result = saveManualPreset({
      name: formData.name,
      grams,
      protein,
      calories,
    });
    if (!result.ok) {
      toast.error('Could not save preset.');
      return;
    }
    toast.success(result.updated ? 'Saved preset updated.' : 'Saved for reuse in this browser.');
  };

  const showNameDropdown = suggestionsOpen && suggestionRows.length > 0;
  const activeQ = activeSearchQuery(formData.name);
  const showUsdaHint =
    suggestionsOpen && Boolean(activeQ) && !usdaEnabled && suggestionRows.length === 0;

  const handleNameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const showList = showNameDropdown;

    if (e.key === 'Escape' && showList) {
      e.preventDefault();
      clearSuggestions();
      return;
    }

    if (showList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (e.key === 'ArrowDown') {
        setSelectedIndex((i) => (i < suggestionRows.length - 1 ? i + 1 : i));
      } else {
        setSelectedIndex((i) => (i > 0 ? i - 1 : -1));
      }
      return;
    }

    if (e.key === 'Enter') {
      if (showList && suggestionRows.length > 0) {
        e.preventDefault();
        const idx = selectedIndex >= 0 ? selectedIndex : 0;
        const row = suggestionRows[idx];
        if (row) applySuggestionRow(row);
        return;
      }
      handleSubmit();
    }
  };

  const handleOtherKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  const handleGramsChange = (nextGrams: string) => {
    setFormData((prev) => {
      const expandedGrams = expandGramsStarPrefix(nextGrams, prev.grams);
      if (!portionLinkEnabled) {
        return { ...prev, grams: expandedGrams };
      }
      if (expandedGrams.trim() === '') {
        return { ...prev, grams: expandedGrams };
      }
      const nextEval = evaluateManualNumber(expandedGrams);
      if (nextEval.kind !== 'ok' || nextEval.value <= 0) {
        return { ...prev, grams: expandedGrams };
      }
      const anchor = linkedAnchorGramsRef.current;
      const baseC = linkedBaselineCaloriesRef.current;
      const baseP = linkedBaselineProteinRef.current;
      if (
        anchor !== null &&
        anchor > 0 &&
        Number.isFinite(anchor) &&
        baseC !== null &&
        baseP !== null &&
        Number.isFinite(baseC) &&
        Number.isFinite(baseP)
      ) {
        const scaled = scaleLinkedMacros(anchor, baseC, baseP, nextEval.value);
        return {
          ...prev,
          grams: expandedGrams,
          calories: String(scaled.calories),
          protein: String(scaled.protein),
        };
      }
      const prevC = evaluateManualNumber(prev.calories);
      const prevP = evaluateManualNumber(prev.protein);
      if (prevC.kind !== 'ok' || prevP.kind !== 'ok') {
        return { ...prev, grams: expandedGrams };
      }
      let denom: number | null =
        anchor !== null && anchor > 0 && Number.isFinite(anchor) ? anchor : null;
      if (denom === null) {
        const prevG = evaluateManualNumber(prev.grams);
        if (prevG.kind !== 'ok' || prevG.value <= 0) {
          return { ...prev, grams: expandedGrams };
        }
        denom = prevG.value;
      }
      const ratio = nextEval.value / denom;
      return {
        ...prev,
        grams: expandedGrams,
        calories: String(Math.round(prevC.value * ratio)),
        protein: String(Math.round(prevP.value * ratio * 10) / 10),
      };
    });
  };

  const handleGramsBlur = (e: FocusEvent<HTMLInputElement>) => {
    if (!portionLinkEnabled) return;
    const g = parseSubmittableNumber(e.currentTarget.value);
    const c = parseSubmittableNumber(formData.calories);
    const p = parseSubmittableNumber(formData.protein);
    if (g !== null && g > 0 && c !== null && p !== null) {
      linkedAnchorGramsRef.current = g;
      linkedBaselineCaloriesRef.current = c;
      linkedBaselineProteinRef.current = p;
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label htmlFor="food-name" className="mb-1.5 block text-sm font-medium">
            Food Name
          </Label>
          <div className="relative flex gap-2">
            {showNameDropdown && (
              <ul
                className="absolute z-50 bottom-full left-0 right-0 mb-1 max-h-60 overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
                role="listbox"
              >
                {suggestionRows.map((row, idx) =>
                  row.type === 'preset' ? (
                    <li
                      key={`p-${row.preset.id}`}
                      className="flex items-stretch"
                      role="option"
                      aria-selected={selectedIndex === idx}
                    >
                      <button
                        type="button"
                        className={`min-w-0 flex-1 cursor-pointer px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground ${
                          selectedIndex === idx ? 'bg-accent text-accent-foreground' : ''
                        }`}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => applySuggestionRow(row)}
                      >
                        <div className="font-medium">{row.preset.name}</div>
                        <div className="text-muted-foreground text-xs">
                          Saved · {row.preset.calories} kcal · {row.preset.grams}g · P {row.preset.protein}g
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label="Remove from saved list"
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 px-2.5"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          removePreset(row.preset.id);
                        }}
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ) : (
                    <li
                      key={`u-${row.name}-${idx}`}
                      role="option"
                      aria-selected={selectedIndex === idx}
                    >
                      <button
                        type="button"
                        className={`w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground ${
                          selectedIndex === idx ? 'bg-accent text-accent-foreground' : ''
                        }`}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => applySuggestionRow(row)}
                      >
                        {row.name}
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
            <Input
              id="food-name"
              placeholder="e.g., Grilled Chicken Breast"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              onKeyDown={handleNameKeyDown}
              onFocus={() => {
                if (blurCloseRef.current) {
                  clearTimeout(blurCloseRef.current);
                  blurCloseRef.current = null;
                }
              }}
              onBlur={() => {
                blurCloseRef.current = setTimeout(() => setSuggestionsOpen(false), 150);
              }}
              className="h-11 min-w-0 flex-1"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={showNameDropdown}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-11 w-11 shrink-0"
              aria-label={suggestionsOpen ? 'Close suggestions' : 'Show saved foods and name suggestions'}
              aria-expanded={suggestionsOpen}
              aria-haspopup="listbox"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setSuggestionsOpen((open) => !open)}
            >
              <ChevronDown className={cn('size-4 transition-transform', suggestionsOpen && 'rotate-180')} />
            </Button>
          </div>
          {showUsdaHint && (
            <p className="text-muted-foreground mt-1.5 text-xs px-0.5">
              Food hints use USDA FoodData Central. Set <code className="rounded bg-muted px-1">USDA_FDC_API_KEY</code>{' '}
              in your project <code className="rounded bg-muted px-1">.env</code> and restart the API.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="food-grams" className="mb-1.5 block text-sm font-medium">
            Weight (grams)
          </Label>
          <Input
            id="food-grams"
            type="text"
            inputMode="decimal"
            placeholder="150"
            value={formData.grams}
            onChange={(e) => handleGramsChange(e.target.value)}
            onBlur={handleGramsBlur}
            onKeyDown={handleOtherKeyDown}
            className="h-11"
          />
        </div>

        <div>
          <Label htmlFor="food-calories" className="mb-1.5 block text-sm font-medium">
            Calories (kcal)
          </Label>
          <Input
            id="food-calories"
            type="text"
            inputMode="decimal"
            placeholder="165"
            value={formData.calories}
            onChange={(e) => setFormData({ ...formData, calories: e.target.value })}
            onKeyDown={handleOtherKeyDown}
            className="h-11"
          />
        </div>

        <div>
          <Label htmlFor="food-protein" className="mb-1.5 block text-sm font-medium">
            Protein (grams)
          </Label>
          <Input
            id="food-protein"
            type="text"
            inputMode="decimal"
            placeholder="31"
            value={formData.protein}
            onChange={(e) => setFormData({ ...formData, protein: e.target.value })}
            onKeyDown={handleOtherKeyDown}
            className="h-11"
          />
        </div>
      </div>

      <div
        className={cn(
          'sticky bottom-0 z-10 -mx-1 mt-1 rounded-2xl border border-teal-200/70 bg-background/85 px-3 py-2.5 shadow-[0_-8px_24px_-8px_rgba(13,148,136,0.12)] backdrop-blur-md dark:border-teal-800/50 dark:shadow-[0_-8px_24px_-8px_rgba(45,212,191,0.08)]',
          portionLinkEnabled &&
            'border-amber-200/80 bg-gradient-to-br from-teal-500/[0.07] via-background/90 to-amber-500/[0.09] dark:border-amber-900/40',
        )}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-xl border transition-colors',
                portionLinkEnabled
                  ? 'border-teal-400/60 bg-teal-500/15 text-teal-700 dark:border-teal-600/50 dark:bg-teal-950/50 dark:text-teal-300'
                  : 'border-border bg-muted/50 text-muted-foreground',
              )}
              aria-hidden
            >
              <Link2 className={cn('size-4', portionLinkEnabled && 'text-teal-600 dark:text-teal-400')} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium leading-tight text-foreground">Portion link</p>
              <p className="text-muted-foreground text-xs leading-snug">
                {portionLinkEnabled
                  ? 'Grams rescales kcal and protein together.'
                  : 'Fill all fields, then link to scale portions from weight.'}
              </p>
            </div>
          </div>
          <div
            className="flex shrink-0 rounded-full border border-border/80 bg-muted/30 p-0.5 shadow-inner"
            role="group"
            aria-label="Portion scaling mode"
          >
            <button
              type="button"
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                !portionLinkEnabled
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={!portionLinkEnabled}
              onClick={() => {
                setPortionLinkEnabled(false);
                clearLinkedPortionRefs();
              }}
            >
              Independent
            </button>
            <button
              type="button"
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                portionLinkEnabled
                  ? 'bg-gradient-to-r from-teal-600 to-amber-600 text-white shadow-sm dark:from-teal-500 dark:to-amber-600'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={portionLinkEnabled}
              aria-disabled={!isValid}
              disabled={!isValid && !portionLinkEnabled}
              onClick={() => {
                if (!isValid) return;
                const g = parseSubmittableNumber(formData.grams);
                const c = parseSubmittableNumber(formData.calories);
                const p = parseSubmittableNumber(formData.protein);
                if (g !== null && g > 0 && c !== null && p !== null) {
                  linkedAnchorGramsRef.current = g;
                  linkedBaselineCaloriesRef.current = c;
                  linkedBaselineProteinRef.current = p;
                }
                setPortionLinkEnabled(true);
              }}
            >
              Linked
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleSavePreset}
          disabled={!isValid}
          className="h-12 w-full justify-center gap-2"
          size="lg"
        >
          <Save className="size-4 shrink-0" />
          Save to List
        </Button>
        <Button onClick={handleSubmit} disabled={!isValid} className="h-11 w-full" size="lg">
          <Plus className="mr-2 size-4" />
          Add Food Entry
        </Button>
      </div>
    </div>
  );
}
