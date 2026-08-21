/**
 * Folds the built script and stylesheet into `dist/index.html`.
 *
 * Chrome enforces CORS on module scripts and on subresources of a `file://`
 * page, so a bundle that loads its JS and CSS as separate files simply does not
 * run when the HTML is opened from the filesystem. Inlining them makes the
 * built app one self-contained page that works from `file://` and from any
 * static host alike.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const indexPath = resolve(DIST, 'index.html');
let html = readFileSync(indexPath, 'utf8');
const consumed: string[] = [];
const scripts: string[] = [];

html = html.replace(
  /<script[^>]*src="\.?\/?([^"]+\.js)"[^>]*><\/script>/g,
  (_match, src: string) => {
    const file = resolve(DIST, src);
    if (!existsSync(file)) return _match;
    consumed.push(file);
    scripts.push(readFileSync(file, 'utf8'));
    return '';
  },
);

html = html.replace(
  /<link[^>]*rel="stylesheet"[^>]*href="\.?\/?([^"]+\.css)"[^>]*>/g,
  (_match, href: string) => {
    const file = resolve(DIST, href);
    if (!existsSync(file)) return _match;
    consumed.push(file);
    return `<style>\n${readFileSync(file, 'utf8')}\n</style>`;
  },
);

// The original tag sits in <head> and was a *module*, so it ran deferred.
// An inline classic script runs where it is written, so it has to move to the
// end of the body or it executes before the elements it looks for exist.
if (scripts.length > 0) {
  const block = scripts.map((code) => `<script>\n${code}\n</script>`).join('\n');
  // A *function* replacement, because `String.replace` expands `$&`, `` $` ``
  // and `$'` inside a string replacement - and a minified bundle is full of
  // those sequences. One of them spliced the whole page into the middle of the
  // script and the file:// build stopped parsing at all, silently, because
  // nothing else in the build looks at what came out.
  html = html.includes('</body>')
    ? html.replace('</body>', () => `${block}\n</body>`)
    : `${html}\n${block}`;
  for (const code of scripts) {
    if (!html.includes(code)) {
      throw new Error('the inlined script does not match the bundle it came from');
    }
  }
}

writeFileSync(indexPath, html);
for (const file of consumed) rmSync(file, { force: true });
console.log(`inlined ${consumed.length} asset(s) into dist/index.html`);
