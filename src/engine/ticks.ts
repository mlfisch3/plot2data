/**
 * Geometric tick detection and tick-label localisation.
 *
 * Ticks are short runs of ink perpendicular to a spine that *terminate* within
 * a few pixels. That termination rule is what separates a tick from a gridline:
 * a gridline crossing the same strip keeps going for the full plot height.
 *
 * Plenty of clean plots draw no tick marks at all, only labels. For those we
 * fall back to locating the label text blobs and using their centres, which a
 * renderer aligns to the tick position anyway.
 */

import { colourDistance, getPixel, inkStrength } from './image.ts';
import type { AxisSide, ImageBuffer, PlotFrame, Rect, RGB, Tick } from './types.ts';

export interface TickOptions {
  /** Longest run still considered a tick rather than a gridline, in pixels. */
  maxTickLength: number;
  /** Shortest run that counts as a tick at all. */
  minTickLength: number;
  /** Colour distance from background that counts as ink. */
  inkThreshold: number;
  /** Widest a single tick may be across the axis, in pixels. */
  maxTickWidth: number;
}

/**
 * Defaults sized for a ~900x560 plot. `resolveTickOptions` rescales the
 * geometric limits for larger or smaller images so a 2x screenshot behaves the
 * same as a 1x one.
 */
export const DEFAULT_TICK_OPTIONS: TickOptions = {
  maxTickLength: 14,
  minTickLength: 2,
  inkThreshold: 40,
  maxTickWidth: 7,
};

export function resolveTickOptions(
  frame: PlotFrame,
  override: Partial<TickOptions> = {},
): TickOptions {
  const minDim = Math.min(frame.rect.x1 - frame.rect.x0, frame.rect.y1 - frame.rect.y0);
  return {
    maxTickLength: clamp(Math.round(minDim * 0.035), 8, 34),
    minTickLength: 2,
    inkThreshold: DEFAULT_TICK_OPTIONS.inkThreshold,
    maxTickWidth: clamp(Math.round(minDim * 0.02), 7, 20),
    ...override,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface TickScan {
  side: AxisSide;
  ticks: Tick[];
  /** 'outward' (outside the data area) or 'inward'. */
  direction: 'outward' | 'inward';
  /** Longest detected tick, used to place the label search band. */
  tickLength: number;
  /** Spine position the ticks hang off. */
  spinePos: number;
  /**
   * `ticks` when real tick marks were found geometrically, `labels` when the
   * plot draws no tick marks and the positions came from the label text blobs.
   */
  source: 'ticks' | 'labels';
  /** The band of pixels, perpendicular to the axis, holding the tick labels. */
  labelBand: { near: number; far: number } | null;
  /** Tight bounding boxes of the label text, when `source === 'labels'`. */
  labelRects?: Rect[];
}

/** Sign of the outward direction from the spine for each axis. */
function outwardSign(side: AxisSide): number {
  return side === 'bottom' ? 1 : -1;
}

/**
 * Walk perpendicular to the spine and return how many consecutive ink pixels
 * there are, stopping at `limit + 1`.
 */
function runLength(
  img: ImageBuffer,
  bg: RGB,
  along: number,
  from: number,
  step: number,
  limit: number,
  horizontalSpine: boolean,
  inkThreshold: number,
): number {
  let n = 0;
  for (let k = 0; k <= limit; k++) {
    const p = from + k * step;
    const x = horizontalSpine ? along : p;
    const y = horizontalSpine ? p : along;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) break;
    if (colourDistance(getPixel(img, x, y), bg) < inkThreshold) break;
    n++;
  }
  return n;
}

/** Range along the axis to scan, a little wider than the data rectangle. */
function axisRange(img: ImageBuffer, frame: PlotFrame, side: AxisSide, margin: number) {
  const horizontal = side === 'bottom';
  const lo = Math.max(0, (horizontal ? frame.rect.x0 : frame.rect.y0) - margin);
  const hi = Math.min(
    (horizontal ? img.width : img.height) - 1,
    (horizontal ? frame.rect.x1 : frame.rect.y1) + margin,
  );
  return { lo, hi, horizontal };
}

/**
 * Locate the band of rows (bottom axis) or columns (left axis) that holds the
 * tick labels: the first contiguous stripe of ink outside the axis, past any
 * tick marks. Adapting to the image instead of assuming a font size is what
 * makes 2x screenshots work identically to 1x ones.
 */
export function findLabelBand(
  img: ImageBuffer,
  frame: PlotFrame,
  side: AxisSide,
  spinePos: number,
  startOffset: number,
  inkThreshold: number,
): { near: number; far: number } | null {
  const { lo, hi, horizontal } = axisRange(img, frame, side, 6);
  const step = outwardSign(side);
  const limit = Math.round(
    horizontal ? Math.min(img.height * 0.3, 160) : Math.min(img.width * 0.35, 220),
  );
  const bg = frame.background;

  let near = -1;
  let far = -1;
  let emptyRun = 0;
  for (let k = startOffset; k <= limit; k++) {
    const p = spinePos + k * step;
    if (p < 0 || p >= (horizontal ? img.height : img.width)) break;
    let count = 0;
    for (let a = lo; a <= hi; a++) {
      const x = horizontal ? a : p;
      const y = horizontal ? p : a;
      if (colourDistance(getPixel(img, x, y), bg) >= inkThreshold) count++;
    }
    if (count > 0) {
      if (near < 0) near = p;
      far = p;
      emptyRun = 0;
    } else if (near >= 0 && ++emptyRun >= 3) {
      break;
    }
  }
  if (near < 0) return null;
  return step > 0 ? { near, far } : { near: far, far: near };
}

function scanDirection(
  img: ImageBuffer,
  frame: PlotFrame,
  side: AxisSide,
  direction: 'outward' | 'inward',
  opts: TickOptions,
): Tick[] {
  const horizontalSpine = side === 'bottom';
  const spine = horizontalSpine ? frame.bottom : frame.left;
  if (!spine) return [];
  const half = Math.ceil(spine.thickness / 2) + 1;
  const spinePos = Math.round(spine.pos);
  const step = direction === 'outward' ? outwardSign(side) : -outwardSign(side);
  const from = spinePos + step * half;

  const { lo, hi } = axisRange(img, frame, side, 4);
  const bg = frame.background;
  const axisLimit = horizontalSpine ? img.width : img.height;

  const lengths = new Int32Array(hi - lo + 1);
  for (let a = lo; a <= hi; a++) {
    const n = runLength(
      img,
      bg,
      a,
      from,
      step,
      opts.maxTickLength,
      horizontalSpine,
      opts.inkThreshold,
    );
    // A run that reaches the cap is a gridline or the data area, not a tick.
    lengths[a - lo] = n > opts.maxTickLength ? 0 : n;
  }

  /**
   * Sub-pixel tick centre: ink mass over the tick's own rows, including the
   * antialiased columns either side that fall below the binary threshold.
   */
  const centroid = (i: number, j: number, len: number): number => {
    let wsum = 0;
    let psum = 0;
    for (let k = i - 1; k <= j + 1; k++) {
      const a = lo + k;
      if (a < 0 || a >= axisLimit) continue;
      let mass = 0;
      for (let d = 0; d < len; d++) {
        const p = from + d * step;
        const x = horizontalSpine ? a : p;
        const y = horizontalSpine ? p : a;
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        mass += inkStrength(getPixel(img, x, y), bg);
      }
      wsum += mass;
      psum += mass * a;
    }
    return wsum > 0 ? psum / wsum : lo + (i + j) / 2;
  };

  const ticks: Tick[] = [];
  let i = 0;
  while (i < lengths.length) {
    if (lengths[i] < opts.minTickLength) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lengths.length && lengths[j + 1] >= opts.minTickLength) j++;
    if (j - i + 1 <= opts.maxTickWidth) {
      let maxLen = 0;
      for (let k = i; k <= j; k++) maxLen = Math.max(maxLen, lengths[k]);
      ticks.push({ px: centroid(i, j, maxLen), length: maxLen, major: true });
    }
    i = j + 1;
  }
  return ticks;
}

/**
 * Reject ticks that break the regular spacing of the majority. Chart ticks are
 * evenly spaced (linearly, or per-decade on a log axis), so an isolated stray
 * blob of ink under the axis is easy to drop.
 */
function keepRegular<T extends { px: number }>(items: T[]): T[] {
  if (items.length < 4) return items;
  const gaps: number[] = [];
  for (let i = 1; i < items.length; i++) gaps.push(items[i].px - items[i - 1].px);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (!(median > 0)) return items;
  // Accept a gap that is close to the median or a small multiple of it: log
  // axes legitimately skip positions, and so do axes with rotated labels.
  const ok = (g: number) => {
    const ratio = g / median;
    const nearest = Math.round(ratio);
    return nearest >= 1 && nearest <= 4 && Math.abs(ratio - nearest) < 0.25;
  };
  return items.filter((t, i) => {
    const prev = i > 0 ? items[i - 1].px : null;
    const next = i < items.length - 1 ? items[i + 1].px : null;
    return (prev !== null && ok(t.px - prev)) || (next !== null && ok(next - t.px));
  });
}

/** Split ticks into major/minor by length when two clear populations exist. */
function classifyMajor(ticks: Tick[]): Tick[] {
  if (ticks.length < 4) return ticks.map((t) => ({ ...t, major: true }));
  const lens = ticks.map((t) => t.length);
  const min = Math.min(...lens);
  const max = Math.max(...lens);
  if (max - min < 2) return ticks.map((t) => ({ ...t, major: true }));
  const cut = (min + max) / 2;
  const longs = ticks.filter((t) => t.length >= cut).length;
  if (longs === 0 || longs === ticks.length) return ticks.map((t) => ({ ...t, major: true }));
  return ticks.map((t) => ({ ...t, major: t.length >= cut }));
}

/**
 * Group the ink inside the label band into text blobs and take each blob's
 * bounding-box centre as a tick position.
 */
function detectLabelGroups(
  img: ImageBuffer,
  frame: PlotFrame,
  side: AxisSide,
  band: { near: number; far: number },
  opts: TickOptions,
): Array<Tick & { rect: Rect }> {
  const { lo, hi, horizontal } = axisRange(img, frame, side, 40);
  const bg = frame.background;

  const near = new Int32Array(hi - lo + 1).fill(-1);
  const far = new Int32Array(hi - lo + 1).fill(-1);
  for (let a = lo; a <= hi; a++) {
    for (let p = band.near; p <= band.far; p++) {
      const x = horizontal ? a : p;
      const y = horizontal ? p : a;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (colourDistance(getPixel(img, x, y), bg) < opts.inkThreshold) continue;
      if (near[a - lo] < 0) near[a - lo] = p;
      far[a - lo] = p;
    }
  }

  // Merge glyphs of the same number: digits within a fraction of the text size.
  const textSize = band.far - band.near + 1;
  const mergeGap = horizontal ? Math.max(3, Math.round(textSize * 0.4)) : Math.max(2, Math.round(textSize * 0.12));
  const maxBlob = Math.round((hi - lo) * 0.4);

  const out: Array<Tick & { rect: Rect }> = [];
  let i = 0;
  while (i < near.length) {
    if (near[i] < 0) {
      i++;
      continue;
    }
    let j = i;
    let gap = 0;
    let last = i;
    while (j + 1 < near.length) {
      if (near[j + 1] >= 0) {
        last = j + 1;
        gap = 0;
      } else if (++gap > mergeGap) break;
      j++;
    }
    j = last;
    let pMin = Infinity;
    let pMax = -Infinity;
    for (let k = i; k <= j; k++) {
      if (near[k] < 0) continue;
      pMin = Math.min(pMin, near[k]);
      pMax = Math.max(pMax, far[k]);
    }
    if (j - i + 1 <= maxBlob) {
      out.push({
        px: lo + (i + j) / 2,
        length: 0,
        major: true,
        rect: horizontal
          ? { x0: lo + i, x1: lo + j, y0: pMin, y1: pMax }
          : { x0: pMin, x1: pMax, y0: lo + i, y1: lo + j },
      });
    }
    i = j + 1;
  }
  return out;
}

export function detectTicks(
  img: ImageBuffer,
  frame: PlotFrame,
  side: AxisSide,
  options: Partial<TickOptions> = {},
): TickScan {
  const opts = resolveTickOptions(frame, options);
  const spine = side === 'bottom' ? frame.bottom : frame.left;
  const spinePos = spine ? Math.round(spine.pos) : side === 'bottom' ? frame.rect.y1 : frame.rect.x0;
  const halfSpine = Math.ceil((spine?.thickness ?? 2) / 2) + 1;

  let direction: 'outward' | 'inward' = 'outward';
  let ticks = keepRegular(scanDirection(img, frame, side, 'outward', opts));
  if (ticks.length < 3) {
    const inward = keepRegular(scanDirection(img, frame, side, 'inward', opts));
    if (inward.length > ticks.length) {
      ticks = inward;
      direction = 'inward';
    }
  }

  if (ticks.length >= 2) {
    ticks = classifyMajor(ticks);
    const tickLength = Math.max(...ticks.map((t) => t.length));
    const start = direction === 'outward' ? halfSpine + tickLength + 1 : halfSpine;
    return {
      side,
      ticks,
      direction,
      tickLength,
      spinePos,
      source: 'ticks',
      labelBand: findLabelBand(img, frame, side, spinePos, start, opts.inkThreshold),
    };
  }

  const band = findLabelBand(img, frame, side, spinePos, halfSpine + 1, opts.inkThreshold);
  if (!band) {
    return { side, ticks: [], direction, tickLength: 0, spinePos, source: 'ticks', labelBand: null };
  }
  const groups = keepRegular(detectLabelGroups(img, frame, side, band, opts));
  return {
    side,
    ticks: groups.map(({ px, length, major }) => ({ px, length, major })),
    direction: 'outward',
    tickLength: 0,
    spinePos,
    source: 'labels',
    labelBand: band,
    labelRects: groups.map((g) => g.rect),
  };
}

/**
 * The rectangle where the label for tick `index` should be. When the positions
 * came from label blobs we already know the exact box; otherwise we take the
 * detected label band and a slice of it centred on the tick.
 */
export function labelRect(
  img: ImageBuffer,
  scan: TickScan,
  index: number,
  neighbourGap: number,
): Rect {
  const tick = scan.ticks[index];
  if (scan.source === 'labels' && scan.labelRects?.[index]) {
    const r = scan.labelRects[index];
    return { x0: r.x0 - 2, y0: r.y0 - 2, x1: r.x1 + 2, y1: r.y1 + 2 };
  }
  const band = scan.labelBand;
  if (scan.side === 'bottom') {
    const halfWidth = Math.max(12, Math.min(neighbourGap * 0.48, 90));
    const y0 = band ? band.near - 2 : scan.spinePos + scan.tickLength + 2;
    const y1 = band ? band.far + 2 : y0 + 26;
    return {
      x0: Math.max(0, Math.round(tick.px - halfWidth)),
      x1: Math.min(img.width - 1, Math.round(tick.px + halfWidth)),
      y0: Math.max(0, y0),
      y1: Math.min(img.height - 1, y1),
    };
  }
  const halfHeight = Math.max(8, Math.min(neighbourGap * 0.48, 30));
  const x1 = band ? band.far + 2 : scan.spinePos - scan.tickLength - 2;
  const x0 = band ? band.near - 2 : x1 - 90;
  return {
    x0: Math.max(0, x0),
    x1: Math.max(0, Math.min(img.width - 1, x1)),
    y0: Math.max(0, Math.round(tick.px - halfHeight)),
    y1: Math.min(img.height - 1, Math.round(tick.px + halfHeight)),
  };
}

/** Median spacing between consecutive ticks; used to size label crops. */
export function medianGap(ticks: Tick[]): number {
  if (ticks.length < 2) return 40;
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i++) gaps.push(Math.abs(ticks[i].px - ticks[i - 1].px));
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
