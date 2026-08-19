import { describe, expect, it } from 'vitest';
import { parseLabel, parseOffsetAnnotation } from '../src/engine/parse-number.ts';

function value(s: string): number | null {
  return parseLabel(s)?.value ?? null;
}

describe('parseLabel', () => {
  it('reads plain numbers', () => {
    expect(value('0')).toBe(0);
    expect(value('42')).toBe(42);
    expect(value('3.14')).toBeCloseTo(3.14, 10);
    expect(value('.5')).toBe(0.5);
    expect(value('-17')).toBe(-17);
    expect(value('+8')).toBe(8);
  });

  it('reads unicode minus and dashes as negatives', () => {
    expect(value('−5')).toBe(-5);
    expect(value('–2.5')).toBe(-2.5);
  });

  it('applies magnitude suffixes', () => {
    expect(value('42k')).toBe(42_000);
    expect(value('42K')).toBe(42_000);
    expect(value('8k')).toBe(8000);
    expect(value('1.5M')).toBe(1_500_000);
    expect(value('3B')).toBe(3e9);
    expect(value('3bn')).toBe(3e9);
    expect(value('2T')).toBe(2e12);
  });

  it('reads the abbreviated ticks from the multipanel example', () => {
    expect(['42k', '34k', '25k', '17k', '8k', '0'].map(value)).toEqual([
      42000, 34000, 25000, 17000, 8000, 0,
    ]);
    expect(['22k', '18k', '13k', '9k', '4k', '0'].map(value)).toEqual([
      22000, 18000, 13000, 9000, 4000, 0,
    ]);
    expect(['88k', '70k', '53k', '35k', '18k', '0'].map(value)).toEqual([
      88000, 70000, 53000, 35000, 18000, 0,
    ]);
  });

  it('records percent as a unit without rescaling the value', () => {
    const p = parseLabel('60%');
    expect(p?.value).toBe(60);
    expect(p?.unit).toBe('%');
  });

  it('strips currency prefixes and records the symbol', () => {
    const p = parseLabel('$1,200');
    expect(p?.value).toBe(1200);
    expect(p?.unit).toBe('$');
    expect(value('€2.5M')).toBe(2_500_000);
  });

  it('handles thousands separators and decimal commas', () => {
    expect(value('1,234')).toBe(1234);
    expect(value('1,234,567')).toBe(1_234_567);
    expect(value('1.234.567')).toBe(1_234_567);
    expect(value('1 234 567')).toBe(1_234_567);
    expect(value('0,25')).toBe(0.25);
    expect(value('1,5')).toBe(1.5);
    expect(value('1.234,56')).toBeCloseTo(1234.56, 10);
    expect(value('1,234.56')).toBeCloseTo(1234.56, 10);
  });

  it('reads powers of ten in every common written form', () => {
    expect(value('10^0')).toBe(1);
    expect(value('10^7')).toBe(1e7);
    expect(value('10⁷')).toBe(1e7);
    expect(value('10⁰')).toBe(1);
    expect(value('10^-3')).toBeCloseTo(1e-3, 15);
    expect(value('10⁻³')).toBeCloseTo(1e-3, 15);
    expect(value('1×10^6')).toBe(1e6);
    expect(parseLabel('10^6')?.powerOfTen).toBe(true);
  });

  it('reads the microprocessor chart decade labels', () => {
    const labels = ['10^0', '10^1', '10^2', '10^3', '10^4', '10^5', '10^6', '10^7'];
    expect(labels.map(value)).toEqual([1, 10, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7]);
  });

  it('reads scientific notation', () => {
    expect(value('1e6')).toBe(1e6);
    expect(value('2.5e-3')).toBeCloseTo(2.5e-3, 15);
    expect(value('2.5×10^-3')).toBeCloseTo(2.5e-3, 15);
  });

  it('reads the two-decimal ticks from the hits-per-visit example', () => {
    const labels = ['0.00', '0.09', '0.19', '0.28', '0.38', '0.47', '0.57', '0.66', '0.76', '0.85', '0.94'];
    expect(labels.map(value)).toEqual([0, 0.09, 0.19, 0.28, 0.38, 0.47, 0.57, 0.66, 0.76, 0.85, 0.94]);
  });

  it('reads year labels as ordinary numbers', () => {
    expect(['1970', '1980', '2020', '2024'].map(value)).toEqual([1970, 1980, 2020, 2024]);
  });

  it('rejects text that is not a number', () => {
    expect(parseLabel('Women')).toBeNull();
    expect(parseLabel('Hits Average Per Visit')).toBeNull();
    expect(parseLabel('')).toBeNull();
    expect(parseLabel('   ')).toBeNull();
    expect(parseLabel('-')).toBeNull();
    expect(parseLabel('⁶')).toBeNull();
  });
});

describe('parseOffsetAnnotation', () => {
  it('reads matplotlib multiplier annotations', () => {
    expect(parseOffsetAnnotation('1e6')).toEqual({ multiplier: 1e6, offset: 0 });
    expect(parseOffsetAnnotation('1e-3')).toEqual({ multiplier: 1e-3, offset: 0 });
    expect(parseOffsetAnnotation('×10^6')).toEqual({ multiplier: 1e6, offset: 0 });
    expect(parseOffsetAnnotation('10^6')).toEqual({ multiplier: 1e6, offset: 0 });
  });

  it('reads additive offset annotations', () => {
    expect(parseOffsetAnnotation('+3.14')).toEqual({ multiplier: 1, offset: 3.14 });
    expect(parseOffsetAnnotation('-1200')).toEqual({ multiplier: 1, offset: -1200 });
  });

  it('ignores ordinary numbers and noise', () => {
    expect(parseOffsetAnnotation('100')).toBeNull();
    expect(parseOffsetAnnotation('Year')).toBeNull();
    expect(parseOffsetAnnotation('')).toBeNull();
  });
});

describe('parseLabel decimal handling', () => {
  it('never reads a lone period as a thousands separator', () => {
    expect(parseLabel('0.001')?.value).toBeCloseTo(0.001, 15);
    expect(parseLabel('0.01')?.value).toBeCloseTo(0.01, 15);
    expect(parseLabel('1.000')?.value).toBeCloseTo(1, 15);
    expect(parseLabel('2.500')?.value).toBeCloseTo(2.5, 15);
  });
});
