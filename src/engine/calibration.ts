/**
 * Pixel-to-data calibration.
 *
 * Two rules drive this module, and both exist to stop the tool being silently
 * wrong:
 *
 * 1. The mapping is always expressible as two anchors the user can see and
 *    edit. Whatever fitting happens underneath, what ships to the CSV is a
 *    two-anchor mapping the user has had the chance to check.
 * 2. Anchors are pre-filled by a *least-squares fit over every readable tick*,
 *    not by trusting two of them. Real charts round their printed tick values
 *    (0, 4k, 9k, 13k, 18k, 22k for evenly spaced pixels), so a two-point fit off
 *    the extremes inherits the rounding error of exactly those two labels. The
 *    fit residual is reported so a misread label shows up as a warning instead
 *    of a wrong number.
 */

import type {
  Anchor,
  AxisCalibration,
  AxisScale,
  AxisSide,
  LabelledTick,
  ScaleFitReport,
} from './types.ts';

/** A pixel position with a known data value, used as fit input. */
export interface FitSample {
  px: number;
  value: number;
}

export interface AxisFit {
  scale: AxisScale;
  /** value = slope * px + intercept, in the scale's own space (log10 for log). */
  slope: number;
  intercept: number;
  /** RMS residual in the scale's own space. */
  residual: number;
  /** Residual as a fraction of the full data range across the fitted pixels. */
  relativeResidual: number;
  samples: number;
  /** Labels discarded as misreads before the final fit. */
  dropped: FitSample[];
}

function leastSquares(samples: FitSample[], transform: (v: number) => number): AxisFit | null {
  const pts = samples
    .map((s) => ({ px: s.px, y: transform(s.value) }))
    .filter((p) => Number.isFinite(p.y) && Number.isFinite(p.px));
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.px;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.px - mx) * (p.px - mx);
    sxy += (p.px - mx) * (p.y - my);
  }
  if (Math.abs(sxx) < 1e-9) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (const p of pts) {
    const e = p.y - (slope * p.px + intercept);
    sse += e * e;
  }
  const residual = Math.sqrt(sse / n);
  const spanPx = Math.max(...pts.map((p) => p.px)) - Math.min(...pts.map((p) => p.px));
  const spanValue = Math.abs(slope * spanPx);
  return {
    scale: 'linear',
    slope,
    intercept,
    residual,
    relativeResidual: spanValue > 0 ? residual / spanValue : Infinity,
    samples: n,
    dropped: [],
  };
}

/**
 * Least squares with misread-label rejection.
 *
 * OCR gets a label wrong now and then - `0.1` read as `1` is a whole decade,
 * `12` read as `17` shifts the whole axis - and one bad label drags a plain
 * least-squares fit off for every point. Residual-trimming does not find these:
 * a single large outlier inflates the residuals of the good points too. So we
 * look for the largest set of labels that agree on one straight mapping, and
 * only adopt it when it is dramatically better than fitting everything, which
 * keeps merely *rounded* labels (`0, 4k, 9k, 13k, 18k, 22k`) in the fit where
 * they belong. Whatever is dropped is reported, never hidden.
 *
 * The RANSAC step runs whenever the full fit has any detectable residual,
 * rather than only when the residual is already large. The women-men chart
 * misprints `2021` where the regular decade grid would put `2020` and the full
 * fit absorbs the one-year error silently; running RANSAC always lets it be
 * dropped as soon as the inlier fit is dramatically better.
 */
function robustLeastSquares(
  samples: FitSample[],
  transform: (v: number) => number,
): AxisFit | null {
  const full = leastSquares(samples, transform);
  if (!full) return null;
  if (samples.length < 4) return full;

  const pts = samples
    .map((s) => ({ s, y: transform(s.value) }))
    .filter((p) => Number.isFinite(p.y));
  if (pts.length < 4) return full;
  const range = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
  if (!(range > 0)) return full;
  // Tolerance from what the labels can actually tell us, not from their spread:
  // a single wild misread inflates the spread and then hides inside the wider
  // tolerance it created. Ticks are placed to about a pixel, and printed values
  // are rounded to their own last digit; those two bound the honest error.
  const quantum = inferQuantum(pts.map((p) => p.y));

  // Pair-wise RANSAC: for each pair, call every point within tolerance of the
  // pair's line an inlier. The tolerance keeps a comfortable envelope around
  // honest rounded labels (`0, 4k, 9k, 13k, 18k, 22k` for evenly spaced ticks).
  let best: FitSample[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].s.px - pts[i].s.px;
      if (Math.abs(dx) < 1e-9) continue;
      const slope = (pts[j].y - pts[i].y) / dx;
      const intercept = pts[i].y - slope * pts[i].s.px;
      const tol = Math.max(Math.abs(slope) * 3, quantum * 0.6, range * 1e-9);
      const inliers = pts
        .filter((p) => Math.abs(p.y - (slope * p.s.px + intercept)) <= tol)
        .map((p) => p.s);
      if (inliers.length > best.length) best = inliers;
    }
  }

  // Leave-one-out: a label that is off by less than the RANSAC tolerance can
  // still be the only reason the fit is not clean. The women-men chart's
  // `2021` misprint sits one year off a decade grid and is well inside both
  // the pixel tolerance and the quantum envelope, but dropping it alone makes
  // the fit perfect. Only consider leave-one-out when the full fit still
  // leaves pixel-scale residuals and dropping the one is dramatic.
  if (best.length === pts.length && pts.length >= 5) {
    const fullResidualPx = full.residual / Math.max(Math.abs(full.slope), 1e-12);
    if (fullResidualPx >= 0.5) {
      let dropOutlier: FitSample | null = null;
      let dropResPx = fullResidualPx;
      for (let i = 0; i < pts.length; i++) {
        const subset = pts.filter((_, k) => k !== i).map((p) => p.s);
        const fit = leastSquares(subset, transform);
        if (!fit) continue;
        const resPx = fit.residual / Math.max(Math.abs(fit.slope), 1e-12);
        // Drop one when the inlier fit is at least twice as tight and lands
        // under 0.6 px of residual - the dense, per-decade grid the women-men
        // chart gives after dropping `2021` sits around half a pixel, so a
        // tighter cap would miss it, and a looser one would start absorbing
        // rounded-label noise on the panel charts.
        if (resPx < fullResidualPx * 0.5 && resPx < 0.6 && resPx < dropResPx) {
          dropResPx = resPx;
          dropOutlier = pts[i].s;
        }
      }
      if (dropOutlier) best = pts.filter((p) => p.s !== dropOutlier).map((p) => p.s);
    }
  }

  if (best.length < Math.max(3, pts.length * 0.5)) return full;
  if (best.length === pts.length) return full;
  const trimmed = leastSquares(best, transform);
  if (!trimmed) return full;
  // Keep the trimmed fit when either the residual is dramatically smaller, or
  // the trimmed residual is already as tight as the quantum allows. The second
  // guard is what the women-men chart needs: dropping `2021` leaves a perfect
  // fit on the other five labels while the full fit still looks tolerable in
  // relative terms, so the ratio check alone would not fire.
  const trimmedResidualPx = trimmed.residual / Math.max(Math.abs(trimmed.slope), 1e-12);
  const fullResidualPx = full.residual / Math.max(Math.abs(full.slope), 1e-12);
  const dramaticImprovement = trimmed.relativeResidual < full.relativeResidual * 0.4;
  // On a dense label grid - the women-men decade axis after `2021` is dropped
  // settles at about half a pixel of residual - absolute pixel measures are a
  // cleaner trigger than the proportional one: a sub-pixel inlier residual
  // with a pixel-plus full residual says exactly one label broke the grid.
  const tightOnInliers = trimmedResidualPx <= 0.6 && fullResidualPx >= 1.2;
  if (!(dramaticImprovement || tightOnInliers)) return full;
  const kept = new Set(best);
  return { ...trimmed, dropped: samples.filter((s) => !kept.has(s)) };
}

/**
 * The step the printed labels are quantised to: 0.01 for `0.09, 0.19, 0.28`,
 * 1000 for `0, 4k, 9k, 13k`. Half of it bounds how far a correctly-read label
 * can sit from the true mapping through rounding alone.
 */
function inferQuantum(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v) && v !== 0);
  if (finite.length === 0) return 0;
  const scale = Math.max(...finite.map(Math.abs));
  for (let k = 6; k >= -8; k--) {
    const q = Math.pow(10, k);
    if (q > scale) continue;
    if (finite.every((v) => Math.abs(v / q - Math.round(v / q)) < 1e-6)) return q;
  }
  return 0;
}

/**
 * Choose linear or log by comparing normalised residuals.
 *
 * Two labelled ticks fit both models exactly, so with fewer than three samples
 * we refuse to guess and return linear with `ambiguous: true`; the UI makes the
 * toggle prominent in that state.
 */
export function fitAxis(samples: FitSample[]): { fit: AxisFit; report: ScaleFitReport } | null {
  const linear = robustLeastSquares(samples, (v) => v);
  if (!linear) return null;

  const positive = samples.every((s) => s.value > 0);
  // A log axis needs decades to be a log axis. Over a narrow span far from zero
  // - a year axis, say - log10 is very nearly a straight line, so both models
  // fit and the tool would keep flagging an ambiguity that does not exist.
  const values = samples.map((s) => s.value);
  const decades = positive
    ? Math.log10(Math.max(...values) / Math.min(...values))
    : 0;
  const log = positive && decades >= 0.5 ? robustLeastSquares(samples, (v) => Math.log10(v)) : null;

  if (samples.length < 3 || !log) {
    return {
      fit: linear,
      report: {
        linearResidual: linear.relativeResidual,
        logResidual: log ? log.relativeResidual : null,
        samples: samples.length,
        droppedLabels: linear.dropped.length,
        chosen: 'linear',
        ambiguous: samples.length < 3,
      },
    };
  }

  // Require the winner to be clearly better; a near-tie means the data does not
  // actually distinguish the models (for example a short span on a log axis).
  const chosen: AxisScale = log.relativeResidual < linear.relativeResidual * 0.25 ? 'log' : 'linear';
  const ambiguous =
    Math.abs(log.relativeResidual - linear.relativeResidual) <
    Math.max(log.relativeResidual, linear.relativeResidual) * 0.25;
  const winner = chosen === 'log' ? { ...log, scale: 'log' as const } : linear;
  return {
    fit: winner,
    report: {
      linearResidual: linear.relativeResidual,
      logResidual: log.relativeResidual,
      samples: samples.length,
      droppedLabels: winner.dropped.length,
      chosen,
      ambiguous,
    },
  };
}

/**
 * Turn a fit into the two visible anchors, evaluated at the extreme fitted
 * pixel positions so the numbers the user sees line up with the plot edges.
 */
export function anchorsFromFit(
  fit: AxisFit,
  pxLo: number,
  pxHi: number,
): { a: Anchor; b: Anchor } {
  const at = (px: number) => {
    const y = fit.slope * px + fit.intercept;
    return fit.scale === 'log' ? Math.pow(10, y) : y;
  };
  // Quantise in the scale's own space, so a decade endpoint on a log axis lands
  // exactly on the decade instead of being rounded into a different one.
  const toSpace = (v: number) => (fit.scale === 'log' ? Math.log10(v) : v);
  const fromSpace = (v: number) => (fit.scale === 'log' ? Math.pow(10, v) : v);
  const lo = toSpace(at(pxLo));
  const hi = toSpace(at(pxHi));
  return {
    a: { px: pxLo, value: fromSpace(tidy(lo, lo, hi)), source: 'ocr' },
    b: { px: pxHi, value: fromSpace(tidy(hi, lo, hi)), source: 'ocr' },
  };
}

/**
 * Round an anchor to the precision the fit actually supports.
 *
 * The fit puts the left edge of a 0-12 axis at 0.00054, which is true and
 * useless: it is 0.005% of the range, an order of magnitude below the
 * uncertainty this tool reports for the same axis. Showing it makes a correct
 * calibration look broken, and every downstream number inherits the noise. So
 * quantise to about 0.01% of the range, which is finer than anything measurable
 * and reads as the number the axis is actually labelled with.
 */
function tidy(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return value;
  const range = Math.abs(hi - lo);
  if (!(range > 0)) return value;
  const quantum = Math.pow(10, Math.floor(Math.log10(range)) - 4);
  const rounded = Math.round(value / quantum) * quantum;
  // Kill the binary-float dust the multiply leaves behind.
  return Number(rounded.toPrecision(12));
}

/**
 * Build a calibration for one axis from whatever labelled ticks were read.
 * Falls back to a default 0..1 mapping over the plot extent when nothing was
 * readable - the user then types the two values in.
 */
export function calibrateAxis(
  side: AxisSide,
  labelled: LabelledTick[],
  pxLo: number,
  pxHi: number,
  override?: { scale?: AxisScale; multiplier?: number; offset?: number },
): AxisCalibration {
  const samples = labelled
    .filter((t): t is LabelledTick & { value: number } => typeof t.value === 'number')
    .map((t) => ({ px: t.px, value: t.value }));

  const fitted = fitAxis(samples);
  const multiplier = override?.multiplier ?? 1;
  const offset = override?.offset ?? 0;

  if (!fitted) {
    return {
      side,
      scale: override?.scale ?? 'linear',
      a: { px: pxLo, value: 0, source: 'default' },
      b: { px: pxHi, value: 1, source: 'default' },
      multiplier,
      offset,
      scaleSource: override?.scale ? 'manual' : 'default',
    };
  }

  let fit = fitted.fit;
  if (override?.scale && override.scale !== fit.scale) {
    const refit = robustLeastSquares(
      samples,
      override.scale === 'log' ? (v) => Math.log10(v) : (v) => v,
    );
    if (refit) fit = { ...refit, scale: override.scale };
  }

  const { a, b } = anchorsFromFit(fit, pxLo, pxHi);
  return {
    side,
    scale: fit.scale,
    a,
    b,
    multiplier,
    offset,
    scaleSource: override?.scale ? 'manual' : 'fit',
    scaleFit: fitted.report,
  };
}

/** Map a pixel position to a data value through a calibration. */
export function pixelToValue(cal: AxisCalibration, px: number): number {
  const t = (px - cal.a.px) / (cal.b.px - cal.a.px);
  let raw: number;
  if (cal.scale === 'log') {
    const la = Math.log10(cal.a.value);
    const lb = Math.log10(cal.b.value);
    raw = Math.pow(10, la + t * (lb - la));
  } else {
    raw = cal.a.value + t * (cal.b.value - cal.a.value);
  }
  return raw * cal.multiplier + cal.offset;
}

/** Inverse of `pixelToValue`. */
export function valueToPixel(cal: AxisCalibration, value: number): number {
  const raw = (value - cal.offset) / cal.multiplier;
  let t: number;
  if (cal.scale === 'log') {
    const la = Math.log10(cal.a.value);
    const lb = Math.log10(cal.b.value);
    t = (Math.log10(raw) - la) / (lb - la);
  } else {
    t = (raw - cal.a.value) / (cal.b.value - cal.a.value);
  }
  return cal.a.px + t * (cal.b.px - cal.a.px);
}

/** Data units per pixel at `px`. On a log axis this varies along the axis. */
export function scaleAt(cal: AxisCalibration, px: number): number {
  const h = 0.5;
  return Math.abs(pixelToValue(cal, px + h) - pixelToValue(cal, px - h));
}

/** True when the anchors describe a usable, non-degenerate mapping. */
export function isValid(cal: AxisCalibration): boolean {
  if (!Number.isFinite(cal.a.value) || !Number.isFinite(cal.b.value)) return false;
  if (cal.a.px === cal.b.px) return false;
  if (cal.a.value === cal.b.value) return false;
  if (cal.scale === 'log' && (cal.a.value <= 0 || cal.b.value <= 0)) return false;
  return true;
}

/**
 * Human-readable one-line summary of the mapping, shown live in the UI.
 *
 * `spanPx` should be the plot area's own edges. Describing the range at the
 * anchors instead would be useless: the value at an anchor is the anchor's
 * value by definition, so the statement would not move when the user drags one.
 */
export function describeAxis(
  cal: AxisCalibration,
  name: string,
  unit?: string,
  spanPx?: [number, number],
): string {
  const [pxLo, pxHi] = spanPx ?? [cal.a.px, cal.b.px];
  const lo = pixelToValue(cal, pxLo);
  const hi = pixelToValue(cal, pxHi);
  const u = unit ? ` ${unit}` : '';
  return `${name}: ${formatValue(lo)}${u} to ${formatValue(hi)}${u}, ${cal.scale}`;
}

export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(3).replace(/e([+-])(\d)$/, 'e$10$2');
  return String(Number(v.toPrecision(6)));
}
