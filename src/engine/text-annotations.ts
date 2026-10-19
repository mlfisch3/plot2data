/**
 * OCR of the chart's own prose: title, axis titles, and the units carried in
 * brackets or parens. These are cosmetic and never touch a number: a bad OCR
 * read costs a title and the extraction stays correct.
 *
 * Each text block is a strip outside the plot frame: a title above, an x-axis
 * title below the tick-label band, a y-axis title to the left of it. The
 * y-axis title is usually rotated, so the engine rotates the crop before
 * recognition.
 */

import { colourDistance, createImage, cropImage, getPixel, scaleImage } from './image.ts';
import { normaliseForOcr, type OcrProvider } from './labels.ts';
import type { ImageBuffer, PlotFrame, Rect } from './types.ts';

export interface TextAnnotations {
  /** Title drawn above the plot. */
  title?: string;
  /** X-axis title (below the x-tick labels). */
  xTitle?: string;
  /** Y-axis title (to the left of the y-tick labels), rotated upright. */
  yTitle?: string;
  /** Unit parsed from the axis title's brackets or parens. */
  xUnit?: string;
  yUnit?: string;
}

/** The character set a chart title or axis title actually uses. */
const TITLE_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ()[]/-,.'%&+:x×$£€";

/**
 * Scan a strip for a horizontal text line and return the tightest bounding box.
 * Returns null when the strip holds no plausible text (too little ink, too
 * fragmented, or a long solid line that is a frame instead of a title).
 */
function textStripBounds(
  img: ImageBuffer,
  strip: Rect,
  background: { r: number; g: number; b: number },
): Rect | null {
  if (strip.x1 <= strip.x0 || strip.y1 <= strip.y0) return null;
  // Per-column ink extent.
  const perCol = new Int32Array(strip.x1 - strip.x0 + 1);
  let totalInk = 0;
  let topMin = strip.y1;
  let bottomMax = strip.y0;
  for (let x = strip.x0; x <= strip.x1; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = strip.y0; y <= strip.y1; y++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (colourDistance(getPixel(img, x, y), background) < 40) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top >= 0) {
      perCol[x - strip.x0] = bottom - top + 1;
      topMin = Math.min(topMin, top);
      bottomMax = Math.max(bottomMax, bottom);
      totalInk++;
    }
  }
  if (totalInk < 10) return null;
  // Find the x-range containing the densest ink: skip leading/trailing empties.
  let x0 = strip.x0;
  while (x0 <= strip.x1 && perCol[x0 - strip.x0] === 0) x0++;
  let x1 = strip.x1;
  while (x1 >= strip.x0 && perCol[x1 - strip.x0] === 0) x1--;
  if (x1 - x0 < 20) return null;
  // Avoid a long solid rule: a horizontal line fills the row across the strip
  // with ~1 px of extent. A text line has mixed extents.
  const extents = Array.from(perCol).filter((v) => v > 0);
  if (extents.length < 10) return null;
  const avgExtent = extents.reduce((a, b) => a + b, 0) / extents.length;
  if (avgExtent < 3) return null;
  const height = bottomMax - topMin + 1;
  if (height < 6 || height > (strip.y1 - strip.y0) * 0.95) return null;
  return { x0, y0: topMin, x1, y1: bottomMax };
}

async function recogniseStrip(
  img: ImageBuffer,
  rect: Rect,
  background: { r: number; g: number; b: number },
  ocr: OcrProvider,
): Promise<string | null> {
  try {
    const crop = normaliseForOcr(cropImage(img, rect), background);
    const h = rect.y1 - rect.y0 + 1;
    const scale = Math.max(1, Math.min(4, Math.round(46 / Math.max(1, h))));
    const result = await ocr.recognise(scaleImage(crop, scale), { charset: TITLE_CHARSET });
    const text = result.text.replace(/\s+/g, ' ').trim();
    return looksLikeTitle(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * A plausible title: enough letters to be prose, not a scatter of symbols.
 *
 * A rotated y-axis strip that happens to overlap a tick-label column comes back
 * as a string of digits and symbols; a successful read of a real title is a
 * few words, mostly letters.
 */
function looksLikeTitle(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;
  const solid = trimmed.replace(/\s/g, '');
  if (letters / solid.length < 0.5) return false;
  // At least one word of four or more letters: a chart title that collapses
  // into a scatter of 2-3 character tokens (`ee SY oem YY`) is OCR noise, not
  // a real heading. "Year" and "Age" are the only likely short-word axis
  // titles and the first clears the floor on its own.
  const words = trimmed.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (!words.some((w) => (w.match(/[A-Za-z]/g) ?? []).length >= 4)) return false;
  return true;
}

/** Rotate an image buffer 90° counter-clockwise so a vertical title reads horizontally. */
function rotateCcw(img: ImageBuffer): ImageBuffer {
  const out = createImage(img.height, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const srcIndex = (y * img.width + x) * 4;
      // (x, y) in src → (y, width - 1 - x) in dst
      const dstX = y;
      const dstY = img.width - 1 - x;
      const dstIndex = (dstY * out.width + dstX) * 4;
      out.data[dstIndex] = img.data[srcIndex];
      out.data[dstIndex + 1] = img.data[srcIndex + 1];
      out.data[dstIndex + 2] = img.data[srcIndex + 2];
      out.data[dstIndex + 3] = img.data[srcIndex + 3];
    }
  }
  return out;
}

/** Parse `Hits Average Per Visit` or `[Billions of USD]` into {title, unit}. */
function splitUnit(text: string): { title?: string; unit?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const match = trimmed.match(/^(.*?)\s*[([{<]\s*([^)\]}>]+?)\s*[)\]}>]\s*$/);
  if (match) {
    const title = match[1].trim();
    return title ? { title, unit: match[2].trim() } : { unit: match[2].trim() };
  }
  return { title: trimmed };
}

/** Read every text block around the plot frame. Cosmetic; never changes numbers. */
export async function readTextAnnotations(
  img: ImageBuffer,
  frame: PlotFrame,
  xLabelBand: { near: number; far: number } | null,
  yLabelBand: { near: number; far: number } | null,
  ocr: OcrProvider | null,
): Promise<TextAnnotations> {
  if (!ocr) return {};
  const out: TextAnnotations = {};
  const bg = frame.background;
  const r = frame.rect;

  // Title: a strip above the plot. Leave room for an annotation like `1e6`.
  const titleStrip: Rect = {
    x0: Math.max(0, r.x0 - 10),
    y0: 0,
    x1: Math.min(img.width - 1, r.x1 + 10),
    y1: Math.max(0, r.y0 - 10),
  };
  const titleBox = textStripBounds(img, titleStrip, bg);
  if (titleBox) {
    const padded = padRect(titleBox, 4, img);
    const text = await recogniseStrip(img, padded, bg, ocr);
    if (text) out.title = text;
  }

  // X-axis title: below the tick-label row.
  const xTitleYLo = (xLabelBand ? xLabelBand.far : r.y1 + 20) + 6;
  if (xTitleYLo < img.height - 10) {
    const xStrip: Rect = {
      x0: Math.max(0, r.x0 - 10),
      y0: xTitleYLo,
      x1: Math.min(img.width - 1, r.x1 + 10),
      y1: Math.min(img.height - 1, xTitleYLo + 40),
    };
    const box = textStripBounds(img, xStrip, bg);
    if (box) {
      const padded = padRect(box, 4, img);
      const text = await recogniseStrip(img, padded, bg, ocr);
      if (text) {
        const { title, unit } = splitUnit(text);
        if (title) out.xTitle = title;
        if (unit) out.xUnit = unit;
      }
    }
  }

  // Y-axis title: strip to the left of the y-tick labels, rotated upright.
  // The strip has to be wide enough to actually hold text (20+ px). Narrower
  // than that is noise - typically a dotted gridline edge or the tick marks
  // themselves - and the rotated OCR has nothing honest to find in it.
  const yTitleXHi = (yLabelBand ? yLabelBand.far : r.x0 - 20) - 4;
  const yTitleXLo = Math.max(0, yTitleXHi - 80);
  if (yTitleXHi - yTitleXLo >= 10) {
    const yStrip: Rect = {
      x0: yTitleXLo,
      y0: Math.max(0, r.y0 - 10),
      x1: yTitleXHi,
      y1: Math.min(img.height - 1, r.y1 + 10),
    };
    // Crop then rotate 90° CCW so the vertical title reads left to right.
    try {
      const rawCrop = cropImage(img, yStrip);
      const rotated = rotateCcw(rawCrop);
      // Does the rotated crop hold any text at all?
      const rotRect: Rect = { x0: 0, y0: 0, x1: rotated.width - 1, y1: rotated.height - 1 };
      const box = textStripBounds(rotated, rotRect, bg);
      if (box) {
        const padded = padRect(box, 4, rotated);
        const text = await recogniseStrip(rotated, padded, bg, ocr);
        if (text) {
          const { title, unit } = splitUnit(text);
          if (title) out.yTitle = title;
          if (unit) out.yUnit = unit;
        }
      }
    } catch {
      // A failed OCR is a missing title, nothing more.
    }
  }
  return out;
}

function padRect(r: Rect, by: number, img: ImageBuffer): Rect {
  return {
    x0: Math.max(0, r.x0 - by),
    y0: Math.max(0, r.y0 - by),
    x1: Math.min(img.width - 1, r.x1 + by),
    y1: Math.min(img.height - 1, r.y1 + by),
  };
}
