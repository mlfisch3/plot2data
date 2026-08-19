/**
 * Copy the tesseract.js worker and WASM core into `public/` so the built bundle
 * carries its own OCR and never reaches the network at runtime. Run from the
 * `predev` and `prebuild` scripts; the copied files are generated, not tracked.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/tesseract');

// The LSTM-only cores are ~800 KB smaller than the full ones and are all the
// engine needs. All three SIMD variants ship because tesseract.js picks one
// from the browser's capabilities at runtime, and a missing variant means no
// OCR at all on that browser.
const CORES = [
  'tesseract-core-lstm',
  'tesseract-core-simd-lstm',
  'tesseract-core-relaxedsimd-lstm',
];

const FILES: Array<[string, string]> = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ...CORES.flatMap((core): Array<[string, string]> => [
    [`node_modules/tesseract.js-core/${core}.wasm.js`, `${core}.wasm.js`],
    [`node_modules/tesseract.js-core/${core}.wasm`, `${core}.wasm`],
  ]),
];

mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) {
  const src = resolve(ROOT, from);
  if (!existsSync(src)) {
    console.warn(`missing ${from} - OCR will be unavailable`);
    continue;
  }
  copyFileSync(src, resolve(OUT, to));
}
console.log(`tesseract assets copied to public/tesseract/`);
