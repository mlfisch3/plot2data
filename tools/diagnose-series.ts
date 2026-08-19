/**
 * Developer diagnostic for the segmentation and tracing stages.
 * `node --experimental-strip-types tools/diagnose-series.ts [idPrefix]`
 */
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFrame } from '../src/engine/frame.ts';
import {
  buildMask,
  findComponents,
  findSeriesCandidates,
  selectDataComponents,
} from '../src/engine/segment.ts';
import { loadImage } from '../test/helpers/load-image.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
const files = [resolve(ROOT, 'corpus'), resolve(ROOT, 'examples/real')].flatMap((d) =>
  readdirSync(d)
    .filter((f) => /\.(png|jpg)$/.test(f) && (!only || f.startsWith(only)))
    .map((f) => resolve(d, f)),
);

for (const path of files) {
  const img = loadImage(path);
  const frame = detectFrame(img);
  const cands = findSeriesCandidates(img, frame);
  console.log(`\n=== ${path.split('/').pop()}`);
  const colours = cands.map((c) => c.colour);
  for (const c of cands) {
    const mask = buildMask(img, frame, c.colour, colours);
    const comps = findComponents(mask);
    const sel = selectDataComponents(comps, mask);
    console.log(
      `  rgb(${c.colour.r.toFixed(0)},${c.colour.g.toFixed(0)},${c.colour.b.toFixed(0)}) ` +
        `n=${c.pixelCount} cov=${(c.columnCoverage * 100).toFixed(0)}% gray=${c.gray} ` +
        `comps=${comps.length} kept=${sel.kept.length} rej=${sel.rejected.length} marker=${sel.markerLike}`,
    );
  }
}
