/**
 * Folds the module build into one HTML file that carries its own OCR.
 *
 * This is the build to send someone for review: one file, no directory beside
 * it, served over https from wherever it lands. That rules out every request
 * the other builds make for their own assets, so the assets travel inside the
 * page - gzipped and base64'd, and unpacked at runtime with the browser's own
 * `DecompressionStream`, which costs nothing to ship. Nothing here reaches the
 * network, and a content-security policy that forbids other hosts changes
 * nothing about how it runs.
 *
 * Three things go in besides the app:
 *
 * - `worker.min.js`, tesseract's worker;
 * - **one** WASM core, the plain LSTM one. The other builds ship all three SIMD
 *   variants because tesseract picks one from the browser's capabilities and a
 *   missing variant means no OCR at all; here the core is named exactly, and the
 *   plain one is the only variant every browser with WebAssembly can run. It is
 *   the slower of the three by roughly half, which on a dozen tick-label crops
 *   is not a wait anyone notices, and it saves 3.9 MB of page.
 * - `eng.traineddata`, already vendored gzipped, so it is embedded as it sits.
 *
 * The worker is assembled as one script - core, then a shim, then the worker -
 * rather than left to fetch its parts. `getCore` skips loading a core when
 * `TesseractCore` is already defined, so prepending it is all that is needed;
 * the shim is there for the language data, which the worker fetches by a path
 * it builds itself and which therefore has to be intercepted rather than
 * pointed somewhere else.
 *
 * Splicing is done with function replacements throughout: `String.replace`
 * expands `$&`, `` $` `` and `$'` in a string replacement, and a minified
 * bundle and a base64 payload are both full of them. What was written is
 * checked against what was read before the file is kept.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(ROOT, 'dist-review');
const OUT_DIR = resolve(ROOT, 'review');
const OUT = resolve(OUT_DIR, 'plot2data-review.html');

/** The core every browser with WebAssembly can run; see the note above. */
const CORE = 'tesseract-core-lstm.wasm.js';

function read(path: string): Buffer {
  if (!existsSync(path)) throw new Error(`missing ${path} - run \`npm run assets\` and the review build first`);
  return readFileSync(path);
}

/** Gzip and base64, the form the payloads travel in. */
function packed(buffer: Buffer): string {
  return gzipSync(buffer, { level: 9 }).toString('base64');
}

const indexPath = resolve(BUILD, 'index.html');
let html = read(indexPath).toString('utf8');

const scripts: string[] = [];
html = html.replace(/<script[^>]*src="\.?\/?([^"]+\.js)"[^>]*><\/script>/g, (match, src: string) => {
  const file = resolve(BUILD, src);
  if (!existsSync(file)) return match;
  scripts.push(readFileSync(file, 'utf8'));
  return '';
});
if (scripts.length !== 1) throw new Error(`expected one module script in the build, found ${scripts.length}`);

let styles = 0;
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="\.?\/?([^"]+\.css)"[^>]*>/g, (match, href: string) => {
  const file = resolve(BUILD, href);
  if (!existsSync(file)) return match;
  styles++;
  const css = readFileSync(file, 'utf8');
  return `<style>\n${css}\n</style>`;
});
if (styles !== 1) throw new Error(`expected one stylesheet in the build, found ${styles}`);

const payloads = {
  worker: packed(read(resolve(ROOT, 'public/tesseract/worker.min.js'))),
  core: packed(read(resolve(ROOT, 'public/tesseract', CORE))),
  // Already gzipped where it is vendored, so it ships exactly as it sits.
  lang: read(resolve(ROOT, 'vendor/tessdata/eng.traineddata.gz')).toString('base64'),
};

/**
 * The bootstrap, as a classic script so it runs before the deferred module.
 *
 * It only publishes a function: nothing is unpacked until the app actually asks
 * for OCR, so a review that never loads an image never pays for it.
 */
const bootstrap = `
<script>
(() => {
  const PACKED = {
    worker: "${payloads.worker}",
    core: "${payloads.core}",
    lang: "${payloads.lang}"
  };
  const bytes = (b64) => {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };
  const unpack = async (b64) => new Response(
    new Blob([bytes(b64)]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer();

  // The language data is fetched by a path the worker builds itself, so it is
  // intercepted rather than pointed somewhere else.
  const shim = 'self.__p2dLang=LANG_URL;(()=>{const f=self.fetch.bind(self);' +
    'self.fetch=(i,o)=>{const u=typeof i==="string"?i:(i&&i.url)||"";' +
    'return f(u.indexOf(".traineddata")>=0?self.__p2dLang:i,o);};})();\\n';

  let ready = null;
  window.p2dOcrAssets = () => (ready ??= (async () => {
    const [worker, core, lang] = await Promise.all([
      unpack(PACKED.worker),
      unpack(PACKED.core),
      unpack(PACKED.lang),
    ]);
    const langUrl = URL.createObjectURL(new Blob([lang], { type: 'application/octet-stream' }));
    // Core first: tesseract loads one only when TesseractCore is undefined, so
    // defining it here is what stops the worker asking a directory for it.
    const source = [
      new Uint8Array(core),
      '\\n;\\n',
      shim.replace('LANG_URL', JSON.stringify(langUrl)),
      new Uint8Array(worker),
    ];
    return {
      workerPath: URL.createObjectURL(new Blob(source, { type: 'text/javascript' })),
      // Unused - the core is already in the worker - but the option wants a string.
      corePath: 'embedded',
      langPath: '.',
    };
  })());
})();
</script>`;

const module = `<script type="module">\n${scripts[0]}\n</script>`;
const block = `${bootstrap}\n${module}\n`;
html = html.includes('</body>')
  ? html.replace('</body>', () => `${block}</body>`)
  : `${html}\n${block}`;

for (const piece of [scripts[0], payloads.worker, payloads.core, payloads.lang]) {
  if (!html.includes(piece)) throw new Error('a payload did not survive being spliced into the page');
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html);
const size = statSync(OUT).size;
console.log(`${OUT}\n${size} bytes (${(size / 1024 / 1024).toFixed(2)} MB)`);
