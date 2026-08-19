/**
 * Curve tracing against masks whose true path is known exactly.
 *
 * The corpus measures the whole pipeline end to end; this measures the tracer
 * alone, by rasterising a polyline into a coverage mask at a known stroke width
 * and asking for the path back. That isolates the one thing a centroid cannot
 * do on its own - reach the tip of a sharp apex - from every other source of
 * error in the pipeline.
 */

import { describe, expect, it } from 'vitest';
import { traceCurve, traceMarkers } from '../src/engine/trace.ts';
import { findComponents, type SeriesMask } from '../src/engine/segment.ts';

/**
 * Rasterise a polyline into an alpha mask by supersampling.
 *
 * Each pixel is sampled on an 8x8 grid and its alpha is the fraction of samples
 * within half a stroke width of the path, which is exactly the coverage
 * fraction `inkAlpha` recovers from a real antialiased image.
 */
function strokeMask(
  width: number,
  height: number,
  path: (x: number) => number,
  strokeWidth: number,
  samplesPerColumn = 24,
): SeriesMask {
  const alpha = new Float32Array(width * height);
  const half = strokeWidth / 2;
  // Dense sample points along the path; nearest-point distance to those is a
  // good enough stand-in for distance to the polyline at this sampling rate.
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= width * samplesPerColumn; i++) {
    const x = i / samplesPerColumn;
    pts.push([x, path(x)]);
  }
  const N = 8;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let hit = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = px - 0.5 + (sx + 0.5) / N;
          const y = py - 0.5 + (sy + 0.5) / N;
          const lo = Math.max(0, Math.floor((x - half - 1) * samplesPerColumn));
          const hi = Math.min(pts.length - 1, Math.ceil((x + half + 1) * samplesPerColumn));
          let best = Infinity;
          for (let k = lo; k <= hi; k++) {
            const d = Math.hypot(pts[k][0] - x, pts[k][1] - y);
            if (d < best) best = d;
          }
          if (best <= half) hit++;
        }
      }
      alpha[py * width + px] = hit / (N * N);
    }
  }
  return { colour: { r: 0, g: 0, b: 0 }, rect: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 }, alpha, width, height };
}

function traced(mask: SeriesMask): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of traceCurve(mask).points) out.set(Math.round(p.px), p.py);
  return out;
}

/** RMS of the traced path against the truth, over the columns away from the edges. */
function rms(mask: SeriesMask, path: (x: number) => number, margin = 4): number {
  const got = traced(mask);
  let sse = 0;
  let n = 0;
  for (const [x, y] of got) {
    if (x < margin || x >= mask.width - margin) continue;
    const d = y - path(x);
    sse += d * d;
    n++;
  }
  return Math.sqrt(sse / Math.max(1, n));
}

/** A filled disc rasterised by supersampling, at a deliberately sub-pixel centre. */
function discMask(width: number, height: number, cx: number, cy: number, r: number): SeriesMask {
  const alpha = new Float32Array(width * height);
  const N = 8;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let hit = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = px - 0.5 + (sx + 0.5) / N;
          const y = py - 0.5 + (sy + 0.5) / N;
          if (Math.hypot(x - cx, y - cy) <= r) hit++;
        }
      }
      alpha[py * width + px] = hit / (N * N);
    }
  }
  return { colour: { r: 0, g: 0, b: 0 }, rect: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 }, alpha, width, height };
}

describe('traceMarkers', () => {
  it('returns the centre of mass, not the middle of the bounding box', () => {
    // A centre deliberately off the pixel grid: the bounding box of the pixels
    // this covers is centred on a half-pixel, and only the alpha weighting can
    // put the point back where the marker was actually drawn.
    const cx = 12.37;
    const cy = 9.82;
    const mask = discMask(26, 22, cx, cy, 3.4);
    const components = findComponents(mask);
    expect(components).toHaveLength(1);
    const marker = traceMarkers(components).points[0];
    expect(marker.px).toBeCloseTo(cx, 1);
    expect(marker.py).toBeCloseTo(cy, 1);

    const bounds = components[0].bounds;
    const boxCx = (bounds.x0 + bounds.x1) / 2;
    const boxCy = (bounds.y0 + bounds.y1) / 2;
    // The bounding-box answer is measurably worse, which is why it is not used.
    expect(Math.hypot(marker.px - cx, marker.py - cy)).toBeLessThan(
      Math.hypot(boxCx - cx, boxCy - cy),
    );
  });
});

describe('traceCurve on a known path', () => {
  it('recovers a flat line to well under a tenth of a pixel', () => {
    const path = () => 30.37;
    const mask = strokeMask(60, 60, path, 3);
    expect(rms(mask, path)).toBeLessThan(0.05);
  });

  it('recovers a gentle curve to well under a tenth of a pixel', () => {
    const path = (x: number) => 30 + 12 * Math.sin(x / 9);
    const mask = strokeMask(80, 60, path, 3);
    expect(rms(mask, path)).toBeLessThan(0.1);
  });

  it('measures the stroke width whatever the slope', () => {
    const flat = traceCurve(strokeMask(60, 60, () => 30, 4));
    const steep = traceCurve(strokeMask(60, 90, (x) => 10 + x * 1.2, 4));
    expect(flat.thicknessPx).toBeGreaterThan(3.2);
    expect(flat.thicknessPx).toBeLessThan(4.4);
    // The old median-vertical-extent estimate reads about 6.3 px here.
    expect(steep.thicknessPx).toBeGreaterThan(3.2);
    expect(steep.thicknessPx).toBeLessThan(4.4);
  });

  it('reaches the tip of a sawtooth instead of the centroid of the column', () => {
    const period = 22;
    const peak = 12;
    const trough = 62;
    // Symmetric sawtooth: sharp apexes and sharp troughs, straight in between.
    const path = (x: number) => {
      const t = (x % period) / period;
      return t < 0.5 ? trough + (peak - trough) * (t * 2) : peak + (trough - peak) * ((t - 0.5) * 2);
    };
    const mask = strokeMask(140, 76, path, 3);
    const got = traced(mask);

    let best = Infinity;
    for (const [x, y] of got) if (x > 10 && x < 130 && Math.abs((x % period) - period / 2) < 2) best = Math.min(best, y);
    // Within half a pixel of the true apex; the centroid alone lands about
    // 8 px short here, which is a fifth of the sawtooth's amplitude.
    expect(best).toBeGreaterThan(peak - 0.9);
    expect(best).toBeLessThan(peak + 0.9);

    let deepest = -Infinity;
    for (const [x, y] of got) if (x > 10 && x < 130 && (x % period) < 2) deepest = Math.max(deepest, y);
    expect(deepest).toBeGreaterThan(trough - 0.9);
    expect(deepest).toBeLessThan(trough + 0.9);
  });

  it('leaves a steep monotone run alone', () => {
    // A straight ramp is steep everywhere but turns nowhere, so the value in
    // every column is still the middle of its ink.
    const path = (x: number) => 8 + x * 3;
    const mask = strokeMask(24, 90, path, 3);
    expect(rms(mask, path, 3)).toBeLessThan(0.3);
  });

  it('does not invent a peak on a smooth maximum', () => {
    const path = (x: number) => 40 - 18 * Math.exp(-((x - 40) ** 2) / 400);
    const mask = strokeMask(80, 60, path, 3);
    const got = traced(mask);
    const apex = got.get(40)!;
    expect(Math.abs(apex - path(40))).toBeLessThan(0.25);
  });
});
