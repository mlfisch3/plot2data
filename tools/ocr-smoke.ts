import { resolve } from 'node:path';
import { NodeOcr } from '../test/helpers/node-ocr.ts';
import { loadImage } from '../test/helpers/load-image.ts';
import { detectFrame } from '../src/engine/frame.ts';
import { detectTicks } from '../src/engine/ticks.ts';
import { readTickLabels, readOffsetAnnotations } from '../src/engine/labels.ts';

const file = process.argv[2] ?? 'corpus/linear-single-solid.png';
const img = loadImage(resolve(file));
const frame = detectFrame(img);
const ocr = new NodeOcr();
await ocr.start();
for (const side of ['bottom', 'left'] as const) {
  const scan = detectTicks(img, frame, side);
  const t0 = Date.now();
  const labels = await readTickLabels(img, frame, scan, ocr);
  console.log(
    `${side}: ${Date.now() - t0}ms`,
    labels.filter((l) => l.text).map((l) => `${l.px.toFixed(0)}="${l.text}"->${l.value}`).join('  '),
  );
}
console.log('annotations', await readOffsetAnnotations(img, frame, ocr));
await ocr.stop();
