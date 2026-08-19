/**
 * A minimal `.xlsx` writer.
 *
 * "Export to Excel" honestly read means a real workbook, not a CSV with the
 * extension changed - that opens with a warning, loses the second sheet, and is
 * a lie about the format. An xlsx is a zip of a few small XML parts, and zip
 * entries may be *stored* rather than deflated, so the whole format costs one
 * CRC table and a couple of headers. That is cheaper than a dependency, and it
 * keeps the engine dependency-free and the bundle offline.
 *
 * The cost of storing rather than deflating is size: the file is about as big
 * as the XML inside it. For a few thousand rows of numbers that is well under a
 * megabyte, and it never leaves the device anyway.
 */

/** A cell value. `null` writes an empty cell rather than a zero. */
export type Cell = number | string | null;

export interface Sheet {
  /** Tab name. Excel forbids `[]:*?/\` and more than 31 characters. */
  name: string;
  rows: Cell[][];
}

/** Build a workbook. The result is the bytes of an `.xlsx` file. */
export function writeXlsx(sheets: Sheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('a workbook needs at least one sheet');
  const parts: Array<{ name: string; data: Uint8Array }> = [
    { name: '[Content_Types].xml', data: utf8(contentTypes(sheets.length)) },
    { name: '_rels/.rels', data: utf8(rootRels()) },
    { name: 'xl/workbook.xml', data: utf8(workbook(sheets)) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels(sheets.length)) },
  ];
  sheets.forEach((sheet, i) => {
    parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(worksheet(sheet)) });
  });
  return zip(parts);
}

/* ------------------------------------------------------------------- xml */

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function contentTypes(sheetCount: number): string {
  const overrides = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    `${DECL}<Types xmlns="${NS_CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    `${overrides}</Types>`
  );
}

function rootRels(): string {
  return (
    `${DECL}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>'
  );
}

function workbook(sheets: Sheet[]): string {
  const tabs = sheets
    .map((s, i) => `<sheet name="${escapeXml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return `${DECL}<workbook xmlns="${NS}" xmlns:r="${NS_REL}"><sheets>${tabs}</sheets></workbook>`;
}

function workbookRels(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return `${DECL}<Relationships xmlns="${NS_PKG_REL}">${rels}</Relationships>`;
}

function worksheet(sheet: Sheet): string {
  const rows = sheet.rows
    .map((cells, r) => {
      const body = cells
        .map((value, c) => {
          if (value === null || value === '') return '';
          const ref = `${columnName(c)}${r + 1}`;
          if (typeof value === 'number') {
            // Excel has no way to write NaN or an infinity as a number, and an
            // empty cell is the honest reading of "no value here".
            if (!Number.isFinite(value)) return '';
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${body}</row>`;
    })
    .join('');
  return `${DECL}<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`;
}

/** `0 -> A`, `26 -> AA`, as Excel names its columns. */
export function columnName(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Excel rejects these outright, so a series name cannot be trusted as a tab. */
function sheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31);
  return cleaned.trim() || 'Sheet';
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}

/* ------------------------------------------------------------------- zip */

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Pack parts into a zip with every entry stored uncompressed.
 *
 * Timestamps are fixed at the epoch the zip format starts from. A real clock
 * would make two exports of the same data differ byte for byte, which costs a
 * test its simplest assertion and buys nothing: the workbook records when the
 * numbers were read in its own provenance sheet, not in file metadata.
 */
function zip(parts: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const DOS_TIME = 0;
  const DOS_DATE = 33; // 1 January 1980, the earliest the format can express.
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const part of parts) {
    const name = utf8(part.name);
    const crc = crc32(part.data);
    const local = new Uint8Array(30 + name.length + part.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, part.data.length, true);
    lv.setUint32(22, part.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(part.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, part.data.length, true);
    cv.setUint32(24, part.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const chunks = [...locals, ...centrals, end];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
