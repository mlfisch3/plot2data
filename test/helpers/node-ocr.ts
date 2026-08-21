/**
 * A tesseract.js-backed OCR provider for Node tests.
 *
 * The engine takes OCR as an interface so it stays DOM-free; this is the test
 * implementation, and `src/ui/ocr.ts` is the browser one. Both point at the
 * traineddata vendored in `public/tessdata`, so nothing touches the network.
 */

import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createWorker, type Worker } from 'tesseract.js';
import type { ImageBuffer } from '../../src/engine/types.ts';
import type { OcrProvider, OcrResult } from '../../src/engine/labels.ts';

const ROOT = resolve(import.meta.dirname, '../..');

function encodePng(img: ImageBuffer): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png);
}

const CHARSET = '0123456789.,-+%$kKMBbnTeEx^';

export class NodeOcr implements OcrProvider {
  private worker: Worker | null = null;
  private charset = CHARSET;

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = await createWorker('eng', 1, {
      // A plain filesystem path makes tesseract.js read the traineddata with
      // fs instead of fetch, which keeps the tests entirely offline.
      langPath: resolve(ROOT, 'public/tessdata'),
      gzip: false,
      cacheMethod: 'none',
      logger: () => {},
    });
    await this.worker.setParameters({
      tessedit_char_whitelist: CHARSET,
      // A tick label is a single line of text, never a paragraph.
      tessedit_pageseg_mode: '7' as never,
    });
    this.charset = CHARSET;
  }

  async recognise(image: ImageBuffer, hint?: { charset?: string }): Promise<OcrResult> {
    if (!this.worker) await this.start();
    const wanted = hint?.charset ?? CHARSET;
    if (wanted !== this.charset) {
      await this.worker!.setParameters({ tessedit_char_whitelist: wanted });
      this.charset = wanted;
    }
    const { data } = await this.worker!.recognize(encodePng(image));
    return { text: data.text.replace(/\s+/g, ' ').trim(), confidence: data.confidence / 100 };
  }

  async stop(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
