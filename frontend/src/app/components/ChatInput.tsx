import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Mic, Send, Square } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { fetchFoodSuggestions } from '../utils/api';

interface ChatInputProps {
  onSubmit: (text: string) => void | Promise<void>;
  placeholder?: string;
}

/** Last comma-separated segment, then last whitespace token — min length 2 to query. */
function activeSearchQuery(value: string): string | null {
  const lastComma = value.lastIndexOf(',');
  const segment = lastComma === -1 ? value : value.slice(lastComma + 1);
  const m = segment.match(/(\S+)$/);
  if (!m) return null;
  const q = m[1];
  return q.length >= 2 ? q : null;
}

/** Replace the last token in the last segment with `replacement`. */
function replaceActiveToken(value: string, replacement: string): string {
  const lastComma = value.lastIndexOf(',');
  const prefix = lastComma === -1 ? '' : value.slice(0, lastComma + 1);
  const segment = lastComma === -1 ? value : value.slice(lastComma + 1);
  const m = segment.match(/^(.*?)(\S+)$/);
  if (!m) return prefix + replacement;
  return prefix + m[1] + replacement;
}

export function ChatInput({ onSubmit, placeholder = "Try: 'I had chicken breast and rice'" }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [focused, setFocused] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = activeSearchQuery(input);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q) {
      setSuggestions([]);
      setSelectedIndex(-1);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void (async () => {
        const list = await fetchFoodSuggestions(q, 12);
        setSuggestions(list);
        setSelectedIndex(-1);
      })();
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [input]);

  const applySuggestion = (text: string) => {
    setInput(replaceActiveToken(input, text));
    setSuggestions([]);
    setSelectedIndex(-1);
  };

  const handleSubmit = async () => {
    const t = input.trim();
    if (!t || isSending) return;
    setInput('');
    setSuggestions([]);
    setSelectedIndex(-1);
    setIsSending(true);
    try {
      await onSubmit(t);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const showList = focused && suggestions.length > 0;

    if (e.key === 'Escape' && showList) {
      e.preventDefault();
      setSuggestions([]);
      setSelectedIndex(-1);
      return;
    }

    if (showList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (e.key === 'ArrowDown') {
        setSelectedIndex((i) => (i < suggestions.length - 1 ? i + 1 : i));
      } else {
        setSelectedIndex((i) => (i > 0 ? i - 1 : -1));
      }
      return;
    }

    if (e.key === 'Enter') {
      if (showList && selectedIndex >= 0 && suggestions[selectedIndex]) {
        e.preventDefault();
        applySuggestion(suggestions[selectedIndex]);
        return;
      }
      void handleSubmit();
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      const audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());

        toast.info('Voice recording captured! In production, this would convert speech to text.');

        const mockTranscriptions = [
          'I had chicken breast and rice',
          'I ate a banana',
          'Had oatmeal for breakfast',
          'Lunch was a salad with salmon',
        ];
        const mockText = mockTranscriptions[Math.floor(Math.random() * mockTranscriptions.length)];
        setInput(mockText);
      };

      mediaRecorder.start();
      setIsRecording(true);
      toast.success('Recording started...');
    } catch (error) {
      toast.error('Could not access microphone. Please check permissions.');
      console.error('Error accessing microphone:', error);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const showDropdown = focused && suggestions.length > 0;

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
            {suggestions.map((s, idx) => (
              <li key={`${s}-${idx}`} role="option" aria-selected={selectedIndex === idx}>
                <button
                  type="button"
                  className={`w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground ${
                    selectedIndex === idx ? 'bg-accent text-accent-foreground' : ''
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applySuggestion(s)}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
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
