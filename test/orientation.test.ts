/**
 * Which end is which.
 *
 * The captain reported the two lower panels - the re-plot of the extracted
 * numbers and the overlay on the original - as mirrored left-to-right against
 * the source image. A mirror is invisible on a symmetric chart and it cancels
 * itself out of any comparison that only checks *values*, which is why it could
 * survive rounds of verification that matched desktop against phone to the last
 * digit. So it gets a test that is asymmetric on purpose and that asserts
 * direction rather than magnitude.
 *
 * The chart is drawn here rather than taken from the corpus so the answer is
 * known exactly and no corpus number moves with it: a flat line with one narrow
 * spike a fifth of the way in from the left, which is unmistakable under a
 * mirror, and a ramp, which is unmistakable under a flip of either axis.
 *
 * The three panels reach the screen by two routes and both are covered:
 *
 * - the chart panel plots `point.x` and `point.y` straight, so the exported
 *   numbers themselves decide which end is drawn where;
 * - the overlay panel puts every point back on the image with `valueToPixel`,
 *   the same function `src/ui/overlay.ts` calls, so a round trip that does not
 *   land back on the ink it came from is a mirror in the drawing.
 *
 * A build mirrored in either place fails here.
 */

import { describe, expect, it } from 'vitest';
import { analyse, buildSeries, pixelToValue, valueToPixel } from '../src/engine/index.ts';
import type { Calibration, ImageBuffer } from '../src/engine/types.ts';

const WIDTH = 480;
const HEIGHT = 320;
/** The frame, inclusive, in image pixels. */
const PLOT = { x0: 60, y0: 20, x1: 440, y1: 280 };
/** Where the spike's tip sits: a fifth of the way in from the left. */
const SPIKE_PX = PLOT.x0 + (PLOT.x1 - PLOT.x0) * 0.2;

/**
 * The calibration a user would type in with no OCR: x rising to the right, y
 * rising upwards, in round numbers that make a mirror obvious by eye.
 */
const CAL: Calibration = {
  x: {
    side: 'bottom',
    scale: 'linear',
    a: { px: PLOT.x0, value: 0, source: 'manual' },
    b: { px: PLOT.x1, value: 100, source: 'manual' },
    multiplier: 1,
    offset: 0,
    scaleSource: 'manual',
  },
  y: {
    side: 'left',
    scale: 'linear',
    a: { px: PLOT.y1, value: 0, source: 'manual' },
    b: { px: PLOT.y0, value: 50, source: 'manual' },
    multiplier: 1,
    offset: 0,
    scaleSource: 'manual',
  },
};

interface Point {
  x: number;
  y: number;
}

function blank(): { data: Uint8ClampedArray } & ImageBuffer {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  return { width: WIDTH, height: HEIGHT, data };
}

function paint(img: ImageBuffer, x: number, y: number, rgb: [number, number, number], alpha: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || alpha <= 0) return;
  const i = (y * img.width + x) * 4;
  const a = Math.min(1, alpha);
  for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] * (1 - a) + rgb[c] * a);
}

/** An antialiased polyline, so the tracer sees the sub-pixel edges a real chart has. */
function stroke(img: ImageBuffer, path: Point[], width: number, rgb: [number, number, number]): void {
  const half = width / 2;
  const minX = Math.max(0, Math.floor(Math.min(...path.map((p) => p.x)) - half - 2));
  const maxX = Math.min(img.width - 1, Math.ceil(Math.max(...path.map((p) => p.x)) + half + 2));
  const minY = Math.max(0, Math.floor(Math.min(...path.map((p) => p.y)) - half - 2));
  const maxY = Math.min(img.height - 1, Math.ceil(Math.max(...path.map((p) => p.y)) + half + 2));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let best = Infinity;
      for (let i = 1; i < path.length; i++) best = Math.min(best, distanceToSegment(px, py, path[i - 1], path[i]));
      paint(img, px, py, rgb, Math.max(0, Math.min(1, half + 0.5 - best)));
    }
  }
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

function rect(img: ImageBuffer, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): void {
  for (let x = x0; x <= x1; x++) {
    paint(img, x, y0, rgb, 1);
    paint(img, x, y1, rgb, 1);
  }
  for (let y = y0; y <= y1; y++) {
    paint(img, x0, y, rgb, 1);
    paint(img, x1, y, rgb, 1);
  }
}

/** The frame, its tick marks, and whatever series the case wants. */
function chart(series: Array<{ path: Point[]; rgb: [number, number, number] }>): ImageBuffer {
  const img = blank();
  const ink: [number, number, number] = [40, 40, 40];
  rect(img, PLOT.x0, PLOT.y0, PLOT.x1, PLOT.y1, ink);
  for (let i = 0; i <= 5; i++) {
    const x = Math.round(PLOT.x0 + ((PLOT.x1 - PLOT.x0) * i) / 5);
    for (let d = 1; d <= 5; d++) paint(img, x, PLOT.y1 + d, ink, 1);
    const y = Math.round(PLOT.y1 - ((PLOT.y1 - PLOT.y0) * i) / 5);
    for (let d = 1; d <= 5; d++) paint(img, PLOT.x0 - d, y, ink, 1);
  }
  for (const s of series) stroke(img, s.path, 3, s.rgb);
  return img;
}

/** A flat line with one narrow spike, a fifth of the way in from the left. */
function spikeChart(): ImageBuffer {
  const base = PLOT.y1 - 30;
  const tip = PLOT.y0 + 25;
  return chart([
    {
      rgb: [30, 90, 200],
      path: [
        { x: PLOT.x0 + 4, y: base },
        { x: SPIKE_PX - 9, y: base },
        { x: SPIKE_PX, y: tip },
        { x: SPIKE_PX + 9, y: base },
        { x: PLOT.x1 - 4, y: base },
      ],
    },
  ]);
}

/** A straight ramp from bottom left to top right. */
function rampChart(): ImageBuffer {
  return chart([
    {
      rgb: [30, 90, 200],
      path: [
        { x: PLOT.x0 + 4, y: PLOT.y1 - 12 },
        { x: PLOT.x1 - 4, y: PLOT.y0 + 12 },
      ],
    },
  ]);
}

async function extract(img: ImageBuffer): Promise<Point[]> {
  const analysis = await analyse(img, { ocr: null });
  expect(analysis.series.length).toBeGreaterThan(0);
  const series = buildSeries(analysis, { calibration: CAL, resample: { kind: 'native' } });
  const points = series[0].points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  expect(points.length).toBeGreaterThan(50);
  return points;
}

describe('which end is which', () => {
  it('puts the spike where it was drawn, a fifth of the way in from the left', async () => {
    const points = await extract(spikeChart());

    // The exported numbers, which are what the chart panel plots.
    const peak = points.reduce((best, p) => (p.y > best.y ? p : best));
    const trueX = pixelToValue(CAL.x, SPIKE_PX);
    expect(peak.x).toBeGreaterThan(trueX - 3);
    expect(peak.x).toBeLessThan(trueX + 3);
    // Stated the other way round, so a mirror cannot pass by luck: the peak is
    // in the left third of the axis, not the right.
    expect(peak.x).toBeLessThan(35);

    // The overlay panel's own round trip: value -> pixel has to land back on
    // the ink it was read from.
    expect(valueToPixel(CAL.x, peak.x)).toBeCloseTo(SPIKE_PX, 0);
  });

  it('exports a ramp that rises to the right, on both axes', async () => {
    const points = await extract(rampChart());
    const sorted = [...points].sort((a, b) => a.x - b.x);

    // x rises with the image's own pixels...
    expect(valueToPixel(CAL.x, sorted[0].x)).toBeLessThan(valueToPixel(CAL.x, sorted[sorted.length - 1].x));
    // ...and so does the value, which is what makes the chart panel draw the
    // left-hand end of the plot on the left.
    expect(sorted[0].x).toBeLessThan(sorted[sorted.length - 1].x);
    // y rises upwards: the right-hand end was drawn nearer the top of the image.
    expect(sorted[0].y).toBeLessThan(sorted[sorted.length - 1].y);
    expect(valueToPixel(CAL.y, sorted[0].y)).toBeGreaterThan(
      valueToPixel(CAL.y, sorted[sorted.length - 1].y),
    );
  });

  it('reads the same points back to the pixels they were traced from', async () => {
    const points = await extract(rampChart());
    for (const p of points) {
      // Every point, not just the ends: a mirror about the middle leaves the
      // centre alone, so an average or a midpoint check would miss it.
      const px = valueToPixel(CAL.x, p.x);
      const py = valueToPixel(CAL.y, p.y);
      expect(px).toBeGreaterThanOrEqual(PLOT.x0 - 1);
      expect(px).toBeLessThanOrEqual(PLOT.x1 + 1);
      expect(pixelToValue(CAL.x, px)).toBeCloseTo(p.x, 6);
      expect(pixelToValue(CAL.y, py)).toBeCloseTo(p.y, 6);
      // The ramp was drawn straight, so the pixel a value maps back to must
      // still be on it. A mirrored x would put every point on the wrong side.
      const expectedPy = PLOT.y1 - 12 - ((px - (PLOT.x0 + 4)) / (PLOT.x1 - 4 - (PLOT.x0 + 4))) * (PLOT.y1 - PLOT.y0 - 24);
      expect(Math.abs(py - expectedPy)).toBeLessThan(4);
    }
  });
});
