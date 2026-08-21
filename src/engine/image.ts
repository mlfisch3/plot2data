/** Pixel-level helpers over plain RGBA buffers. No DOM. */

import type { ImageBuffer, Rect, RGB } from './types.ts';

export function createImage(width: number, height: number): ImageBuffer & { data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function idx(img: ImageBuffer, x: number, y: number): number {
  return (y * img.width + x) * 4;
}

export function getPixel(img: ImageBuffer, x: number, y: number): RGB {
  const i = idx(img, x, y);
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] };
}

export function setPixel(img: ImageBuffer, x: number, y: number, c: RGB, a = 255): void {
  const i = idx(img, x, y);
  const d = img.data as Uint8ClampedArray;
  d[i] = c.r;
  d[i + 1] = c.g;
  d[i + 2] = c.b;
  d[i + 3] = a;
}

/** ITU-R BT.601 luma, 0..255. */
export function luma(c: RGB): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

/** Euclidean RGB distance. Cheap and good enough for flat-colour chart ink. */
export function colourDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Saturation in the HSV sense, 0..1. Used to tell chart ink from gray chrome. */
export function saturation(c: RGB): number {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  return max === 0 ? 0 : (max - min) / max;
}

export function isGray(c: RGB, threshold = 0.18): boolean {
  return saturation(c) < threshold;
}

export function clampRect(r: Rect, img: ImageBuffer): Rect {
  return {
    x0: Math.max(0, Math.min(img.width - 1, Math.round(r.x0))),
    y0: Math.max(0, Math.min(img.height - 1, Math.round(r.y0))),
    x1: Math.max(0, Math.min(img.width - 1, Math.round(r.x1))),
    y1: Math.max(0, Math.min(img.height - 1, Math.round(r.y1))),
  };
}

export function rectWidth(r: Rect): number {
  return r.x1 - r.x0 + 1;
}

export function rectHeight(r: Rect): number {
  return r.y1 - r.y0 + 1;
}

/** Copy a sub-rectangle into a new buffer. Used to hand crops to the OCR provider. */
export function cropImage(img: ImageBuffer, rect: Rect): ImageBuffer {
  const r = clampRect(rect, img);
  const w = rectWidth(r);
  const h = rectHeight(r);
  const out = createImage(Math.max(1, w), Math.max(1, h));
  for (let y = 0; y < h; y++) {
    const srcStart = idx(img, r.x0, r.y0 + y);
    out.data.set(img.data.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return out;
}

/**
 * Bilinear upscale by an integer factor.
 *
 * Recognisers read small chart labels far better when the upscale is smooth:
 * nearest-neighbour turns a 9 px digit into a staircase of hard blocks, and the
 * classifier sees the staircase rather than the glyph.
 */
export function scaleImage(img: ImageBuffer, factor: number): ImageBuffer {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return img;
  const out = createImage(img.width * f, img.height * f);
  const sample = (x: number, y: number, c: number): number => {
    const cx = Math.max(0, Math.min(img.width - 1, x));
    const cy = Math.max(0, Math.min(img.height - 1, y));
    return img.data[(cy * img.width + cx) * 4 + c];
  };
  for (let y = 0; y < out.height; y++) {
    // Sample at pixel centres so the output is not shifted by half a pixel.
    const sy = (y + 0.5) / f - 0.5;
    const y0 = Math.floor(sy);
    const ty = sy - y0;
    for (let x = 0; x < out.width; x++) {
      const sx = (x + 0.5) / f - 0.5;
      const x0 = Math.floor(sx);
      const tx = sx - x0;
      const di = (y * out.width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = sample(x0, y0, c) * (1 - tx) + sample(x0 + 1, y0, c) * tx;
        const bottom = sample(x0, y0 + 1, c) * (1 - tx) + sample(x0 + 1, y0 + 1, c) * tx;
        out.data[di + c] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  return out;
}

/**
 * Estimate the dominant (background) colour by quantising to a coarse grid and
 * taking the modal bucket, then averaging the exact pixels in that bucket.
 */
export function dominantColour(img: ImageBuffer, rect?: Rect): RGB {
  const r = rect ? clampRect(rect, img) : { x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 };
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const q = 16;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = idx(img, x, y);
      const key =
        ((img.data[i] / q) | 0) * 4096 + ((img.data[i + 1] / q) | 0) * 64 + ((img.data[i + 2] / q) | 0);
      let e = bins.get(key);
      if (!e) {
        e = { n: 0, r: 0, g: 0, b: 0 };
        bins.set(key, e);
      }
      e.n++;
      e.r += img.data[i];
      e.g += img.data[i + 1];
      e.b += img.data[i + 2];
    }
  }
  let best = { n: 0, r: 255, g: 255, b: 255 };
  for (const e of bins.values()) if (e.n > best.n) best = e;
  if (best.n === 0) return { r: 255, g: 255, b: 255 };
  return { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
}

/**
 * Where a pixel sits on the blend ray from a background to an ink colour.
 *
 * `t` is how far along that ray it lies - 0 is the background, 1 is the fully
 * saturated ink, above 1 is *more* saturated than the ink - and `off` is how
 * far it is from the ray, which is what separates a blend of this ink from a
 * different colour entirely.
 */
export interface BlendFit {
  t: number;
  off: number;
}

export function blendFit(pixel: RGB, ink: RGB, bg: RGB): BlendFit {
  const dr = ink.r - bg.r;
  const dg = ink.g - bg.g;
  const db = ink.b - bg.b;
  const denom = dr * dr + dg * dg + db * db;
  if (denom < 1e-6) return { t: 0, off: Infinity };
  const t = ((pixel.r - bg.r) * dr + (pixel.g - bg.g) * dg + (pixel.b - bg.b) * db) / denom;
  const rr = pixel.r - (bg.r + t * dr);
  const rg = pixel.g - (bg.g + t * dg);
  const rb = pixel.b - (bg.b + t * db);
  return { t, off: Math.sqrt(rr * rr + rg * rg + rb * rb) };
}

/**
 * Distance from a pixel to the blend *segment* between a background and an ink
 * colour - the set of colours that ink can actually produce on that paper.
 *
 * This is the right way to ask "could this pixel be this series?", and it is
 * not the same question as "which series' colour is it nearest". Desaturating
 * a dark red towards white runs through a band of mid-tones that are, in plain
 * RGB distance, closer to a saturated orange than to the red they came from -
 * so a nearest-colour test hands every red marker's antialiased halo to an
 * orange series drawn elsewhere on the chart. Measured against the segments,
 * the same pixels sit 0.9 from red's and 47 from orange's, which is not a close
 * call at all.
 *
 * Clamping to the segment rather than the infinite ray is what keeps a darker
 * shade out of a lighter series of the same hue: a colour beyond the ink is not
 * a blend of it, and pays the full distance to the ink itself.
 */
export function blendDistance(pixel: RGB, ink: RGB, bg: RGB): number {
  const fit = blendFit(pixel, ink, bg);
  if (!Number.isFinite(fit.off)) return Infinity;
  const t = Math.max(0, Math.min(1, fit.t));
  return Math.hypot(
    pixel.r - (bg.r + t * (ink.r - bg.r)),
    pixel.g - (bg.g + t * (ink.g - bg.g)),
    pixel.b - (bg.b + t * (ink.b - bg.b)),
  );
}

/**
 * Ink coverage of a pixel against a known background, 0..1.
 *
 * Antialiased chart pixels are a linear blend `p = alpha*ink + (1-alpha)*bg`.
 * Projecting `p - bg` onto `ink - bg` recovers alpha, which is what makes the
 * column centroid sub-pixel accurate instead of quantised to whole pixels.
 */
export function inkAlpha(pixel: RGB, ink: RGB, bg: RGB): number {
  const { t, off } = blendFit(pixel, ink, bg);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Reject pixels that lie far off the bg->ink line (a different colour entirely).
  return off > 60 ? 0 : t;
}

/** Generic "how far is this pixel from the background", 0..1. */
export function inkStrength(pixel: RGB, bg: RGB, fullScale = 140): number {
  return Math.min(1, colourDistance(pixel, bg) / fullScale);
}
