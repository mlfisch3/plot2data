/**
 * Node-side image loading for tests. The browser uses `createImageBitmap`;
 * here we decode PNG/JPEG directly so the engine can be exercised headlessly.
 */

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { ImageBuffer } from '../../src/engine/types.ts';

export function loadImage(path: string): ImageBuffer {
  const buf = readFileSync(path);
  if (path.endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  }
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
    const img = jpeg.decode(buf, { useTArray: true });
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  }
  throw new Error(`unsupported image type: ${path}`);
}
