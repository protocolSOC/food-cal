import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from 'react';
import { Mic, Send, Square, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { fetchFoodSuggestions } from '../utils/api';
import { activeSearchQuery, replaceActiveToken } from '../utils/foodNameQuery';
import {
  deleteManualPreset,
  listAllManualPresets,
  matchManualPresets,
  MAX_PRESETS,
  type ManualFoodPreset,
} from '../utils/manualPresets';

interface ChatInputProps {
  onSubmit: (text: string) => void | Promise<void>;
  /** When set, choosing a saved preset logs via manual meal API instead of inserting the name for chat/LLM. */
  onSubmitPreset?: (preset: ManualFoodPreset) => void | Promise<void>;
  placeholder?: string;
}

type SuggestionRow =
  | { type: 'preset'; preset: ManualFoodPreset }
  | { type: 'usda'; name: string };

export function ChatInput({
  onSubmit,
  onSubmitPreset,
  placeholder = "Try: 'I had chicken breast and rice'",
}: ChatInputProps) {
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [presetSuggestions, setPresetSuggestions] = useState<ManualFoodPreset[]>([]);
  const [usdaSuggestions, setUsdaSuggestions] = useState<string[]>([]);
  const [usdaEnabled, setUsdaEnabled] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [focused, setFocused] = useState(false);
  const speechRecognitionRef = useRef<WebSpeechRecognition | null>(null);
  const inputPrefixRef = useRef('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const suggestionRows = useMemo((): SuggestionRow[] => {
    const presetRows: SuggestionRow[] = presetSuggestions.map((p) => ({ type: 'preset', preset: p }));
    const usdaRows: SuggestionRow[] = usdaSuggestions.map((name) => ({ type: 'usda', name }));
    return [...presetRows, ...usdaRows];
  }, [presetSuggestions, usdaSuggestions]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!focused) {
      setPresetSuggestions([]);
      setUsdaSuggestions([]);
      setSelectedIndex(-1);
      return;
    }

    const q = activeSearchQuery(input);

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
  }, [input, focused]);

  useEffect(() => {
    return () => {
      speechRecognitionRef.current?.abort();
      speechRecognitionRef.current = null;
    };
  }, []);

  const submitPreset = async (preset: ManualFoodPreset) => {
    if (isSending || !onSubmitPreset) return;
    setPresetSuggestions([]);
    setUsdaSuggestions([]);
    setSelectedIndex(-1);
    setInput('');
    setIsSending(true);
    try {
      await onSubmitPreset(preset);
    } finally {
      setIsSending(false);
    }
  };

  const applySuggestionRow = (row: SuggestionRow) => {
    if (row.type === 'preset' && onSubmitPreset) {
      void submitPreset(row.preset);
      return;
    }
    const text = row.type === 'preset' ? row.preset.name : row.name;
    setInput(replaceActiveToken(input, text));
    setPresetSuggestions([]);
    setUsdaSuggestions([]);
    setSelectedIndex(-1);
  };

  const removePreset = (id: string) => {
    if (!deleteManualPreset(id)) return;
    const q = activeSearchQuery(input);
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

  const handleSubmit = async () => {
    const t = input.trim();
    if (!t || isSending) return;
    setInput('');
    setPresetSuggestions([]);
    setUsdaSuggestions([]);
    setSelectedIndex(-1);
    setIsSending(true);
    try {
      await onSubmit(t);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const showList = focused && suggestionRows.length > 0;

    if (e.key === 'Escape' && showList) {
      e.preventDefault();
      setPresetSuggestions([]);
      setUsdaSuggestions([]);
      setSelectedIndex(-1);
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
      void handleSubmit();
    }
  };

  const startRecording = () => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      toast.error('Speech recognition is not supported in this browser. Try Chrome or Edge.');
      return;
    }

    try {
      inputPrefixRef.current = input.trimEnd();
      const rec = new Ctor();
      speechRecognitionRef.current = rec;
      rec.lang = navigator.language || 'en-US';
      rec.continuous = true;
      rec.interimResults = true;

      rec.onresult = (event: WebSpeechRecognitionResultEvent) => {
        let line = '';
        for (let i = 0; i < event.results.length; i++) {
          line += event.results[i]![0]!.transcript;
        }
        const spoken = line.trim();
        const prefix = inputPrefixRef.current;
        setInput(prefix ? `${prefix} ${spoken}` : spoken);
      };

      rec.onerror = (event: WebSpeechRecognitionErrorEvent) => {
        if (event.error === 'aborted') return;
        if (event.error === 'no-speech') return;
        if (event.error === 'not-allowed') {
          toast.error('Allow microphone access to use voice input.');
        } else {
          toast.error(`Speech recognition: ${event.error}`);
        }
      };

      rec.onend = () => {
        speechRecognitionRef.current = null;
        setIsRecording(false);
      };

      rec.start();
      setIsRecording(true);
      toast.success('Listening… click the mic again to stop.');
    } catch (error) {
      toast.error('Could not start speech recognition.');
      console.error(error);
    }
  };

  const stopRecording = () => {
    const rec = speechRecognitionRef.current;
    if (rec && isRecording) {
      rec.stop();
    }
  };

  const showDropdown = focused && suggestionRows.length > 0;
  const activeQ = activeSearchQuery(input);
  const showUsdaHint =
    focused && Boolean(activeQ) && !usdaEnabled && suggestionRows.length === 0;

  return (
    <div className="flex gap-2 items-start w-full">
      <div className="relative flex-1 min-w-0">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (blurCloseRef.current) {
              clearTimeout(blurCloseRef.current);
              blurCloseRef.current = null;
            }
            setFocused(true);
          }}
          onBlur={() => {
            blurCloseRef.current = setTimeout(() => setFocused(false), 150);
          }}
          placeholder={placeholder}
          className="w-full"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showDropdown}
        />
        {showDropdown && (
          <ul
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
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
                    onMouseDown={(e) => e.preventDefault()}
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
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applySuggestionRow(row)}
                  >
                    {row.name}
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
        {showUsdaHint && (
          <p className="text-muted-foreground mt-1.5 text-xs px-0.5">
            Food hints use USDA FoodData Central. Set <code className="rounded bg-muted px-1">USDA_FDC_API_KEY</code> in
            your project <code className="rounded bg-muted px-1">.env</code> and restart the API (see{' '}
            <a
              className="underline underline-offset-2"
              href="https://fdc.nal.usda.gov/api-key-signup"
              target="_blank"
              rel="noreferrer"
            >
              api-key-signup
            </a>
            ).
          </p>
        )}
      </div>

      <Button
        variant={isRecording ? 'destructive' : 'outline'}
        size="icon"
        className="shrink-0"
        onClick={isRecording ? stopRecording : startRecording}
        title={isRecording ? 'Stop recording' : 'Start voice recording'}
      >
        {isRecording ? <Square className="size-4" /> : <Mic className="size-4" />}
      </Button>

      <Button
        onClick={() => void handleSubmit()}
        disabled={!input.trim() || isSending}
        size="icon"
        className="shrink-0"
      >
        <Send className="size-4" />
      </Button>
    </div>
  );
}
