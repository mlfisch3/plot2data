/**
 * The seam between the page and the Android shell.
 *
 * The page is the same page everywhere. When it happens to be running inside
 * `android/`, four things arrive from or go to the native side: images shared
 * into the app, the window insets, and the two ways a CSV can leave a phone.
 * Everywhere else these fall back to what a browser already does, so nothing
 * here is conditional at the call sites.
 */

import { downloadBlob } from './image-io.ts';

export interface IncomingImage {
  /** Stable id for the cached copy the shell holds; survives process death. */
  token: string;
  /** Same-origin URL the shell serves the bytes from. */
  url: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface HostInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** Largest display corner radius, so controls can stay out of the curve. */
  corner: number;
}

/** Injected by the Android shell; absent in every browser. */
interface NativeBridge {
  ready(): void;
  saveCsv(name: string, text: string): void;
  shareCsv(name: string, text: string): void;
  /**
   * Binary export, base64 encoded. Added for the xlsx workbook; the CSV routes
   * stay as they were, because a text string is the cheaper path for the common
   * case and an older shell still has to serve it.
   */
  saveBinary?(name: string, base64: string, mime: string): void;
  shareBinary?(name: string, base64: string, mime: string): void;
}

declare global {
  interface Window {
    Plot2DataAndroid?: NativeBridge;
    __p2dHost?: {
      receiveImages(images: IncomingImage[]): void;
      setInsets(insets: HostInsets): void;
    };
  }
}

const native: NativeBridge | null = window.Plot2DataAndroid ?? null;

/** True when the page is running inside the Android shell. */
export const onAndroid = native !== null;

/**
 * Publish the receiver the shell calls into, then tell it we are listening.
 *
 * The shell holds any image that arrived before this point and delivers it the
 * moment `ready()` lands, so a share that launches the app cold is not lost to
 * the race with the page loading.
 */
export function installHost(handlers: { onImages(images: IncomingImage[]): void }): void {
  window.__p2dHost = {
    receiveImages(images) {
      if (Array.isArray(images) && images.length > 0) handlers.onImages(images);
    },
    setInsets(insets) {
      applyInsets(insets);
    },
  };
  native?.ready();
}

function applyInsets(insets: HostInsets): void {
  const root = document.documentElement.style;
  const px = (value: number) => `${Math.max(0, Math.round(value))}px`;
  root.setProperty('--inset-top', px(insets.top));
  root.setProperty('--inset-right', px(insets.right));
  root.setProperty('--inset-bottom', px(insets.bottom));
  root.setProperty('--inset-left', px(insets.left));
  root.setProperty('--inset-corner', px(insets.corner));
}

/**
 * Fetch an image the shell has made available.
 *
 * The bytes come over the asset loader's own origin rather than as a base64
 * string through the bridge, so a 12-megapixel screenshot costs one stream
 * instead of a 30 MB JavaScript string.
 */
export async function fetchIncoming(image: IncomingImage): Promise<File> {
  const response = await fetch(image.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`The shared image could not be read (${response.status}).`);
  const blob = await response.blob();
  return new File([blob], image.name, { type: blob.type || image.mime });
}

/* -------------------------------------------------------------------- csv */

export type CsvDestination = 'save' | 'share';

export const CSV_MIME = 'text/csv';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Sharing a file is offered when the platform can actually do it. */
export function canShareCsv(): boolean {
  if (onAndroid) return true;
  if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
  try {
    return navigator.canShare({ files: [new File(['x'], 'probe.csv', { type: 'text/csv' })] });
  } catch {
    return false;
  }
}

/**
 * Get a file off the device.
 *
 * On Android a `download` attribute does nothing at all, so both routes go
 * through the shell: `save` opens the system file picker, `share` hands the
 * file to another app. In a browser they are a download and a Web Share.
 *
 * Text still goes over the bridge as text. A workbook cannot, so it goes as
 * base64 - which costs a third more bytes, but a spreadsheet of a few thousand
 * rows is small and the alternative is a second transport for one file type.
 */
export async function exportFile(
  destination: CsvDestination,
  filename: string,
  data: string | Uint8Array,
  mime: string = CSV_MIME,
): Promise<void> {
  if (native) {
    if (typeof data === 'string') {
      if (destination === 'share') native.shareCsv(filename, data);
      else native.saveCsv(filename, data);
      return;
    }
    const base64 = toBase64(data);
    const send = destination === 'share' ? native.shareBinary : native.saveBinary;
    if (!send) throw new Error('This version of the app cannot save that format. Export a CSV instead.');
    send.call(native, filename, base64, mime);
    return;
  }

  const blobParts: BlobPart[] = [typeof data === 'string' ? data : new Uint8Array(data)];
  if (destination === 'share' && canShareCsv()) {
    const file = new File(blobParts, filename, { type: mime });
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (error) {
      // A dismissed share sheet is not a failure worth reporting, but a real
      // one should still leave the user with their file.
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }

  downloadBlob(filename, new Blob(blobParts, { type: mime }));
}

/** Base64 in chunks: one `String.fromCharCode` over a megabyte blows the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
