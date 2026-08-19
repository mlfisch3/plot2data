/**
 * The export formats.
 *
 * The xlsx tests read the produced bytes back rather than trusting them: a
 * workbook that only *looks* like a zip is exactly the failure mode a
 * hand-written writer has, and it would show up on the captain's desk rather
 * than here.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { analyse, buildSeries, toCsv, toTable, toXlsx, writeXlsx, columnName } from '../src/engine/index.ts';
import type { Analysis } from '../src/engine/pipeline.ts';
import { loadImage } from './helpers/load-image.ts';

let cached: Analysis | null = null;

async function fixture(): Promise<Analysis> {
  if (!cached) {
    cached = await analyse(loadImage(resolve(import.meta.dirname, '../corpus/linear-multi.png')), {
      ocr: null,
    });
  }
  return cached;
}

/** Read a stored (uncompressed) zip back, by name. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the end-of-central-directory record from the back.
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  expect(end, 'no end-of-central-directory record').toBeGreaterThanOrEqual(0);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);

  const out = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    const size = view.getUint32(at + 24, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(offset, true), `${name} local header`).toBe(0x04034b50);
    const localNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + localNameLength + extraLength;
    out.set(name, decoder.decode(bytes.subarray(start, start + size)));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

describe('csv', () => {
  it('shares one x column across curve series', async () => {
    const a = await fixture();
    const table = toTable(buildSeries(a, { resample: { kind: 'uniform', count: 50 } }));
    expect(table.columns[0]).toBe('x');
    expect(table.columns).toHaveLength(1 + a.series.length);
    expect(table.rows).toHaveLength(50);
  });

  it('honours the delimiter', async () => {
    const a = await fixture();
    const series = buildSeries(a, { resample: { kind: 'uniform', count: 5 } });
    for (const [delimiter, name] of [
      [',', 'comma'],
      ['\t', 'tab'],
      [';', 'semicolon'],
      ['|', 'pipe'],
    ] as const) {
      const body = toCsv(a, series, { delimiter })
        .split('\n')
        .filter((l) => l && !l.startsWith('#'));
      expect(body[0].split(delimiter), name).toHaveLength(1 + a.series.length);
      expect(body[1].split(delimiter), name).toHaveLength(1 + a.series.length);
    }
  });

  it('quotes a name that would break the delimiter', async () => {
    const a = await fixture();
    const series = buildSeries(a, {
      resample: { kind: 'uniform', count: 3 },
      names: ['sales, net', 'b', 'c'],
    });
    const line = toCsv(a, series, { delimiter: ',' })
      .split('\n')
      .find((l) => l.startsWith('x,'))!;
    expect(line).toContain('"sales, net"');
    // The same name needs no quoting once the delimiter is a tab.
    const tabbed = toCsv(a, series, { delimiter: '\t' })
      .split('\n')
      .find((l) => l.startsWith('x\t'))!;
    expect(tabbed).toContain('sales, net');
    expect(tabbed).not.toContain('"');
  });

  it('drops the header row and the comments together when asked', async () => {
    const a = await fixture();
    const series = buildSeries(a, { resample: { kind: 'uniform', count: 4 } });
    const bare = toCsv(a, series, { header: false });
    expect(bare.startsWith('#')).toBe(false);
    expect(bare).not.toContain('plot2data v');
    expect(bare.trim().split('\n')).toHaveLength(4);
    const full = toCsv(a, series, { header: true });
    expect(full).toContain('# plot2data v');
    expect(full).toContain('\nx,');
  });

  it('names the anchors X1/X2 and Y1/Y2 in the header', async () => {
    const a = await fixture();
    const header = toCsv(a, buildSeries(a, { resample: { kind: 'uniform', count: 2 } }));
    expect(header).toMatch(/# X1: pixel .* X2: pixel /);
    expect(header).toMatch(/# Y1: pixel .* Y2: pixel /);
  });

  it('leaves a cell blank where a series does not reach', async () => {
    const a = await fixture();
    const series = buildSeries(a, { resample: { kind: 'uniform', count: 40 } });
    // Truncate one series so the shared grid runs past its end.
    series[1].points = series[1].points.map((p, i) => (i > 30 ? { x: p.x, y: NaN } : p));
    const rows = toCsv(a, series).split('\n').filter((l) => l && !l.startsWith('#'));
    expect(rows[rows.length - 1].split(',')[2]).toBe('');
  });
});

describe('xlsx', () => {
  it('names columns the way Excel does', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });

  it('writes a readable package with the parts Excel needs', () => {
    const files = unzip(writeXlsx([{ name: 'data', rows: [['a', 1], ['b', 2.5]] }]));
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]) {
      expect(files.has(part), part).toBe(true);
    }
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="B2"><v>2.5</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">b</t>');
  });

  it('writes numbers as numbers and blanks as blanks', async () => {
    const a = await fixture();
    const series = buildSeries(a, { resample: { kind: 'uniform', count: 6 } });
    series[0].points[2] = { x: series[0].points[2].x, y: NaN };
    const sheet = unzip(toXlsx(a, series)).get('xl/worksheets/sheet1.xml')!;
    // Row 1 is the column names, so the third data row is row 4.
    expect(sheet).toContain('<row r="4">');
    expect(sheet).not.toContain('NaN');
    expect(sheet).not.toContain('t="inlineStr"><is><t xml:space="preserve">0');
  });

  it('puts the provenance on its own sheet, under the header toggle', async () => {
    const a = await fixture();
    const series = buildSeries(a, { resample: { kind: 'uniform', count: 3 } });
    const withHeader = unzip(toXlsx(a, series, { header: true }));
    expect(withHeader.get('xl/workbook.xml')).toContain('name="plot2data"');
    expect(withHeader.get('xl/worksheets/sheet2.xml')).toContain('plot2data v');
    const bare = unzip(toXlsx(a, series, { header: false }));
    expect(bare.has('xl/worksheets/sheet2.xml')).toBe(false);
    expect(bare.get('xl/worksheets/sheet1.xml')).not.toContain('inlineStr');
  });

  it('sanitises a sheet name Excel would reject', () => {
    const files = unzip(writeXlsx([{ name: 'a/b[c]:d*e?f'.repeat(4), rows: [[1]] }]));
    const name = /name="([^"]*)"/.exec(files.get('xl/workbook.xml')!)![1];
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });
});
