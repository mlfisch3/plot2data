/**
 * Path tracing and marker extraction in pixel space.
 *
 * Curve mode walks the plot's x columns and takes the *intensity-weighted
 * centroid* of the data ink in each column. Because an antialiased edge pixel
 * carries a partial alpha, that centroid is accurate to a fraction of a pixel -
 * thresholding and taking the middle of the run throws that accuracy away.
 */

import type { Component, SeriesMask } from './segment.ts';
import type { TracePoint, TracedSeries } from './types.ts';

export interface TraceOptions {
  /** Widest run of empty columns bridged by continuity, in pixels. */
  maxGapPx: number;
  /** Alpha below which a pixel is not data ink. */
  minAlpha: number;
  /** How far a run may sit from the previous column's run and still continue it. */
  continuityTolerancePx: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  maxGapPx: 24,
  minAlpha: 0.12,
  continuityTolerancePx: 6,
};

interface Run {
  lo: number;
  hi: number;
  weight: number;
  centroid: number;
}

/** Contiguous vertical runs of ink in one column, with sub-pixel centroids. */
function columnRuns(mask: SeriesMask, x: number, minAlpha: number): Run[] {
  const runs: Run[] = [];
  let y = 0;
  while (y < mask.height) {
    if (mask.alpha[y * mask.width + x] < minAlpha) {
      y++;
      continue;
    }
    const lo = y;
    let weight = 0;
    let moment = 0;
    while (y < mask.height && mask.alpha[y * mask.width + x] >= minAlpha) {
      const a = mask.alpha[y * mask.width + x];
      weight += a;
      moment += a * y;
      y++;
    }
    runs.push({ lo, hi: y - 1, weight, centroid: weight > 0 ? moment / weight : lo });
  }
  return runs;
}

/**
 * Trace one series as a curve.
 *
 * Where a column holds several runs - a curve doubling back, or two branches
 * crossing - continuity with the previous column decides which run continues
 * the path, falling back to the heaviest run when nothing is adjacent.
 */
export function traceCurve(
  mask: SeriesMask,
  options: Partial<TraceOptions> = {},
): { points: TracePoint[]; thicknessPx: number; strokeWidthPx: number } {
  const opts = { ...DEFAULT_TRACE_OPTIONS, ...options };
  const raw: Array<{ run: Run } | null> = new Array(mask.width).fill(null);

  // Seed from the column with the single heaviest run so the walk starts on the
  // path rather than on whatever happens to be at the left edge.
  let seedX = -1;
  let seedRun: Run | null = null;
  const allRuns: Run[][] = [];
  for (let x = 0; x < mask.width; x++) {
    const runs = columnRuns(mask, x, opts.minAlpha);
    allRuns.push(runs);
    for (const r of runs) {
      if (!seedRun || r.weight > seedRun.weight) {
        seedRun = r;
        seedX = x;
      }
    }
  }
  if (!seedRun || seedX < 0) return { points: [], thicknessPx: 0, strokeWidthPx: 0 };

  const pick = (runs: Run[], prev: Run | null): Run | null => {
    if (runs.length === 0) return null;
    if (!prev) return runs.reduce((a, b) => (b.weight > a.weight ? b : a));
    const tol = opts.continuityTolerancePx;
    const overlapping = runs.filter((r) => r.hi >= prev.lo - tol && r.lo <= prev.hi + tol);
    const pool = overlapping.length ? overlapping : runs;
    // Among plausible continuations prefer the closest, breaking ties by weight.
    return pool.reduce((a, b) => {
      const da = Math.abs(a.centroid - prev.centroid);
      const db = Math.abs(b.centroid - prev.centroid);
      if (Math.abs(da - db) < 0.5) return b.weight > a.weight ? b : a;
      return db < da ? b : a;
    });
  };

  raw[seedX] = { run: seedRun };
  let prev: Run | null = seedRun;
  for (let x = seedX + 1; x < mask.width; x++) {
    const r = pick(allRuns[x], prev);
    if (r) {
      raw[x] = { run: r };
      prev = r;
    }
  }
  prev = seedRun;
  for (let x = seedX - 1; x >= 0; x--) {
    const r = pick(allRuns[x], prev);
    if (r) {
      raw[x] = { run: r };
      prev = r;
    }
  }

  const points: TracePoint[] = [];
  let lastIdx = -1;
  for (let x = 0; x < mask.width; x++) {
    const entry = raw[x];
    if (!entry) continue;
    if (lastIdx >= 0 && x - lastIdx > 1 && x - lastIdx - 1 <= opts.maxGapPx) {
      // Bridge dashes, marker gaps and antialiasing dropouts by continuity.
      const a = points[points.length - 1];
      const span = x - lastIdx;
      for (let k = 1; k < span; k++) {
        const t = k / span;
        points.push({
          px: lastIdx + k,
          py: a.py + t * (entry.run.centroid - a.py),
          weight: a.weight + t * (entry.run.weight - a.weight),
          interpolated: true,
        });
      }
    }
    points.push({ px: x, py: entry.run.centroid, weight: entry.run.weight, interpolated: false });
    lastIdx = x;
  }

  const measured = points.filter((p) => !p.interpolated).map((p) => p.weight);
  const thicknessPx = median(measured);
  return { points, thicknessPx, strokeWidthPx: Math.min(thicknessPx, rowThickness(mask, opts.minAlpha)) };
}

/** Median horizontal ink thickness; with the vertical one this bounds the stroke width. */
function rowThickness(mask: SeriesMask, minAlpha: number): number {
  const widths: number[] = [];
  for (let y = 0; y < mask.height; y++) {
    let run = 0;
    for (let x = 0; x < mask.width; x++) {
      const a = mask.alpha[y * mask.width + x];
      if (a >= minAlpha) {
        run += a;
      } else if (run > 0) {
        widths.push(run);
        run = 0;
      }
    }
    if (run > 0) widths.push(run);
  }
  return widths.length ? median(widths) : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Marker mode: each component's alpha-weighted centroid is a real sample of the
 * underlying data, not a resampling of a drawn line.
 */
export function traceMarkers(components: Component[]): {
  points: TracePoint[];
  markerWidthPx: number;
  heightPx: number;
} {
  const points = components
    .map((c) => ({ px: c.cx, py: c.cy, weight: c.area, interpolated: false }))
    .sort((a, b) => a.px - b.px);
  const widths = components.map((c) => c.bounds.x1 - c.bounds.x0 + 1);
  const heights = components.map((c) => c.bounds.y1 - c.bounds.y0 + 1);
  return { points, markerWidthPx: median(widths), heightPx: median(heights) };
}

/** Convert mask-local coordinates back to image pixel coordinates. */
export function toImageSpace(series: TracedSeries, mask: SeriesMask): TracedSeries {
  return {
    ...series,
    points: series.points.map((p) => ({
      ...p,
      px: p.px + mask.rect.x0,
      py: p.py + mask.rect.y0,
    })),
  };
}
