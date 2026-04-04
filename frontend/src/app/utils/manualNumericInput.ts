const ALLOWED_CHARS = /^[\d\s+\-*/().]+$/;

function normalizeMultiplySigns(s: string): string {
  return s.replace(/\u00d7/g, '*');
}

/** Fullwidth Unicode digits (U+FF10–FF19) → ASCII 0–9 */
function normalizeDigitsToAscii(s: string): string {
  let out = '';
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    if (cp >= 0xff10 && cp <= 0xff19) {
      out += String.fromCodePoint(cp - 0xff10 + 0x30);
    } else {
      out += c;
    }
  }
  return out;
}

function normalizeManualNumberInput(raw: string): string {
  return normalizeDigitsToAscii(normalizeMultiplySigns(raw.trim()));
}

export type ManualNumberResult =
  | { kind: 'ok'; value: number }
  | { kind: 'empty' }
  | { kind: 'incomplete' }
  | { kind: 'invalid' };

class ExprParser {
  s: string;
  i = 0;
  incomplete = false;

  constructor(s: string) {
    this.s = s;
  }

  skip(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) {
      this.i++;
    }
  }

  readNumber(): number | null {
    this.skip();
    const start = this.i;
    if (this.i >= this.s.length) {
      this.incomplete = true;
      return null;
    }

    const ch = this.s[this.i]!;
    if (ch === '.') {
      this.i++;
      if (this.i >= this.s.length || !/\d/.test(this.s[this.i]!)) {
        this.incomplete = true;
        return null;
      }
      while (this.i < this.s.length && /\d/.test(this.s[this.i]!)) {
        this.i++;
      }
    } else if (/\d/.test(ch)) {
      while (this.i < this.s.length && /\d/.test(this.s[this.i]!)) {
        this.i++;
      }
      if (this.i < this.s.length && this.s[this.i] === '.') {
        this.i++;
        while (this.i < this.s.length && /\d/.test(this.s[this.i]!)) {
          this.i++;
        }
      }
    } else {
      return null;
    }

    const slice = this.s.slice(start, this.i);
    const n = Number.parseFloat(slice);
    if (!Number.isFinite(n)) {
      return null;
    }
    return n;
  }

  parseFactor(): number | null {
    this.skip();
    if (this.i >= this.s.length) {
      this.incomplete = true;
      return null;
    }

    const ch = this.s[this.i]!;
    if (ch === '-') {
      this.i++;
      const v = this.parseFactor();
      if (v === null) {
        return null;
      }
      return -v;
    }

    if (ch === '(') {
      this.i++;
      const v = this.parseExpression();
      if (v === null) {
        return null;
      }
      this.skip();
      if (this.i >= this.s.length || this.s[this.i] !== ')') {
        this.incomplete = true;
        return null;
      }
      this.i++;
      return v;
    }

    if (ch === ')' || ch === '+' || ch === '*' || ch === '/') {
      return null;
    }

    return this.readNumber();
  }

  parseTerm(): number | null {
    let left = this.parseFactor();
    if (left === null) {
      return null;
    }
    while (true) {
      this.skip();
      if (this.i >= this.s.length) {
        break;
      }
      const op = this.s[this.i]!;
      if (op !== '*' && op !== '/') {
        break;
      }
      this.i++;
      const right = this.parseFactor();
      if (right === null) {
        return null;
      }
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  parseExpression(): number | null {
    let left = this.parseTerm();
    if (left === null) {
      return null;
    }
    while (true) {
      this.skip();
      if (this.i >= this.s.length) {
        break;
      }
      const op = this.s[this.i]!;
      if (op !== '+' && op !== '-') {
        break;
      }
      this.i++;
      const right = this.parseTerm();
      if (right === null) {
        return null;
      }
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
}

/**
 * Parses a manual numeric field that may contain arithmetic (+ - * / parentheses).
 * Does not use eval. Incomplete expressions (e.g. "20*") return `incomplete`.
 * Normalizes Unicode × and fullwidth digits before parsing.
 */
export function evaluateManualNumber(raw: string): ManualNumberResult {
  const s = normalizeManualNumberInput(raw);
  if (s === '') {
    return { kind: 'empty' };
  }
  if (!ALLOWED_CHARS.test(s)) {
    return { kind: 'invalid' };
  }

  const p = new ExprParser(s);
  const value = p.parseExpression();
  if (value === null) {
    return { kind: p.incomplete ? 'incomplete' : 'invalid' };
  }
  p.skip();
  if (p.i < p.s.length) {
    return { kind: 'invalid' };
  }
  if (!Number.isFinite(value)) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', value };
}

export function isSubmittableNumeric(raw: string): boolean {
  const r = evaluateManualNumber(raw);
  return r.kind === 'ok' && r.value >= 0;
}

/** When valid for submit/save, returns the numeric value; otherwise null. */
export function parseSubmittableNumber(raw: string): number | null {
  const r = evaluateManualNumber(raw);
  if (r.kind !== 'ok' || r.value < 0) {
    return null;
  }
  return r.value;
}

/**
 * Turns "*2" into "70*2" when the field had a valid positive grams value before this edit
 * (e.g. user selected all and typed "*2" instead of appending to "70").
 */
export function expandGramsStarPrefix(raw: string, previousGrams: string): string {
  const t = normalizeManualNumberInput(raw);
  if (t === '' || !t.startsWith('*')) {
    return raw;
  }
  const base = evaluateManualNumber(previousGrams.trim());
  if (base.kind !== 'ok' || base.value <= 0) {
    return raw;
  }
  return `${base.value}${t}`;
}

/** Portion-link scaling: macros at anchor weight × (evaluated grams / anchor grams). */
export function scaleLinkedMacros(
  anchorGrams: number,
  baselineCalories: number,
  baselineProtein: number,
  evaluatedGrams: number,
): { calories: number; protein: number } {
  const ratio = evaluatedGrams / anchorGrams;
  return {
    calories: Math.round(baselineCalories * ratio),
    protein: Math.round(baselineProtein * ratio * 10) / 10,
  };
}
