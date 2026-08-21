/**
 * Series names read off the chart's own legend.
 *
 * Measured against the captain's microprocessor screenshot, which is the case
 * this exists for: a colour-coded legend outside the plot frame, entries
 * wrapped over two rows, and a chart title drawn in one of the series' own
 * colours sitting above it as a decoy.
 *
 * Naming is cosmetic, so the assertions are about what is adopted and what is
 * refused, never about a number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { analyse, looksLikeALabel } from '../src/engine/index.ts';
import { loadImage } from './helpers/load-image.ts';
import { NodeOcr } from './helpers/node-ocr.ts';
import { ROOT } from './helpers/accuracy.ts';

const ocr = new NodeOcr();
beforeAll(async () => {
  await ocr.start();
});
afterAll(async () => {
  await ocr.stop();
});

describe('looksLikeALabel', () => {
  it('accepts words and refuses what a row of markers reads as', () => {
    expect(looksLikeALabel('Typical Power (Watts)')).toBe(true);
    expect(looksLikeALabel('Men')).toBe(true);
    expect(looksLikeALabel('10^3')).toBe(false);
    expect(looksLikeALabel('.. , ...')).toBe(false);
    expect(looksLikeALabel('')).toBe(false);
    expect(looksLikeALabel('ab')).toBe(false);
  });
});

describe('02-microprocessor-log-scatter', () => {
  it('names every series from the legend, and not from the title', async () => {
    const image = loadImage(resolve(ROOT, 'examples/real/02-microprocessor-log-scatter.png'));
    const a = await analyse(image, { ocr });
    expect(a.series).toHaveLength(5);

    const named = new Map(a.series.map((s) => [s.label?.text ?? '', s.traced.colour]));
    for (const wanted of [
      'Transistors (thousands)',
      'Frequency (MHz)',
      'Typical Power (Watts)',
      'Number of Logical Cores',
    ]) {
      expect([...named.keys()], wanted).toContain(wanted);
    }
    // The fifth wraps over three rows and carries a superscript the recogniser
    // flattens, so it is matched loosely - the words are what matter.
    expect([...named.keys()].some((t) => t.startsWith('Single-Thread Performance'))).toBe(true);

    // The chart's title is drawn in black, is the longest run of black text in
    // the image, and is not a legend entry. Aligning the entries into a column
    // is what tells them apart.
    for (const s of a.series) {
      expect(s.label?.text ?? '').not.toContain('42 Years');
    }

    // Every label sits outside the plot frame on this chart.
    for (const s of a.series) if (s.label) expect(s.label.outside).toBe(true);
  });

  it('changes no extracted number', async () => {
    const image = loadImage(resolve(ROOT, 'examples/real/02-microprocessor-log-scatter.png'));
    const [withNames, without] = await Promise.all([
      analyse(image, { ocr, readLabels: true }),
      analyse(image, { ocr, readLabels: false }),
    ]);
    expect(without.legend).toEqual([]);
    expect(withNames.series.map((s) => s.marker.points.length)).toEqual(
      without.series.map((s) => s.marker.points.length),
    );
    expect(withNames.series.map((s) => s.marker.points[0].py)).toEqual(
      without.series.map((s) => s.marker.points[0].py),
    );
    expect(withNames.calibration).toEqual(without.calibration);
  });
});

describe('03-women-men-percent', () => {
  it('takes a name printed inside the plot in the series colour', async () => {
    const image = loadImage(resolve(ROOT, 'examples/real/03-women-men-percent.png'));
    const a = await analyse(image, { ocr });
    const names = a.series.map((s) => s.label?.text).filter(Boolean);
    // There is no legend on this chart at all: the two series are named by
    // words printed among the data in their own colour.
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(['Women', 'Men']).toContain(n);
  });
});
