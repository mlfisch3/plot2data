/**
 * Copy the Android web bundle into the app's assets.
 *
 * `dist-android/` is the same app as `dist/`, built as ES modules because the
 * WebView serves it from an https asset-loader origin rather than `file://`.
 * The copy is generated, never committed: the bundle has exactly one home in
 * the repository, which is `src/`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = resolve(ROOT, 'dist-android');
const TO = resolve(ROOT, 'android/app/src/main/assets');

if (!existsSync(FROM)) {
  console.error(`missing ${FROM} - run \`P2D_ANDROID=1 vite build\` first`);
  process.exit(1);
}
if (!existsSync(join(FROM, 'index.html'))) {
  console.error(`${FROM} has no index.html; the build did not produce a page`);
  process.exit(1);
}

rmSync(TO, { recursive: true, force: true });
mkdirSync(TO, { recursive: true });
cpSync(FROM, TO, { recursive: true });

function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = measure(path);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

const { files, bytes } = measure(TO);
console.log(`synced ${files} file(s), ${(bytes / 1e6).toFixed(1)} MB into android/app/src/main/assets/`);
