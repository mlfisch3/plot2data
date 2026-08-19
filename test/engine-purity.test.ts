/**
 * The engine must stay DOM-free and dependency-free.
 *
 * The Android wrapper reuses `src/engine` unchanged and the whole accuracy
 * suite runs it under Node, so a stray `document` or a pulled-in browser
 * library would break both. Cheap to check, expensive to discover later.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ENGINE = resolve(import.meta.dirname, '../src/engine');
const files = readdirSync(ENGINE).filter((f) => f.endsWith('.ts'));

const FORBIDDEN = [
  'document',
  'window',
  'HTMLCanvasElement',
  'createImageBitmap',
  'OffscreenCanvas',
  'navigator',
  'localStorage',
  'fetch(',
];

describe('engine purity', () => {
  it('has source files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file} touches no DOM API`, () => {
      const source = readFileSync(resolve(ENGINE, file), 'utf8')
        // Comments may name these APIs when explaining why they are absent.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const symbol of FORBIDDEN) {
        expect(source, `${file} must not use ${symbol}`).not.toContain(symbol);
      }
    });

    it(`${file} imports nothing outside the engine`, () => {
      const source = readFileSync(resolve(ENGINE, file), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec.startsWith('./'), `${file} imports ${spec}`).toBe(true);
      }
    });
  }
});
