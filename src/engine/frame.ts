/**
 * Plot frame and axis line detection.
 *
 * The signal is long straight runs of ink. Axis spines differ from gridlines in
 * three ways we exploit: they are stronger (higher contrast against the
 * background), they are achromatic, and they sit at the outside of the data
 * area. Data series are rejected because they are rarely straight for a long
 * run and are usually coloured.
 *
 * Two real-world complications are handled explicitly. Screenshots often carry
 * an outer border that looks exactly like a spine, so a run hugging the image
 * edge is rejected when anything else is available. And many clean charts draw
 * no y-axis line at all, in which case the gridlines' own extent defines the
 * data rectangle.
 */

import { clampRect, colourDistance, dominantColour, getPixel, isGray, luma } from './image.ts';
import type { ImageBuffer, PlotFrame, RGB, Rect, SpineLine } from './types.ts';

export interface FrameOptions {
  /** Minimum fraction of the image span a run must cover to be a candidate. */
  minRunFraction: number;
  /** Ink threshold: colour distance from background that counts as ink. */
  inkThreshold: number;
  /** Max saturation for a run to be considered axis chrome rather than data. */
  maxSpineSaturation: number;
}

export const DEFAULT_FRAME_OPTIONS: FrameOptions = {
  minRunFraction: 0.4,
  // Deliberately low. Publication charts often draw gridlines at 8-12% contrast,
  // and those gridlines are the only frame evidence when no axis line is drawn.
  // Spine selection ranks by strength, so faint runs joining the candidate pool
  // costs nothing.
  inkThreshold: 20,
  maxSpineSaturation: 0.35,
};

interface Band extends SpineLine {
  gray: boolean;
  /** Extent of the run's dense core, with adjacent label text split off. */
  coreStart: number;
  coreEnd: number;
}

interface RunCandidate {
  pos: number;
  start: number;
  end: number;
  coreStart: number;
  coreEnd: number;
  length: number;
  strength: number;
  gray: boolean;
}

/**
 * Longest near-contiguous ink run along one row (or column), tolerating small
 * gaps so a dotted gridline reads as one run and a spine crossed by a data
 * line is not split.
 */
function longestRun(
  span: number,
  inkAt: (i: number) => number,
  maxGap: number,
): { start: number; end: number; strength: number } {
  let bestStart = 0;
  let bestEnd = -1;
  let bestSum = 0;
  let curStart = -1;
  let curSum = 0;
  let gap = 0;
  let lastInk = -1;
  const commit = () => {
    if (curStart >= 0 && lastInk - curStart > bestEnd - bestStart) {
      bestStart = curStart;
      bestEnd = lastInk;
      bestSum = curSum;
    }
  };
  for (let i = 0; i < span; i++) {
    const s = inkAt(i);
    if (s > 0) {
      if (curStart < 0) {
        curStart = i;
        curSum = 0;
      }
      curSum += s;
      lastInk = i;
      gap = 0;
    } else if (curStart >= 0 && ++gap > maxGap) {
      commit();
      curStart = -1;
      gap = 0;
    }
  }
  commit();
  const len = bestEnd - bestStart + 1;
  return { start: bestStart, end: bestEnd, strength: len > 0 ? bestSum / len : 0 };
}

/**
 * Every long enough ink run per row (or column), not just the longest.
 *
 * On a multipanel composite each gridline passes through every panel as a
 * separate run broken by panel gutters; the single-run scanner used by
 * `detectFrame` picks one and drops the rest, so a plot sitting beside another
 * one leaves no evidence in `hBands`. The multi-plot detector needs them all.
 */
function scanAllLongRuns(
  img: ImageBuffer,
  bg: RGB,
  horizontal: boolean,
  opts: FrameOptions,
): RunCandidate[] {
  const outer = horizontal ? img.height : img.width;
  const span = horizontal ? img.width : img.height;
  // Keep the gap tolerance tight: a multipanel composite has 20-25 px gutters
  // between panels and a looser gap would bridge them into one long run and
  // hide the panel structure. The single-plot `detectFrame` uses 2% for
  // dotted gridlines, but this scanner needs panels to stay distinct.
  const maxGap = Math.max(2, Math.min(8, Math.round(span * 0.01)));
  const minLen = span * opts.minRunFraction;
  const raw: RunCandidate[] = [];

  for (let p = 0; p < outer; p++) {
    // Walk the row and collect every ink stretch, bridging small gaps.
    let runStart = -1;
    let runSum = 0;
    let lastInk = -1;
    let gap = 0;
    let coloured = 0;
    let inked = 0;
    const commit = () => {
      if (runStart < 0 || lastInk < runStart) return;
      const len = lastInk - runStart + 1;
      if (len < minLen) return;
      raw.push({
        pos: p,
        start: runStart,
        end: lastInk,
        coreStart: runStart,
        coreEnd: lastInk,
        length: len,
        strength: len > 0 ? runSum / len : 0,
        gray: inked === 0 || coloured / inked < 0.6,
      });
    };
    for (let i = 0; i < span; i++) {
      const c = horizontal ? getPixel(img, i, p) : getPixel(img, p, i);
      const d = colourDistance(c, bg);
      if (d >= opts.inkThreshold) {
        if (runStart < 0) {
          runStart = i;
          runSum = 0;
          coloured = 0;
          inked = 0;
          gap = 0;
        }
        runSum += Math.min(1, d / 160);
        lastInk = i;
        inked++;
        if (!isGray(c, opts.maxSpineSaturation)) coloured++;
        gap = 0;
      } else if (runStart >= 0 && ++gap > maxGap) {
        commit();
        runStart = -1;
      }
    }
    commit();
  }
  // Sort by (pos, start) so `mergeBands` sees adjacent-row runs in order.
  raw.sort((a, b) => a.pos - b.pos || a.start - b.start);
  return raw;
}

/**
 * Merge runs that are adjacent in `pos` AND overlap in extent.
 *
 * One physical gridline is drawn two or three pixels thick, so it generates
 * runs on consecutive rows at the same x. On a multipanel composite each row
 * also carries other runs for the other panels, and the wrong merge glues them
 * together across the gutter. Only merging when the extents actually overlap
 * keeps a one-pixel-thick panel-1 gridline distinct from a panel-2 gridline on
 * the adjacent row.
 */
function mergeRunsPerRow(runs: RunCandidate[]): Band[] {
  if (runs.length === 0) return [];
  const used = new Array(runs.length).fill(false);
  const out: Band[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const members = [runs[i]];
    // Walk forward; stop as soon as we skip two rows with no match.
    let furthest = runs[i].pos;
    for (let j = i + 1; j < runs.length; j++) {
      if (used[j]) continue;
      if (runs[j].pos - furthest > 2) break;
      // Must share x-range with any current member.
      const r = runs[j];
      const matches = members.some(
        (m) => Math.min(m.end, r.end) - Math.max(m.start, r.start) >= Math.min(m.end - m.start, r.end - r.start) * 0.5,
      );
      if (!matches) continue;
      used[j] = true;
      members.push(r);
      furthest = Math.max(furthest, r.pos);
    }
    let wsum = 0;
    let psum = 0;
    for (const m of members) {
      wsum += m.strength;
      psum += m.strength * m.pos;
    }
    out.push({
      pos: wsum > 0 ? psum / wsum : members[0].pos,
      thickness: furthest - members[0].pos + 1,
      start: Math.min(...members.map((m) => m.start)),
      end: Math.max(...members.map((m) => m.end)),
      coreStart: median(members.map((m) => m.coreStart)),
      coreEnd: median(members.map((m) => m.coreEnd)),
      strength: Math.max(...members.map((m) => m.strength)),
      gray: members.filter((m) => m.gray).length * 2 >= members.length,
    });
  }
  return out;
}

function scanLines(img: ImageBuffer, bg: RGB, horizontal: boolean, opts: FrameOptions): RunCandidate[] {
  const outer = horizontal ? img.height : img.width;
  const span = horizontal ? img.width : img.height;
  const maxGap = Math.max(3, Math.round(span * 0.02));
  const minLen = span * opts.minRunFraction;
  const raw: RunCandidate[] = [];

  for (let p = 0; p < outer; p++) {
    let coloured = 0;
    let inked = 0;
    const inkAt = (i: number) => {
      const c = horizontal ? getPixel(img, i, p) : getPixel(img, p, i);
      const d = colourDistance(c, bg);
      if (d < opts.inkThreshold) return 0;
      inked++;
      if (!isGray(c, opts.maxSpineSaturation)) coloured++;
      return Math.min(1, d / 160);
    };
    const run = longestRun(span, inkAt, maxGap);
    const len = run.end - run.start + 1;
    if (len < minLen) continue;

    // Tick-label text sitting on the same row as a gridline merges into the
    // run across the small gap between them. Re-run with the tightest gap
    // tolerance that still keeps most of the line, which splits the label off
    // while leaving a dashed or dotted line intact.
    let core = { start: run.start, end: run.end };
    for (const g of [2, 4, 6]) {
      if (g >= maxGap) break;
      const tight = longestRun(span, inkAt, g);
      if (tight.end - tight.start + 1 >= len * 0.6) {
        core = { start: tight.start, end: tight.end };
        break;
      }
    }

    raw.push({
      pos: p,
      start: run.start,
      end: run.end,
      coreStart: core.start,
      coreEnd: core.end,
      length: len,
      strength: run.strength,
      // A spine is achromatic, but a flat data line lying on top of one covers
      // part of it, so require only that a substantial minority of the run is
      // still grey rather than that almost all of it is.
      gray: inked === 0 || coloured / inked < 0.6,
    });
  }
  return raw;
}

/** Merge adjacent rows/columns belonging to the same physical line. */
function mergeBands(cands: RunCandidate[]): Band[] {
  const out: Band[] = [];
  let i = 0;
  while (i < cands.length) {
    let j = i;
    while (j + 1 < cands.length && cands[j + 1].pos === cands[j].pos + 1) j++;
    const band = cands.slice(i, j + 1);
    // Ink-weighted centre of the band gives a sub-pixel spine position.
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
      coreStart: median(band.map((c) => c.coreStart)),
      coreEnd: median(band.map((c) => c.coreEnd)),
      strength: Math.max(...band.map((c) => c.strength)),
      gray: band.filter((c) => c.gray).length * 2 >= band.length,
    });
    i = j + 1;
  }
  return out;
}

/**
 * A run hugging the image edge and spanning nearly the whole image is a
 * screenshot border, not an axis. Drop those unless nothing else is available.
 */
function dropImageBorders(bands: Band[], dim: number, span: number): Band[] {
  const edge = Math.max(3, dim * 0.01);
  const kept = bands.filter(
    (b) => !((b.pos <= edge || b.pos >= dim - 1 - edge) && b.end - b.start + 1 >= span * 0.97),
  );
  return kept.length > 0 ? kept : bands;
}

/**
 * Data-area bounds from a set of parallel long runs.
 *
 * Each run's dense core already has any adjacent tick label split off, so the
 * median core extent over all the gridlines is the data rectangle even when no
 * spine is drawn on that side.
 */
function boundsFromBands(bands: Band[], span: number): { lo: number; hi: number } | null {
  if (bands.length === 0) return null;
  const lo = median(bands.map((b) => b.coreStart));
  const hi = median(bands.map((b) => b.coreEnd));
  if (hi - lo < span * 0.2) return null;
  return { lo, hi };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * Pick a spine from `bands`, preferring the extreme position in `direction`
 * among candidates that are strong, achromatic and pass `accept`.
 */
function pickSpine(
  bands: Band[],
  direction: 'max' | 'min',
  limit: { lo: number; hi: number },
  accept: (b: Band) => boolean = () => true,
): Band | null {
  const strongest = Math.max(0, ...bands.map((b) => b.strength));
  const eligible = bands.filter(
    (b) =>
      b.pos >= limit.lo &&
      b.pos <= limit.hi &&
      b.strength >= strongest * 0.55 &&
      b.gray &&
      accept(b),
  );
  if (eligible.length === 0) return null;
  const maxLen = Math.max(...eligible.map((b) => b.end - b.start));
  const longEnough = eligible.filter((b) => b.end - b.start >= maxLen * 0.9);
  longEnough.sort((a, b) => (direction === 'max' ? b.pos - a.pos : a.pos - b.pos));
  return longEnough[0];
}

/**
 * Detect the plot frame.
 *
 * A plot may have a full box, only bottom+left spines, or only a bottom spine
 * with horizontal gridlines. Either way the long runs' own extents define the
 * data rectangle, so we never require all four spines.
 */
export function detectFrame(img: ImageBuffer, options: Partial<FrameOptions> = {}): PlotFrame {
  const opts = { ...DEFAULT_FRAME_OPTIONS, ...options };
  const bg = dominantColour(img);
  const darkTheme = luma(bg) < 128;

  const hBands = dropImageBorders(
    mergeBands(scanLines(img, bg, true, opts)),
    img.height,
    img.width,
  );
  const vBands = dropImageBorders(
    mergeBands(scanLines(img, bg, false, opts)),
    img.width,
    img.height,
  );

  const bottom = pickSpine(hBands, 'max', { lo: img.height * 0.3, hi: img.height - 1 });

  // A vertical run continuing well past the bottom axis belongs to some other
  // rectangle in the screenshot - a panel divider, a card border - not to this
  // plot. The same idea horizontally once the left spine is known.
  // Generous: a spine's run legitimately bridges the small gap to the tick
  // label centred beyond its end. Only a run overshooting by a large fraction
  // of the image is another rectangle's edge.
  const yTol = Math.max(6, img.height * 0.08);
  const xTol = Math.max(6, img.width * 0.08);
  const insidePlotV = (b: Band) => !bottom || b.end <= bottom.pos + yTol;
  const left = pickSpine(vBands, 'min', { lo: 0, hi: img.width * 0.6 }, insidePlotV);
  const insidePlotH = (b: Band) => !left || b.start >= left.pos - xTol;

  // Top and right close a drawn box, so they must lie inside the extent of the
  // spines they close off, and be as strong as them. Without the strength test
  // a gridline is picked as the top of the frame and data above it is cut off.
  const boxStrength = Math.max(bottom?.strength ?? 0, left?.strength ?? 0) * 0.75;
  const withinBottom = (b: Band) =>
    !bottom || (b.pos >= bottom.start - 4 && b.pos <= bottom.end + 4);
  const withinLeft = (b: Band) => !left || (b.pos >= left.start - 4 && b.pos <= left.end + 4);

  const topRaw = pickSpine(
    hBands,
    'min',
    { lo: 0, hi: img.height * 0.5 },
    (b) => withinLeft(b) && insidePlotH(b) && b.strength >= boxStrength,
  );
  const rightRaw = pickSpine(
    vBands,
    'max',
    { lo: img.width * 0.4, hi: img.width - 1 },
    (b) => withinBottom(b) && insidePlotV(b) && b.strength >= boxStrength,
  );

  // A single spine is found twice when scanning from both ends; keep the outer.
  const top = topRaw && bottom && Math.abs(bottom.pos - topRaw.pos) <= 8 ? null : topRaw;
  const right = rightRaw && left && Math.abs(rightRaw.pos - left.pos) <= 8 ? null : rightRaw;

  // Where a spine is missing, the long runs perpendicular to it bound the data
  // area: horizontal gridlines span the plot width, vertical ones its height.
  const hBounds = boundsFromBands(hBands.filter(insidePlotH), img.width);
  const vBounds = boundsFromBands(vBands.filter(insidePlotV), img.height);

  // Positions of the runs that were not themselves chosen as a spine: with no
  // top spine, the topmost gridline is the top of the data area.
  const otherH = hBands.filter((b) => b !== bottom && b !== top && insidePlotH(b)).map((b) => b.pos);
  const otherV = vBands.filter((b) => b !== left && b !== right && insidePlotV(b)).map((b) => b.pos);

  // Gridline evidence comes from both directions: the runs parallel to the
  // missing spine give its position, the perpendicular ones give their extent.
  // Take the outermost of the two, since both mark data-area content.
  const outermost = (pick: 'min' | 'max', ...vals: Array<number | undefined>) => {
    const defined = vals.filter((v): v is number => v !== undefined && Number.isFinite(v));
    if (defined.length === 0) return undefined;
    return pick === 'min' ? Math.min(...defined) : Math.max(...defined);
  };

  let x0 =
    left?.pos ??
    outermost('min', hBounds?.lo, otherV.length ? Math.min(...otherV) : undefined) ??
    0;
  let x1 =
    right?.pos ??
    outermost('max', hBounds?.hi, otherV.length ? Math.max(...otherV) : undefined) ??
    img.width - 1;
  let y0 =
    top?.pos ??
    outermost('min', vBounds?.lo, otherH.length ? Math.min(...otherH) : undefined) ??
    0;
  let y1 =
    bottom?.pos ??
    outermost('max', vBounds?.hi, otherH.length ? Math.max(...otherH) : undefined) ??
    img.height - 1;

  // Where an edge could not be derived at all, fall back to the image bound on
  // that side only, keeping whichever edge we did find.
  if (!(x1 - x0 > 10)) {
    if (left) x1 = img.width - 1;
    else if (right) x0 = 0;
    else {
      x0 = 0;
      x1 = img.width - 1;
    }
  }
  if (!(y1 - y0 > 10)) {
    if (bottom) y0 = 0;
    else if (top) y1 = img.height - 1;
    else {
      y0 = 0;
      y1 = img.height - 1;
    }
  }

  const rect: Rect = clampRect({ x0, y0, x1, y1 }, img);
  const spineCount = [bottom, left, top, right].filter(Boolean).length;
  const gridEvidence = Math.min(1, (hBands.length + vBands.length) / 6);

  return {
    rect,
    bottom: bottom ?? null,
    left: left ?? null,
    top: top ?? null,
    right: right ?? null,
    background: dominantColour(img, insetRect(rect, 3)),
    darkTheme,
    confidence: Math.min(
      1,
      (bottom ? 0.4 : 0) + (left ? 0.25 : 0) + spineCount * 0.05 + gridEvidence * 0.25,
    ),
  };
}

export function insetRect(r: Rect, by: number): Rect {
  return { x0: r.x0 + by, y0: r.y0 + by, x1: r.x1 - by, y1: r.y1 - by };
}

/**
 * A plot candidate found in an uncropped image.
 *
 * `rect` is a conservative data-area rectangle. `confidence` ranks the
 * candidates against each other; the top one is auto-selected when it is
 * clearly stronger than the rest, and otherwise the user is asked to pick.
 */
export interface PlotCandidate {
  rect: Rect;
  /** 0..1. See `scorePlotCandidate` for what counts. */
  confidence: number;
  /** Number of parallel horizontal runs (gridlines or spines) agreeing on the x extent. */
  horizontalLines: number;
  /** Number of parallel vertical runs agreeing on the y extent. */
  verticalLines: number;
  /** Rough label: 'full-box' | 'bottom-only' | 'label-only'. */
  kind: 'full-box' | 'bottom-left' | 'bottom-only' | 'label-only';
}

/**
 * Find every plot-like rectangle in an image.
 *
 * Rather than picking one global plot frame, this returns every candidate
 * region whose horizontal gridlines and vertical runs agree on a rectangle.
 * On a cropped-to-one-plot image the top result is the plot. On a multipanel
 * composite the result is one entry per panel, each with its own x range
 * taken from the gridline cluster that sits inside it.
 *
 * Candidates are returned in descending confidence. The caller decides what
 * to do with multiple: an auto-select when one dominates, a picker otherwise.
 */
export function detectPlotCandidates(
  img: ImageBuffer,
  options: Partial<FrameOptions> = {},
): PlotCandidate[] {
  const opts = { ...DEFAULT_FRAME_OPTIONS, ...options };
  const bg = dominantColour(img);

  // Pick up faint gridlines too: a clean chart often draws them at 8-12%
  // contrast, well below the normal ink threshold. Taking a dedicated low
  // threshold just for the panel scan keeps the main frame detector tight.
  const scanOpts = { ...opts, inkThreshold: Math.min(opts.inkThreshold, 15), minRunFraction: 0.1 };
  // scanLines only reports one longest run per row. On a multipanel composite
  // the per-panel gridlines are shorter than the one global band and get
  // dropped. Walk the image once more and collect every run that passes the
  // length floor, not just the longest. The usual `mergeBands` step would
  // merge adjacent-row runs blindly, which is wrong when there are several
  // non-overlapping runs on the same row: let `mergeRunsPerRow` do an x-aware
  // merge instead.
  const hAll = mergeRunsPerRow(scanAllLongRuns(img, bg, true, scanOpts));
  const vAll = mergeRunsPerRow(scanAllLongRuns(img, bg, false, scanOpts));
  const hBands = hAll;
  const vBands = vAll;

  // Drop runs that span most of the image AND hug the edge: screenshot borders.
  // Keep candidate panel separators, which are also long but not at the edge.
  const hUse = hBands.filter(
    (b) =>
      !(
        (b.pos <= 2 || b.pos >= img.height - 3) &&
        b.end - b.start + 1 >= img.width * 0.95
      ),
  );
  const vUse = vBands.filter(
    (b) =>
      !(
        (b.pos <= 2 || b.pos >= img.width - 3) &&
        b.end - b.start + 1 >= img.height * 0.95
      ),
  );

  // Cluster horizontal runs by their (start, end) x-range. On a multipanel
  // composite each panel's gridlines share one x-range; on a single-plot
  // image every gridline shares the plot's full x-range.
  const hGroups = clusterBandsByExtent(hUse, img.width);

  const candidates: PlotCandidate[] = [];

  // Primary signal: horizontal gridline cluster → x-range, y-extent from the
  // cluster's own range. The data area's y-range is from the topmost band to
  // the bottommost in the group; the x-range is the shared extent.
  for (const group of hGroups) {
    if (group.length < 3) continue;
    const xLo = median(group.map((b) => b.coreStart));
    const xHi = median(group.map((b) => b.coreEnd));
    if (xHi - xLo < img.width * 0.08) continue;
    const yLo = Math.min(...group.map((b) => Math.round(b.pos)));
    const yHi = Math.max(...group.map((b) => Math.round(b.pos)));
    if (yHi - yLo < img.height * 0.08) continue;

    // Look for vertical bands whose extent falls inside this [yLo..yHi]
    // range and whose x position is close to the x-extent limits.
    const matchingV = vUse.filter(
      (b) =>
        b.pos >= xLo - 4 &&
        b.pos <= xHi + 4 &&
        b.start <= yLo + 10 &&
        b.end >= yHi - 10,
    );
    const kind = chooseKind(hUse, matchingV, { x0: xLo, y0: yLo, x1: xHi, y1: yHi });
    const confidence = scorePlotCandidate(group.length, matchingV.length, img, {
      x0: xLo,
      y0: yLo,
      x1: xHi,
      y1: yHi,
    });
    candidates.push({
      rect: {
        x0: Math.round(xLo),
        y0: yLo,
        x1: Math.round(xHi),
        y1: yHi,
      },
      confidence,
      horizontalLines: group.length,
      verticalLines: matchingV.length,
      kind,
    });
  }

  // Dedupe: candidates whose rects overlap by more than 70% are the same plot.
  const unique: PlotCandidate[] = [];
  for (const c of candidates.sort((a, b) => b.confidence - a.confidence)) {
    if (unique.some((u) => overlapRatio(u.rect, c.rect) > 0.7)) continue;
    unique.push(c);
  }
  // Fall back to a single global rectangle if the gridline-cluster approach
  // found nothing: a plot drawn with four strong spines and no inner lines.
  if (unique.length === 0) {
    const fallback = detectFrame(img, options);
    unique.push({
      rect: fallback.rect,
      confidence: fallback.confidence,
      horizontalLines: 0,
      verticalLines: 0,
      kind: 'full-box',
    });
  }
  return unique;
}

/** Group bands that share a start/end extent to within a fraction of the span. */
function clusterBandsByExtent(bands: Band[], span: number): Band[][] {
  const tol = Math.max(6, span * 0.02);
  const groups: Band[][] = [];
  for (const b of bands) {
    const matched = groups.find((g) => {
      const g0 = median(g.map((x) => x.coreStart));
      const g1 = median(g.map((x) => x.coreEnd));
      return Math.abs(g0 - b.coreStart) <= tol && Math.abs(g1 - b.coreEnd) <= tol;
    });
    if (matched) matched.push(b);
    else groups.push([b]);
  }
  return groups;
}

/** Score a candidate by its evidence: more lines + more inner ink = stronger. */
function scorePlotCandidate(
  hCount: number,
  vCount: number,
  img: ImageBuffer,
  rect: { x0: number; y0: number; x1: number; y1: number },
): number {
  const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  if (area <= 0) return 0;
  // Count ink pixels inside the rectangle (data presence).
  const bg = dominantColour(img);
  let ink = 0;
  const stepX = Math.max(1, Math.round((rect.x1 - rect.x0) / 60));
  const stepY = Math.max(1, Math.round((rect.y1 - rect.y0) / 40));
  for (let y = Math.max(0, Math.round(rect.y0)); y <= Math.min(img.height - 1, Math.round(rect.y1)); y += stepY) {
    for (let x = Math.max(0, Math.round(rect.x0)); x <= Math.min(img.width - 1, Math.round(rect.x1)); x += stepX) {
      if (colourDistance(getPixel(img, x, y), bg) >= 25) ink++;
    }
  }
  const sampled = Math.max(1, Math.round((rect.x1 - rect.x0) / stepX) * Math.round((rect.y1 - rect.y0) / stepY));
  const inkShare = Math.min(1, ink / sampled);
  const lineScore = Math.min(1, hCount / 5) * 0.6 + Math.min(1, vCount / 2) * 0.2;
  return Math.max(0, Math.min(1, lineScore + inkShare * 0.3));
}

function overlapRatio(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const aArea = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
  const bArea = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
  return inter / Math.min(aArea, bArea);
}

function chooseKind(
  hBands: Band[],
  vBands: Band[],
  rect: Rect,
): PlotCandidate['kind'] {
  const strongBottom = hBands.some(
    (b) => Math.abs(b.pos - rect.y1) <= 3 && b.strength >= 0.3 && b.gray,
  );
  const strongTop = hBands.some(
    (b) => Math.abs(b.pos - rect.y0) <= 3 && b.strength >= 0.3 && b.gray,
  );
  const strongLeft = vBands.some(
    (b) => Math.abs(b.pos - rect.x0) <= 3 && b.strength >= 0.3 && b.gray,
  );
  const strongRight = vBands.some(
    (b) => Math.abs(b.pos - rect.x1) <= 3 && b.strength >= 0.3 && b.gray,
  );
  if (strongTop && strongBottom && strongLeft && strongRight) return 'full-box';
  if (strongBottom && strongLeft) return 'bottom-left';
  if (strongBottom) return 'bottom-only';
  return 'label-only';
}
