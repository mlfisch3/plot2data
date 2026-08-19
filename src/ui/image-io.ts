/**
 * Getting pixels in and out of the browser: file picker, drag and drop,
 * clipboard paste, and cropping. Everything stays local - no upload, ever.
 */

import type { ImageBuffer, Rect } from '../engine/types.ts';

/** What the file picker advertises. Decoding is what actually decides. */
export const ACCEPT_ATTRIBUTE = 'image/*';

export interface LoadedImage {
  buffer: ImageBuffer;
  name: string;
  bitmap: ImageBitmap;
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  // Decode first and complain afterwards. A file arriving from a share sheet,
  // a clipboard or a screenshot tool often carries no type at all or a wildcard
  // one, and refusing on the label would reject images the platform can read
  // perfectly well.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    const label = file.type || 'unknown type';
    throw new Error(`That file could not be read as an image (${label}). Use a PNG or JPEG screenshot.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return {
    buffer: { width: data.width, height: data.height, data: data.data },
    name: file.name || 'pasted image',
    bitmap,
  };
}

/** First image found in a drop or paste event. */
export function fileFromTransfer(items: DataTransferItemList | null, files: FileList | null): File | null {
  const isImage = (file: File | null): file is File =>
    file !== null && (file.type.startsWith('image/') || file.type === '');
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (isImage(file)) return file;
    }
  }
  if (files) {
    for (const file of Array.from(files)) if (isImage(file)) return file;
  }
  return null;
}

export function cropBuffer(buffer: ImageBuffer, rect: Rect): ImageBuffer {
  const x0 = Math.max(0, Math.round(rect.x0));
  const y0 = Math.max(0, Math.round(rect.y0));
  const x1 = Math.min(buffer.width - 1, Math.round(rect.x1));
  const y1 = Math.min(buffer.height - 1, Math.round(rect.y1));
  const w = Math.max(1, x1 - x0 + 1);
  const h = Math.max(1, y1 - y0 + 1);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * buffer.width + x0) * 4;
    out.set(buffer.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Trigger a download of `text` without leaving the page. */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
