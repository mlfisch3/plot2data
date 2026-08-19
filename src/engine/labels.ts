/**
 * Tick-label reading.
 *
 * OCR is a convenience that pre-fills the anchors, never the source of truth:
 * every value it produces lands in an editable field, and the tool works fully
 * without it. The engine stays DOM-free by taking the recogniser as an
 * interface - the browser supplies a tesseract.js-backed implementation.
 */

import { colourDistance, createImage, cropImage, getPixel, scaleImage } from './image.ts';
import { findLabelBlobs, medianGap, resolveTickOptions, type TickScan } from './ticks.ts';
import { parseLabel, parseOffsetAnnotation } from './parse-number.ts';
import type {
  AxisSide,
  ImageBuffer,
  LabelledTick,
  OffsetAnnotation,
  PlotFrame,
  Rect,
} from './types.ts';

export interface OcrResult {
  text: string;
  /** 0..1 if the provider reports one. */
  confidence?: number;
}

export interface OcrProvider {
  /** Recognise the text in an RGBA buffer. Must not require the DOM. */
  recognise(image: ImageBuffer, hint?: { charset?: string }): Promise<OcrResult>;
}

/** Characters that can appear in a numeric axis label. */
export const NUMERIC_CHARSET = '0123456789.,-+%$€£kKMBbnTteE^x×';

/** Ink pixel count inside a rectangle, used to skip empty label slots cheaply. */
function inkCount(img: ImageBuffer, rect: Rect, bg: { r: number; g: number; b: number }): number {
  let n = 0;
  for (let y = Math.max(0, rect.y0); y <= Math.min(img.height - 1, rect.y1); y++) {
    for (let x = Math.max(0, rect.x0); x <= Math.min(img.width - 1, rect.x1); x++) {
      if (colourDistance(getPixel(img, x, y), bg) >= 40) n++;
    }
  }
  return n;
}

/**
 * Upscale factor that puts small chart labels in the recogniser's comfort zone.
 * Around 50 px of text height reads best; below ~30 px digits start to drop.
 */
function ocrScale(rect: Rect): number {
  const h = rect.y1 - rect.y0 + 1;
  if (h <= 0) return 4;
  return Math.max(2, Math.min(6, Math.round(50 / h)));
}

/** Per-column vertical ink extent inside a rectangle. */
function inkExtents(
  img: ImageBuffer,
  rect: Rect,
  bg: { r: number; g: number; b: number },
): Array<{ top: number; bottom: number } | null> {
  const out: Array<{ top: number; bottom: number } | null> = [];
  for (let x = rect.x0; x <= rect.x1; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = rect.y0; y <= rect.y1; y++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (colourDistance(getPixel(img, x, y), bg) < 40) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    out.push(top < 0 ? null : { top, bottom });
  }
  return out;
}

/**
 * Split a label written with a superscript exponent, such as the `10^7` decade
 * labels on a log axis.
 *
 * OCR flattens `10` with a raised `7` into `107`, which is a silently wrong
 * answer of exactly the kind this tool exists to avoid. The superscript is
 * obvious geometrically: its glyphs sit entirely in the upper part of the text
 * box while the base glyphs reach the baseline.
 */
export function splitSuperscript(
  img: ImageBuffer,
  rect: Rect,
  bg: { r: number; g: number; b: number },
): { base: Rect; exponent: Rect } | null {
  const cols = inkExtents(img, rect, bg);
  const inked = cols.filter((c): c is { top: number; bottom: number } => c !== null);
  if (inked.length < 4) return null;
  const top = Math.min(...inked.map((c) => c.top));
  const bottom = Math.max(...inked.map((c) => c.bottom));
  const height = bottom - top + 1;
  if (height < 6) return null;

  // Glyph groups along the label.
  const glyphs: Array<{ x0: number; x1: number; top: number; bottom: number }> = [];
  let i = 0;
  while (i < cols.length) {
    if (!cols[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < cols.length && cols[j + 1]) j++;
    let gTop = Infinity;
    let gBottom = -Infinity;
    for (let k = i; k <= j; k++) {
      gTop = Math.min(gTop, cols[k]!.top);
      gBottom = Math.max(gBottom, cols[k]!.bottom);
    }
    glyphs.push({ x0: rect.x0 + i, x1: rect.x0 + j, top: gTop, bottom: gBottom });
    i = j + 1;
  }
  if (glyphs.length < 2) return null;

  // Trailing glyphs confined to the top of the box are the exponent.
  const raisedCut = top + height * 0.62;
  let split = glyphs.length;
  while (split > 0 && glyphs[split - 1].bottom <= raisedCut) split--;
  if (split === glyphs.length || split === 0) return null;

  const baseGlyphs = glyphs.slice(0, split);
  const expGlyphs = glyphs.slice(split);
  // The base must actually reach the baseline, otherwise this is just a short
  // glyph at the end of an ordinary label.
  const baseBottom = Math.max(...baseGlyphs.map((g) => g.bottom));
  if (baseBottom < top + height * 0.8) return null;

  // The exponent must be a digit, not a stray mark: a gridline dot or a comma
  // caught at the edge of the crop also sits above the baseline, and treating
  // one as an exponent turns `40` into an unreadable `4^0`.
  const expTop = Math.min(...expGlyphs.map((g) => g.top));
  const expBottom = Math.max(...expGlyphs.map((g) => g.bottom));
  const expWidth = expGlyphs[expGlyphs.length - 1].x1 - expGlyphs[0].x0 + 1;
  const baseWidth = baseGlyphs[baseGlyphs.length - 1].x1 - baseGlyphs[0].x0 + 1;
  if (expBottom - expTop + 1 < height * 0.3) return null;
  if (expWidth < baseWidth * 0.2 || expWidth < 2) return null;

  return {
    base: { x0: baseGlyphs[0].x0, x1: baseGlyphs[baseGlyphs.length - 1].x1, y0: rect.y0, y1: rect.y1 },
    exponent: {
      x0: expGlyphs[0].x0,
      x1: expGlyphs[expGlyphs.length - 1].x1,
      y0: Math.min(...expGlyphs.map((g) => g.top)) - 1,
      y1: Math.max(...expGlyphs.map((g) => g.bottom)) + 1,
    },
  };
}

/**
 * Normalise a label crop to black text on white.
 *
 * Recognisers are tuned for dark text on light paper. Chart labels arrive light
 * on dark, or blurred by JPEG, or tinted; mapping ink strength to darkness
 * gives the recogniser what it expects and keeps the antialiasing ramp, which
 * it reads better than a hard threshold.
 */
export function normaliseForOcr(img: ImageBuffer, bg: { r: number; g: number; b: number }): ImageBuffer {
  let strongest = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = colourDistance(getPixel(img, x, y), bg);
      if (d > strongest) strongest = d;
    }
  }
  const scale = Math.max(30, strongest * 0.75);
  // A quiet white margin: recognisers segment a line of text much better when
  // it is not flush against the edge of the image.
  const margin = 6;
  const out = createImage(img.width + margin * 2, img.height + margin * 2);
  out.data.fill(255);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = colourDistance(getPixel(img, x, y), bg);
      const v = Math.round(255 * (1 - Math.min(1, d / scale)));
      const i = ((y + margin) * out.width + (x + margin)) * 4;
      out.data[i] = v;
      out.data[i + 1] = v;
      out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

async function recogniseRect(
  img: ImageBuffer,
  rect: Rect,
  ocr: OcrProvider,
  bg: { r: number; g: number; b: number },
): Promise<OcrResult | null> {
  try {
    const crop = normaliseForOcr(cropImage(img, rect), bg);
    return await ocr.recognise(scaleImage(crop, ocrScale(rect)), { charset: NUMERIC_CHARSET });
  } catch {
    return null;
  }
}

/**
 * Read the labels next to the detected ticks.
 *
 * Labels are located as text blobs first and only then matched to the nearest
 * tick. Cropping a fixed window around each tick instead would hand a minor
 * tick its neighbour's label - a wrong value that then poisons the calibration
 * fit - and would waste OCR calls on the many unlabelled minor ticks of a log
 * axis.
 */
export async function readTickLabels(
  img: ImageBuffer,
  frame: PlotFrame,
  scan: TickScan,
  ocr: OcrProvider | null,
  options: { maxLabels?: number } = {},
): Promise<LabelledTick[]> {
  const out: LabelledTick[] = scan.ticks.map((t) => ({ ...t }));
  if (!ocr || scan.ticks.length === 0 || !scan.labelBand) return out;

  const opts = resolveTickOptions(frame);
  const blobs =
    scan.source === 'labels' && scan.labelRects
      ? scan.ticks.map((t, i) => ({ px: t.px, rect: scan.labelRects![i] }))
      : findLabelBlobs(img, frame, scan.side, scan.labelBand, opts);

  const gap = medianGap(scan.ticks);
  const tolerance = Math.max(4, gap * 0.35);
  const max = options.maxLabels ?? 24;

  // Match blobs to ticks before doing any OCR, so we only pay for labels that
  // actually belong to a tick.
  const jobs: Array<{ index: number; rect: Rect }> = [];
  for (const blob of blobs) {
    let bestIndex = -1;
    let bestD = Infinity;
    for (let i = 0; i < scan.ticks.length; i++) {
      const d = Math.abs(scan.ticks[i].px - blob.px);
      if (d < bestD) {
        bestD = d;
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || bestD > tolerance) continue;
    if (jobs.some((j) => j.index === bestIndex)) continue;
    // Pad for breathing room, but never into the plot area: a gridline or the
    // end of a data line inside the crop is noise the recogniser has to guess
    // around.
    const padded = pad(blob.rect, 3, img);
    if (scan.side === 'left') padded.x1 = Math.min(padded.x1, frame.rect.x0 - 1);
    else padded.y0 = Math.max(padded.y0, frame.rect.y1 + 1);
    jobs.push({ index: bestIndex, rect: padded });
    if (jobs.length >= max) break;
  }

  for (const job of jobs) {
    const sup = splitSuperscript(img, job.rect, frame.background);
    let text: string;
    let confidence: number | undefined;
    if (sup) {
      const [base, exponent] = await Promise.all([
        recogniseRect(img, pad(sup.base, 2, img), ocr, frame.background),
        recogniseRect(img, pad(sup.exponent, 3, img), ocr, frame.background),
      ]);
      const b = base?.text.trim() ?? '';
      const e = exponent?.text.trim() ?? '';
      if (!b || !e) continue;
      text = `${b}^${e}`;
      confidence = Math.min(base?.confidence ?? 1, exponent?.confidence ?? 1);
    } else {
      const r = await recogniseRect(img, job.rect, ocr, frame.background);
      if (!r) continue;
      text = r.text.trim();
      confidence = r.confidence;
    }
    if (!text) continue;
    out[job.index].text = text;
    out[job.index].confidence = confidence;
    const parsed = parseLabel(text);
    if (parsed) out[job.index].value = parsed.value;
  }
  return out;
}

function pad(rect: Rect, by: number, img: ImageBuffer): Rect {
  return {
    x0: Math.max(0, rect.x0 - by),
    y0: Math.max(0, rect.y0 - by),
    x1: Math.min(img.width - 1, rect.x1 + by),
    y1: Math.min(img.height - 1, rect.y1 + by),
  };
}

/** The unit symbol carried by any of the read labels, applied to the whole axis. */
export function axisUnit(labelled: LabelledTick[]): string | undefined {
  for (const t of labelled) {
    if (!t.text) continue;
    const parsed = parseLabel(t.text);
    if (parsed?.unit) return parsed.unit;
  }
  return undefined;
}

/**
 * Corners of the axis region where matplotlib-style multiplier and offset
 * annotations are printed (`1e6`, `+3.14`). Missing one puts every exported
 * value off by orders of magnitude, so anything matching is surfaced to the
 * user for confirmation rather than applied silently.
 */
export function annotationRects(img: ImageBuffer, frame: PlotFrame): Array<{ side: AxisSide; rect: Rect }> {
  const r = frame.rect;
  const h = Math.max(18, Math.round((r.y1 - r.y0) * 0.06));
  const w = Math.max(60, Math.round((r.x1 - r.x0) * 0.18));
  const clamp = (rect: Rect): Rect => ({
    x0: Math.max(0, rect.x0),
    y0: Math.max(0, rect.y0),
    x1: Math.min(img.width - 1, rect.x1),
    y1: Math.min(img.height - 1, rect.y1),
  });
  return [
    // Above the top-left corner: the y-axis multiplier.
    { side: 'left', rect: clamp({ x0: r.x0 - w, y0: r.y0 - h - 6, x1: r.x0 + w, y1: r.y0 - 2 }) },
    // Below the bottom-right corner: the x-axis multiplier.
    { side: 'bottom', rect: clamp({ x0: r.x1 - w, y0: r.y1 + 4, x1: r.x1 + w, y1: r.y1 + h + 30 }) },
  ];
}

/** OCR the annotation corners and return anything that parses as a multiplier or offset. */
export async function readOffsetAnnotations(
  img: ImageBuffer,
  frame: PlotFrame,
  ocr: OcrProvider | null,
): Promise<OffsetAnnotation[]> {
  if (!ocr) return [];
  const out: OffsetAnnotation[] = [];
  for (const { side, rect } of annotationRects(img, frame)) {
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) continue;
    if (inkCount(img, rect, frame.background) < 8) continue;
    const result = await recogniseRect(img, rect, ocr, frame.background);
    if (!result) continue;
    const text = result.text.trim();
    if (!text) continue;
    const parsed = parseOffsetAnnotation(text);
    if (parsed) out.push({ side, text, multiplier: parsed.multiplier, offset: parsed.offset, rect });
  }
  return out;
}
