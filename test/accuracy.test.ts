/**
 * Measured accuracy over the synthetic corpus.
 *
 * Ground truth is exact: each corpus image is rendered from an analytic
 * function, so the error here is the tool's error and nothing else. The budget
 * is deliberately a hard assertion - a regression that doubles the error should
 * fail the build, not quietly land.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASES, runCase, type CaseResult } from './helpers/accuracy.ts';
import { NodeOcr } from './helpers/node-ocr.ts';

const ocr = new NodeOcr();
const results: CaseResult[] = [];

beforeAll(async () => {
  await ocr.start();
});

afterAll(async () => {
  await ocr.stop();
  const rows = results
    .map(
      (r) =>
        `  ${r.id.padEnd(22)} series ${r.detectedSeries}/${r.expectedSeries}  ${r.mode.padEnd(6)} ` +
        `${r.xScale}/${r.yScale}  rms ${r.errors.map((e) => `${e.rmsPercent.toFixed(3)}%`).join(' ')}` +
        `  cover ${r.errors.map((e) => `${(e.coverage * 100).toFixed(0)}%`).join(' ')}` +
        `  peak ${r.errors
          .map((e) => (e.peak.count ? `${e.peak.shortfallPercent.toFixed(3)}%/${e.peak.count}` : '-'))
          .join(' ')}` +
        `  axis err x ${r.xRangeError.toFixed(3)}% y ${r.yRangeError.toFixed(3)}%`,
    )
    .join('\n');
  console.log(`\nAccuracy over the synthetic corpus (RMS as % of full scale):\n${rows}\n`);
});

/**
 * Hard budget on the peak shortfall, as a percentage of full scale.
 *
 * Signed and measured inwards, so a tracer that shaves the tips off spikes
 * fails here however good its headline RMS looks - which is the whole point of
 * measuring peaks separately. Before the apex correction `narrow-peaks`
 * measured 0.99% here and `sawtooth-sharp` 0.51%, on headline RMS figures of
 * 0.26% and 0.24% that said nothing at all about it.
 */
const PEAK_BUDGET_PERCENT = 0.4;

describe('accuracy over the synthetic corpus', () => {
  for (const spec of CASES) {
    it(`${spec.id}: ${spec.description}`, async () => {
      const r = await runCase(spec, { ocr });
      results.push(r);

      expect(r.detectedSeries).toBeGreaterThanOrEqual(spec.series.length);
      expect(r.xScale).toBe(spec.xScale === 'logarithmic' ? 'log' : 'linear');
      expect(r.yScale).toBe(spec.yScale === 'logarithmic' ? 'log' : 'linear');
      // The axis calibration itself must land within 0.5% of the true range.
      expect(r.xRangeError).toBeLessThan(0.5);
      expect(r.yRangeError).toBeLessThan(0.5);
      const minPoints = r.mode === 'marker' ? Math.round(spec.samples * 0.7) : 50;
      for (const e of r.errors) {
        expect(e.points).toBeGreaterThanOrEqual(minPoints);
        expect(e.rmsPercent).toBeLessThan(r.rmsBudget);
        // A truncated trace can still score a low RMS over the part it covers,
        // so coverage is asserted separately.
        expect(e.coverage).toBeGreaterThan(0.9);
        // So can a trace that clips every peak, which is why peaks are their own
        // assertion rather than a line in the average.
        if (e.peak.count > 0) {
          expect(e.peak.shortfallPercent).toBeLessThan(PEAK_BUDGET_PERCENT);
          expect(e.peak.shortfallPercent).toBeGreaterThan(-PEAK_BUDGET_PERCENT);
        }
      }
    });
  }
});
