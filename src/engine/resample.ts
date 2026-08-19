/**
 * Calibration of traced pixel paths into data values, resampling, and the
 * uncertainty that follows from the drawn line's own thickness.
 */

import { pixelToValue, scaleAt } from './calibration.ts';
import type {
  AxisCalibration,
  Calibration,
  DataSeries,
  TracePoint,
  TracedSeries,
  Uncertainty,
} from './types.ts';

export type ResampleMode =
  | { kind: 'native' }
  | {
      kind: 'uniform';
      count: number;
      /**
       * Pixel range the grid spans. Given one, every series lands on the *same*
       * x values, which is what lets the export be one table with one x column.
       * Omitted, each series spans its own extent.
       */
      range?: readonly [number, number];
    };

/**
 * Resample a traced path onto a uniform grid along the axis's own coordinate.
 *
 * Uniform in pixels is uniform in x on a linear axis and uniform in log10(x) on
 * a logarithmic one, which is what "evenly spaced" means on the axis as drawn.
 * It also keeps the sampling density constant in pixels, where the accuracy
 * actually lives.
 *
 * Where the grid runs past a series' own extent the point is emitted as NaN
 * rather than extrapolated, so a shorter series leaves the cell blank instead
 * of claiming a value the chart never drew.
 */
export function resamplePixels(points: TracePoint[], mode: ResampleMode): TracePoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.px - b.px);
  if (mode.kind === 'native' || mode.count <= 1) return sorted;

  const first = sorted[0].px;
  const last = sorted[sorted.length - 1].px;
  const lo = mode.range ? mode.range[0] : first;
  const hi = mode.range ? mode.range[1] : last;
  if (!(hi > lo)) return sorted;

  const out: TracePoint[] = [];
  let j = 0;
  for (let i = 0; i < mode.count; i++) {
    const px = lo + ((hi - lo) * i) / (mode.count - 1);
    if (px < first - 0.5 || px > last + 0.5) {
      out.push({ px, py: NaN, weight: 0, interpolated: true });
      continue;
    }
    while (j < sorted.length - 2 && sorted[j + 1].px < px) j++;
    const a = sorted[j];
    const b = sorted[Math.min(j + 1, sorted.length - 1)];
    const t = b.px === a.px ? 0 : (px - a.px) / (b.px - a.px);
    out.push({
      px,
      py: a.py + t * (b.py - a.py),
      weight: a.weight + t * (b.weight - a.weight),
      interpolated: a.interpolated || b.interpolated || t > 0,
    });
  }
  return out;
}

/**
 * Uncertainty from line thickness.
 *
 * A 3 px line over a 600 px axis spanning 0-100 is +/-0.25 no matter how good
 * the algorithm is; this reports that honestly rather than hiding it behind
 * more decimal places.
 */
export function estimateUncertainty(
  cal: Calibration,
  thicknessPx: number,
  strokeWidthPx: number,
): Uncertainty {
  const midX = (cal.x.a.px + cal.x.b.px) / 2;
  const midY = (cal.y.a.px + cal.y.b.px) / 2;
  const halfY = thicknessPx / 2;
  const halfX = strokeWidthPx / 2;
  const u: Uncertainty = {
    x: halfX * scaleAt(cal.x, midX),
    y: halfY * scaleAt(cal.y, midY),
  };
  // On a log axis absolute error scales with the value, so the useful number is
  // the multiplicative one.
  if (cal.y.scale === 'log') u.yRelative = relativeFactor(cal.y, halfY);
  if (cal.x.scale === 'log') u.xRelative = relativeFactor(cal.x, halfX);
  return u;
}

function relativeFactor(cal: AxisCalibration, halfPx: number): number {
  const decadesPerPx =
    (Math.log10(cal.b.value) - Math.log10(cal.a.value)) / (cal.b.px - cal.a.px);
  return Math.pow(10, Math.abs(decadesPerPx) * halfPx) - 1;
}

/** Apply the calibration to a traced series and resample it. */
export function calibrateSeries(
  traced: TracedSeries,
  cal: Calibration,
  mode: ResampleMode,
  name: string,
): DataSeries {
  // Markers are real samples; resampling them would destroy that.
  const pts = traced.mode === 'marker' ? traced.points : resamplePixels(traced.points, mode);
  return {
    name,
    colour: traced.colour,
    mode: traced.mode,
    points: pts.map((p) => ({ x: pixelToValue(cal.x, p.px), y: pixelToValue(cal.y, p.py) })),
    uncertainty: estimateUncertainty(
      cal,
      traced.thicknessPx,
      traced.markerWidthPx > 0 ? traced.markerWidthPx : traced.thicknessPx,
    ),
  };
}
