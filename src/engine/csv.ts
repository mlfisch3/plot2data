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
import type { Calibration, DataSeries } from './types.ts';

export const TOOL_VERSION = '0.1.0';

export interface CsvOptions {
  /** Decimal places for the data columns. */
  precision?: number;
  /** Source image file name, recorded in the header. */
  source?: string;
  calibration?: Calibration;
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

  lines.push(`# ${describeAxis(cal.x, 'x', analysis.units.x)}`);
  lines.push(`# ${describeAxis(cal.y, 'y', analysis.units.y)}`);
  lines.push(
    `# x anchors: pixel ${cal.x.a.px.toFixed(1)} = ${formatValue(cal.x.a.value)}, pixel ${cal.x.b.px.toFixed(1)} = ${formatValue(cal.x.b.value)} (${cal.x.a.source})`,
  );
  lines.push(
    `# y anchors: pixel ${cal.y.a.px.toFixed(1)} = ${formatValue(cal.y.a.value)}, pixel ${cal.y.b.px.toFixed(1)} = ${formatValue(cal.y.b.value)} (${cal.y.a.source})`,
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
 * Serialise series to CSV on a shared x grid.
 *
 * Curve-mode series share the resample grid so they line up in one table.
 * Marker-mode series have their own x positions, so each gets its own x column.
 */
export function toCsv(analysis: Analysis, series: DataSeries[], options: CsvOptions = {}): string {
  const precision = options.precision ?? 6;
  const lines = csvHeader(analysis, series, options);
  if (series.length === 0) return `${lines.join('\n')}\n`;

  const shared =
    series.every((s) => s.mode === 'curve') &&
    series.every((s) => s.points.length === series[0].points.length) &&
    series.every((s) => s.points.every((p, i) => Math.abs(p.x - series[0].points[i].x) < 1e-9));

  if (shared) {
    lines.push(['x', ...series.map((s) => s.name)].join(','));
    for (let i = 0; i < series[0].points.length; i++) {
      lines.push(
        [fmt(series[0].points[i].x, precision), ...series.map((s) => fmt(s.points[i].y, precision))].join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  const header: string[] = [];
  for (const s of series) header.push(`${s.name}_x`, `${s.name}_y`);
  lines.push(header.join(','));
  const rows = Math.max(...series.map((s) => s.points.length));
  for (let i = 0; i < rows; i++) {
    const cells: string[] = [];
    for (const s of series) {
      const p = s.points[i];
      cells.push(p ? fmt(p.x, precision) : '', p ? fmt(p.y, precision) : '');
    }
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}
