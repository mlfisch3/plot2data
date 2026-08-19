import { describe, expect, it } from 'vitest';
import {
  calibrateAxis,
  describeAxis,
  fitAxis,
  isValid,
  pixelToValue,
  scaleAt,
  valueToPixel,
} from '../src/engine/calibration.ts';
import type { LabelledTick } from '../src/engine/types.ts';

function ticks(pairs: Array<[number, number]>): LabelledTick[] {
  return pairs.map(([px, value]) => ({ px, length: 4, major: true, value }));
}

describe('fitAxis', () => {
  it('picks linear for evenly spaced linear labels', () => {
    const f = fitAxis([
      { px: 0, value: 0 },
      { px: 100, value: 10 },
      { px: 200, value: 20 },
      { px: 300, value: 30 },
    ])!;
    expect(f.report.chosen).toBe('linear');
    expect(f.fit.scale).toBe('linear');
    expect(f.fit.relativeResidual).toBeLessThan(1e-12);
  });

  it('picks log for decade labels evenly spaced in pixels', () => {
    const f = fitAxis([
      { px: 400, value: 1 },
      { px: 300, value: 10 },
      { px: 200, value: 100 },
      { px: 100, value: 1000 },
    ])!;
    expect(f.report.chosen).toBe('log');
    expect(f.report.logResidual).toBeLessThan(1e-12);
    expect(f.report.linearResidual).toBeGreaterThan(0.05);
  });

  it('reads the microprocessor chart decades as log', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
      px: 760 - n * 95,
      value: Math.pow(10, n),
    }));
    const f = fitAxis(samples)!;
    expect(f.report.chosen).toBe('log');
    expect(f.report.ambiguous).toBe(false);
  });

  it('refuses to guess the scale from only two labels', () => {
    const f = fitAxis([
      { px: 0, value: 1 },
      { px: 100, value: 100 },
    ])!;
    expect(f.report.samples).toBe(2);
    expect(f.report.ambiguous).toBe(true);
    expect(f.report.chosen).toBe('linear');
  });
});

describe('calibrateAxis', () => {
  it('beats a two-point fit when printed tick values are rounded', () => {
    // The multipanel example: pixels are exactly even, printed values are
    // rounded to whole thousands. True mapping is 0 at px 140, 22400 at px 20.
    const truth = (px: number) => ((140 - px) / 120) * 22400;
    const px = [140, 116, 92, 68, 44, 20];
    const printed = [0, 4000, 9000, 13000, 18000, 22000];
    const cal = calibrateAxis('left', ticks(px.map((p, i) => [p, printed[i]])), 140, 20);

    let lsqWorst = 0;
    let twoPointWorst = 0;
    for (const p of px) {
      lsqWorst = Math.max(lsqWorst, Math.abs(pixelToValue(cal, p) - truth(p)));
      // A naive two-point calibration off the extreme printed labels.
      const twoPoint = ((140 - p) / 120) * 22000;
      twoPointWorst = Math.max(twoPointWorst, Math.abs(twoPoint - truth(p)));
    }
    expect(lsqWorst).toBeLessThan(twoPointWorst);
    expect(lsqWorst).toBeLessThan(400);
    // The rounding shows up as a non-zero but small residual, not as silence.
    expect(cal.scaleFit!.linearResidual).toBeGreaterThan(0);
    expect(cal.scaleFit!.linearResidual).toBeLessThan(0.02);
  });

  it('maps pixels to values on a linear axis', () => {
    const cal = calibrateAxis('bottom', ticks([[100, 0], [300, 6], [500, 12]]), 100, 500);
    expect(pixelToValue(cal, 100)).toBeCloseTo(0, 9);
    expect(pixelToValue(cal, 300)).toBeCloseTo(6, 9);
    expect(pixelToValue(cal, 500)).toBeCloseTo(12, 9);
    expect(valueToPixel(cal, 6)).toBeCloseTo(300, 6);
  });

  it('maps pixels to values on a log axis', () => {
    const cal = calibrateAxis(
      'left',
      ticks([[500, 0.01], [400, 0.1], [300, 1], [200, 10], [100, 100]]),
      500,
      100,
    );
    expect(cal.scale).toBe('log');
    expect(pixelToValue(cal, 500)).toBeCloseTo(0.01, 9);
    expect(pixelToValue(cal, 300)).toBeCloseTo(1, 9);
    expect(pixelToValue(cal, 100)).toBeCloseTo(100, 9);
  });

  it('applies a multiplier annotation to every value', () => {
    const cal = calibrateAxis('left', ticks([[500, 0], [100, 8]]), 500, 100, {
      multiplier: 1e6,
    });
    expect(pixelToValue(cal, 100)).toBeCloseTo(8e6, 3);
    expect(pixelToValue(cal, 300)).toBeCloseTo(4e6, 3);
    expect(valueToPixel(cal, 4e6)).toBeCloseTo(300, 6);
  });

  it('applies an additive offset annotation', () => {
    const cal = calibrateAxis('bottom', ticks([[0, 0], [100, 2]]), 0, 100, { offset: 3.14 });
    expect(pixelToValue(cal, 0)).toBeCloseTo(3.14, 9);
    expect(pixelToValue(cal, 100)).toBeCloseTo(5.14, 9);
  });

  it('honours a manual scale override', () => {
    const cal = calibrateAxis('left', ticks([[500, 1], [400, 2], [300, 3]]), 500, 300, {
      scale: 'log',
    });
    expect(cal.scale).toBe('log');
    expect(cal.scaleSource).toBe('manual');
  });

  it('falls back to an editable default when nothing was read', () => {
    const cal = calibrateAxis('bottom', [], 50, 850);
    expect(cal.scaleSource).toBe('default');
    expect(cal.a.source).toBe('default');
    expect(isValid(cal)).toBe(true);
  });
});

describe('scaleAt', () => {
  it('is constant on a linear axis and varies on a log axis', () => {
    const lin = calibrateAxis('left', ticks([[400, 0], [0, 100]]), 400, 0);
    expect(scaleAt(lin, 100)).toBeCloseTo(scaleAt(lin, 300), 9);

    const log = calibrateAxis('left', ticks([[400, 1], [300, 10], [200, 100], [100, 1000]]), 400, 100);
    expect(scaleAt(log, 150)).toBeGreaterThan(scaleAt(log, 350) * 10);
  });
});

describe('describeAxis', () => {
  it('states the mapping in a form a human can check', () => {
    const cal = calibrateAxis('bottom', ticks([[100, 0], [500, 12]]), 100, 500);
    expect(describeAxis(cal, 'x')).toBe('x: 0 to 12, linear');
  });
});
