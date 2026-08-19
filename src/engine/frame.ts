/**
 * Plot frame and axis line detection.
 *
 * The signal is long straight runs of ink. Axis spines differ from gridlines in
 * three ways that we exploit: they are stronger (higher contrast against the
 * background), they are achromatic, and they sit at the outside of the data
 * area. Data series are rejected because they are rarely straight for a long
 * run and are usually coloured.
 */

import { clampRect, colourDistance, dominantColour, getPixel, isGray, luma } from './image.ts';
import type { ImageBuffer, PlotFrame, RGB, Rect, SpineLine } from './types.ts';

export interface FrameOptions {
  /** Minimum fraction of the image span a run must cover to be a spine candidate. */
  minRunFraction: number;
  /** Ink threshold: colour distance from background that counts as ink. */
  inkThreshold: number;
  /** Max saturation for a run to be considered axis chrome rather than data. */
  maxSpineSaturation: number;
}

export const DEFAULT_FRAME_OPTIONS: FrameOptions = {
  minRunFraction: 0.4,
  inkThreshold: 40,
  maxSpineSaturation: 0.35,
};

interface RunCandidate {
  pos: number;
  start: number;
  end: number;
  length: number;
  strength: number;
  gray: boolean;
}

/**
 * Longest near-contiguous ink run along one row (or column), tolerating small
 * gaps so that a spine crossed by tick labels or a legend is still one run.
 */
function longestRun(
  span: number,
  isInk: (i: number) => number,
  maxGap: number,
): { start: number; end: number; strength: number } {
  let bestStart = 0;
  let bestEnd = -1;
  let bestSum = 0;
  let curStart = -1;
  let curSum = 0;
  let gap = 0;
  let lastInk = -1;
  for (let i = 0; i < span; i++) {
    const s = isInk(i);
    if (s > 0) {
      if (curStart < 0) {
        curStart = i;
        curSum = 0;
      }
      curSum += s;
      lastInk = i;
      gap = 0;
    } else if (curStart >= 0) {
      gap++;
      if (gap > maxGap) {
        if (lastInk - curStart > bestEnd - bestStart) {
          bestStart = curStart;
          bestEnd = lastInk;
          bestSum = curSum;
        }
        curStart = -1;
        gap = 0;
      }
    }
  }
  if (curStart >= 0 && lastInk - curStart > bestEnd - bestStart) {
    bestStart = curStart;
    bestEnd = lastInk;
    bestSum = curSum;
  }
  const len = bestEnd - bestStart + 1;
  return { start: bestStart, end: bestEnd, strength: len > 0 ? bestSum / len : 0 };
}

function scanLines(
  img: ImageBuffer,
  bg: RGB,
  horizontal: boolean,
  opts: FrameOptions,
): RunCandidate[] {
  const outer = horizontal ? img.height : img.width;
  const span = horizontal ? img.width : img.height;
  const maxGap = Math.max(3, Math.round(span * 0.02));
  const minLen = span * opts.minRunFraction;
  const raw: RunCandidate[] = [];

  for (let p = 0; p < outer; p++) {
    let satSum = 0;
    let satN = 0;
    const run = longestRun(
      span,
      (i) => {
        const c = horizontal ? getPixel(img, i, p) : getPixel(img, p, i);
        const d = colourDistance(c, bg);
        if (d < opts.inkThreshold) return 0;
        satSum += isGray(c, opts.maxSpineSaturation) ? 0 : 1;
        satN++;
        return Math.min(1, d / 160);
      },
      maxGap,
    );
    const len = run.end - run.start + 1;
    if (len < minLen) continue;
    const colouredFraction = satN > 0 ? satSum / satN : 0;
    raw.push({
      pos: p,
      start: run.start,
      end: run.end,
      length: len,
      strength: run.strength,
      gray: colouredFraction < 0.4,
    });
  }
  return raw;
}

/** Merge adjacent rows/columns belonging to the same physical line. */
function mergeBands(cands: RunCandidate[]): SpineLine[] {
  const out: SpineLine[] = [];
  let i = 0;
  while (i < cands.length) {
    let j = i;
    while (j + 1 < cands.length && cands[j + 1].pos === cands[j].pos + 1) j++;
    const band = cands.slice(i, j + 1);
    // Ink-weighted centre of the band gives sub-pixel spine position.
    let wsum = 0;
    let psum = 0;
    for (const c of band) {
      wsum += c.strength;
      psum += c.strength * c.pos;
    }
    out.push({
      pos: wsum > 0 ? psum / wsum : band[0].pos,
      thickness: band.length,
      start: Math.min(...band.map((c) => c.start)),
      end: Math.max(...band.map((c) => c.end)),
      strength: Math.max(...band.map((c) => c.strength)),
    });
    i = j + 1;
  }
  return out;
}

function pickSpine(
  bands: Array<SpineLine & { gray: boolean }>,
  prefer: 'max' | 'min',
  limit: { lo: number; hi: number },
): SpineLine | null {
  const strongest = Math.max(0, ...bands.map((b) => b.strength));
  const eligible = bands.filter(
    (b) => b.pos >= limit.lo && b.pos <= limit.hi && b.strength >= strongest * 0.55 && b.gray,
  );
  if (eligible.length === 0) return null;
  // Prefer the longest run; break ties by extremity in the requested direction.
  const maxLen = Math.max(...eligible.map((b) => b.end - b.start));
  const longEnough = eligible.filter((b) => b.end - b.start >= maxLen * 0.9);
  longEnough.sort((a, b) => (prefer === 'max' ? b.pos - a.pos : a.pos - b.pos));
  return longEnough[0];
}

/**
 * Detect the plot frame.
 *
 * A plot may have a full box or only bottom+left spines. Either way the spines'
 * own extents define the data rectangle, so we do not need all four.
 */
export function detectFrame(img: ImageBuffer, options: Partial<FrameOptions> = {}): PlotFrame {
  const opts = { ...DEFAULT_FRAME_OPTIONS, ...options };
  const bg = dominantColour(img);
  const darkTheme = luma(bg) < 128;

  const hCands = scanLines(img, bg, true, opts);
  const vCands = scanLines(img, bg, false, opts);
  const hBands = mergeBands(hCands).map((b) => ({ ...b, gray: bandGray(hCands, b) }));
  const vBands = mergeBands(vCands).map((b) => ({ ...b, gray: bandGray(vCands, b) }));

  const bottom = pickSpine(hBands, 'max', { lo: img.height * 0.3, hi: img.height - 1 });
  const top = pickSpine(hBands, 'min', { lo: 0, hi: img.height * 0.5 });
  const left = pickSpine(vBands, 'min', { lo: 0, hi: img.width * 0.6 });
  const right = pickSpine(vBands, 'max', { lo: img.width * 0.4, hi: img.width - 1 });

  // `top`/`bottom` (and `left`/`right`) collapse onto the same band when the
  // plot has only one spine on that axis; keep the outer one and drop the twin.
  const distinctBottom = bottom;
  const distinctTop = top && bottom && Math.abs(bottom.pos - top.pos) <= 8 ? null : top;
  const distinctLeft = left;
  const distinctRight = right && left && Math.abs(right.pos - left.pos) <= 8 ? null : right;

  // Build the data rectangle. Spine positions bound it directly; where a spine
  // is missing we fall back to the perpendicular spine's own extent.
  let x0 = distinctLeft ? distinctLeft.pos : (distinctBottom?.start ?? 0);
  let x1 = distinctRight ? distinctRight.pos : (distinctBottom?.end ?? img.width - 1);
  let y0 = distinctTop ? distinctTop.pos : (distinctLeft?.start ?? 0);
  let y1 = distinctBottom ? distinctBottom.pos : (distinctLeft?.end ?? img.height - 1);

  if (x1 - x0 < 10) {
    x0 = 0;
    x1 = img.width - 1;
  }
  if (y1 - y0 < 10) {
    y0 = 0;
    y1 = img.height - 1;
  }

  const rect: Rect = clampRect({ x0, y0, x1, y1 }, img);
  const found = [distinctBottom, distinctLeft, distinctTop, distinctRight].filter(Boolean).length;
  const interiorBg = dominantColour(img, insetRect(rect, 3));

  return {
    rect,
    bottom: distinctBottom ?? null,
    left: distinctLeft ?? null,
    top: distinctTop ?? null,
    right: distinctRight ?? null,
    background: interiorBg,
    darkTheme,
    confidence: Math.min(1, (distinctBottom ? 0.4 : 0) + (distinctLeft ? 0.4 : 0) + found * 0.05),
  };
}

function bandGray(cands: RunCandidate[], band: SpineLine): boolean {
  const members = cands.filter((c) => Math.abs(c.pos - band.pos) <= band.thickness);
  if (members.length === 0) return true;
  return members.filter((m) => m.gray).length * 2 >= members.length;
}

export function insetRect(r: Rect, by: number): Rect {
  return { x0: r.x0 + by, y0: r.y0 + by, x1: r.x1 - by, y1: r.y1 - by };
}
