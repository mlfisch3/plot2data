/**
 * The automatic point count, against traces whose vertex spacing is known.
 *
 * These are synthetic `TracedSeries`, not images, so the question asked is
 * exactly the one the estimator answers: given this path, how often was it
 * drawn to turn?
 */

import { describe, expect, it } from 'vitest';
import { suggestSampling } from '../src/engine/sampling.ts';
import type { TracedSeries } from '../src/engine/types.ts';

/** A traced path sampled once per column from `path`. */
function series(width: number, path: (x: number) => number): TracedSeries {
  const points = [];
  for (let x = 0; x < width; x++) {
    points.push({ px: x, py: path(x), weight: 2, interpolated: false });
  }
  return { colour: { r: 0, g: 0, b: 0 }, mode: 'curve', points, thicknessPx: 2, markerWidthPx: 0 };
}

/** A polyline through vertices `pitch` columns apart, linear in between. */
function polyline(width: number, pitch: number, at: (v: number) => number): TracedSeries {
  return series(width, (x) => {
    const v = Math.floor(x / pitch);
    const t = (x - v * pitch) / pitch;
    return at(v) + t * (at(v + 1) - at(v));
  });
}

describe('suggestSampling', () => {
  it('finds the pitch of a regular polyline', () => {
    const s = polyline(600, 10, (v) => 40 + 25 * Math.sin(v * 1.1));
    const got = suggestSampling([s], 599);
    expect(got.kind).toBe('uniform');
    expect(got.spacingPx).toBeGreaterThan(8);
    expect(got.spacingPx).toBeLessThan(12);
    // 599 px at a vertex every 10 px is 60 vertices plus the far end.
    expect(got.count).toBeGreaterThan(52);
    expect(got.count).toBeLessThan(68);
  });

  it('finds a fine pitch on a spiky series', () => {
    const s = polyline(700, 4, (v) => 60 + (v % 12 === 0 ? -40 : 6 * Math.sin(v)));
    const got = suggestSampling([s], 699);
    expect(got.kind).toBe('uniform');
    expect(got.count).toBeGreaterThan(120);
    expect(got.count).toBeLessThanOrEqual(700);
  });

  it('never proposes more points than there are columns', () => {
    const s = polyline(300, 3, (v) => 30 + 20 * Math.sin(v));
    const got = suggestSampling([s], 299);
    expect(got.count).toBeLessThanOrEqual(300);
  });

  it('falls back to one point per column for a smooth curve', () => {
    const s = series(600, (x) => 50 + 30 * Math.sin(x / 60));
    const got = suggestSampling([s], 599);
    expect(got.kind).toBe('native');
    expect(got.count).toBe(600);
    expect(got.reason).toContain('pixel column');
  });

  it('falls back for a trace too short to read a pitch off', () => {
    const s = polyline(18, 3, (v) => 10 + v);
    expect(suggestSampling([s], 17).kind).toBe('native');
  });

  it('leaves marker series to their own sample positions', () => {
    const s: TracedSeries = {
      ...polyline(300, 5, (v) => 20 + v),
      mode: 'marker',
    };
    expect(suggestSampling([s], 299).kind).toBe('native');
  });

  it('takes the finest pitch when several series disagree', () => {
    const coarse = polyline(600, 20, (v) => 30 + 15 * Math.sin(v));
    const fine = polyline(600, 5, (v) => 60 + 10 * Math.sin(v));
    const got = suggestSampling([coarse, fine], 599);
    expect(got.spacingPx).toBeLessThan(8);
  });

  it('explains itself in one line either way', () => {
    for (const s of [polyline(600, 10, (v) => 40 + 25 * Math.sin(v)), series(600, (x) => x / 4)]) {
      const reason = suggestSampling([s], 599).reason;
      expect(reason.length).toBeGreaterThan(10);
      expect(reason.split('\n')).toHaveLength(1);
    }
  });
});
