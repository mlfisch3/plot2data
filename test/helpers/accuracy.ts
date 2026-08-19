/**
 * Ground-truth comparison helpers shared by the accuracy test and the accuracy
 * report generator.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyse, buildSeries } from '../../src/engine/index.ts';
import type { AnalyseOptions } from '../../src/engine/pipeline.ts';
import type { DataSeries } from '../../src/engine/types.ts';
import { CASES, DEFAULT_RMS_BUDGET, FUNCTIONS, type CaseSpec } from '../../tools/corpus-spec.ts';
import { loadImage } from './load-image.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const CORPUS = resolve(ROOT, 'corpus');

export interface SeriesError {
  label: string;
  /** RMS error as a percentage of the axis full-scale range. */
  rmsPercent: number;
  maxPercent: number;
  /** RMS x error as a percentage of the x range. */
  rmsXPercent: number;
  points: number;
  /** Fraction of the true x range the extracted series actually spans. */
  coverage: number;
  /** Peak-height error, measured only at the turning points. See `peakError`. */
  peak: PeakError;
}

/**
 * How well the turning points come back.
 *
 * A headline RMS averages over every x, and a plot's peaks are a tiny fraction
 * of its columns - so a tracer can shave a third off every spike and still
 * score under a tenth of a percent. That is exactly what happened, so peaks get
 * their own metric.
 *
 * `shortfallPercent` is signed and measured *inwards*: positive means the
 * extracted extremum falls short of the true one, at a maximum and at a minimum
 * alike. A systematic clip therefore shows up as a positive mean rather than
 * cancelling itself out.
 */
export interface PeakError {
  /** Number of true turning points prominent enough to measure. */
  count: number;
  /** Mean signed shortfall as a percentage of the y full-scale range. */
  shortfallPercent: number;
  /** Worst single shortfall, same units. */
  worstPercent: number;
  /** RMS of the signed shortfalls, same units. */
  rmsPercent: number;
}

const NO_PEAKS: PeakError = { count: 0, shortfallPercent: 0, worstPercent: 0, rmsPercent: 0 };

/** A turning point of the ground-truth function, with its prominence. */
interface Extremum {
  x: number;
  y: number;
  kind: 'max' | 'min';
  prominence: number;
}

/**
 * Turning points of the truth function, found by dense sampling.
 *
 * Prominence is the smaller of the two drops to the neighbouring turning
 * points, which is what separates a real peak from a ripple; anything under 5%
 * of full scale is not a peak worth holding the tracer to.
 */
function trueExtrema(spec: CaseSpec, seriesIndex: number, yRange: number): Extremum[] {
  const steps = 4000;
  const logX = spec.xScale === 'logarithmic';
  const lo = logX ? Math.log10(spec.xMin) : spec.xMin;
  const hi = logX ? Math.log10(spec.xMax) : spec.xMax;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const v = lo + ((hi - lo) * i) / steps;
    const x = logX ? Math.pow(10, v) : v;
    xs.push(x);
    ys.push(measure(spec, truthAt(spec, seriesIndex, x)));
  }

  const turns: Array<{ i: number; kind: 'max' | 'min' }> = [];
  for (let i = 1; i < steps; i++) {
    const before = ys[i] - ys[i - 1];
    const after = ys[i + 1] - ys[i];
    if (before > 0 && after <= 0) turns.push({ i, kind: 'max' });
    else if (before < 0 && after >= 0) turns.push({ i, kind: 'min' });
  }
  // Collapse the runs of equal samples a flat-topped extremum produces.
  const merged = turns.filter((t, k) => k === 0 || t.i - turns[k - 1].i > 2 || t.kind !== turns[k - 1].kind);

  const out: Extremum[] = [];
  for (let k = 0; k < merged.length; k++) {
    const t = merged[k];
    const left = k > 0 ? ys[merged[k - 1].i] : ys[0];
    const right = k < merged.length - 1 ? ys[merged[k + 1].i] : ys[steps];
    const prominence = Math.min(Math.abs(ys[t.i] - left), Math.abs(ys[t.i] - right));
    if (prominence < yRange * 0.05) continue;
    out.push({ x: xs[t.i], y: ys[t.i], kind: t.kind, prominence });
  }
  return out;
}

/** y in the space the error is measured in: log10 for a log axis. */
function measure(spec: CaseSpec, y: number): number {
  return spec.yScale === 'logarithmic' ? Math.log10(Math.max(y, 1e-12)) : y;
}

/**
 * Compare the extracted turning points against the true ones.
 *
 * The search window is a few pixel columns wide, because a peak the tracer
 * places one column off is still the same peak; anything wider would let a
 * neighbouring feature stand in for a peak that was missed entirely.
 */
function peakError(
  spec: CaseSpec,
  seriesIndex: number,
  points: Array<{ x: number; y: number }>,
  yRange: number,
  pixelsPerXUnit: number,
): PeakError {
  const extrema = trueExtrema(spec, seriesIndex, yRange);
  const window = 3 / Math.max(1e-9, pixelsPerXUnit);
  const shortfalls: number[] = [];
  for (const e of extrema) {
    const t = (e.x - spec.xMin) / (spec.xMax - spec.xMin);
    if (t < 0.01 || t > 0.99) continue;
    let best: number | null = null;
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (Math.abs(p.x - e.x) > window) continue;
      const y = measure(spec, p.y);
      if (best === null) best = y;
      else best = e.kind === 'max' ? Math.max(best, y) : Math.min(best, y);
    }
    if (best === null) continue;
    shortfalls.push(e.kind === 'max' ? e.y - best : best - e.y);
  }
  if (shortfalls.length === 0) return NO_PEAKS;
  const pct = (v: number) => (v / yRange) * 100;
  const mean = shortfalls.reduce((a, b) => a + b, 0) / shortfalls.length;
  const sse = shortfalls.reduce((a, b) => a + b * b, 0) / shortfalls.length;
  return {
    count: shortfalls.length,
    shortfallPercent: pct(mean),
    worstPercent: pct(Math.max(...shortfalls)),
    rmsPercent: pct(Math.sqrt(sse)),
  };
}

export interface CaseResult {
  id: string;
  description: string;
  detectedSeries: number;
  expectedSeries: number;
  mode: string;
  xScale: string;
  yScale: string;
  xRangeError: number;
  yRangeError: number;
  errors: SeriesError[];
  warnings: string[];
  worstRms: number;
  /** RMS budget this case is held to, as a percentage of full scale. */
  rmsBudget: number;
}

/** Truth for a case, evaluated analytically at any x. */
export function truthAt(spec: CaseSpec, seriesIndex: number, x: number): number {
  return FUNCTIONS[spec.series[seriesIndex].fn](x);
}

/**
 * Match extracted series to ground-truth series by colour, then by best fit.
 * Series order out of the engine follows pixel count, not the chart's order.
 */
function matchSeries(spec: CaseSpec, extracted: DataSeries[]): Array<number | null> {
  const wanted = spec.series.map((s) => hexToRgb(s.colour));
  const used = new Set<number>();
  return wanted.map((w) => {
    let best: number | null = null;
    let bestD = Infinity;
    for (let i = 0; i < extracted.length; i++) {
      if (used.has(i)) continue;
      const c = extracted[i].colour;
      const d = Math.hypot(c.r - w.r, c.g - w.g, c.b - w.b);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best !== null && bestD < 110) {
      used.add(best);
      return best;
    }
    return null;
  });
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = parseInt(hex.replace('#', ''), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

export async function runCase(spec: CaseSpec, options: AnalyseOptions = {}): Promise<CaseResult> {
  const file = resolve(CORPUS, `${spec.id}.${spec.format === 'jpeg' ? 'jpg' : 'png'}`);
  const img = loadImage(file);
  const analysis = await analyse(img, options);
  const series = buildSeries(analysis, { resample: { kind: 'uniform', count: 200 } });
  // Peaks are measured at native resolution: a 200-point resample can step over
  // a spike that is four columns wide, and that would measure the sampling
  // rather than the tracer.
  const native = buildSeries(analysis, { resample: { kind: 'native' } });
  const rect = analysis.frame.rect;
  const pixelsPerXUnit = (rect.x1 - rect.x0) / Math.max(1e-9, spec.xMax - spec.xMin);

  const yRange = spec.yScale === 'logarithmic'
    ? Math.log10(spec.yMax) - Math.log10(spec.yMin)
    : spec.yMax - spec.yMin;
  const xRange = spec.xScale === 'logarithmic'
    ? Math.log10(spec.xMax) - Math.log10(spec.xMin)
    : spec.xMax - spec.xMin;

  const cal = analysis.calibration;
  const xLo = Math.min(cal.x.a.value * cal.x.multiplier + cal.x.offset, cal.x.b.value * cal.x.multiplier + cal.x.offset);
  const xHi = Math.max(cal.x.a.value * cal.x.multiplier + cal.x.offset, cal.x.b.value * cal.x.multiplier + cal.x.offset);
  const yLo = Math.min(cal.y.a.value * cal.y.multiplier + cal.y.offset, cal.y.b.value * cal.y.multiplier + cal.y.offset);
  const yHi = Math.max(cal.y.a.value * cal.y.multiplier + cal.y.offset, cal.y.b.value * cal.y.multiplier + cal.y.offset);

  const match = matchSeries(spec, series);
  const errors: SeriesError[] = [];

  for (let s = 0; s < spec.series.length; s++) {
    const idx = match[s];
    if (idx === null) {
      errors.push({
        label: spec.series[s].label,
        rmsPercent: NaN,
        maxPercent: NaN,
        rmsXPercent: NaN,
        points: 0,
        coverage: 0,
        peak: NO_PEAKS,
      });
      continue;
    }
    const pts = series[idx].points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const spanLo = pts.length ? Math.min(...pts.map((p) => p.x)) : 0;
    const spanHi = pts.length ? Math.max(...pts.map((p) => p.x)) : 0;
    const coverage = spec.xScale === 'logarithmic'
      ? (Math.log10(Math.max(spanHi, 1e-12)) - Math.log10(Math.max(spanLo, 1e-12))) /
        (Math.log10(spec.xMax) - Math.log10(spec.xMin))
      : (spanHi - spanLo) / (spec.xMax - spec.xMin);
    let sse = 0;
    let sseX = 0;
    let worst = 0;
    let n = 0;
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      // Ignore the outermost 1% of the axis: the drawn line is clipped there.
      const t = (p.x - spec.xMin) / (spec.xMax - spec.xMin);
      if (t < 0.005 || t > 0.995) continue;
      const truth = truthAt(spec, s, p.x);
      const err = spec.yScale === 'logarithmic'
        ? Math.log10(Math.max(p.y, 1e-12)) - Math.log10(truth)
        : p.y - truth;
      sse += err * err;
      worst = Math.max(worst, Math.abs(err));
      // x error: how far the traced point's x is from where that y occurs is
      // not well defined for a general curve, so we report the calibration's
      // own x placement error via the axis range instead.
      n++;
    }
    errors.push({
      label: spec.series[s].label,
      rmsPercent: n ? (Math.sqrt(sse / n) / yRange) * 100 : NaN,
      maxPercent: n ? (worst / yRange) * 100 : NaN,
      rmsXPercent: n ? (Math.sqrt(sseX / n) / xRange) * 100 : 0,
      points: n,
      coverage,
      peak: peakError(spec, s, native[idx]?.points ?? [], yRange, pixelsPerXUnit),
    });
  }

  const xErr = spec.xScale === 'logarithmic'
    ? (Math.abs(Math.log10(Math.max(xLo, 1e-12)) - Math.log10(spec.xMin)) +
       Math.abs(Math.log10(Math.max(xHi, 1e-12)) - Math.log10(spec.xMax))) / 2
    : (Math.abs(xLo - spec.xMin) + Math.abs(xHi - spec.xMax)) / 2;
  const yErr = spec.yScale === 'logarithmic'
    ? (Math.abs(Math.log10(Math.max(yLo, 1e-12)) - Math.log10(spec.yMin)) +
       Math.abs(Math.log10(Math.max(yHi, 1e-12)) - Math.log10(spec.yMax))) / 2
    : (Math.abs(yLo - spec.yMin) + Math.abs(yHi - spec.yMax)) / 2;

  const finite = errors.map((e) => e.rmsPercent).filter((v) => Number.isFinite(v));
  return {
    id: spec.id,
    description: spec.description,
    detectedSeries: series.length,
    expectedSeries: spec.series.length,
    mode: series.length ? series[0].mode : 'none',
    xScale: analysis.calibration.x.scale,
    yScale: analysis.calibration.y.scale,
    xRangeError: (xErr / xRange) * 100,
    yRangeError: (yErr / yRange) * 100,
    errors,
    warnings: analysis.warnings.map((w) => `${w.level}: ${w.message}`),
    worstRms: finite.length ? Math.max(...finite) : NaN,
    rmsBudget: spec.rmsBudgetPercent ?? DEFAULT_RMS_BUDGET,
  };
}

export function loadTruthCsv(id: string): Array<number[]> {
  const text = readFileSync(resolve(CORPUS, `${id}.csv`), 'utf8');
  return text
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(',').map(Number));
}

export { CASES };
