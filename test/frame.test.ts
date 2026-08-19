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
