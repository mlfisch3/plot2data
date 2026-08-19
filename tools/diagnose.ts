/**
 * Developer diagnostic: run the detection stages over every corpus image and
 * print what was found. Not part of the test suite - this is the tool used when
 * tuning thresholds. `node --experimental-strip-types tools/diagnose.ts [id]`
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { detectFrame } from '../src/engine/frame.ts';
import { detectTicks, medianGap } from '../src/engine/ticks.ts';
import type { ImageBuffer } from '../src/engine/types.ts';

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../corpus');

function load(path: string): ImageBuffer {
  const buf = readFileSync(path);
  if (path.endsWith('.png')) {
    const p = PNG.sync.read(buf);
    return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
  }
  const j = jpeg.decode(buf, { useTArray: true });
  return { width: j.width, height: j.height, data: new Uint8ClampedArray(j.data) };
}

const only = process.argv[2];
const files = readdirSync(CORPUS)
  .filter((f) => /\.(png|jpg)$/.test(f))
  .filter((f) => !only || f.startsWith(only));

for (const f of files) {
  const img = load(resolve(CORPUS, f));
  const frame = detectFrame(img);
  const xs = detectTicks(img, frame, 'bottom');
  const ys = detectTicks(img, frame, 'left');
  console.log(`\n=== ${f}  ${img.width}x${img.height}`);
  console.log(
    `  frame rect=(${frame.rect.x0},${frame.rect.y0})-(${frame.rect.x1},${frame.rect.y1}) ` +
      `dark=${frame.darkTheme} conf=${frame.confidence.toFixed(2)} ` +
      `bg=${frame.background.r.toFixed(0)},${frame.background.g.toFixed(0)},${frame.background.b.toFixed(0)}`,
  );
  console.log(
    `  spines bottom=${frame.bottom?.pos.toFixed(1)} left=${frame.left?.pos.toFixed(1)} ` +
      `top=${frame.top?.pos.toFixed(1)} right=${frame.right?.pos.toFixed(1)}`,
  );
  console.log(
    `  x ticks n=${xs.ticks.length} dir=${xs.direction} len=${xs.tickLength} gap=${medianGap(xs.ticks).toFixed(1)} ` +
      `pos=[${xs.ticks.map((t) => t.px.toFixed(0)).join(' ')}]`,
  );
  console.log(
    `  y ticks n=${ys.ticks.length} dir=${ys.direction} len=${ys.tickLength} gap=${medianGap(ys.ticks).toFixed(1)} ` +
      `pos=[${ys.ticks.map((t) => t.px.toFixed(0)).join(' ')}]`,
  );
}
