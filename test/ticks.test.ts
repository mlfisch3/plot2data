import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { detectFrame } from '../src/engine/frame.ts';
import { detectTicks } from '../src/engine/ticks.ts';
import { loadImage } from './helpers/load-image.ts';
import type { AxisSide } from '../src/engine/types.ts';

function scan(file: string, side: AxisSide) {
  const img = loadImage(resolve(import.meta.dirname, '..', file));
  return detectTicks(img, detectFrame(img), side);
}

function spacings(px: number[]): number[] {
  return px.slice(1).map((v, i) => v - px[i]);
}

describe('detectTicks', () => {
  it('finds evenly spaced ticks on both axes of a clean plot', () => {
    const x = scan('corpus/linear-single-solid.png', 'bottom');
    const y = scan('corpus/linear-single-solid.png', 'left');
    expect(x.ticks).toHaveLength(7);
    expect(y.ticks).toHaveLength(11);
    expect(x.source).toBe('ticks');
    for (const s of spacings(x.ticks.map((t) => t.px))) expect(s).toBeCloseTo(138.8, -0.5);
  });

  it('falls back to label blobs when the plot draws no tick marks', () => {
    const x = scan('corpus/linear-single-nogrid.png', 'bottom');
    expect(x.source).toBe('labels');
    expect(x.ticks).toHaveLength(7);
    expect(x.labelRects).toHaveLength(7);
    // Blob centres must land on the same grid the tick marks would have.
    for (const s of spacings(x.ticks.map((t) => t.px))) expect(s).toBeCloseTo(138.8, -0.5);
  });

  it('works identically on a 2x screenshot', () => {
    const x = scan('corpus/retina-2x.png', 'bottom');
    const y = scan('corpus/retina-2x.png', 'left');
    expect(x.ticks).toHaveLength(7);
    expect(y.ticks).toHaveLength(11);
  });

  it('keeps log-axis minor ticks including every decade', () => {
    const y = scan('corpus/log-y.png', 'left');
    const px = y.ticks.map((t) => t.px);
    // Decades of a 0.01..100 axis over the plot height.
    for (const decade of [18, 144, 271, 397, 524]) {
      expect(px.some((p) => Math.abs(p - decade) < 2)).toBe(true);
    }
  });

  it('reads inward ticks on a plot that draws them inside the frame', () => {
    const y = scan('examples/real/02-microprocessor-log-scatter.png', 'left');
    expect(y.direction).toBe('inward');
    expect(y.ticks).toHaveLength(8);
    for (const s of spacings(y.ticks.map((t) => t.px))) expect(s).toBeCloseTo(90.6, -0.5);
  });

  it('rejects a wiggly data line near the axis as inward ticks', () => {
    // Panel 2 is flat at zero along the axis; its wiggles are not ticks.
    const x = scan('examples/real/01-panel2.png', 'bottom');
    expect(x.source).toBe('labels');
    expect(x.ticks).toHaveLength(5);
  });

  it('finds year labels and abbreviated y labels on a cropped panel', () => {
    const x = scan('examples/real/01-panel1.png', 'bottom');
    const y = scan('examples/real/01-panel1.png', 'left');
    expect(x.ticks).toHaveLength(5);
    expect(y.ticks).toHaveLength(6);
  });

  it('separates the y labels from a plot with no y-axis line', () => {
    const y = scan('examples/real/03-women-men-percent.png', 'left');
    expect(y.ticks.map((t) => Math.round(t.px))).toEqual([19, 99, 181, 260]);
  });
});
