/**
 * Tick-label number parsing.
 *
 * This is where silent wrong answers come from. Reading `42k` as `42` puts the
 * whole export off by 1000 with nothing in the UI to show for it, so every
 * abbreviation the wild throws at us is handled explicitly and unit-tested.
 *
 * Handled: unicode minus and dashes, thousands separators (comma, period,
 * space, thin space, apostrophe), decimal comma, magnitude suffixes
 * (k/K/M/MM/B/bn/T), percent, currency prefixes, scientific notation, the
 * `x10^n` / `10^n` / `10<superscript>` forms used on log axes, and superscript
 * digits on their own.
 */

export interface ParsedLabel {
  /** Numeric value of the label, with magnitude suffixes already applied. */
  value: number;
  /** Unit symbol carried by this label, if any. Applied to the whole axis. */
  unit?: string;
  /** Magnitude suffix that was applied, for display ('k', 'M', ...). */
  suffix?: string;
  /** True when the label was written as a power of ten (`10^6`, `10⁶`). */
  powerOfTen?: boolean;
  /** The cleaned text the value was parsed from. */
  normalised: string;
}

const SUPERSCRIPT: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
};

const SUFFIXES: Array<{ re: RegExp; factor: number; label: string }> = [
  { re: /^(?:bn|b)$/i, factor: 1e9, label: 'B' },
  { re: /^(?:mm|m)$/, factor: 1e6, label: 'M' },
  { re: /^m$/i, factor: 1e6, label: 'M' },
  { re: /^k$/i, factor: 1e3, label: 'k' },
  { re: /^t$/i, factor: 1e12, label: 'T' },
  { re: /^(?:tn)$/i, factor: 1e12, label: 'T' },
];

const CURRENCY = /[$€£¥₹₩]/g;

/** Map superscript characters to their ASCII equivalents. */
export function unsuperscript(text: string): string {
  let out = '';
  for (const ch of text) out += SUPERSCRIPT[ch] ?? ch;
  return out;
}

/** True if every character of `text` is a superscript digit or sign. */
function isAllSuperscript(text: string): boolean {
  return text.length > 0 && [...text].every((ch) => ch in SUPERSCRIPT);
}

function normaliseDashes(text: string): string {
  return text
    .replace(/[−–—‒－]/g, '-')
    .replace(/[    ]/g, ' ');
}

/**
 * Strip digit-group separators without destroying a decimal comma.
 *
 * `1,234` is one thousand two hundred and thirty four; `1,5` is one and a half.
 * The rule that separates them is that a group separator is always followed by
 * exactly three digits and there is more than one digit before it, or the
 * pattern repeats.
 */
function stripGroupSeparators(text: string): string {
  let s = text.replace(/['’]/g, '').replace(/(\d) (?=\d{3}\b)/g, '$1');
  // Comma or period used as a repeated group separator: 1,234,567 / 1.234.567
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return s.replace(/[.,]/g, '');
  // Mixed form: 1.234,56 (EU) or 1,234.56 (US) - the last separator is decimal.
  const mixed = /^-?\d{1,3}(?:([.,])\d{3})+([.,])\d+$/.exec(s);
  if (mixed && mixed[1] !== mixed[2]) {
    return s.split(mixed[1]).join('').replace(mixed[2], '.');
  }
  // Lone comma with a non-3-digit tail is a decimal comma: 1,5 or 0,25
  if (/^-?\d+,\d{1,2}$/.test(s) || /^-?\d+,\d{4,}$/.test(s)) return s.replace(',', '.');
  // Lone comma with exactly 3 trailing digits is ambiguous; treat as a group
  // separator, which is overwhelmingly the more common intent on chart axes.
  if (/^-?\d+,\d{3}$/.test(s)) return s.replace(',', '');
  return s;
}

/**
 * Parse one tick label. Returns `null` when the text carries no usable number,
 * which is the normal outcome for a misread or an axis title caught by mistake.
 */
export function parseLabel(raw: string): ParsedLabel | null {
  if (!raw) return null;
  let text = normaliseDashes(raw).trim();
  if (!text) return null;

  // A bare superscript run is an exponent that lost its base in OCR.
  if (isAllSuperscript(text)) return null;

  let unit: string | undefined;
  if (text.includes('%')) {
    unit = '%';
    text = text.replace(/%/g, '');
  }
  const currency = text.match(CURRENCY);
  if (currency) {
    unit = currency[0];
    text = text.replace(CURRENCY, '');
  }
  CURRENCY.lastIndex = 0;
  text = text.trim();

  // Power-of-ten forms: 10^6, 10**6, 10E6, 10⁶, x10⁶, ×10^6, 1×10^6.
  const pow = matchPowerOfTen(text);
  if (pow !== null) {
    return { value: pow.value, unit, powerOfTen: true, normalised: pow.normalised };
  }

  text = unsuperscript(text);
  // Scientific notation written with a multiplication sign: 2.5×10-3
  text = text.replace(/[×x*]\s*10\s*\^?\s*/gi, 'e');
  text = text.replace(/\s+/g, ' ').trim();

  // Trailing magnitude suffix.
  let factor = 1;
  let suffix: string | undefined;
  const sufMatch = /^(.*?)([a-z]{1,2})$/i.exec(text);
  if (sufMatch && /\d/.test(sufMatch[1]) && !/e$/i.test(sufMatch[1])) {
    for (const s of SUFFIXES) {
      if (s.re.test(sufMatch[2])) {
        factor = s.factor;
        suffix = s.label;
        text = sufMatch[1].trim();
        break;
      }
    }
  }

  text = stripGroupSeparators(text.replace(/\s/g, ''));
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return { value: value * factor, unit, suffix, normalised: text };
}

function matchPowerOfTen(text: string): { value: number; normalised: string } | null {
  const t = text.replace(/\s+/g, '');
  // 10^6, 10**6, 10E6 (only when the mantissa is exactly 10 and there is a
  // marker), and 10 followed by superscript digits.
  const explicit = /^(?:[-+]?1(?:\.0+)?)?[×x*]?10(?:\^|\*\*)([-+]?\d+)$/i.exec(t);
  if (explicit) return { value: Math.pow(10, Number(explicit[1])), normalised: `1e${explicit[1]}` };

  const supMatch = /^(?:[-+]?1(?:\.0+)?)?[×x*]?10([⁰¹²³⁴-⁹⁺⁻]+)$/.exec(t);
  if (supMatch) {
    const exp = Number(unsuperscript(supMatch[1]));
    if (Number.isFinite(exp)) return { value: Math.pow(10, exp), normalised: `1e${exp}` };
  }
  return null;
}

/**
 * Parse an axis offset/multiplier annotation such as matplotlib's `1e6` or
 * `+3.14` printed in the corner of the axis region.
 */
export function parseOffsetAnnotation(raw: string): { multiplier: number; offset: number } | null {
  const text = normaliseDashes(raw).replace(/\s+/g, '').trim();
  if (!text) return null;

  // Additive offset: a leading sign is mandatory, that is what marks it.
  if (/^[-+]/.test(text)) {
    const parsed = parseLabel(text);
    if (parsed && parsed.value !== 0) return { multiplier: 1, offset: parsed.value };
    return null;
  }

  const pow = matchPowerOfTen(text);
  if (pow) return { multiplier: pow.value, offset: 0 };

  // Bare scientific notation: 1e6, 1e-3, 2.5e8.
  if (/^\d(?:\.\d+)?e[-+]?\d+$/i.test(text)) {
    const v = Number(text);
    if (Number.isFinite(v) && v !== 1) return { multiplier: v, offset: 0 };
  }
  return null;
}
