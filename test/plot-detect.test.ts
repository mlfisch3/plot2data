/**
 * Multi-plot detection in uncropped screenshots.
 *
 * Three cases to cover: a cropped-to-one-plot image returns one candidate,
 * a multipanel composite returns one candidate per panel, and the three
 * candidates on the composite each land on their respective panel. The
 * numbers here are loose rect bounds, not pixel-exact: the UI uses the
 * candidate as a starting point and the user can still drag the handles.
 */

import { describe, expect, it } from 'vitest';
import { detectPlotCandidates } from '../src/engine/index.ts';
import { loadImage } from './helpers/load-image.ts';
import { resolve } from 'node:path';

const REAL = resolve(import.meta.dirname, '..', 'examples/real');

describe('detectPlotCandidates', () => {
  it('finds exactly one plot in a cropped image', () => {
    const img = loadImage(resolve(REAL, '01-panel1.png'));
    const cands = detectPlotCandidates(img);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    // The best candidate's rect must cover the panel's data area roughly.
    const best = cands[0];
    expect(best.rect.x0).toBeLessThan(80);
    expect(best.rect.x1).toBeGreaterThan(220);
    expect(best.rect.y0).toBeLessThan(80);
    expect(best.rect.y1).toBeGreaterThan(120);
  });

  it('finds three plots in the multipanel composite', () => {
    const img = loadImage(resolve(REAL, '01-multipanel-blue-ktrend.png'));
    const cands = detectPlotCandidates(img);
    expect(cands.length).toBeGreaterThanOrEqual(3);

    // One candidate per panel, by x-range.
    const panels = cands
      .slice(0, 3)
      .map((c) => ({ xMid: (c.rect.x0 + c.rect.x1) / 2, c }))
      .sort((a, b) => a.xMid - b.xMid);
    const [p1, p2, p3] = panels;
    expect(p1.xMid).toBeLessThan(300);
    expect(p2.xMid).toBeGreaterThan(400);
    expect(p2.xMid).toBeLessThan(650);
    expect(p3.xMid).toBeGreaterThan(700);
  });

  it('finds the microprocessor chart as the strongest candidate', () => {
    const img = loadImage(resolve(REAL, '02-microprocessor-log-scatter.png'));
    const cands = detectPlotCandidates(img);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const best = cands[0];
    // The chart's own frame sits roughly at (77, 80, 1256, 820).
    expect(best.rect.x0).toBeLessThan(150);
    expect(best.rect.x1).toBeGreaterThan(1100);
    expect(best.rect.y0).toBeLessThan(150);
    expect(best.rect.y1).toBeGreaterThan(700);
    expect(best.confidence).toBeGreaterThan(0.5);
  });

  it('falls back to the whole-frame detector when no gridlines are visible', () => {
    const img = loadImage(resolve(REAL, '05-retail-sales-monthly.png'));
    const cands = detectPlotCandidates(img);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const best = cands[0];
    expect(best.rect.x1 - best.rect.x0).toBeGreaterThan(img.width * 0.6);
    expect(best.rect.y1 - best.rect.y0).toBeGreaterThan(img.height * 0.6);
  });
});
