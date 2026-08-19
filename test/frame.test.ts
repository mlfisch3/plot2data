import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { detectFrame } from '../src/engine/frame.ts';
import { loadImage } from './helpers/load-image.ts';

const CORPUS = resolve(import.meta.dirname, '../corpus');

describe('detectFrame', () => {
  it('finds the plot rectangle on a clean light-theme plot', () => {
    const img = loadImage(resolve(CORPUS, 'linear-single-solid.png'));
    const f = detectFrame(img);
    expect(f.bottom).not.toBeNull();
    expect(f.left).not.toBeNull();
    // The plot area should occupy most of the image but not all of it.
    const w = f.rect.x1 - f.rect.x0;
    const h = f.rect.y1 - f.rect.y0;
    expect(w / img.width).toBeGreaterThan(0.8);
    expect(h / img.height).toBeGreaterThan(0.8);
    expect(f.rect.x0).toBeGreaterThan(10);
    expect(f.darkTheme).toBe(false);
  });

  it('finds the plot rectangle on a dark-theme plot', () => {
    const img = loadImage(resolve(CORPUS, 'dark-theme.png'));
    const f = detectFrame(img);
    expect(f.darkTheme).toBe(true);
    expect(f.bottom).not.toBeNull();
    expect(f.left).not.toBeNull();
  });
});

describe('detectFrame on real-world screenshots', () => {
  it('ignores the outer screenshot border and finds the drawn plot box', () => {
    const img = loadImage(resolve(import.meta.dirname, '../examples/real/02-microprocessor-log-scatter.png'));
    const f = detectFrame(img);
    // The image has a black border at its own edges; the plot box is inside it.
    expect(f.rect.x1).toBeLessThan(img.width - 200);
    expect(f.rect.y0).toBeGreaterThan(40);
    expect(f.left).not.toBeNull();
    expect(f.right).not.toBeNull();
  });

  it('finds the data area from gridlines when no y-axis line is drawn', () => {
    const img = loadImage(resolve(import.meta.dirname, '../examples/real/03-women-men-percent.png'));
    const f = detectFrame(img);
    expect(f.left).toBeNull();
    // Tick labels sit to the left of the data area and must not be inside it.
    expect(f.rect.x0).toBeGreaterThan(20);
    expect(f.rect.x0).toBeLessThan(35);
    expect(f.bottom).not.toBeNull();
  });

  it('handles a non-white background', () => {
    const img = loadImage(resolve(import.meta.dirname, '../examples/real/04-hits-per-visit-redgreen.png'));
    const f = detectFrame(img);
    expect(f.background.r).toBeGreaterThan(240);
    expect(f.background.b).toBeLessThan(f.background.r - 3);
    expect(f.darkTheme).toBe(false);
  });

  it('rejects a panel divider that overshoots the plot', () => {
    const img = loadImage(resolve(import.meta.dirname, '../examples/real/01-panel1.png'));
    const f = detectFrame(img);
    expect(f.rect.x1).toBeLessThan(290);
    expect(f.rect.y0).toBeLessThan(25);
  });
});
