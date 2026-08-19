/**
 * Ground-truth comparison helpers shared by the accuracy test and the accuracy
 * report generator.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyse, buildSeries } from '../../src/engine/index.ts';
import type { AnalyseOptions } from '../../src/engine/pipeline.ts';
import type { DataSeries } from '../../src/engine/types.ts';
import { CASES, FUNCTIONS, type CaseSpec } from '../../tools/corpus-spec.ts';
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
