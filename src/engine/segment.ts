/**
 * Data-ink segmentation over the plot interior.
 *
 * Two problems are solved here. First, which colours are data series: the
 * dominant non-background, non-gridline colours. Second, which of the pixels of
 * a series colour are actually data: charts routinely print labels *inside* the
 * plot area in the series' own colour ("Women", "Men", endpoint values), so
 * colour cannot separate them. Shape and connectivity can - a data path spans a
 * large fraction of the plot width, a word does not.
 */

import { colourDistance, getPixel, inkAlpha, isGray, luma } from './image.ts';
import { insetRect } from './frame.ts';
import type { ImageBuffer, PlotFrame, Rect, RGB, SeriesCandidate } from './types.ts';

export interface SegmentOptions {
  /** Colour distance below which two pixels join the same cluster. */
  clusterRadius: number;
  /** Distance from the background at which a pixel counts as ink. */
  inkThreshold: number;
  /** Minimum share of the largest cluster for a cluster to be a series. */
  minClusterShare: number;
  /** Maximum number of series to return. */
  maxSeries: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  clusterRadius: 60,
  inkThreshold: 30,
  minClusterShare: 0.06,
  maxSeries: 6,
};

/** Per-pixel coverage of one series colour over the plot interior. */
export interface SeriesMask {
  colour: RGB;
  rect: Rect;
  /** Row-major alpha in [0,1] over `rect`, `width * height` entries. */
  alpha: Float32Array;
  width: number;
  height: number;
}

export interface Component {
  /** Index into the mask's own pixel list. */
  pixels: number[];
  bounds: Rect;
  /** Sum of alpha over the component: its ink area. */
  area: number;
  /** Alpha-weighted centroid. */
  cx: number;
  cy: number;
}

/**
 * Gridlines: interior rows/columns that are nearly fully inked in a single
 * faint colour. Excluding them stops a grey series from swallowing the grid,
 * and stops the grid from dominating the colour clustering.
 */
export interface GridInfo {
  columns: Set<number>;
  rows: Set<number>;
  colour: RGB | null;
  /** Largest colour distance from the background found in the interior. */
  strongestInk: number;
}

export function detectGridlines(img: ImageBuffer, frame: PlotFrame, interior: Rect): GridInfo {
  const bg = frame.background;
  const columns = new Set<number>();
  const rows = new Set<number>();
  const samples: RGB[] = [];

  let strongestInk = 0;
  for (let y = interior.y0; y <= interior.y1; y++) {
    for (let x = interior.x0; x <= interior.x1; x++) {
      const d = colourDistance(getPixel(img, x, y), bg);
      if (d > strongestInk) strongestInk = d;
    }
  }
  // A gridline is faint relative to the data ink as well as faint outright,
  // which is what keeps a dark dotted grid on a chart of dark markers from
  // being mistaken for a series - and a grey data line from being erased.
  const faintLimit = Math.max(40, strongestInk * 0.55);

  const scan = (isColumn: boolean, out: Set<number>) => {
    const outerLo = isColumn ? interior.x0 : interior.y0;
    const outerHi = isColumn ? interior.x1 : interior.y1;
    const innerLo = isColumn ? interior.y0 : interior.x0;
    const innerHi = isColumn ? interior.y1 : interior.x1;
    const total = innerHi - innerLo + 1;
    if (total < 8) return;
    for (let o = outerLo; o <= outerHi; o++) {
      const rs: number[] = [];
      const gs: number[] = [];
      const bs: number[] = [];
      for (let i = innerLo; i <= innerHi; i++) {
        const c = isColumn ? getPixel(img, o, i) : getPixel(img, i, o);
        if (colourDistance(c, bg) < 12) continue;
        rs.push(c.r);
        gs.push(c.g);
        bs.push(c.b);
      }
      const inked = rs.length;
      // 0.3 rather than "almost every pixel": dotted grids are the norm on the
      // charts this tool targets, and a sparse dot pattern covers little of the
      // line it draws. The faintness tests below are what keep data out.
      if (inked / total < 0.3) continue;
      // Median, not mean: data markers sitting on a gridline drag a mean toward
      // the data colour and hide the gridline from these tests.
      const mid = { r: medianOf(rs), g: medianOf(gs), b: medianOf(bs) };
      // Gridlines are faint and achromatic; a solid data line is neither.
      if (!isGray(mid, 0.25)) continue;
      if (colourDistance(mid, bg) > faintLimit) continue;
      out.add(o);
      samples.push(mid);
    }
  };

  scan(true, columns);
  scan(false, rows);

  if (samples.length === 0) return { columns, rows, colour: null, strongestInk };
  const mean = samples.reduce(
    (acc, c) => ({ r: acc.r + c.r / samples.length, g: acc.g + c.g / samples.length, b: acc.b + c.b / samples.length }),
    { r: 0, g: 0, b: 0 },
  );
  return { columns, rows, colour: mean, strongestInk };
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

interface Cluster {
  r: number;
  g: number;
  b: number;
  n: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  columns: Set<number>;
}

/**
 * Cluster the interior's ink by colour. Chart series are flat colours, so
 * greedy nearest-centroid clustering with a generous radius separates them
 * cleanly while folding each series' antialiased edge pixels into its own
 * cluster.
 */
export function findSeriesCandidates(
  img: ImageBuffer,
  frame: PlotFrame,
  options: Partial<SegmentOptions> = {},
  cachedGrid?: GridInfo,
): SeriesCandidate[] {
  const opts = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const interior = clampInterior(frame.rect, img, frame);
  const grid = cachedGrid ?? detectGridlines(img, frame, interior);
  const bg = frame.background;
  const clusters: Cluster[] = [];
  const plotWidth = interior.x1 - interior.x0 + 1;

  // Cluster only the strongest ink. Antialiased edges and JPEG ringing are
  // weak blends toward the background; including them spawns phantom "series"
  // that shadow the real one. The edges are picked back up by `buildMask`,
  // where their partial alpha is exactly what gives sub-pixel accuracy.
  const coreThreshold = Math.max(opts.inkThreshold, grid.strongestInk * 0.35);
  const labelW = interior.x1 - interior.x0 + 1;
  const labelH = interior.y1 - interior.y0 + 1;
  const labels = new Int32Array(labelW * labelH).fill(-1);

  for (let y = interior.y0; y <= interior.y1; y++) {
    if (grid.rows.has(y)) continue;
    for (let x = interior.x0; x <= interior.x1; x++) {
      if (grid.columns.has(x)) continue;
      const c = getPixel(img, x, y);
      if (colourDistance(c, bg) < coreThreshold) continue;
      if (grid.colour && colourDistance(c, grid.colour) < 24) continue;

      let best: Cluster | null = null;
      let bestD = Infinity;
      for (const cl of clusters) {
        const d = colourDistance(c, { r: cl.r / cl.n, g: cl.g / cl.n, b: cl.b / cl.n });
        if (d < bestD) {
          bestD = d;
          best = cl;
        }
      }
      if (!best || bestD > opts.clusterRadius) {
        labels[(y - interior.y0) * labelW + (x - interior.x0)] = clusters.length;
        clusters.push({
          r: c.r,
          g: c.g,
          b: c.b,
          n: 1,
          minX: x,
          maxX: x,
          minY: y,
          maxY: y,
          columns: new Set([x]),
        });
        continue;
      }
      labels[(y - interior.y0) * labelW + (x - interior.x0)] = clusters.indexOf(best);
      best.r += c.r;
      best.g += c.g;
      best.b += c.b;
      best.n++;
      best.minX = Math.min(best.minX, x);
      best.maxX = Math.max(best.maxX, x);
      best.minY = Math.min(best.minY, y);
      best.maxY = Math.max(best.maxY, y);
      best.columns.add(x);
    }
  }

  const merged = mergeAntialiasClusters(
    clusters,
    bg,
    adjacencyFractions(labels, labelW, labelH, clusters.length, clusters.map((c) => c.n)),
  );
  const largest = Math.max(0, ...merged.map((c) => c.n));
  if (largest === 0) return [];

  return merged
    // A real series is either substantial or spread across the plot. A small
    // cluster confined to a few columns is compression noise or a stray mark.
    .filter(
      (c) =>
        c.n >= largest * opts.minClusterShare &&
        c.n >= 24 &&
        (c.columns.size / plotWidth >= 0.25 || c.n >= largest * 0.2),
    )
    .map((c) => {
      const colour = { r: c.r / c.n, g: c.g / c.n, b: c.b / c.n };
      return {
        colour,
        pixelCount: c.n,
        columnCoverage: c.columns.size / plotWidth,
        bounds: { x0: c.minX, y0: c.minY, x1: c.maxX, y1: c.maxY },
        gray: isGray(colour, 0.2),
      };
    })
    .sort((a, b) => b.pixelCount - a.pixelCount)
    .slice(0, opts.maxSeries);
}

/**
 * Fold each series' antialiased edge colours back into the series itself.
 *
 * The edge pixels of a 2 px blue line are blends of blue and the background, so
 * they cluster separately and would otherwise be reported as extra "series"
 * that shadow the real one. A blend is recognisable: it sits on the straight
 * line between the background and the base colour in RGB space. Only clusters
 * clearly smaller than the base are folded in, so a genuine lighter tint drawn
 * as its own series survives.
 */
function mergeAntialiasClusters(
  clusters: Cluster[],
  bg: RGB,
  adjacency: Float32Array,
): Cluster[] {
  const n = clusters.length;
  const indexed = clusters.map((c, i) => ({ ...c, colour: { r: c.r / c.n, g: c.g / c.n, b: c.b / c.n }, index: i }));
  const ordered = [...indexed].sort((a, b) => b.n - a.n);
  const kept: Array<(typeof indexed)[number]> = [];
  for (const c of ordered) {
    const colour = c.colour;
    let base: (typeof indexed)[number] | undefined;
    let baseT = 0;
    for (const k of kept) {
      const fit = rayFit(colour, k.colour, bg);
      const touch = adjacency[c.index * n + k.index];
      // Two ways a cluster turns out to be part of another series. It can sit
      // on the straight line from the background to that series' colour, which
      // is what an antialiased edge is; a lighter *tint* drawn as its own
      // series looks identical by colour alone, so we also require the pixels
      // to hug the base. Or it can be a compression halo, which is off the
      // blend line but wrapped tightly around the line it came from.
      const isEdge = fit.t > 0.08 && fit.off < 20 && touch >= 0.25;
      const isHalo = touch >= 0.6 && colourDistance(colour, k.colour) < 170;
      if (isEdge || isHalo) {
        base = k;
        baseT = fit.t;
        break;
      }
    }
    if (!base) {
      kept.push({ ...c, colour });
      continue;
    }
    // A thin antialiased line never reaches full saturation, so the cluster
    // that lies *beyond* the current base along the same ray is the truer ink
    // colour; adopt it.
    if (baseT > 1) base.colour = colour;
    base.n += c.n;
    base.minX = Math.min(base.minX, c.minX);
    base.maxX = Math.max(base.maxX, c.maxX);
    base.minY = Math.min(base.minY, c.minY);
    base.maxY = Math.max(base.maxY, c.maxY);
    for (const x of c.columns) base.columns.add(x);
  }
  return kept.map((k) => ({ ...k, r: k.colour.r * k.n, g: k.colour.g * k.n, b: k.colour.b * k.n }));
}

/**
 * For each ordered pair of clusters, the fraction of the first cluster's
 * pixels that touch a pixel of the second. Antialiased edges and compression
 * halos wrap the line they came from; two genuinely different series touch
 * only where they cross.
 */
function adjacencyFractions(
  labels: Int32Array,
  width: number,
  height: number,
  clusterCount: number,
  sizes: number[],
): Float32Array {
  const counts = new Float32Array(clusterCount * clusterCount);
  const seen = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (l < 0) continue;
      seen.clear();
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const m = labels[ny * width + nx];
          if (m >= 0 && m !== l) seen.add(m);
        }
      }
      for (const m of seen) counts[l * clusterCount + m]++;
    }
  }
  for (let l = 0; l < clusterCount; l++) {
    const size = Math.max(1, sizes[l]);
    for (let m = 0; m < clusterCount; m++) counts[l * clusterCount + m] /= size;
  }
  return counts;
}

/**
 * Project `c` onto the ray from `bg` through `base`. `t` is how far along that
 * ray it sits (1 = exactly the base colour, >1 = more saturated) and `off` is
 * how far off the ray it is, which is what tells a blend from a real colour.
 */
function rayFit(c: RGB, base: RGB, bg: RGB): { t: number; off: number } {
  const dr = base.r - bg.r;
  const dg = base.g - bg.g;
  const db = base.b - bg.b;
  const denom = dr * dr + dg * dg + db * db;
  if (denom < 1e-6) return { t: 0, off: Infinity };
  const t = ((c.r - bg.r) * dr + (c.g - bg.g) * dg + (c.b - bg.b) * db) / denom;
  const off = Math.hypot(c.r - (bg.r + t * dr), c.g - (bg.g + t * dg), c.b - (bg.b + t * db));
  return { t, off };
}

/**
 * Inset the plot rectangle so spine pixels never enter the data mask. The
 * inset follows the spine thickness, which doubles on a 2x screenshot.
 */
export function clampInterior(rect: Rect, img: ImageBuffer, frame?: PlotFrame): Rect {
  const thickest = Math.max(
    2,
    frame?.bottom?.thickness ?? 0,
    frame?.left?.thickness ?? 0,
    frame?.top?.thickness ?? 0,
    frame?.right?.thickness ?? 0,
  );
  const r = insetRect(rect, Math.ceil(thickest / 2) + 1);
  return {
    x0: Math.max(0, Math.min(img.width - 1, r.x0)),
    y0: Math.max(0, Math.min(img.height - 1, r.y0)),
    x1: Math.max(0, Math.min(img.width - 1, r.x1)),
    y1: Math.max(0, Math.min(img.height - 1, r.y1)),
  };
}

/**
 * Build the per-pixel coverage mask for one series colour.
 *
 * `inkAlpha` recovers the blend fraction of an antialiased pixel, which is what
 * makes the column centroid accurate to a fraction of a pixel rather than
 * quantised to whole rows.
 */
export function buildMask(
  img: ImageBuffer,
  frame: PlotFrame,
  colour: RGB,
  others: RGB[],
  options: Partial<SegmentOptions> = {},
  cachedGrid?: GridInfo,
): SeriesMask {
  const opts = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const rect = clampInterior(frame.rect, img, frame);
  const width = rect.x1 - rect.x0 + 1;
  const height = rect.y1 - rect.y0 + 1;
  const alpha = new Float32Array(width * height);
  const bg = frame.background;
  const grid = cachedGrid ?? detectGridlines(img, frame, rect);
  const rivals = others.filter((o) => colourDistance(o, colour) > 1e-6);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = getPixel(img, rect.x0 + x, rect.y0 + y);
      if (colourDistance(px, bg) < opts.inkThreshold * 0.5) continue;
      // A pixel closer to another series' colour belongs to that series.
      const dOwn = colourDistance(px, colour);
      let claimed = false;
      for (const r of rivals) {
        if (colourDistance(px, r) < dOwn) {
          claimed = true;
          break;
        }
      }
      if (claimed) continue;
      if (grid.colour && colourDistance(px, grid.colour) < colourDistance(px, colour)) continue;
      const a = inkAlpha(px, colour, bg);
      if (a > 0.05) alpha[y * width + x] = a;
    }
  }
  return { colour, rect, alpha, width, height };
}

/** 8-connected components of a mask above `threshold`. */
export function findComponents(mask: SeriesMask, threshold = 0.3): Component[] {
  const { width, height, alpha } = mask;
  const seen = new Uint8Array(width * height);
  const out: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < alpha.length; start++) {
    if (seen[start] || alpha[start] < threshold) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pixels: number[] = [];
    let area = 0;
    let sx = 0;
    let sy = 0;
    let x0 = width;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;

    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      const a = alpha[i];
      pixels.push(i);
      area += a;
      sx += a * x;
      sy += a * y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const ni = ny * width + nx;
          if (seen[ni] || alpha[ni] < threshold) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    out.push({
      pixels,
      bounds: { x0, y0, x1, y1 },
      area,
      cx: area > 0 ? sx / area : x0,
      cy: area > 0 ? sy / area : y0,
    });
  }
  return out.sort((a, b) => b.area - a.area);
}

export interface ComponentSelection {
  kept: Component[];
  rejected: Component[];
  /** True when the kept components look like discrete markers, not a path. */
  markerLike: boolean;
}

/** Per-column alpha-weighted centroid of one component. */
function componentColumns(component: Component, mask: SeriesMask): Map<number, number> {
  const weight = new Map<number, number>();
  const moment = new Map<number, number>();
  for (const i of component.pixels) {
    const x = i % mask.width;
    const y = (i / mask.width) | 0;
    const a = mask.alpha[i];
    weight.set(x, (weight.get(x) ?? 0) + a);
    moment.set(x, (moment.get(x) ?? 0) + a * y);
  }
  const out = new Map<number, number>();
  for (const [x, w] of weight) if (w > 0) out.set(x, moment.get(x)! / w);
  return out;
}

function medianNum(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Median weighted by ink area.
 *
 * A plain median over components counts a two-pixel speck the same as the
 * line itself, so a curve broken into a few long pieces plus a scatter of text
 * glyphs would look like a field of markers. Weighting by area asks what the
 * bulk of the ink looks like, which is the question that matters.
 */
function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((acc, p) => acc + p.w, 0);
  if (total <= 0) return medianNum(values);
  let seen = 0;
  for (const p of pairs) {
    seen += p.w;
    if (seen >= total / 2) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

/**
 * Separate data ink from in-plot text, and decide whether the ink is a drawn
 * path or discrete markers.
 *
 * The mode test is shape, not spacing: a marker is a compact filled blob, a
 * dash is an elongated sliver, and a line is a long thin ribbon whose bounding
 * box is mostly empty. Fill ratio and aspect separate those cleanly, where a
 * spacing rule confuses a dashed line with a scatter.
 *
 * For a path, components are admitted by *continuity*: a dash lies on the line
 * its neighbours describe, a printed word does not. That is a connectivity and
 * geometry test on purpose - charts print labels inside the plot in the series'
 * own colour, so no colour rule can reject them.
 */
export function selectDataComponents(
  components: Component[],
  mask: SeriesMask,
): ComponentSelection {
  if (components.length === 0) return { kept: [], rejected: [], markerLike: false };

  const metrics = components.map((c) => {
    const w = c.bounds.x1 - c.bounds.x0 + 1;
    const h = c.bounds.y1 - c.bounds.y0 + 1;
    return { c, w, h, fill: c.area / (w * h), aspect: w / h, span: w };
  });
  const medianArea = medianNum(metrics.map((m) => m.c.area));
  const substantial = metrics.filter((m) => m.c.area >= medianArea * 0.15);
  const areas = substantial.map((m) => m.c.area);
  const typicalFill = weightedMedian(substantial.map((m) => m.fill), areas);
  const typicalAspect = weightedMedian(substantial.map((m) => m.aspect), areas);

  const markerLike =
    substantial.length >= 4 && typicalFill >= 0.35 && typicalAspect >= 0.45 && typicalAspect <= 2.2;

  if (markerLike) {
    // Keep blobs of a consistent size: the outliers are specks and glyphs.
    const kept = metrics
      .filter((m) => m.c.area >= medianArea * 0.2 && m.c.area <= medianArea * 8)
      .map((m) => m.c);
    return { kept, rejected: components.filter((c) => !kept.includes(c)), markerLike: true };
  }

  // Path mode. Grow outward from the longest component, admitting anything that
  // continues the line it describes.
  const columnsOf = new Map<Component, Map<number, number>>();
  for (const c of components) columnsOf.set(c, componentColumns(c, mask));

  const trunk = metrics.reduce((a, b) => (b.span > a.span ? b : a)).c;
  const path = new Float64Array(mask.width).fill(Number.NaN);
  const distance = new Int32Array(mask.width);
  const fill = (c: Component) => {
    for (const [x, y] of columnsOf.get(c)!) path[x] = y;
    refreshDistance(path, distance);
  };
  fill(trunk);

  const trunkCols = columnsOf.get(trunk)!;
  const stroke = medianNum(
    [...trunkCols.keys()].map((x) => {
      let w = 0;
      for (let y = 0; y < mask.height; y++) w += mask.alpha[y * mask.width + x];
      return w;
    }),
  );
  const tol = Math.min(Math.max(3, stroke * 2.5), mask.height * 0.08);
  const maxRef = Math.max(12, Math.round(mask.width * 0.05));
  const maxJoin = Math.max(8, Math.round(mask.width * 0.03));

  // Grow nearest-first, not largest-first: a dashed line is a chain, and each
  // link can only be judged once its neighbour is part of the path. Taking the
  // biggest remaining piece instead leaves gaps the chain never crosses.
  const accepted = new Set<Component>([trunk]);
  const refused = new Set<Component>();
  for (;;) {
    let next: Component | null = null;
    let nextGap = Infinity;
    for (const c of components) {
      if (accepted.has(c) || refused.has(c)) continue;
      let gap = Infinity;
      for (const x of columnsOf.get(c)!.keys()) gap = Math.min(gap, distance[x]);
      if (gap < nextGap) {
        nextGap = gap;
        next = c;
      }
    }
    if (!next || nextGap > maxJoin) break;

    const deviations: number[] = [];
    let allowance = tol;
    for (const [x, y] of columnsOf.get(next)!) {
      // Only judge where the path is genuinely nearby. Extrapolating a slope
      // across a long component's far end says nothing about whether its near
      // end continues the line, and would reject the continuation.
      if (distance[x] > maxJoin) continue;
      const ref = referenceAt(path, x, maxRef);
      if (ref === null) continue;
      // Across a gap on a steep segment, a small slope error becomes a large
      // position error, so the allowance grows with slope and gap.
      const local = ref.extrapolated
        ? tol * 2 + Math.abs(ref.slope) * ref.distance
        : tol;
      allowance = Math.max(allowance, local);
      deviations.push(Math.abs(y - ref.value));
    }
    if (deviations.length > 0 && medianNum(deviations) <= allowance) {
      accepted.add(next);
      fill(next);
    } else {
      refused.add(next);
    }
  }

  const kept = components.filter((c) => accepted.has(c));
  return { kept, rejected: components.filter((c) => !accepted.has(c)), markerLike: false };
}

/** Distance from each column to the nearest column where the path is known. */
function refreshDistance(path: Float64Array, out: Int32Array): void {
  const big = path.length + 1;
  let run = big;
  for (let i = 0; i < path.length; i++) {
    run = Number.isNaN(path[i]) ? Math.min(big, run + 1) : 0;
    out[i] = run;
  }
  run = big;
  for (let i = path.length - 1; i >= 0; i--) {
    run = Number.isNaN(path[i]) ? Math.min(big, run + 1) : 0;
    if (run < out[i]) out[i] = run;
  }
}

/**
 * The path's value at column `x`: interpolated when the path is known on both
 * sides, otherwise extrapolated along the local slope from the nearer side.
 *
 * The slope comes from a least-squares fit over the nearest known columns, not
 * from the last two. The final column of a dash is half-covered ink, so its
 * centroid is biased, and a two-point slope built on it swings wildly - enough
 * to break the chain in the middle of a steep dashed segment.
 */
function referenceAt(
  path: Float64Array,
  x: number,
  maxRef: number,
): { value: number; extrapolated: boolean; distance: number; slope: number } | null {
  let left = -1;
  for (let i = x - 1; i >= Math.max(0, x - maxRef); i--) {
    if (!Number.isNaN(path[i])) {
      left = i;
      break;
    }
  }
  let right = -1;
  for (let i = x + 1; i < Math.min(path.length, x + maxRef + 1); i++) {
    if (!Number.isNaN(path[i])) {
      right = i;
      break;
    }
  }
  if (left >= 0 && right >= 0) {
    const t = (x - left) / (right - left);
    return {
      value: path[left] + t * (path[right] - path[left]),
      extrapolated: false,
      distance: Math.min(x - left, right - x),
      slope: (path[right] - path[left]) / (right - left),
    };
  }
  const anchor = left >= 0 ? left : right;
  if (anchor < 0) return null;
  const distance = Math.abs(x - anchor);
  const slope = slopeNear(path, anchor, left >= 0 ? -1 : 1, 10);
  return { value: path[anchor] + slope * (x - anchor), extrapolated: true, distance, slope };
}

/** Least-squares slope over up to `count` known columns from `anchor`. */
function slopeNear(path: Float64Array, anchor: number, step: number, count: number): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = anchor; i >= 0 && i < path.length && xs.length < count; i += step) {
    if (Number.isNaN(path[i])) continue;
    xs.push(i);
    ys.push(path[i]);
  }
  if (xs.length < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  return sxx > 1e-9 ? sxy / sxx : 0;
}

/** Mask covering only the selected components. */
export function maskOfComponents(mask: SeriesMask, components: Component[]): SeriesMask {
  const alpha = new Float32Array(mask.alpha.length);
  for (const c of components) for (const i of c.pixels) alpha[i] = mask.alpha[i];
  return { ...mask, alpha };
}

/** True when the plot's ink is darker than its background. */
export function inkIsDark(frame: PlotFrame): boolean {
  return luma(frame.background) >= 128;
}
