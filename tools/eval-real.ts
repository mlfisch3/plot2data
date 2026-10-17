/**
 * Headless evaluation over `examples/real/`.
 *
 * For every file in the acceptance set the engine is run end to end, an overlay
 * image is rendered to `tools/eval-output/`, and a per-image JSON report is
 * written alongside it. The report is the thing the accuracy work is judged by:
 * axis-position error, peak shortfall, series counts, warnings.
 *
 * This is a tool, not a test. It does not fail; it measures. The accuracy
 * suite is what fails a build on a regression.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  analyse,
  buildSeries,
  valueToPixel,
  type Analysis,
  type AnalyseOptions,
  type Calibration,
  type DataSeries,
  type ImageBuffer,
  type RGB,
} from '../src/engine/index.ts';
import { loadImage } from '../test/helpers/load-image.ts';
import { NodeOcr } from '../test/helpers/node-ocr.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'tools/eval-output');

interface Expectation {
  file: string;
  title: string;
  /** Whole image, or a crop? Used to decide whether to try auto-detect. */
  cropped: boolean;
  axis?: { xMin: number; xMax: number; yMin: number; yMax: number };
  xScale?: 'linear' | 'log';
  yScale?: 'linear' | 'log';
  /**
   * Known tick values whose pixel positions are measured by hand in the image.
   * These are the authoritative points the axis-position error is measured on.
   * Positions were taken from the printed tick labels and double-checked by
   * reading the image: a tick on an axis spine with a label beneath/beside it
   * is unambiguous to a pixel.
   */
  xAnchors?: Array<{ value: number; px: number }>;
  yAnchors?: Array<{ value: number; py: number }>;
  /** Measure peaks against the drawn ink. */
  measureSpikes?: boolean;
}

/**
 * Expectations. Axis anchor pixel positions were taken by inspecting the images
 * at native pixel resolution against the tick labels printed on them.
 *
 * `03-women-men-percent.png` is the one the "1969 vs 1970" defect lives on and
 * is the explicit tightening target for Part 3; its y-axis has no spine, so
 * the tick positions are the label-blob centres and are deliberately checked
 * at four values to pin the fit.
 */
const EXPECTATIONS: Expectation[] = [
  {
    file: '01-panel1.png',
    title: 'Panel 1 (cropped)',
    cropped: true,
    axis: { xMin: 2019.5, xMax: 2024.2, yMin: 0, yMax: 42000 },
    xScale: 'linear',
    yScale: 'linear',
    // Label-blob centres measured from the pixels: no spine or tick, so the
    // label text's own centre is the published tick position.
    xAnchors: [
      { value: 2020, px: 69 },
      { value: 2021, px: 117 },
      { value: 2022, px: 166 },
      { value: 2023, px: 215 },
      { value: 2024, px: 263 },
    ],
    yAnchors: [
      { value: 42000, py: 19 },
      { value: 34000, py: 45 },
      { value: 25000, py: 71 },
      { value: 17000, py: 98 },
      { value: 8000, py: 124 },
    ],
  },
  {
    file: '01-panel2.png',
    title: 'Panel 2 (cropped)',
    cropped: true,
    axis: { xMin: 2019.5, xMax: 2024.2, yMin: 0, yMax: 22400 },
    xScale: 'linear',
    yScale: 'linear',
    xAnchors: [
      { value: 2020, px: 79 },
      { value: 2021, px: 127 },
      { value: 2022, px: 176 },
      { value: 2023, px: 225 },
      { value: 2024, px: 273 },
    ],
    yAnchors: [
      { value: 22000, py: 19 },
      { value: 18000, py: 45 },
      { value: 13000, py: 71 },
      { value: 9000, py: 98 },
      { value: 4000, py: 124 },
    ],
  },
  {
    file: '01-panel3.png',
    title: 'Panel 3 (cropped)',
    cropped: true,
    axis: { xMin: 2019.5, xMax: 2024.2, yMin: 0, yMax: 88000 },
    xScale: 'linear',
    yScale: 'linear',
    xAnchors: [
      { value: 2020, px: 74 },
      { value: 2021, px: 122 },
      { value: 2022, px: 171 },
      { value: 2023, px: 220 },
      { value: 2024, px: 268 },
    ],
    yAnchors: [
      { value: 88000, py: 19 },
      { value: 70000, py: 45 },
      { value: 53000, py: 71 },
      { value: 35000, py: 98 },
      { value: 18000, py: 124 },
    ],
  },
  {
    file: '02-microprocessor-log-scatter.png',
    title: '42 Years of Microprocessor Trend Data',
    cropped: true,
    axis: { xMin: 1970, xMax: 2020, yMin: 1, yMax: 1e7 },
    xScale: 'linear',
    yScale: 'log',
  },
  {
    file: '03-women-men-percent.png',
    title: 'Women vs Men, percent',
    cropped: true,
    axis: { xMin: 1970, xMax: 2021, yMin: 0, yMax: 60 },
    xScale: 'linear',
    yScale: 'linear',
    // Decade labels centred on their ticks. "2021" at the far right is
    // right-aligned to the plot edge, so its text centre sits a few pixels
    // left of its true tick position. That is the exact bias Part 3 fixes.
    xAnchors: [
      { value: 1970, px: 29 },
      { value: 1980, px: 81 },
      { value: 1990, px: 133 },
      { value: 2000, px: 184 },
      { value: 2010, px: 236 },
    ],
    yAnchors: [
      { value: 60, py: 18 },
      { value: 40, py: 98 },
      { value: 20, py: 181 },
    ],
  },
  {
    file: '04-hits-per-visit-redgreen.png',
    title: 'Hits average per visit',
    cropped: true,
    axis: { xMin: 0, xMax: 23, yMin: 0, yMax: 0.94 },
    xScale: 'linear',
    yScale: 'linear',
  },
  {
    file: '05-retail-sales-monthly.png',
    title: 'Retail Sales, monthly',
    cropped: true,
    axis: { xMin: 1992, xMax: 2019.4, yMin: 120, yMax: 520 },
    xScale: 'linear',
    yScale: 'linear',
    // Only the first and last label; the chart's `2001` and `2011` labels sit a
    // few pixels off their ticks because the glyphs `0`+`1` are narrower than
    // `9`+`6`, and that is a label-asymmetry artefact, not a tick-detection
    // error. The two endpoints pin the mapping anyway, and the middle labels
    // are implicitly checked by the extraction landing on the ink.
    xAnchors: [
      { value: 1996, px: 235 },
      { value: 2016, px: 1092 },
    ],
    yAnchors: [
      { value: 520, py: 15 },
      { value: 440, py: 121 },
      { value: 360, py: 230 },
      { value: 280, py: 335 },
      { value: 200, py: 443 },
      { value: 120, py: 549 },
    ],
    measureSpikes: true,
  },
  {
    file: '01-multipanel-blue-ktrend.png',
    title: 'Multipanel (uncropped composite)',
    cropped: false,
    axis: { xMin: 2019.5, xMax: 2024.2, yMin: 0, yMax: 42000 },
    xScale: 'linear',
    yScale: 'linear',
  },
  {
    file: '06-retail-sales-overlay-clipped-spikes.png',
    title: 'Retail Sales (overlay, prior defect)',
    cropped: true,
    axis: { xMin: 1992, xMax: 2019.4, yMin: 120, yMax: 520 },
    xScale: 'linear',
    yScale: 'linear',
    measureSpikes: true,
  },
  {
    file: '09-captain-manual-overlay-retail-sales.png',
    title: "Captain's manual overlay (reference)",
    cropped: false,
    axis: { xMin: 1991, xMax: 2021, yMin: 120, yMax: 520 },
    xScale: 'linear',
    yScale: 'linear',
  },
];

interface AxisErrorReport {
  pixelErrorMax: number;
  pixelErrorMean: number;
  perTick: Array<{ value: number; expectedPx: number; actualPx: number; errorPx: number }>;
}

/** How far each known tick landed from where the calibration puts it, in pixels. */
function axisErrorPx(
  calibration: Calibration,
  axis: 'x' | 'y',
  anchors: Array<{ value: number; px?: number; py?: number }>,
): AxisErrorReport | null {
  if (!anchors.length) return null;
  const cal = axis === 'x' ? calibration.x : calibration.y;
  const perTick = anchors.map((a) => {
    const expected = axis === 'x' ? (a.px ?? 0) : (a.py ?? 0);
    const actual = valueToPixel(cal, a.value);
    return { value: a.value, expectedPx: expected, actualPx: actual, errorPx: actual - expected };
  });
  const abs = perTick.map((p) => Math.abs(p.errorPx));
  return {
    pixelErrorMax: abs.reduce((a, b) => Math.max(a, b), 0),
    pixelErrorMean: abs.reduce((a, b) => a + b, 0) / abs.length,
    perTick,
  };
}

interface SpikeReport {
  spikes: number;
  meanRecoveredPercent: number;
  medianRecoveredPercent: number;
  worstRecoveredPercent: number;
  /** Shortfall at peaks as a percentage of the drawn amplitude, inwards. */
  meanShortfallPercent: number;
  worstShortfallPercent: number;
}

/**
 * How much of each drawn spike's amplitude the trace recovers.
 *
 * Ink is the only truth. For every candidate peak - a column whose topmost ink
 * sits above everything in a neighbourhood - the trace is compared against
 * `top + t/2`, with the trough measured the same way. The ratio of the two
 * amplitudes is what the overlay is checking by eye.
 */
function spikeRecovery(analysis: Analysis): SpikeReport | null {
  const series = analysis.series[0];
  if (!series) return null;
  const t = series.traced.thicknessPx;
  if (!(t > 0) || series.traced.mode !== 'curve') return null;
  const mask = series.mask;
  const top = new Float64Array(mask.width).fill(NaN);
  const bottom = new Float64Array(mask.width).fill(NaN);
  for (let x = 0; x < mask.width; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < mask.height; y++) {
      if (mask.alpha[y * mask.width + x] >= 0.12) {
        if (lo < 0) lo = y;
        hi = y;
      }
    }
    if (lo < 0) continue;
    top[x] = lo + 0.5 - Math.min(1, mask.alpha[lo * mask.width + x]);
    bottom[x] = hi - 0.5 + Math.min(1, mask.alpha[hi * mask.width + x]);
  }
  const traced = new Float64Array(mask.width).fill(NaN);
  for (const p of series.traced.points) traced[Math.round(p.px)] = p.py;
  const reach = 8;
  const peaks: Array<{ x: number; tip: number; traced: number }> = [];
  for (let x = reach; x < mask.width - reach; x++) {
    if (!Number.isFinite(top[x])) continue;
    let lowest = true;
    let rise = 0;
    for (let d = -reach; d <= reach; d++) {
      if (!Number.isFinite(top[x + d])) continue;
      if (top[x + d] < top[x] - 1e-9) lowest = false;
      rise = Math.max(rise, top[x + d] - top[x]);
    }
    if (!lowest || rise < 3 * t) continue;
    if (peaks.length && x - peaks[peaks.length - 1].x < reach) continue;
    let best = Infinity;
    for (let d = -reach; d <= reach; d++) {
      if (Number.isFinite(traced[x + d])) best = Math.min(best, traced[x + d]);
    }
    peaks.push({ x, tip: top[x] + t / 2, traced: best });
  }
  if (peaks.length < 2) return null;
  const recoveries: number[] = [];
  const shortfalls: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    let inkLow = -Infinity;
    let traceLow = -Infinity;
    for (let x = peaks[i - 1].x; x <= peaks[i].x; x++) {
      if (Number.isFinite(bottom[x])) inkLow = Math.max(inkLow, bottom[x]);
      if (Number.isFinite(traced[x])) traceLow = Math.max(traceLow, traced[x]);
    }
    const inkAmp = inkLow - t / 2 - peaks[i].tip;
    const traceAmp = traceLow - peaks[i].traced;
    if (inkAmp > 4 * t && Number.isFinite(traceAmp)) {
      recoveries.push(traceAmp / inkAmp);
      // Shortfall at the peak itself: how far the trace misses the drawn tip,
      // expressed as a fraction of the drawn amplitude. 0 is perfect, 1 means
      // the peak is lost entirely.
      const peakShort = (peaks[i].traced - peaks[i].tip) / inkAmp;
      shortfalls.push(peakShort);
    }
  }
  if (recoveries.length === 0) return null;
  const sorted = [...recoveries].sort((a, b) => a - b);
  const sortedShort = [...shortfalls].sort((a, b) => a - b);
  return {
    spikes: recoveries.length,
    meanRecoveredPercent: (recoveries.reduce((a, b) => a + b, 0) / recoveries.length) * 100,
    medianRecoveredPercent: sorted[sorted.length >> 1] * 100,
    worstRecoveredPercent: sorted[0] * 100,
    meanShortfallPercent: (shortfalls.reduce((a, b) => a + b, 0) / shortfalls.length) * 100,
    worstShortfallPercent: sortedShort[sortedShort.length - 1] * 100,
  };
}

/** Native pixel distance from the drawn ink to where the trace put its point. */
interface InkMissReport {
  points: number;
  meanMissPx: number;
  medianMissPx: number;
  worstMissPx: number;
}

function inkMiss(analysis: Analysis): InkMissReport | null {
  const series = analysis.series[0];
  if (!series || series.traced.mode !== 'curve') return null;
  const mask = series.mask;
  const misses: number[] = [];
  for (const p of series.traced.points) {
    const x = Math.round(p.px);
    if (x < 0 || x >= mask.width) continue;
    let best = Infinity;
    for (let y = 0; y < mask.height; y++) {
      if (mask.alpha[y * mask.width + x] >= 0.4) {
        best = Math.min(best, Math.abs(y - p.py));
      }
    }
    if (Number.isFinite(best)) misses.push(best);
  }
  if (misses.length === 0) return null;
  const sorted = [...misses].sort((a, b) => a - b);
  return {
    points: misses.length,
    meanMissPx: misses.reduce((a, b) => a + b, 0) / misses.length,
    medianMissPx: sorted[sorted.length >> 1],
    worstMissPx: sorted[sorted.length - 1],
  };
}

/**
 * Render an overlay PNG in the captain's style: dim the original to 55% and
 * draw the extracted points on top as small coloured dots.
 */
function renderOverlay(
  img: ImageBuffer,
  analysis: Analysis,
  series: DataSeries[],
  calibration: Calibration,
): ImageBuffer {
  const out: ImageBuffer = {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.width * img.height * 4),
  };
  const bgR = 255;
  const bgG = 255;
  const bgB = 255;
  const alpha = 0.55;
  for (let i = 0; i < img.data.length; i += 4) {
    out.data[i] = Math.round(img.data[i] * alpha + bgR * (1 - alpha));
    out.data[i + 1] = Math.round(img.data[i + 1] * alpha + bgG * (1 - alpha));
    out.data[i + 2] = Math.round(img.data[i + 2] * alpha + bgB * (1 - alpha));
    out.data[i + 3] = 255;
  }
  // Draw the frame rectangle lightly.
  const r = analysis.frame.rect;
  drawRect(out, r.x0, r.y0, r.x1, r.y1, { r: 90, g: 90, b: 90 }, 0.4);
  // Draw dots at each extracted point.
  for (const s of series) {
    const colour = { r: s.colour.r, g: s.colour.g, b: s.colour.b };
    for (const p of s.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const px = valueToPixel(calibration.x, p.x);
      const py = valueToPixel(calibration.y, p.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      drawDot(out, Math.round(px), Math.round(py), 2.0, colour);
    }
  }
  return out;
}

function drawDot(img: ImageBuffer, cx: number, cy: number, r: number, colour: RGB): void {
  const r2 = r * r;
  const r0 = Math.ceil(r);
  for (let dy = -r0; dy <= r0; dy++) {
    for (let dx = -r0; dx <= r0; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      // Dark halo + solid colour: makes a 2 px dot read against any background.
      const edge = d2 > (r - 0.6) * (r - 0.6);
      img.data[i] = edge ? Math.max(0, colour.r - 60) : colour.r;
      img.data[i + 1] = edge ? Math.max(0, colour.g - 60) : colour.g;
      img.data[i + 2] = edge ? Math.max(0, colour.b - 60) : colour.b;
      img.data[i + 3] = 255;
    }
  }
}

function drawRect(
  img: ImageBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: RGB,
  opacity: number,
): void {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = Math.round(img.data[i] * (1 - opacity) + colour.r * opacity);
    img.data[i + 1] = Math.round(img.data[i + 1] * (1 - opacity) + colour.g * opacity);
    img.data[i + 2] = Math.round(img.data[i + 2] * (1 - opacity) + colour.b * opacity);
    img.data[i + 3] = 255;
  };
  for (let x = x0; x <= x1; x++) {
    put(x, y0);
    put(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    put(x0, y);
    put(x1, y);
  }
}

function writePng(path: string, img: ImageBuffer): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

interface EvalResult {
  file: string;
  title: string;
  width: number;
  height: number;
  frame: { x0: number; y0: number; x1: number; y1: number; confidence: number };
  seriesFound: number;
  mode: string;
  calibration: {
    xScale: string;
    yScale: string;
    xLo: number;
    xHi: number;
    yLo: number;
    yHi: number;
  };
  axisError: {
    x: AxisErrorReport | null;
    y: AxisErrorReport | null;
  };
  spikes: SpikeReport | null;
  inkMiss: InkMissReport | null;
  warnings: string[];
  errored: string | null;
}

async function evaluate(exp: Expectation, options: AnalyseOptions): Promise<EvalResult> {
  const path = resolve(ROOT, 'examples/real', exp.file);
  const img = loadImage(path);
  const result: EvalResult = {
    file: exp.file,
    title: exp.title,
    width: img.width,
    height: img.height,
    frame: { x0: 0, y0: 0, x1: 0, y1: 0, confidence: 0 },
    seriesFound: 0,
    mode: 'none',
    calibration: {
      xScale: '',
      yScale: '',
      xLo: NaN,
      xHi: NaN,
      yLo: NaN,
      yHi: NaN,
    },
    axisError: { x: null, y: null },
    spikes: null,
    inkMiss: null,
    warnings: [],
    errored: null,
  };
  try {
    const analysis = await analyse(img, options);
    // Native resampling so the overlay shows what the engine actually traced,
    // one point per column: a uniform resample at 200 points drops peak-tip
    // columns on a dense monthly chart and makes a clean trace look clipped.
    const series = buildSeries(analysis, { resample: { kind: 'native' } });
    const cal = analysis.calibration;
    const xLo = Math.min(cal.x.a.value, cal.x.b.value) * cal.x.multiplier + cal.x.offset;
    const xHi = Math.max(cal.x.a.value, cal.x.b.value) * cal.x.multiplier + cal.x.offset;
    const yLo = Math.min(cal.y.a.value, cal.y.b.value) * cal.y.multiplier + cal.y.offset;
    const yHi = Math.max(cal.y.a.value, cal.y.b.value) * cal.y.multiplier + cal.y.offset;
    result.frame = { ...analysis.frame.rect, confidence: analysis.frame.confidence };
    result.seriesFound = series.length;
    result.mode = [...new Set(series.map((s) => s.mode))].join(', ') || 'none';
    result.calibration = { xScale: cal.x.scale, yScale: cal.y.scale, xLo, xHi, yLo, yHi };
    result.axisError.x = axisErrorPx(cal, 'x', exp.xAnchors ?? []);
    result.axisError.y = axisErrorPx(cal, 'y', exp.yAnchors ?? []);
    if (exp.measureSpikes) result.spikes = spikeRecovery(analysis);
    result.inkMiss = inkMiss(analysis);
    result.warnings = analysis.warnings.map((w) => `${w.level}: ${w.message}`);
    const overlay = renderOverlay(img, analysis, series, cal);
    writePng(resolve(OUT, `${basename(exp.file, '.png')}-overlay.png`), overlay);
  } catch (err: unknown) {
    const e = err as Error;
    result.errored = e.message || String(err);
  }
  return result;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const ocr = new NodeOcr();
  await ocr.start();

  const results: EvalResult[] = [];
  for (const exp of EXPECTATIONS) {
    process.stderr.write(`eval ${exp.file} ... `);
    const result = await evaluate(exp, { ocr });
    results.push(result);
    const errX = result.axisError.x
      ? `x max ${result.axisError.x.pixelErrorMax.toFixed(2)}px`
      : 'x -';
    const errY = result.axisError.y
      ? `y max ${result.axisError.y.pixelErrorMax.toFixed(2)}px`
      : 'y -';
    const peak = result.spikes
      ? `peak mean ${result.spikes.meanShortfallPercent.toFixed(2)}% worst ${result.spikes.worstShortfallPercent.toFixed(2)}%`
      : '';
    const err = result.errored ? ` ERROR: ${result.errored}` : '';
    process.stderr.write(`${errX} ${errY} ${peak}${err}\n`);
  }

  writeFileSync(
    resolve(OUT, 'report.json'),
    JSON.stringify(results, null, 2),
  );
  writeFileSync(resolve(OUT, 'report.md'), markdownReport(results));
  await ocr.stop();
  console.log(`wrote ${results.length} overlays and report.{md,json} to tools/eval-output/`);
}

function markdownReport(results: EvalResult[]): string {
  const lines: string[] = [];
  lines.push('# Real-image evaluation');
  lines.push('');
  lines.push('Produced by `npm run eval:real`. Overlays live beside this file.');
  lines.push('');
  lines.push('| File | Series | Mode | Axis err (x / y, px max) | Peak shortfall (mean / worst, %) | Warnings |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const xErr = r.axisError.x ? r.axisError.x.pixelErrorMax.toFixed(2) : '-';
    const yErr = r.axisError.y ? r.axisError.y.pixelErrorMax.toFixed(2) : '-';
    const peak = r.spikes
      ? `${r.spikes.meanShortfallPercent.toFixed(2)} / ${r.spikes.worstShortfallPercent.toFixed(2)}`
      : '-';
    const warn = r.errored ? `ERROR: ${r.errored}` : `${r.warnings.length}`;
    lines.push(`| ${r.file} | ${r.seriesFound} | ${r.mode} | ${xErr} / ${yErr} | ${peak} | ${warn} |`);
  }
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.file} - ${r.title}`);
    lines.push('');
    if (r.errored) {
      lines.push(`**ERROR**: ${r.errored}`);
      lines.push('');
      continue;
    }
    lines.push(
      `Frame ${r.frame.x0},${r.frame.y0} - ${r.frame.x1},${r.frame.y1} (conf ${r.frame.confidence.toFixed(2)}). ` +
        `Calibration: x ${r.calibration.xScale} ${num(r.calibration.xLo)}..${num(r.calibration.xHi)}, ` +
        `y ${r.calibration.yScale} ${num(r.calibration.yLo)}..${num(r.calibration.yHi)}.`,
    );
    lines.push('');
    if (r.axisError.x) {
      lines.push(
        `x axis: max ${r.axisError.x.pixelErrorMax.toFixed(2)} px, mean ${r.axisError.x.pixelErrorMean.toFixed(2)} px. ` +
          r.axisError.x.perTick.map((p) => `${p.value}: ${p.errorPx.toFixed(2)}px`).join(' | ') + '.',
      );
    }
    if (r.axisError.y) {
      lines.push(
        `y axis: max ${r.axisError.y.pixelErrorMax.toFixed(2)} px, mean ${r.axisError.y.pixelErrorMean.toFixed(2)} px. ` +
          r.axisError.y.perTick.map((p) => `${p.value}: ${p.errorPx.toFixed(2)}px`).join(' | ') + '.',
      );
    }
    if (r.spikes) {
      lines.push(
        `spikes (${r.spikes.spikes}): mean recovered ${r.spikes.meanRecoveredPercent.toFixed(1)}%, ` +
          `median ${r.spikes.medianRecoveredPercent.toFixed(1)}%, worst ${r.spikes.worstRecoveredPercent.toFixed(1)}%; ` +
          `peak shortfall mean ${r.spikes.meanShortfallPercent.toFixed(2)}%, worst ${r.spikes.worstShortfallPercent.toFixed(2)}%.`,
      );
    }
    if (r.inkMiss) {
      lines.push(
        `trace vs ink: median ${r.inkMiss.medianMissPx.toFixed(2)} px, worst ${r.inkMiss.worstMissPx.toFixed(2)} px over ${r.inkMiss.points} points.`,
      );
    }
    if (r.warnings.length) {
      for (const w of r.warnings) lines.push(`- ${w}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function num(v: number): string {
  if (!Number.isFinite(v)) return 'nan';
  if (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3) return v.toExponential(2);
  return Number(v.toPrecision(5)).toString();
}

await main();
