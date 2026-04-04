import { describe, expect, it } from 'vitest';
import {
  evaluateManualNumber,
  expandGramsStarPrefix,
  isSubmittableNumeric,
  parseSubmittableNumber,
  scaleLinkedMacros,
} from './manualNumericInput';

describe('evaluateManualNumber', () => {
  it('returns empty for blank', () => {
    expect(evaluateManualNumber('')).toEqual({ kind: 'empty' });
    expect(evaluateManualNumber('   ')).toEqual({ kind: 'empty' });
  });

  it('evaluates multiplication', () => {
    expect(evaluateManualNumber('180*3')).toEqual({ kind: 'ok', value: 540 });
    expect(evaluateManualNumber('180 * 3')).toEqual({ kind: 'ok', value: 540 });
    expect(evaluateManualNumber('70*20')).toEqual({ kind: 'ok', value: 1400 });
    expect(evaluateManualNumber('70×2')).toEqual({ kind: 'ok', value: 140 });
  });

  it('normalizes fullwidth digits', () => {
    expect(evaluateManualNumber('７０*２')).toEqual({ kind: 'ok', value: 140 });
  });

  it('evaluates addition and mixed ops', () => {
    expect(evaluateManualNumber('20+5')).toEqual({ kind: 'ok', value: 25 });
    expect(evaluateManualNumber('10+2*3')).toEqual({ kind: 'ok', value: 16 });
    expect(evaluateManualNumber('(10+2)*3')).toEqual({ kind: 'ok', value: 36 });
  });

  it('returns incomplete for trailing operator', () => {
    expect(evaluateManualNumber('20*')).toEqual({ kind: 'incomplete' });
    expect(evaluateManualNumber('180*')).toEqual({ kind: 'incomplete' });
    expect(evaluateManualNumber('10+')).toEqual({ kind: 'incomplete' });
  });

  it('returns incomplete for unclosed paren', () => {
    expect(evaluateManualNumber('(')).toEqual({ kind: 'incomplete' });
    expect(evaluateManualNumber('(1+2')).toEqual({ kind: 'incomplete' });
  });

  it('returns invalid for letters or unknown chars', () => {
    expect(evaluateManualNumber('abc')).toEqual({ kind: 'invalid' });
    expect(evaluateManualNumber('180g')).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for adjacent numbers without operator', () => {
    expect(evaluateManualNumber('20 3')).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for division by zero', () => {
    expect(evaluateManualNumber('1/0')).toEqual({ kind: 'invalid' });
  });

  it('handles unary minus and decimals', () => {
    expect(evaluateManualNumber('-5')).toEqual({ kind: 'ok', value: -5 });
    expect(evaluateManualNumber('.5')).toEqual({ kind: 'ok', value: 0.5 });
    expect(evaluateManualNumber('5.5')).toEqual({ kind: 'ok', value: 5.5 });
  });
});

describe('isSubmittableNumeric', () => {
  it('requires ok and non-negative', () => {
    expect(isSubmittableNumeric('100')).toBe(true);
    expect(isSubmittableNumeric('180*3')).toBe(true);
    expect(isSubmittableNumeric('-1')).toBe(false);
    expect(isSubmittableNumeric('20*')).toBe(false);
  });
});

describe('parseSubmittableNumber', () => {
  it('returns numeric value or null', () => {
    expect(parseSubmittableNumber('180*3')).toBe(540);
    expect(parseSubmittableNumber('5-10')).toBe(null);
  });
});

describe('scaleLinkedMacros', () => {
  it('scales from baseline at anchor; reverting grams restores macros', () => {
    const anchor = 50;
    const baselineCal = 100;
    const baselineP = 10;
    expect(scaleLinkedMacros(anchor, baselineCal, baselineP, 100)).toEqual({ calories: 200, protein: 20 });
    expect(scaleLinkedMacros(anchor, baselineCal, baselineP, 50)).toEqual({ calories: 100, protein: 10 });
  });
});

describe('expandGramsStarPrefix', () => {
  it('prepends previous grams when input starts with *', () => {
    expect(expandGramsStarPrefix('*2', '70')).toBe('70*2');
    expect(expandGramsStarPrefix('*20', '70')).toBe('70*20');
    expect(expandGramsStarPrefix('70*2', '70')).toBe('70*2');
  });

  it('leaves input unchanged when no leading *', () => {
    expect(expandGramsStarPrefix('70', '100')).toBe('70');
  });
});
