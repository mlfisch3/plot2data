/**
 * Path tracing and marker extraction in pixel space.
 *
 * Curve mode walks the plot's x columns and reduces the data ink in each column
 * to one value. Where the curve is locally flat the *intensity-weighted
 * centroid* is that value: an antialiased edge pixel carries a partial alpha, so
 * the centroid is accurate to a fraction of a pixel, and thresholding and taking
 * the middle of the run would throw that accuracy away.
 *
 * A centroid is only right while the ink in the column is one flat stroke. At a
 * sharp apex the same column holds the rising edge, the tip and the falling
 * edge, and the centroid then lands halfway down the spike - which is exactly
 * how a spiky series comes back with its peaks shaved off. The drawn line has a
 * roughly uniform thickness `t` and the plotted value sits at the *centre* of
 * the stroke, so at a turning point the value is half a stroke in from the
 * outermost ink. See `columnValues` for how the two regimes are blended.
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
  /**
   * Ink extent, as a multiple of the stroke thickness, at which a column stops
   * counting as locally flat. Below this the centroid is kept unchanged, which
   * is what preserves the sub-pixel accuracy the corpus measures.
   */
  flatSpanRatio: number;
  /** Extent ratio at which a column is treated as fully steep or turning. */
  steepSpanRatio: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  maxGapPx: 24,
  minAlpha: 0.12,
  continuityTolerancePx: 6,
  flatSpanRatio: 1.25,
  steepSpanRatio: 2,
};

interface Run {
  /** First and last inked row of the run. */
  lo: number;
  hi: number;
  /** Sum of alpha: the ink *area* in this column, in pixels. */
  weight: number;
  centroid: number;
  /** Sub-pixel outermost ink, from the coverage of the two edge rows. */
  top: number;
  bottom: number;
}

/**
 * Contiguous vertical runs of ink in one column, with sub-pixel centroids.
 *
 * `alpha` is a coverage fraction, not an intensity, so a row's alpha is the
 * share of that pixel the stroke covers. That makes the outer edges sub-pixel
 * too: a top row only 30% covered puts the true edge 0.2 px below its centre.
 */
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
    const hi = y - 1;
    const aLo = Math.min(1, mask.alpha[lo * mask.width + x]);
    const aHi = Math.min(1, mask.alpha[hi * mask.width + x]);
    runs.push({
      lo,
      hi,
      weight,
      centroid: weight > 0 ? moment / weight : lo,
      top: lo + 0.5 - aLo,
      bottom: hi - 0.5 + aHi,
    });
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
): { points: TracePoint[]; thicknessPx: number } {
  const opts = { ...DEFAULT_TRACE_OPTIONS, ...options };
  const raw: Array<Run | null> = new Array(mask.width).fill(null);

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
  if (!seedRun || seedX < 0) return { points: [], thicknessPx: 0 };

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

  raw[seedX] = seedRun;
  let prev: Run | null = seedRun;
  for (let x = seedX + 1; x < mask.width; x++) {
    const r = pick(allRuns[x], prev);
    if (r) {
      raw[x] = r;
      prev = r;
    }
  }
  prev = seedRun;
  for (let x = seedX - 1; x >= 0; x--) {
    const r = pick(allRuns[x], prev);
    if (r) {
      raw[x] = r;
      prev = r;
    }
  }

  const thicknessPx = strokeThickness(raw);
  const values = columnValues(mask, raw, thicknessPx, opts);

  const points: TracePoint[] = [];
  let lastIdx = -1;
  for (let x = 0; x < mask.width; x++) {
    const run = raw[x];
    if (!run) continue;
    if (lastIdx >= 0 && x - lastIdx > 1 && x - lastIdx - 1 <= opts.maxGapPx) {
      // Bridge dashes, marker gaps and antialiasing dropouts by continuity.
      const a = points[points.length - 1];
      const span = x - lastIdx;
      for (let k = 1; k < span; k++) {
        const t = k / span;
        points.push({
          px: lastIdx + k,
          py: a.py + t * (values[x] - a.py),
          weight: a.weight + t * (run.weight - a.weight),
          interpolated: true,
        });
      }
    }
    points.push({ px: x, py: values[x], weight: run.weight, interpolated: false });
    lastIdx = x;
  }

  return { points, thicknessPx };
}

/**
 * Stroke thickness, perpendicular to the path.
 *
 * A stroke of uniform width `t` drawn along a path of length `L` covers `t * L`
 * of ink, so dividing the measured ink area by the measured path length gives
 * `t` directly. That holds however steep the line is, which the older estimate -
 * the median vertical ink extent per column - does not: on a spiky series most
 * columns are steep, and their vertical extent is several times the stroke's
 * real width. On the captain's retail-sales chart that estimate read 23 px for a
 * line under 7 px wide, and every uncertainty derived from it was wrong to match.
 *
 * Only adjacent measured columns contribute, so a dashed line's gaps count
 * towards neither the area nor the length.
 */
function strokeThickness(runs: Array<Run | null>): number {
  let area = 0;
  let length = 0;
  for (let x = 0; x < runs.length; x++) {
    const run = runs[x];
    if (!run) continue;
    area += run.weight;
    const prev = runs[x - 1];
    if (prev) length += Math.hypot(1, run.centroid - prev.centroid);
  }
  if (length <= 0) return runs.find(Boolean)?.weight ?? 0;
  // Half the trailing column of ink has no segment to be spread along, and a
  // very short trace would be dominated by that; one column of slack is enough.
  return area / (length + 1);
}

/** Hermite ramp: 0 below `lo`, 1 above `hi`, smooth at both ends. */
function smoothstep(lo: number, hi: number, v: number): number {
  if (!(hi > lo)) return v >= hi ? 1 : 0;
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * One representative value per column, blending the flat and the turning regime.
 *
 * Per column the ink span is compared with the stroke thickness `t`:
 *
 * - span about `t` - the column holds one flat stroke, so the centroid is the
 *   value, and the sub-pixel accuracy of the rest of the corpus is untouched.
 * - span well over `t` - the column holds a steep or turning segment and the
 *   centroid means nothing. Which value to take is decided by the neighbours:
 *   at a local maximum the curve reaches `topmost ink + t/2`, at a local minimum
 *   `bottommost ink - t/2`, and on a monotone steep run the curve genuinely
 *   passes through the whole span, so the value that joins up with the columns
 *   either side is the geometric middle of the span.
 *
 * Both the steepness and the turn are weights rather than switches, so there is
 * no visible seam where one rule takes over from the other. Note that on a flat
 * column `topmost ink + t/2` *is* the centroid, which is what makes the blend
 * continuous rather than merely smooth.
 */
function columnValues(
  mask: SeriesMask,
  runs: Array<Run | null>,
  thickness: number,
  opts: TraceOptions,
): Float64Array {
  const values = new Float64Array(runs.length);
  for (let x = 0; x < runs.length; x++) values[x] = runs[x]?.centroid ?? 0;
  const t = thickness;
  if (!(t > 0)) return values;

  // A turn has to be visible across at least the width of the stroke: the tip of
  // a spike drawn with a 6 px pen is 6 px of columns that all reach the same
  // height, and a one-column comparison would see a plateau rather than a peak.
  const reach = Math.max(2, Math.round(t));

  for (let x = 0; x < runs.length; x++) {
    const run = runs[x];
    if (!run) continue;
    const span = run.bottom - run.top;
    const steep = smoothstep(opts.flatSpanRatio, opts.steepSpanRatio, span / t);
    if (steep <= 0) continue;

    // How far the outer edge of the ink climbs away from this column on each
    // side. A genuine extremum rises on both sides; a steep monotone run does
    // not, so the weaker side is what counts.
    let leftUp = -Infinity;
    let rightUp = -Infinity;
    let leftDown = -Infinity;
    let rightDown = -Infinity;
    for (let d = 1; d <= reach; d++) {
      const l = runs[x - d];
      const r = runs[x + d];
      if (l) {
        leftUp = Math.max(leftUp, l.top - run.top);
        leftDown = Math.max(leftDown, run.bottom - l.bottom);
      }
      if (r) {
        rightUp = Math.max(rightUp, r.top - run.top);
        rightDown = Math.max(rightDown, run.bottom - r.bottom);
      }
    }
    // A column at the very end of the trace has one side only; judge it on that
    // side rather than refusing to correct an endpoint spike.
    const peak = clamp01(Math.min(sided(leftUp), sided(rightUp)) / t);
    const trough = clamp01(Math.min(sided(leftDown), sided(rightDown)) / t);
    const turn = Math.max(-1, Math.min(1, peak - trough));

    const middle = (run.top + run.bottom) / 2;
    const extreme =
      turn > 0
        ? run.top + turnDepth(mask, x, run, t, opts.minAlpha, true)
        : run.bottom - turnDepth(mask, x, run, t, opts.minAlpha, false);
    const steepValue = middle + Math.abs(turn) * (extreme - middle);
    values[x] = run.centroid + steep * (steepValue - run.centroid);
  }
  return values;
}

/**
 * How far in from the outermost ink the plotted value sits, at a turning point.
 *
 * Half a stroke is the answer whenever the corner is drawn round, which is the
 * common case and the one the rule is stated for. It is not the answer for a
 * *mitred* corner: at a sharp vertex the miter runs on past the vertex - 5 px
 * past it on the corpus's sawtooth, drawn with a line under 2 px wide - and
 * stopping half a stroke in would read a peak the chart never plotted.
 *
 * What both joins have in common is the cross-section: the drawn line is one
 * stroke wide everywhere except inside the join, so descending from the tip
 * until the ink is a full stroke across lands on the vertex either way. The
 * result is clamped between half a stroke - never less than the round-corner
 * answer - and the column's own centroid, so the correction can only ever move
 * the value between doing nothing and doing what the captain's rule says.
 */
function turnDepth(
  mask: SeriesMask,
  x: number,
  run: Run,
  t: number,
  minAlpha: number,
  downward: boolean,
): number {
  const from = downward ? run.top : run.bottom;
  const limit = Math.max(t / 2, Math.abs(run.centroid - from));
  const step = downward ? 1 : -1;
  let prevY = from;
  let prevWidth = 0;
  for (let k = 0; k <= Math.ceil(limit) + 1; k++) {
    const y = Math.round(from) + k * step;
    if (y < 0 || y >= mask.height) break;
    const width = rowWidth(mask, y, x, minAlpha);
    if (width >= t) {
      const share = width > prevWidth ? (t - prevWidth) / (width - prevWidth) : 1;
      const at = prevY + (y - prevY) * Math.max(0, Math.min(1, share));
      return Math.min(limit, Math.max(t / 2, Math.abs(at - from)));
    }
    prevY = y;
    prevWidth = width;
  }
  return limit;
}

/** Ink across one row, within the contiguous run of ink containing column `x`. */
function rowWidth(mask: SeriesMask, y: number, x: number, minAlpha: number): number {
  const row = y * mask.width;
  if (mask.alpha[row + x] < minAlpha) return 0;
  let width = mask.alpha[row + x];
  for (let i = x - 1; i >= 0 && mask.alpha[row + i] >= minAlpha; i--) width += mask.alpha[row + i];
  for (let i = x + 1; i < mask.width && mask.alpha[row + i] >= minAlpha; i++) width += mask.alpha[row + i];
  return width;
}

/** A missing neighbour is not evidence either way, so it does not veto a turn. */
function sided(v: number): number {
  return v === -Infinity ? Infinity : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Marker mode: each component's alpha-weighted centre of mass is a real sample
 * of the underlying data, not a resampling of a drawn line. The centre of mass
 * rather than the middle of the bounding box, for the same reason the curve
 * tracer weights by alpha: the partial coverage of an antialiased marker edge
 * carries the sub-pixel position, and a bounding box quantises it away.
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
