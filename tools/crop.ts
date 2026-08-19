/**
 * Crop a PNG to a rectangle. Used to prepare the single-panel test inputs for
 * the multipanel example, mirroring what the app's crop tool produces.
 * Usage: node --experimental-strip-types tools/crop.ts in.png out.png x y w h
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [, , inPath, outPath, xs, ys, ws, hs] = process.argv;
const src = PNG.sync.read(readFileSync(inPath));
const x = Number(xs);
const y = Number(ys);
const w = Number(ws);
const h = Number(hs);
const out = new PNG({ width: w, height: h });
for (let row = 0; row < h; row++) {
  const from = ((y + row) * src.width + x) * 4;
  src.data.copy(out.data, row * w * 4, from, from + w * 4);
}
writeFileSync(outPath, PNG.sync.write(out));
console.log(`${inPath} -> ${outPath} ${w}x${h} at ${x},${y}`);
