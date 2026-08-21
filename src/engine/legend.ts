/**
 * Series names read off the chart's own legend.
 *
 * A legend that is colour-coded says what each series is, and a chart that
 * bothers to colour-code its legend is exactly the chart worth reading. Matched
 * by colour rather than by position, which is what makes it tractable: the
 * label for the orange series is the text drawn in orange, wherever on the page
 * it happens to sit.
 *
 * Naming is cosmetic and stays that way. Nothing here touches a coordinate, a
 * calibration or an exported number; a bad read costs a name and the generic
 * one is used instead. Every name remains editable in the UI.
 */

import { blendDistance, colourDistance, cropImage, getPixel, inkAlpha, scaleImage } from './image.ts';
import { findComponents, type SeriesMask } from './segment.ts';
import { normaliseForOcr, type OcrProvider } from './labels.ts';
import type { ImageBuffer, PlotFrame, Rect, RGB } from './types.ts';

/** Letters, digits and the punctuation chart legends actually use. */
export const LABEL_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ()[]/-,.'%&+:x×^";

export interface LegendLabel {
  /** Index into the colours array this label was matched to. */
  index: number;
  text: string;
  rect: Rect;
  confidence: number;
  /** True when the text was found outside the plot frame. */
  outside: boolean;
}

export interface LegendOptions {
  /** Skip any ink that is already accounted for as data. */
  dataMasks?: Array<SeriesMask | null>;
  /** Minimum OCR confidence to adopt a name. */
  minConfidence?: number;
}

/**
 * A glyph is small, roughly as tall as it is wide, and never a long bar. The
 * limits are relative to the plot, because "small" on a 4000 px screenshot is
 * not "small" on a 480 px one.
 */
interface Glyph {
  rect: Rect;
  area: number;
}

interface Line {
  rect: Rect;
  glyphs: Glyph[];
}

/** Read whatever legend text is drawn in each of `colours`. */
export async function readLegendLabels(
  img: ImageBuffer,
  frame: PlotFrame,
  colours: RGB[],
  ocr: OcrProvider | null,
  options: LegendOptions = {},
): Promise<LegendLabel[]> {
  if (!ocr || colours.length === 0) return [];
  const perColour = colours.map((_, i) =>
    candidateBlocks(img, frame, colours, i, options.dataMasks?.[i] ?? null),
  );
  const chosen = chooseBlocks(perColour, frame, img.width);

  const out: LegendLabel[] = [];
  for (let i = 0; i < colours.length; i++) {
    const block = chosen[i];
    if (!block) continue;
    const read = await recogniseBlock(img, frame, block.lines, ocr);
    if (!read) continue;
    if (read.confidence < (options.minConfidence ?? 0.45)) continue;
    out.push({
      index: i,
      text: read.text,
      rect: block.rect,
      confidence: read.confidence,
      outside: !overlaps(block.rect, frame.rect),
    });
  }
  return out;
}

interface Candidate {
  lines: Line[];
  rect: Rect;
  glyphs: number;
}

/** Every block of text drawn in one colour that could be a label. */
function candidateBlocks(
  img: ImageBuffer,
  frame: PlotFrame,
  colours: RGB[],
  index: number,
  dataMask: SeriesMask | null,
): Candidate[] {
  const glyphs = findGlyphs(img, frame, colours, index, dataMask);
  if (glyphs.length < 3) return [];
  return groupIntoBlocks(groupIntoLines(glyphs))
    .map((lines) => ({
      lines,
      rect: blockRect(lines),
      glyphs: lines.reduce((n, l) => n + l.glyphs.length, 0),
    }))
    .filter((c) => c.glyphs >= 3)
    .sort((a, b) => b.glyphs - a.glyphs)
    .slice(0, 8);
}

/**
 * Which block is each colour's label.
 *
 * A legend is a column or a row: its entries share a left edge or a top edge,
 * whatever else is written on the page. That alignment is what tells a legend
 * entry from the chart title, which on the microprocessor chart is also drawn
 * in a series colour - black - and is the longest run of black text in the
 * image by some margin.
 *
 * Where an aligned legend is found, only the colours that appear in it are
 * named: a colour whose entry is missing from the legend has no confident
 * match, and a wrong name is worse than a generic one. Where none is found -
 * one series, or words printed inside the plot in the series' own colour, which
 * real charts do - each colour falls back to its own longest run of text.
 */
function chooseBlocks(
  perColour: Candidate[][],
  frame: PlotFrame,
  imageWidth: number,
): Array<Candidate | null> {
  const tolerance = Math.max(6, imageWidth * 0.012);
  let best: { members: Map<number, Candidate>; glyphs: number } | null = null;

  for (const edge of ['x0', 'y0'] as const) {
    const all: Array<{ colour: number; candidate: Candidate }> = [];
    perColour.forEach((list, colour) => list.forEach((candidate) => all.push({ colour, candidate })));
    for (const seed of all) {
      const members = new Map<number, Candidate>();
      let glyphs = 0;
      for (const other of all) {
        if (Math.abs(other.candidate.rect[edge] - seed.candidate.rect[edge]) > tolerance) continue;
        const held = members.get(other.colour);
        if (held && held.glyphs >= other.candidate.glyphs) continue;
        if (held) glyphs -= held.glyphs;
        members.set(other.colour, other.candidate);
        glyphs += other.candidate.glyphs;
      }
      if (members.size < 2) continue;
      const better =
        !best || members.size > best.members.size || (members.size === best.members.size && glyphs > best.glyphs);
      if (better) best = { members, glyphs };
    }
  }

  return perColour.map((list, colour) => {
    if (best) return best.members.get(colour) ?? null;
    // No legend to align to: prefer text outside the plot frame, then length.
    const ranked = [...list].sort(
      (a, b) =>
        Number(!overlaps(b.rect, frame.rect)) - Number(!overlaps(a.rect, frame.rect)) ||
        b.glyphs - a.glyphs,
    );
    return ranked[0] ?? null;
  });
}

/** True when a name read off the chart is worth showing instead of `series_n`. */
export function looksLikeALabel(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;
  // A legend label is words. A row of markers read as text is not, and comes
  // back as a scatter of punctuation and stray digits.
  const solid = trimmed.replace(/\s/g, '');
  return letters / solid.length >= 0.5;
}

/**
 * Glyph-shaped components drawn in one colour, anywhere in the image.
 *
 * Ink already accounted for as data is removed first: `selectDataComponents`
 * has already decided which components of this colour are the series, so a
 * marker cannot be mistaken for a letter here.
 */
function findGlyphs(
  img: ImageBuffer,
  frame: PlotFrame,
  colours: RGB[],
  index: number,
  dataMask: SeriesMask | null,
): Glyph[] {
  const colour = colours[index];
  const bg = frame.background;
  const rivals = colours.filter((_, i) => i !== index);
  const width = img.width;
  const height = img.height;
  const alpha = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = getPixel(img, x, y);
      if (colourDistance(px, bg) < 30) continue;
      const own = blendDistance(px, colour, bg);
      if (rivals.some((r) => blendDistance(px, r, bg) < own)) continue;
      const a = inkAlpha(px, colour, bg);
      if (a > 0.35) alpha[y * width + x] = a;
    }
  }
  if (dataMask) {
    const r = dataMask.rect;
    for (let y = 0; y < dataMask.height; y++) {
      for (let x = 0; x < dataMask.width; x++) {
        if (dataMask.alpha[y * dataMask.width + x] <= 0) continue;
        const iy = r.y0 + y;
        const ix = r.x0 + x;
        if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
        alpha[iy * width + ix] = 0;
      }
    }
  }

  const mask: SeriesMask = {
    colour,
    rect: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 },
    alpha,
    width,
    height,
  };
  const plotH = frame.rect.y1 - frame.rect.y0 + 1;
  const maxGlyph = Math.max(12, plotH * 0.12);
  const minGlyph = Math.max(4, Math.round(plotH / 160));
  const out: Glyph[] = [];
  for (const c of findComponents(mask, 0.4)) {
    const w = c.bounds.x1 - c.bounds.x0 + 1;
    const h = c.bounds.y1 - c.bounds.y0 + 1;
    if (h < minGlyph || h > maxGlyph) continue;
    // A glyph is never a long bar: that is a legend swatch or a dash.
    if (w > h * 3.5) continue;
    if (c.area < 3) continue;
    out.push({ rect: c.bounds, area: c.area });
  }
  return out;
}

/** Glyphs sharing a baseline and close enough together to be one line of text. */
function groupIntoLines(glyphs: Glyph[]): Line[] {
  const sorted = [...glyphs].sort((a, b) => a.rect.x0 - b.rect.x0);
  const used = new Array(sorted.length).fill(false);
  const lines: Line[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const members = [sorted[i]];
    let rect = { ...sorted[i].rect };
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const g = sorted[j];
      const h = Math.min(rect.y1 - rect.y0 + 1, g.rect.y1 - g.rect.y0 + 1);
      const overlap = Math.min(rect.y1, g.rect.y1) - Math.max(rect.y0, g.rect.y0) + 1;
      if (overlap < h * 0.5) continue;
      // A word gap is about one glyph height; anything wider is a separate run.
      if (g.rect.x0 - rect.x1 > (rect.y1 - rect.y0 + 1) * 1.2) continue;
      used[j] = true;
      members.push(g);
      rect = union(rect, g.rect);
    }
    if (members.length >= 2) lines.push({ rect, glyphs: members });
  }
  return lines;
}

/**
 * Lines stacked directly above one another: one label wrapped over two rows.
 *
 * Every open block is a candidate to continue, not just the one started most
 * recently. A page holds several columns of text at once, and the line that
 * continues the legend entry is rarely the next one down the page.
 */
function groupIntoBlocks(lines: Line[]): Line[][] {
  const sorted = [...lines].sort((a, b) => a.rect.y0 - b.rect.y0);
  const blocks: Line[][] = [];
  for (const line of sorted) {
    const h = line.rect.y1 - line.rect.y0 + 1;
    const joined = blocks.find((block) => {
      const last = block[block.length - 1];
      return (
        line.rect.y0 - last.rect.y1 <= h * 1.1 &&
        Math.min(last.rect.x1, line.rect.x1) - Math.max(last.rect.x0, line.rect.x0) > 0
      );
    });
    if (joined) joined.push(line);
    else blocks.push([line]);
  }
  return blocks;
}

function blockRect(block: Line[]): Rect {
  return block.map((l) => l.rect).reduce(union);
}

function union(a: Rect, b: Rect): Rect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

/**
 * Recognise a block one line at a time.
 *
 * The recognisers this tool ships are configured for a single line of text,
 * which is right for a tick label and wrong for a legend entry wrapped over two
 * rows. Reading the rows separately and joining them gets both.
 */
async function recogniseBlock(
  img: ImageBuffer,
  frame: PlotFrame,
  block: Line[],
  ocr: OcrProvider,
): Promise<{ text: string; confidence: number } | null> {
  const parts: string[] = [];
  let worst = 1;
  for (const line of block.slice(0, 3)) {
    const rect = pad(line.rect, 4, img);
    const h = rect.y1 - rect.y0 + 1;
    const scale = Math.max(1, Math.min(4, Math.round(46 / Math.max(1, h))));
    let result;
    try {
      const crop = normaliseForOcr(cropImage(img, rect), frame.background);
      result = await ocr.recognise(scaleImage(crop, scale), { charset: LABEL_CHARSET });
    } catch {
      return null;
    }
    const text = result.text.trim();
    if (!text) continue;
    parts.push(text);
    worst = Math.min(worst, result.confidence ?? 1);
  }
  const text = tidy(parts.join(' '));
  if (!looksLikeALabel(text)) return null;
  return { text, confidence: worst };
}

/** Collapse the whitespace and the punctuation OCR habitually doubles up. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([),.])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .trim();
}

function pad(rect: Rect, by: number, img: ImageBuffer): Rect {
  return {
    x0: Math.max(0, rect.x0 - by),
    y0: Math.max(0, rect.y0 - by),
    x1: Math.min(img.width - 1, rect.x1 + by),
    y1: Math.min(img.height - 1, rect.y1 + by),
  };
}

/** Exposed for diagnostics: the components this module treats as glyphs. */
export function debugGlyphs(
  img: ImageBuffer,
  frame: PlotFrame,
  colours: RGB[],
  index: number,
  dataMask: SeriesMask | null = null,
): { glyphs: Glyph[]; lines: Line[]; blocks: Line[][] } {
  const glyphs = findGlyphs(img, frame, colours, index, dataMask);
  const lines = groupIntoLines(glyphs);
  return { glyphs, lines, blocks: groupIntoBlocks(lines) };
}
