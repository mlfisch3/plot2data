/**
 * CSV export.
 *
 * The header records the calibration that produced the numbers and the
 * uncertainty that follows from the line thickness, and says plainly whether
 * the rows are real samples or a resampling of a drawn curve. Someone reading
 * the file a year later should be able to tell how much to trust it.
 */

import { describeAxis, formatValue } from './calibration.ts';
import type { Analysis } from './pipeline.ts';
import { writeXlsx, type Cell } from './xlsx.ts';
import type { Calibration, DataSeries } from './types.ts';

export const TOOL_VERSION = '0.1.0';

/** Delimiters offered by the UI. Anything else a caller passes is used as-is. */
export const DELIMITERS = {
  comma: ',',
  tab: '\t',
  semicolon: ';',
  pipe: '|',
} as const;

export type DelimiterName = keyof typeof DELIMITERS;

export interface CsvOptions {
  /** Decimal places for the data columns. */
  precision?: number;
  /** Source image file name, recorded in the header. */
  source?: string;
  calibration?: Calibration;
  /** Column separator. Defaults to a comma. */
  delimiter?: string;
  /**
   * Write the column names and the provenance comments. Off means numbers
   * only, for pasting straight into a sheet that already has its own headings.
   */
  header?: boolean;
}

function fmt(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential(precision);
  return String(Number(v.toFixed(precision)));
}

/**
 * Build the comment header. Everything a reader needs to sanity-check the file
 * without the original image is here: the mapping, the tick evidence behind it,
 * the uncertainty, and any warning still outstanding at export time.
 */
export function csvHeader(
  analysis: Analysis,
  series: DataSeries[],
  options: CsvOptions = {},
): string[] {
  const cal = options.calibration ?? analysis.calibration;
  const lines: string[] = [];
  lines.push(`# plot2data v${TOOL_VERSION} - values read from a plot image`);
  // The ranges below span the plot area, not the anchors, so they say what the
  // chart covers rather than restating the anchor values.
  if (options.source) lines.push(`# source: ${options.source}`);

  const modes = new Set(series.map((s) => s.mode));
  if (modes.has('marker')) {
    lines.push('# mode: marker - each row is a detected marker centroid, a real data point');
  }
  if (modes.has('curve')) {
    lines.push(
      '# mode: curve - rows are a RESAMPLING OF THE DRAWN CURVE, not the original sample points',
    );
  }

  const rect = analysis.frame.rect;
  lines.push(`# ${describeAxis(cal.x, 'x', analysis.units.x, [rect.x0, rect.x1])}`);
  lines.push(`# ${describeAxis(cal.y, 'y', analysis.units.y, [rect.y1, rect.y0])}`);
  lines.push(
    `# X1: pixel ${cal.x.a.px.toFixed(1)} = ${formatValue(cal.x.a.value)}, X2: pixel ${cal.x.b.px.toFixed(1)} = ${formatValue(cal.x.b.value)} (${cal.x.a.source})`,
  );
  lines.push(
    `# Y1: pixel ${cal.y.a.px.toFixed(1)} = ${formatValue(cal.y.a.value)}, Y2: pixel ${cal.y.b.px.toFixed(1)} = ${formatValue(cal.y.b.value)} (${cal.y.a.source})`,
  );
  if (cal.x.multiplier !== 1 || cal.x.offset !== 0) {
    lines.push(`# x annotation applied: multiplier ${cal.x.multiplier}, offset ${cal.x.offset}`);
  }
  if (cal.y.multiplier !== 1 || cal.y.offset !== 0) {
    lines.push(`# y annotation applied: multiplier ${cal.y.multiplier}, offset ${cal.y.offset}`);
  }

  for (const [name, axis] of [
    ['x', cal.x],
    ['y', cal.y],
  ] as const) {
    const fit = axis.scaleFit;
    if (!fit) continue;
    const residual = axis.scale === 'log' ? fit.logResidual : fit.linearResidual;
    lines.push(
      `# ${name} calibration: least-squares over ${fit.samples} read tick labels, residual ${
        residual === null ? 'n/a' : `${(residual * 100).toFixed(2)}% of range`
      }`,
    );
  }

  for (const s of series) {
    lines.push(`# ${s.name} uncertainty from line thickness: ${describeUncertainty(s)}`);
  }

  for (const w of analysis.warnings) {
    lines.push(`# ${w.level}: ${w.message}`);
  }
  return lines;
}

/**
 * Human-readable uncertainty for one series.
 *
 * On a log axis an absolute error is meaningless - the same pixel is worth a
 * hundred times more at the top of the axis than at the bottom - so the honest
 * figure there is the multiplicative one.
 */
export function describeUncertainty(s: DataSeries): string {
  const part = (absolute: number, relative: number | undefined, axis: string) =>
    relative === undefined
      ? `+/-${compact(absolute)} in ${axis}`
      : `x or / ${(1 + relative).toFixed(3)} in ${axis} (log axis)`;
  return `${part(s.uncertainty.x, s.uncertainty.xRelative, 'x')}, ${part(s.uncertainty.y, s.uncertainty.yRelative, 'y')}`;
}

/** Three significant figures; uncertainty never deserves more. */
export function compact(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
  return String(Number(v.toPrecision(3)));
}

/**
 * The numeric table behind every export format.
 *
 * Curve series share one resample grid, so they line up in one table under a
 * single x column. Marker series have their own x positions - those are real
 * sample points, and putting them on a shared grid would be an invention - so
 * each gets its own pair of columns.
 */
export function toTable(series: DataSeries[]): { columns: string[]; rows: Array<Array<number | null>> } {
  if (series.length === 0) return { columns: [], rows: [] };

  const shared =
    series.every((s) => s.mode === 'curve') &&
    series.every((s) => s.points.length === series[0].points.length) &&
    series.every((s) => s.points.every((p, i) => Math.abs(p.x - series[0].points[i].x) < 1e-9));

  if (shared) {
    const columns = ['x', ...series.map((s) => s.name)];
    const rows = series[0].points.map((_, i) => [
      cellOf(series[0].points[i].x),
      ...series.map((s) => cellOf(s.points[i].y)),
    ]);
    return { columns, rows };
  }

  const columns: string[] = [];
  for (const s of series) columns.push(`${s.name}_x`, `${s.name}_y`);
  const height = Math.max(...series.map((s) => s.points.length));
  const rows: Array<Array<number | null>> = [];
  for (let i = 0; i < height; i++) {
    const row: Array<number | null> = [];
    for (const s of series) {
      const p = s.points[i];
      row.push(p ? cellOf(p.x) : null, p ? cellOf(p.y) : null);
    }
    rows.push(row);
  }
  return { columns, rows };
}

/** A value the grid ran past is a blank cell, not a zero and not a NaN. */
function cellOf(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/** Serialise series to delimited text. */
export function toCsv(analysis: Analysis, series: DataSeries[], options: CsvOptions = {}): string {
  const precision = options.precision ?? 6;
  const delimiter = options.delimiter ?? DELIMITERS.comma;
  const withHeader = options.header ?? true;
  const lines: string[] = withHeader ? csvHeader(analysis, series, options) : [];
  const table = toTable(series);
  if (table.columns.length === 0) return `${lines.join('\n')}\n`;

  if (withHeader) lines.push(table.columns.map((c) => quote(c, delimiter)).join(delimiter));
  for (const row of table.rows) {
    lines.push(row.map((v) => (v === null ? '' : fmt(v, precision))).join(delimiter));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Quote a field that would otherwise break the delimiter.
 *
 * Only names can need this - a formatted number never contains a separator -
 * but a user may call a series anything at all, including "sales, net".
 */
function quote(value: string, delimiter: string): string {
  if (!value.includes(delimiter) && !/["\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Serialise to a real `.xlsx` workbook.
 *
 * The numbers go on the first sheet as numbers, not as text, so a chart drawn
 * from them works straight away. The provenance that heads the CSV goes on a
 * second sheet rather than above the table, because rows of prose over a data
 * table is exactly what makes a spreadsheet awkward to use.
 */
export function toXlsx(analysis: Analysis, series: DataSeries[], options: CsvOptions = {}): Uint8Array {
  const withHeader = options.header ?? true;
  const table = toTable(series);
  const data: Cell[][] = [];
  if (withHeader && table.columns.length) data.push(table.columns);
  for (const row of table.rows) data.push(row);
  if (data.length === 0) data.push(['no series were selected']);

  const sheets = [{ name: 'data', rows: data }];
  if (withHeader) {
    sheets.push({
      name: 'plot2data',
      rows: csvHeader(analysis, series, options).map((line) => [line.replace(/^# /, '')]),
    });
  }
  return writeXlsx(sheets);
}
