/**
 * Assemble everything OCR needs into `public/`, so the built bundle carries its
 * own text recognition and never reaches the network at runtime. Run from the
 * `dev`, `build`, `test` and `accuracy` scripts; all of `public/` is generated
 * and none of it is tracked.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/tesseract');
const TESSDATA_OUT = resolve(ROOT, 'public/tessdata');
const TESSDATA_SRC = resolve(ROOT, 'vendor/tessdata/eng.traineddata.gz');

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

// The language data is vendored gzipped because it is a tracked 2 MB binary,
// but it ships expanded. Android's asset merger silently gunzips any `.gz` it
// is given *and drops the extension*, so a bundle that asked for
// `eng.traineddata.gz` would 404 inside the app and lose OCR without a word.
// One expanded file behaves identically everywhere, and lets an HTTP server do
// its own compression instead of fighting tesseract.js over who decompresses.
mkdirSync(TESSDATA_OUT, { recursive: true });
const trained = resolve(TESSDATA_OUT, 'eng.traineddata');
if (!existsSync(TESSDATA_SRC)) {
  console.warn('missing vendor/tessdata/eng.traineddata.gz - OCR will be unavailable');
} else if (!existsSync(trained) || statSync(trained).mtimeMs < statSync(TESSDATA_SRC).mtimeMs) {
  writeFileSync(trained, gunzipSync(readFileSync(TESSDATA_SRC)));
  console.log('expanded vendor/tessdata/eng.traineddata.gz -> public/tessdata/');
}

console.log(`tesseract assets copied to public/tesseract/`);
