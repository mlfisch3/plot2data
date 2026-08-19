/**
 * How many points the export should carry, proposed from the image itself.
 *
 * A drawn line chart is a polyline, and its vertices are the real data points.
 * Asking the user to pick a number is asking them to guess at something the
 * picture already says: a monthly series drawn across 1200 px has its vertices
 * about 3.5 px apart, and any other count is either throwing information away
 * or inventing it.
 *
 * So the vertices are counted. Where they are found on a regular pitch the
 * count that pitch implies is proposed; where they are not - points bunched at
 * the interesting parts, or a trace too short or too broken to read a pitch off
 * - the honest answer is one point per pixel column, and that is what is
 * proposed instead. Either way it is a suggestion with its reasoning attached,
 * and the user overrides it.
 *
 * It is an estimate and it says so. Where the drawn line is *wider* than the
 * spacing of its own vertices - the captain's monthly chart is drawn with a
 * 5.5 px pen and plots a point every 3.5 px - some kinks are simply not
 * separable from the ink, and the count comes out low. Measured against the
 * charts in `examples/real`, the estimate lands within a factor of about two of
 * the true point count, which is the right order for a default and no more than
 * that.
 */

import type { TracedSeries } from './types.ts';

export interface SamplingSuggestion {
  /** `native` means one point per pixel column. */
  kind: 'uniform' | 'native';
  /** Points across the shared x span. For `native`, the column count. */
  count: number;
  /** Detected vertex pitch in pixels, when the trace showed one. */
  spacingPx?: number;
  /** Vertices found on the series the estimate came from. */
  vertices?: number;
  confident: boolean;
  /** One line for the UI, saying what was chosen and why. */
  reason: string;
}

/** Below this many detected vertices there is no pitch worth trusting. */
const MIN_VERTICES = 8;
/**
 * Spread of the vertex gaps, as a fraction of their median, above which the
 * spacing is not regular enough to call a sampling rate. Data sampled on a
 * regular pitch sits well under it; vertices bunched at the interesting parts
 * sit above it.
 */
const MAX_GAP_SPREAD = 0.6;
/**
 * Kink threshold, as multiples of the trace's own curvature deviation above its
 * median. Set from the trace rather than in pixels: what counts as a kink
 * depends on how big the plot is and how noisy the ink is, and a constant would
 * find vertices in antialiasing on one chart and none at all on the next.
 * Measured over `examples/real` and the corpus, one deviation is the setting
 * that finds most of a real chart's vertices without turning a smooth curve's
 * ripple into a sampling rate.
 */
const KINK_DEVIATIONS = 1;

/**
 * Propose a point count for a set of traced series.
 *
 * `spanPx` is the width of the shared output grid in pixels, which is what the
 * proposed count has to cover.
 */
export function suggestSampling(series: TracedSeries[], spanPx: number): SamplingSuggestion {
  const columns = Math.max(2, Math.round(spanPx) + 1);
  const native = (reason: string): SamplingSuggestion => ({
    kind: 'native',
    count: columns,
    confident: false,
    reason,
  });

  const curves = series.filter((s) => s.mode === 'curve' && s.points.length > 8);
  if (curves.length === 0) return native(`One point per pixel column (${columns}).`);

  const found = curves
    .map((s) => vertexPitch(s))
    .filter((v): v is Pitch => v !== null)
    .sort((a, b) => a.spacing - b.spacing);
  if (found.length === 0) {
    return native(
      `One point per pixel column (${columns}): the trace shows no regular vertex spacing, so any smaller number would be a guess.`,
    );
  }

  // With several series, the finest regular pitch is the one that has to be
  // resolved; a coarser series is still represented exactly on that grid.
  const best = found[0];
  const count = Math.round(spanPx / best.spacing) + 1;
  if (count < 4 || count > columns) {
    return native(`One point per pixel column (${columns}).`);
  }
  return {
    kind: 'uniform',
    count,
    spacingPx: best.spacing,
    vertices: best.vertices,
    confident: true,
    reason:
      `${count} points, about one per drawn vertex: the trace kinks every ` +
      `${best.spacing.toFixed(1)} px or so, ${best.vertices} times across the plot.`,
  };
}

interface Pitch {
  spacing: number;
  vertices: number;
}

/**
 * The pitch of a polyline's vertices, from where the trace changes direction.
 *
 * A vertex is a spike in the second difference of the traced path: straight
 * between vertices, a kink at each one. The threshold is set from the median
 * absolute deviation of that signal rather than from a constant, because what
 * counts as a kink depends entirely on how big the plot is and how noisy the
 * ink is - a fixed number of pixels would find vertices in antialiasing on one
 * chart and none at all on the next.
 */
function vertexPitch(series: TracedSeries): Pitch | null {
  const points = series.points.filter((p) => !p.interpolated).sort((a, b) => a.px - b.px);
  if (points.length < 24) return null;

  const curvature: Array<{ px: number; k: number }> = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    // Only consecutive columns describe a kink; a gap describes nothing.
    if (b.px - a.px !== 1 || c.px - b.px !== 1) continue;
    curvature.push({ px: b.px, k: Math.abs(a.py - 2 * b.py + c.py) });
  }
  if (curvature.length < 24) return null;

  const noise = medianOf(curvature.map((c) => c.k));
  const spread = medianOf(curvature.map((c) => Math.abs(c.k - noise)));
  // A trace with no kinks at all has a near-zero deviation, and scaling a
  // threshold off it would find "vertices" in rounding error.
  const threshold = Math.max(noise + KINK_DEVIATIONS * spread, 0.35);

  const peaks: number[] = [];
  for (let i = 0; i < curvature.length; i++) {
    const k = curvature[i].k;
    if (k < threshold) continue;
    const before = i > 0 ? curvature[i - 1].k : 0;
    const after = i < curvature.length - 1 ? curvature[i + 1].k : 0;
    if (k < before || k < after) continue;
    if (peaks.length && curvature[i].px - peaks[peaks.length - 1] < 2) continue;
    peaks.push(curvature[i].px);
  }
  if (peaks.length < MIN_VERTICES) return null;

  const gaps: number[] = [];
  for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
  const spacing = medianOf(gaps);
  if (!(spacing >= 2)) return null;
  const gapSpread = medianOf(gaps.map((g) => Math.abs(g - spacing))) / spacing;
  if (gapSpread > MAX_GAP_SPREAD) return null;

  // The vertices have to account for most of the trace, not a regular patch of
  // it with a long smooth stretch either side.
  const covered = peaks[peaks.length - 1] - peaks[0];
  const total = points[points.length - 1].px - points[0].px;
  if (covered < total * 0.6) return null;

  return { spacing, vertices: peaks.length };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
