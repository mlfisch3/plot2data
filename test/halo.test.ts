/**
 * Antialiasing halos must never be promoted to a series.
 *
 * A marker drawn with a hard edge against the paper is ringed by a one-pixel
 * band of intermediate colours. Those pixels have every superficial property of
 * a series - thousands of them, spread across the whole plot, a colour of their
 * own - and the tool once reported them as one: on the captain's microprocessor
 * chart, 123 one-pixel specks sitting on the red triangles were exported as the
 * orange series, while all 54 real orange markers were thrown away.
 *
 * The two halves are asserted separately here, because a fix that suppresses
 * the halo without restoring the ink to its owner would pass one and fail the
 * other.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  analyse,
  blendDistance,
  buildMask,
  detectFrame,
  findBlendArtefacts,
  findSeriesCandidates,
} from '../src/engine/index.ts';
import type { RGB } from '../src/engine/types.ts';
import { loadImage } from './helpers/load-image.ts';
import { ROOT } from './helpers/accuracy.ts';

const WHITE: RGB = { r: 255, g: 255, b: 255 };
/** The four flat colours the microprocessor chart is drawn in. */
const RED: RGB = { r: 186, g: 0, b: 0 };
const ORANGE: RGB = { r: 204, g: 102, b: 0 };

/** No detected series may be a blend artefact of another one. */
function haloesAmongDetectedSeries(image: Parameters<typeof detectFrame>[0]) {
  const frame = detectFrame(image);
  const candidates = findSeriesCandidates(image, frame);
  const colours = candidates.map((c) => c.colour);
  const masks = candidates.map((c) => buildMask(image, frame, c.colour, colours));
  return findBlendArtefacts(candidates, masks, frame.background);
}

describe('blend geometry', () => {
  it('puts a red marker edge on red, though it is nearer orange as a colour', () => {
    // The pixel that broke it: a mid-tone of dark red fading into white paper.
    const edge: RGB = { r: 219, g: 119, b: 119 };
    // By plain colour distance the wrong answer wins, and by a wide margin.
    expect(Math.hypot(edge.r - ORANGE.r, edge.g - ORANGE.g, edge.b - ORANGE.b)).toBeLessThan(
      Math.hypot(edge.r - RED.r, edge.g - RED.g, edge.b - RED.b),
    );
    // Measured against the blend segments, the right answer wins by a wider one.
    expect(blendDistance(edge, RED, WHITE)).toBeLessThan(2);
    expect(blendDistance(edge, ORANGE, WHITE)).toBeGreaterThan(40);
  });

  it('keeps a darker shade out of a lighter series of the same hue', () => {
    // A colour beyond the ink is not a blend of it, whatever the ray says.
    const darkBlue: RGB = { r: 0, g: 0, b: 150 };
    const lightBlue: RGB = { r: 120, g: 120, b: 255 };
    expect(blendDistance(darkBlue, darkBlue, WHITE)).toBeLessThan(1);
    expect(blendDistance(darkBlue, lightBlue, WHITE)).toBeGreaterThan(100);
  });
});

describe('scatter-halo-colours: four strongly antialiased marker series', () => {
  const image = loadImage(resolve(ROOT, 'corpus/scatter-halo-colours.png'));

  it('finds four series and no fifth', async () => {
    const a = await analyse(image, { ocr: null });
    expect(a.series).toHaveLength(4);
    for (const s of a.series) expect(s.autoMode).toBe('marker');
  });

  it('returns one point per drawn marker for every series', async () => {
    const a = await analyse(image, { ocr: null });
    // 22 markers are drawn per series, none of them overlapping.
    for (const s of a.series) expect(s.marker.points.length).toBe(22);
  });

  it('reports no series as a halo of another', () => {
    expect(haloesAmongDetectedSeries(image)).toEqual([]);
  });

  it('measures every series as marker-thick, never one pixel thick', async () => {
    const a = await analyse(image, { ocr: null });
    // A one-pixel-thick "series" is a halo, not a marker. The markers here are
    // drawn 12 px across, so anything under half that is not one of them.
    for (const s of a.series) expect(s.marker.thicknessPx).toBeGreaterThan(6);
  });

  it('keeps each series in the band it was drawn in', async () => {
    const a = await analyse(image, { ocr: null });
    // Four bands, well separated, so the vertical order of the series is fixed
    // and a series that has landed on another's ink cannot reproduce it.
    const centres = a.series
      .map((s) => {
        const ys = s.marker.points.map((p) => p.py + s.mask.rect.y0);
        return ys.reduce((x, y) => x + y, 0) / ys.length;
      })
      .sort((x, y) => x - y);
    for (let i = 1; i < centres.length; i++) {
      expect(centres[i] - centres[i - 1]).toBeGreaterThan(40);
    }
  });
});

describe('02-microprocessor-log-scatter: the chart the defect was found on', () => {
  const image = loadImage(resolve(ROOT, 'examples/real/02-microprocessor-log-scatter.png'));

  it('reports no series as a halo of another', () => {
    expect(haloesAmongDetectedSeries(image)).toEqual([]);
  });

  it('puts the orange series where the orange markers are, not on the red ones', async () => {
    const a = await analyse(image, { ocr: null });
    expect(a.series).toHaveLength(5);
    const near = (c: RGB, want: RGB) =>
      Math.hypot(c.r - want.r, c.g - want.g, c.b - want.b) < 30;
    const orange = a.series.find((s) => near(s.traced.colour, ORANGE));
    const red = a.series.find((s) => near(s.traced.colour, RED));
    expect(orange).toBeDefined();
    expect(red).toBeDefined();

    const top = (s: NonNullable<typeof orange>) =>
      Math.min(...s.marker.points.map((p) => p.py + s.mask.rect.y0));
    // Transistors run four decades above Typical Power, so the orange series has
    // to reach far higher up the image than the red one. When the halo was being
    // exported as the orange series the two topmost points were 2 px apart.
    expect(top(red!) - top(orange!)).toBeGreaterThan(300);

    // And it must be measured as markers, not as a one-pixel-thick structure:
    // that reading is what made the reported uncertainty 17x tighter than every
    // other series on the chart.
    expect(orange!.marker.thicknessPx).toBeGreaterThan(8);
    expect(orange!.marker.thicknessPx / red!.marker.thicknessPx).toBeGreaterThan(0.5);
  });
});
