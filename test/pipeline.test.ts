import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { analyse, buildSeries, toCsv } from '../src/engine/index.ts';
import { loadImage } from './helpers/load-image.ts';
import { NodeOcr } from './helpers/node-ocr.ts';

const ocr = new NodeOcr();
beforeAll(async () => {
  await ocr.start();
});
afterAll(async () => {
  await ocr.stop();
});

function img(path: string) {
  return loadImage(resolve(import.meta.dirname, '..', path));
}

describe('analyse', () => {
  it('reads a clean linear plot end to end', async () => {
    const a = await analyse(img('corpus/linear-single-solid.png'), { ocr });
    expect(a.calibration.x.scale).toBe('linear');
    expect(a.calibration.y.scale).toBe('linear');
    // Anchors land on the plot edges; tolerances here are 0.1% of full scale.
    expect(a.calibration.x.a.value).toBeCloseTo(0, 1);
    expect(a.calibration.x.b.value).toBeCloseTo(12, 1);
    expect(a.calibration.y.a.value).toBeCloseTo(0, 1);
    expect(Math.abs(a.calibration.y.b.value - 100)).toBeLessThan(0.1);
    expect(a.series).toHaveLength(1);
    expect(a.series[0].traced.mode).toBe('curve');
  });

  it('detects a logarithmic y axis from the tick labels', async () => {
    const a = await analyse(img('corpus/log-y.png'), { ocr });
    expect(a.calibration.y.scale).toBe('log');
    expect(a.calibration.y.scaleFit!.chosen).toBe('log');
    expect(a.calibration.y.scaleFit!.ambiguous).toBe(false);
    expect(a.calibration.y.a.value).toBeCloseTo(0.01, 3);
    expect(a.calibration.y.b.value).toBeCloseTo(100, 0);
  });

  it('surfaces a matplotlib-style multiplier annotation', async () => {
    const a = await analyse(img('corpus/offset-annotation.png'), { ocr });
    expect(a.annotations.some((x) => x.multiplier === 1e6)).toBe(true);
    expect(a.warnings.some((w) => w.code === 'offset-annotation')).toBe(true);
    expect(a.calibration.y.multiplier).toBe(1e6);
    const series = buildSeries(a);
    const ys = series[0].points.map((p) => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(5e6);
  });

  it('separates three series by colour', async () => {
    const a = await analyse(img('corpus/linear-multi.png'), { ocr });
    expect(a.series.length).toBe(3);
  });

  it('chooses marker mode for a scatter plot', async () => {
    const a = await analyse(img('corpus/scatter-markers.png'), { ocr });
    expect(a.series[0].traced.mode).toBe('marker');
    expect(a.series[0].traced.points.length).toBeGreaterThanOrEqual(20);
  });

  it('warns and still produces an editable calibration with no OCR', async () => {
    const a = await analyse(img('corpus/linear-single-solid.png'), { ocr: null });
    expect(a.warnings.some((w) => w.code === 'no-ocr')).toBe(true);
    expect(a.calibration.x.a.source).toBe('default');
    expect(a.series.length).toBe(1);
  });
});

describe('toCsv', () => {
  it('records the calibration, the uncertainty and the mode', async () => {
    const a = await analyse(img('corpus/linear-single-solid.png'), { ocr });
    const csv = toCsv(a, buildSeries(a, { resample: { kind: 'uniform', count: 10 } }), {
      source: 'linear-single-solid.png',
    });
    expect(csv).toContain('# plot2data v');
    expect(csv).toContain('RESAMPLING OF THE DRAWN CURVE');
    expect(csv).toMatch(/# x: -?0[.0-9e-]* to 12[.0-9]*, linear/);
    expect(csv).toContain('uncertainty from line thickness');
    expect(csv.trim().split('\n').filter((l) => !l.startsWith('#'))).toHaveLength(11);
  });
});
