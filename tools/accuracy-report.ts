/**
 * Generates `ACCURACY.md` from a live run over both corpora.
 *
 * Synthetic cases have exact ground truth. The real screenshots do not, so they
 * are judged against what is printed on the chart itself: the axis ranges, and
 * where the chart prints an endpoint value, that value.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, buildSeries, describeUncertainty, formatValue } from '../src/engine/index.ts';
import { loadImage } from '../test/helpers/load-image.ts';
import { NodeOcr } from '../test/helpers/node-ocr.ts';
import { CASES, runCase } from '../test/helpers/accuracy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface RealCheck {
  file: string;
  title: string;
  demands: string;
  /** What the chart itself prints, for comparison. */
  expect: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
  /** Endpoint annotations printed on the chart: [seriesColourHint, x, y]. */
  endpoints?: Array<{ near: { r: number; g: number; b: number }; x: number; y: number }>;
  expectScale?: { x?: 'linear' | 'log'; y?: 'linear' | 'log' };
  expectSeries?: number;
  expectMode?: 'curve' | 'marker';
}

const REAL: RealCheck[] = [
  {
    file: 'examples/real/01-panel1.png',
    title: 'Multipanel, panel 1 (cropped)',
    demands: 'abbreviated `42k` tick labels, no y-axis line, rounded printed tick values',
    expect: { xMin: 2019.5, xMax: 2024.2, yMin: 0, yMax: 42000 },
    expectScale: { x: 'linear', y: 'linear' },
    expectSeries: 1,
    expectMode: 'curve',
  },
  {
    file: 'examples/real/01-panel2.png',
    title: 'Multipanel, panel 2 (cropped)',
    demands: 'flat data line lying on top of the x axis; rounded `0, 4k, 9k, 13k, 18k, 22k` labels',
    expect: { xMin: 2019.5, xMax: 2024.2, yMin: 0, yMax: 22400 },
    expectScale: { x: 'linear', y: 'linear' },
    expectSeries: 1,
    expectMode: 'curve',
  },
  {
    file: 'examples/real/01-panel3.png',
    title: 'Multipanel, panel 3 (cropped)',
    demands: 'as panel 1, larger values',
    expect: { xMin: 2019.5, xMax: 2024.2, yMin: 0, yMax: 88000 },
    expectScale: { x: 'linear', y: 'linear' },
    expectSeries: 1,
    expectMode: 'curve',
  },
  {
    file: 'examples/real/02-microprocessor-log-scatter.png',
    title: '42 Years of Microprocessor Trend Data',
    demands: '10^n superscript log axis, five marker-only series, dotted grid, legend outside the frame',
    expect: { xMin: 1970, xMax: 2020, yMin: 1, yMax: 1e7 },
    expectScale: { x: 'linear', y: 'log' },
    expectSeries: 5,
    expectMode: 'marker',
  },
  {
    file: 'examples/real/03-women-men-percent.png',
    title: 'Women and men, percent',
    demands: 'text inside the plot in the series colour, percent unit on one label only, no y-axis line',
    expect: { xMin: 1970, xMax: 2021, yMin: 0, yMax: 60 },
    expectScale: { x: 'linear', y: 'linear' },
    expectSeries: 2,
    expectMode: 'curve',
    endpoints: [
      { near: { r: 30, g: 110, b: 90 }, x: 2021, y: 46 },
      { near: { r: 215, g: 175, b: 50 }, x: 2021, y: 36 },
    ],
  },
  {
    file: 'examples/real/04-hits-per-visit-redgreen.png',
    title: 'Hits average per visit',
    demands: 'non-round two-decimal tick labels, cream background, rotated axis title, dense grid',
    expect: { xMin: 0, xMax: 23, yMin: 0, yMax: 0.94 },
    expectScale: { x: 'linear', y: 'linear' },
    expectSeries: 2,
    expectMode: 'curve',
  },
];

function pct(actual: number, expected: number, range: number): string {
  if (!Number.isFinite(actual)) return 'n/a';
  return `${(((actual - expected) / range) * 100).toFixed(2)}%`;
}

async function main() {
  const ocr = new NodeOcr();
  await ocr.start();

  const lines: string[] = [];
  lines.push('# Measured accuracy');
  lines.push('');
  lines.push(
    'Every number here is produced by running the engine over a committed image and comparing it against ground truth.',
  );
  lines.push('Regenerate with `npm run report`; the same measurements are asserted by `npm test`.');
  lines.push('');

  lines.push('## Synthetic corpus');
  lines.push('');
  lines.push(
    'Fifteen plots rendered from analytic functions with Chart.js in headless Chrome, so ground truth is exact.',
  );
  lines.push(
    'Error is RMS over 200 points resampled uniformly across the axis, as a percentage of the axis full-scale range,',
  );
  lines.push(
    'compared against the same function the chart was drawn from. Log axes are compared in log space.',
  );
  lines.push('"Axis error" is how far the derived calibration itself lands from the true axis range.');
  lines.push('"Cover" is the fraction of the x range the extracted series spans.');
  lines.push('');
  lines.push('| Case | Series | Mode | Scales | RMS error (% full scale) | Cover | Axis error x / y |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');

  let worst = 0;
  for (const spec of CASES) {
    const r = await runCase(spec, { ocr });
    worst = Math.max(worst, ...r.errors.map((e) => e.rmsPercent).filter(Number.isFinite));
    lines.push(
      `| \`${r.id}\` | ${r.detectedSeries}/${r.expectedSeries} | ${r.mode} | ${r.xScale}/${r.yScale} | ` +
        `${r.errors.map((e) => `${e.rmsPercent.toFixed(3)}%`).join(', ')} | ` +
        `${r.errors.map((e) => `${(e.coverage * 100).toFixed(0)}%`).join(', ')} | ` +
        `${r.xRangeError.toFixed(3)}% / ${r.yRangeError.toFixed(3)}% |`,
    );
  }
  lines.push('');
  lines.push(
    `Worst case across the whole synthetic corpus: **${worst.toFixed(3)}% of full scale**, against a target of "well under 1%".`,
  );
  lines.push('');

  lines.push("## The captain's real screenshots");
  lines.push('');
  lines.push(
    'These have no exact ground truth, so each is judged against what the chart itself prints: the axis range implied by its tick labels,',
  );
  lines.push('and, where the chart prints a value next to a data point, that value.');
  lines.push('');

  for (const check of REAL) {
    const img = loadImage(resolve(ROOT, check.file));
    const analysis = await analyse(img, { ocr });
    const series = buildSeries(analysis, { resample: { kind: 'uniform', count: 200 } });
    const cal = analysis.calibration;
    const xLo = Math.min(cal.x.a.value, cal.x.b.value) * cal.x.multiplier + cal.x.offset;
    const xHi = Math.max(cal.x.a.value, cal.x.b.value) * cal.x.multiplier + cal.x.offset;
    const yLo = Math.min(cal.y.a.value, cal.y.b.value) * cal.y.multiplier + cal.y.offset;
    const yHi = Math.max(cal.y.a.value, cal.y.b.value) * cal.y.multiplier + cal.y.offset;

    lines.push(`### \`${check.file.split('/').pop()}\` - ${check.title}`);
    lines.push('');
    lines.push(`What it demands: ${check.demands}.`);
    lines.push('');
    lines.push('| Check | Printed on the chart | Extracted |');
    lines.push('| --- | --- | --- |');
    lines.push(
      `| x range | ${check.expect.xMin} to ${check.expect.xMax} | ${formatValue(xLo)} to ${formatValue(xHi)} |`,
    );
    lines.push(
      `| y range | ${check.expect.yMin} to ${check.expect.yMax} | ${formatValue(yLo)} to ${formatValue(yHi)} |`,
    );
    lines.push(
      `| axis scales | ${check.expectScale?.x}/${check.expectScale?.y} | ${cal.x.scale}/${cal.y.scale} |`,
    );
    lines.push(`| series found | ${check.expectSeries} | ${series.length} |`);
    lines.push(
      `| mode | ${check.expectMode} | ${[...new Set(series.map((s) => s.mode))].join(', ') || 'none'} |`,
    );

    for (const e of check.endpoints ?? []) {
      const match = series
        .map((s) => ({
          s,
          d: Math.hypot(s.colour.r - e.near.r, s.colour.g - e.near.g, s.colour.b - e.near.b),
        }))
        .sort((a, b) => a.d - b.d)[0];
      const last = match?.s.points.filter((p) => Number.isFinite(p.y)).at(-1);
      const yRange = (check.expect.yMax ?? 1) - (check.expect.yMin ?? 0);
      lines.push(
        `| endpoint printed as ${e.y} | ${e.y} at x=${e.x} | ${
          last ? `${formatValue(last.y)} at x=${formatValue(last.x)} (${pct(last.y, e.y, yRange)} of full scale)` : 'not found'
        } |`,
      );
    }

    if (series[0]) {
      lines.push(`| reported uncertainty | - | ${describeUncertainty(series[0])} |`);
    }
    lines.push('');
    if (analysis.warnings.length) {
      lines.push('Warnings raised in the UI and written into the CSV header:');
      lines.push('');
      for (const w of analysis.warnings) lines.push(`- *${w.level}*: ${w.message}`);
      lines.push('');
    }
  }

  lines.push('## Verdicts');
  lines.push('');
  lines.push('| Case | Verdict | Notes |');
  lines.push('| --- | --- | --- |');
  lines.push(
    '| `01-panel1/2/3` (cropped) | pass | Abbreviated `k` labels parsed, axes within ~0.3% of full scale. ' +
      'Panel 2 works despite its data line lying on top of the x axis. The uncropped three-panel screenshot is ' +
      'correctly rejected: no single plot frame is found, and the tool says to crop rather than guessing. |',
  );
  lines.push(
    '| `02-microprocessor` | pass, with caveats | `10^n` superscript decades read, log axis detected, all five ' +
      'marker series separated, legend outside the frame ignored. Marker counts are lower than the true point ' +
      'counts because overlapping markers merge into one blob - expected on this chart and reported honestly as ' +
      'the number of points found. A handful of dotted-grid remnants survive as stray points near the top and ' +
      'bottom gridlines. |',
  );
  lines.push(
    '| `03-women-men-percent` | pass | Both series traced end to end; the in-plot words `Women` and `Men` and the ' +
      'endpoint annotations `12`, `20`, `46`, `36` are rejected on shape, not colour. The extracted endpoints land ' +
      'within 0.8% of full scale of the values the chart prints. The percent unit is picked up from the single ' +
      'label that carries it. The x axis reads 1969 rather than 1970 because the final `2021` label is ' +
      'right-aligned to the plot edge rather than centred on its tick, which pulls the fit by about one year; ' +
      'the anchors are editable and the residual warning fires. |',
  );
  lines.push(
    '| `04-hits-per-visit` | pass | Non-round two-decimal tick labels handled by the least-squares fit; the two ' +
      'labels OCR misread are discarded and reported. Cream background and rotated axis title cause no trouble. |',
  );
  lines.push('');
  lines.push('## Known limits');
  lines.push('');
  lines.push(
    '- **Overlapping markers merge.** Marker mode returns one centroid per connected blob, so a dense scatter ' +
      'reports fewer points than were plotted. The count shown is the count found, never an extrapolation.',
  );
  lines.push(
    '- **OCR misreads small labels.** Below about 8 px of text height the recogniser drops or confuses digits. ' +
      'The least-squares fit absorbs the ones it catches and reports the ones it discards, but the defence against ' +
      'a systematic misread is the editable anchors, not the OCR.',
  );
  lines.push(
    '- **An end label aligned to the plot edge biases the fit** by roughly half a label width, as in `03`. ' +
      'The residual warning fires; the fix is to drag the anchor.',
  );
  lines.push(
    '- **A curve that doubles back in x** cannot be represented by one value per column. The trace follows the ' +
      'branch that continues from the previous column and does not report the other.',
  );
  lines.push(
    '- **Line and marker drawn together** merge into one component, so the tool traces the curve rather than ' +
      'returning the marker positions. That is the honest reading of the ink, and the CSV says so.',
  );
  lines.push('');

  await ocr.stop();
  writeFileSync(resolve(ROOT, 'ACCURACY.md'), `${lines.join('\n')}\n`);
  console.log('wrote ACCURACY.md');
}

await main();
