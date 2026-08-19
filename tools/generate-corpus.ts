/**
 * Renders the synthetic ground-truth corpus with a real charting library in
 * headless Chrome, reproducing the captain's target case exactly: a screenshot
 * of a browser-rendered plot.
 *
 * Run with `npm run corpus`. Outputs to `corpus/`:
 *   <id>.png|jpg   the plot image
 *   <id>.csv       ground truth, densely sampled from the analytic function
 *   <id>.json      case metadata (axis ranges, scales, series colours)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { CASES, FUNCTIONS, type CaseSpec } from './corpus-spec.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'corpus');

const CHROME =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  }) ??
  '/usr/bin/google-chrome';

/** Ground-truth vertices: exactly the points handed to the charting library. */
export function groundTruthPoints(c: CaseSpec): Array<{ x: number; ys: number[] }> {
  const out: Array<{ x: number; ys: number[] }> = [];
  const logX = c.xScale === 'logarithmic';
  const lo = logX ? Math.log10(c.xMin) : c.xMin;
  const hi = logX ? Math.log10(c.xMax) : c.xMax;
  for (let i = 0; i < c.samples; i++) {
    const t = c.samples === 1 ? 0 : i / (c.samples - 1);
    const v = lo + t * (hi - lo);
    const x = logX ? Math.pow(10, v) : v;
    out.push({ x, ys: c.series.map((s) => FUNCTIONS[s.fn](x)) });
  }
  return out;
}

function buildPageHtml(chartJs: string, c: CaseSpec, data: ReturnType<typeof groundTruthPoints>) {
  const fg = c.dark ? '#e8eaed' : '#202124';
  const gridColour = c.dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)';
  const bg = c.dark ? '#15181c' : '#ffffff';
  const divisor = c.yDisplayDivisor ?? 1;

  const datasets = c.series.map((s, si) => ({
    label: s.label,
    data: data.map((p) => ({ x: p.x, y: p.ys[si] / divisor })),
    borderColor: s.colour,
    backgroundColor: s.colour,
    borderWidth: c.scatter ? 0 : (s.width ?? 2),
    borderDash: s.dashed ? [10, 6] : [],
    borderJoinStyle: s.roundJoin ? 'round' : 'miter',
    borderCapStyle: s.roundJoin ? 'round' : 'butt',
    pointRadius: c.scatter ? (c.pointRadius ?? 4) : 0,
    pointBackgroundColor: s.colour,
    pointBorderWidth: 0,
    showLine: !c.scatter,
    tension: 0,
    fill: false,
  }));

  const config = {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 1,
      layout: { padding: { top: 18, right: 26, bottom: 8, left: 8 } },
      plugins: {
        legend: { display: c.series.length > 1, labels: { color: fg, boxHeight: 2 } },
        tooltip: { enabled: false },
      },
      elements: { point: { hoverRadius: 0 } },
      scales: {
        x: {
          type: c.xScale,
          min: c.xMin,
          max: c.xMax,
          ticks: { color: fg, font: { size: 13 }, maxRotation: 0, autoSkip: true },
          grid: { display: !!c.grid, color: gridColour, drawTicks: true, tickLength: 6 },
          border: { color: fg, width: 2 },
        },
        y: {
          type: c.yScale,
          min: c.yMin / divisor,
          max: c.yMax / divisor,
          ticks: { color: fg, font: { size: 13 }, maxRotation: 0, autoSkip: true },
          grid: { display: !!c.grid, color: gridColour, drawTicks: true, tickLength: 6 },
          border: { color: fg, width: 2 },
        },
      },
    },
  };

  const annotation = c.yOffsetAnnotation
    ? `<div class="ann">${c.yOffsetAnnotation}</div>`
    : '';

  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:${bg};}
  #wrap{position:relative;width:${c.width}px;height:${c.height}px;background:${bg};}
  .ann{position:absolute;left:10px;top:0px;color:${fg};font:13px system-ui,sans-serif;}
  canvas{display:block;}
</style>
<div id="wrap">${annotation}<canvas id="c" width="${c.width}" height="${c.height}"></canvas></div>
<script>${chartJs}</script>
<script>
  const cfg = ${JSON.stringify(config)};
  // Log axes: label decades only, in plain notation. Chart.js's default emits
  // "1,000.000" style labels with intermediate minor values, which no clean
  // publication plot would show.
  const decadeOnly = (v) => {
    const l = Math.log10(v);
    if (Math.abs(l - Math.round(l)) > 1e-6) return '';
    const e = Math.round(l);
    if (e >= -3 && e <= 4) return String(Number(v.toPrecision(6)));
    return '1e' + e;
  };
  for (const axis of ['x', 'y']) {
    if (cfg.options.scales[axis].type === 'logarithmic') {
      cfg.options.scales[axis].ticks.callback = decadeOnly;
      cfg.options.scales[axis].ticks.autoSkip = false;
    }
  }
  new Chart(document.getElementById('c').getContext('2d'), cfg);
  window.__ready = true;
</script>`;
}

/**
 * Which cases to render.
 *
 * Regenerating the whole corpus moves every measured number with it, because a
 * different Chrome renders text a hair differently. Naming cases on the command
 * line keeps a new case from disturbing the fifteen already committed:
 * `npm run corpus -- sawtooth-sharp narrow-peaks`.
 */
function selected(): CaseSpec[] {
  const wanted = new Set(process.argv.slice(2));
  if (wanted.size === 0) return CASES;
  const cases = CASES.filter((c) => wanted.has(c.id));
  const missing = [...wanted].filter((id) => !CASES.some((c) => c.id === id));
  if (missing.length) throw new Error(`no such case: ${missing.join(', ')}`);
  return cases;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const cases = selected();
  const chartJs = readFileSync(resolve(ROOT, 'node_modules/chart.js/dist/chart.umd.js'), 'utf8');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });

  const index: Array<Record<string, unknown>> = [];
  try {
    for (const c of cases) {
      const data = groundTruthPoints(c);
      const page = await browser.newPage();
      const dsf = c.deviceScaleFactor ?? 1;
      await page.setViewport({ width: c.width + 40, height: c.height + 40, deviceScaleFactor: dsf });
      await page.setContent(buildPageHtml(chartJs, c, data), { waitUntil: 'load' });
      await page.waitForFunction('window.__ready === true');
      // One extra frame so Chart.js has definitely painted.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      const el = await page.$('#wrap');
      if (!el) throw new Error(`no #wrap for ${c.id}`);
      const jpeg = c.format === 'jpeg';
      const ext = jpeg ? 'jpg' : 'png';
      const file = resolve(OUT, `${c.id}.${ext}`);
      await el.screenshot(
        jpeg
          ? { path: file as `${string}.jpg`, type: 'jpeg', quality: c.jpegQuality ?? 80 }
          : { path: file as `${string}.png`, type: 'png' },
      );
      await page.close();

      const header = ['x', ...c.series.map((s) => s.label)].join(',');
      const rows = data.map((p) => [p.x, ...p.ys].map((v) => formatNum(v)).join(','));
      writeFileSync(resolve(OUT, `${c.id}.csv`), `${header}\n${rows.join('\n')}\n`);
      writeFileSync(
        resolve(OUT, `${c.id}.json`),
        `${JSON.stringify({ ...c, image: `${c.id}.${ext}`, truth: `${c.id}.csv` }, null, 2)}\n`,
      );
      index.push({ id: c.id, image: `${c.id}.${ext}`, description: c.description });
      console.log(`  ${c.id.padEnd(24)} -> ${c.id}.${ext}`);
    }
  } finally {
    await browser.close();
  }
  // The index always describes the whole corpus, whichever subset was rendered.
  const all = CASES.map((c) => ({
    id: c.id,
    image: `${c.id}.${c.format === 'jpeg' ? 'jpg' : 'png'}`,
    description: c.description,
  }));
  writeFileSync(resolve(OUT, 'index.json'), `${JSON.stringify(all, null, 2)}\n`);
  console.log(`\n${index.length} of ${all.length} cases written to corpus/`);
}

function formatNum(v: number): string {
  if (!Number.isFinite(v)) return '';
  return Number(v.toPrecision(12)).toString();
}

await main();
