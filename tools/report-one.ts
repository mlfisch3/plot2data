/** Print the full analysis and CSV header for one image. */
import { resolve } from 'node:path';
import { analyse, buildSeries, toCsv } from '../src/engine/index.ts';
import { loadImage } from '../test/helpers/load-image.ts';
import { NodeOcr } from '../test/helpers/node-ocr.ts';

const file = process.argv[2] ?? 'corpus/linear-single-solid.png';
const ocr = new NodeOcr();
await ocr.start();
const img = loadImage(resolve(file));
const a = await analyse(img, { ocr });
console.log('frame', a.frame.rect, 'conf', a.frame.confidence.toFixed(2));
console.log('x ticks', a.xTicks.filter((t) => t.value !== undefined).map((t) => `${t.px.toFixed(0)}="${t.text}"=${t.value}`).join(' '));
console.log('y ticks', a.yTicks.filter((t) => t.value !== undefined).map((t) => `${t.px.toFixed(0)}="${t.text}"=${t.value}`).join(' '));
console.log('cal', JSON.stringify(a.calibration, null, 1));
console.log('series', a.series.map((s) => `${s.traced.mode} n=${s.traced.points.length} thick=${s.traced.thicknessPx.toFixed(2)}`).join(' | '));
const csv = toCsv(a, buildSeries(a, { resample: { kind: 'uniform', count: 5 } }), { source: file });
console.log(csv);
await ocr.stop();
