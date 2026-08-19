/**
 * Browser OCR provider.
 *
 * The engine takes OCR as an interface so it never touches the DOM; this is the
 * browser implementation. The worker, the WASM core and the language data are
 * all served from the bundle, so nothing here reaches the network.
 */

import { createWorker, type Worker } from 'tesseract.js';
import type { ImageBuffer } from '../engine/types.ts';
import type { OcrProvider, OcrResult } from '../engine/labels.ts';

const CHARSET = '0123456789.,-+%$kKMBbnTeEx^';

function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

function toCanvas(image: ImageBuffer): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas;
}

/** Reject rather than hang: a worker that never loads must not block the UI. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('OCR worker timed out')), ms)),
  ]);
}

export class BrowserOcr implements OcrProvider {
  private worker: Worker | null = null;
  private starting: Promise<void> | null = null;
  /** Set once startup has failed, so we stop retrying on every label. */
  failed = false;

  async start(): Promise<void> {
    if (this.worker || this.failed) return;
    // Chrome refuses to start a worker from a `file://` page, and the failure
    // surfaces inside the worker rather than as a rejected promise, so waiting
    // on it would hang the extraction. Skip it outright and let the user type
    // the anchor values in - the tool works fully without OCR.
    if (window.location.protocol === 'file:') {
      this.failed = true;
      return;
    }
    this.starting ??= (async () => {
      try {
        const worker = await withTimeout(createWorker('eng', 1, {
          workerPath: assetUrl('./tesseract/worker.min.js'),
          corePath: assetUrl('./tesseract/'),
          langPath: assetUrl('./tessdata'),
          // The language data ships expanded; see tools/copy-tesseract.ts.
          gzip: false,
          cacheMethod: 'none',
          logger: () => {},
        }), 30_000);
        await worker.setParameters({
          tessedit_char_whitelist: CHARSET,
          // A tick label is a single line of text, never a paragraph.
          tessedit_pageseg_mode: '7' as never,
        });
        this.worker = worker;
      } catch (error) {
        this.failed = true;
        console.warn('OCR unavailable; tick labels must be typed in', error);
      }
    })();
    await this.starting;
  }

  get available(): boolean {
    return this.worker !== null;
  }

  async recognise(image: ImageBuffer): Promise<OcrResult> {
    if (!this.worker) await this.start();
    if (!this.worker) throw new Error('OCR unavailable');
    const { data } = await this.worker.recognize(toCanvas(image));
    return { text: data.text.replace(/\s+/g, ' ').trim(), confidence: data.confidence / 100 };
  }

  async stop(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
    this.starting = null;
  }
}
