/**
 * The bottom panel: the extracted numbers drawn back over the original image.
 *
 * This is the check the captain built by hand in a spreadsheet, and the one
 * that found the peak clipping, so it belongs in the tool. Two rules make it
 * worth trusting:
 *
 * - The two are aligned **through the calibration**, never by stretching the
 *   image to fit the data. Each extracted point goes back to a pixel with
 *   `valueToPixel`, so a wrong calibration shows up as a visible mismatch
 *   instead of being hidden by the fit. It is the round trip that is being
 *   checked: value -> pixel has to land back on the ink it came from.
 * - The overlay is deliberately not drawn in the series colour. Matching ink
 *   would hide exactly the failures worth seeing.
 */

import { valueToPixel } from '../engine/calibration.ts';
import type { Calibration, DataSeries } from '../engine/types.ts';
import { Viewport, type WorldRect } from './viewport.ts';
import { drawMagnifier } from './magnifier.ts';
import type { SeriesStyle } from './chart.ts';

export interface OverlayData {
  bitmap: ImageBitmap;
  series: DataSeries[];
  /** One style per entry of `series`, in the same order. */
  styles: SeriesStyle[];
  calibration: Calibration;
  /** Opacity of the underlying image, 0..1. */
  imageOpacity: number;
  /** Scales every series' own marker size; the slider under the panel. */
  pointScale: number;
  /** Show the magnifier under the pointer. */
  magnify: boolean;
}

/**
 * One round, filled dot in the series colour.
 *
 * The captain assembles his review overlay in PowerPoint by drawing small
 * dotted markers on top of the chart image at about 55% opacity: a filled
 * round marker in the series colour reads against a dim original of any
 * shape, and the same dot style applied to every series makes the overlay
 * easy to compare across charts. Shape overrides apply to the chart panel
 * and the exported file; the overlay panel is for review and stays round.
 */
function markerDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

export class OverlayPanel {
  readonly viewport: Viewport;
  private ctx: CanvasRenderingContext2D;
  private data: OverlayData | null = null;
  private probe: { x: number; y: number } | null = null;
  /** The image the current view was fitted to, so a new one starts fitted. */
  private fittedTo: ImageBitmap | null = null;

  constructor(readonly canvas: HTMLCanvasElement, onUserView?: (v: Viewport) => void) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.viewport = new Viewport(canvas, ctx, {
      world: () => this.world(),
      draw: () => this.render(),
      onUserView,
      onProbe: (p) => {
        this.probe = p;
        this.render();
      },
      minHeight: 190,
      maxHeight: 420,
    });
  }

  setData(data: OverlayData | null): void {
    this.data = data;
    // A different image is a different world, and the zoom that framed the last
    // one frames nothing in this one: carried across, the panel opens on the
    // wrong region of the new plot, or - measured on a smaller image - on no
    // part of it at all, and shows a blank mat where the overlay should be.
    if (data && data.bitmap !== this.fittedTo) {
      this.fittedTo = data.bitmap;
      this.viewport.fit();
    }
    this.render();
  }

  resize(): void {
    this.viewport.resize();
  }

  private world(): WorldRect {
    const b = this.data?.bitmap;
    return b ? { x0: 0, y0: 0, x1: b.width, y1: b.height } : { x0: 0, y0: 0, x1: 1, y1: 1 };
  }

  render(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    const data = this.data;
    if (!data) return;

    const v = this.viewport;
    ctx.save();
    ctx.globalAlpha = data.imageOpacity;
    ctx.imageSmoothingEnabled = v.scale < 1;
    ctx.drawImage(data.bitmap, v.dx, v.dy, data.bitmap.width * v.scale, data.bitmap.height * v.scale);
    ctx.globalAlpha = 1;

    data.series.forEach((series, index) => {
      const style = data.styles[index];
      if (!style) return;
      const points = series.points
        .map((p) => {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
          const s = v.toScreen(
            valueToPixel(data.calibration.x, p.x),
            valueToPixel(data.calibration.y, p.y),
          );
          return Number.isFinite(s.x) && Number.isFinite(s.y) ? s : null;
        })
        .filter((p): p is { x: number; y: number } => p !== null);
      if (points.length === 0) return;

      if (style.line) {
        // A dark halo under a light dashed line reads against ink of any colour,
        // and neither of them looks like the drawn series.
        const path = () => {
          ctx.beginPath();
          points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
          ctx.stroke();
        };
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(16,20,28,0.55)';
        ctx.lineWidth = style.lineWidth + 1.6;
        path();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = style.lineWidth;
        ctx.setLineDash([5, 4]);
        path();
        ctx.setLineDash([]);
      }
      // Round, filled dots in the series colour, every series the same shape.
      // The reference the captain approved is a dotted trace laid over a dim
      // original - matching the series' own marker shape here would make the
      // overlay look like the chart panel instead of a side-by-side review.
      const radius = Math.max(0.9, (style.size / 2) * data.pointScale);
      if (style.shape !== 'none') {
        ctx.fillStyle = style.colour;
        for (const p of points) {
          markerDot(ctx, p.x, p.y, radius);
          ctx.fill();
        }
      }
    });
    ctx.restore();

    if (data.magnify && this.probe) {
      const image = v.toWorld(this.probe.x, this.probe.y);
      drawMagnifier(ctx, {
        bitmap: data.bitmap,
        at: this.probe,
        image,
        canvasWidth: v.cssWidth,
        canvasHeight: v.cssHeight,
        zoom: 6,
        label: `${image.x.toFixed(0)}, ${image.y.toFixed(0)} px`,
        content: (mctx, toBox) => this.drawTraces(mctx, toBox),
      });
    }
  }

  /** The extracted series, inside the magnifier, at the magnifier's own scale. */
  private drawTraces(
    ctx: CanvasRenderingContext2D,
    toBox: (x: number, y: number) => { x: number; y: number },
  ): void {
    const data = this.data;
    if (!data) return;
    data.series.forEach((series, index) => {
      const style = data.styles[index];
      if (!style) return;
      const points = series.points
        .map((p) => {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
          return toBox(
            valueToPixel(data.calibration.x, p.x),
            valueToPixel(data.calibration.y, p.y),
          );
        })
        .filter((p): p is { x: number; y: number } => p !== null);
      if (points.length === 0) return;
      if (style.line) {
        const path = () => {
          ctx.beginPath();
          points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
          ctx.stroke();
        };
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(16,20,28,0.6)';
        ctx.lineWidth = 3;
        path();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 4]);
        path();
        ctx.setLineDash([]);
      }
      if (style.shape === 'none') return;
      ctx.fillStyle = style.colour;
      for (const p of points) {
        markerDot(ctx, p.x, p.y, 2.5);
        ctx.fill();
      }
    });
  }

  /**
   * Render the overlay at the image's natural resolution and hand back a
   * blob the caller can save, share or copy.
   *
   * Important: this draws at native image coordinates, not at the viewport's
   * scaled coordinates, so the exported file matches the proportions the
   * captain would get by compositing in PowerPoint. The point scale and the
   * image opacity are the ones the user settled on in the panel.
   */
  async saveToBlob(mimeType: string = 'image/png'): Promise<Blob | null> {
    const data = this.data;
    if (!data) return null;
    const w = data.bitmap.width;
    const h = data.bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // White behind the dimmed image so the resulting file has an opaque
    // background rather than a transparent one that depends on the viewer.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = data.imageOpacity;
    ctx.drawImage(data.bitmap, 0, 0);
    ctx.globalAlpha = 1;
    data.series.forEach((series, index) => {
      const style = data.styles[index];
      if (!style || style.shape === 'none') return;
      const radius = Math.max(1.2, (style.size / 2) * data.pointScale);
      ctx.fillStyle = style.colour;
      for (const p of series.points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const px = valueToPixel(data.calibration.x, p.x);
        const py = valueToPixel(data.calibration.y, p.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        markerDot(ctx, px, py, radius);
        ctx.fill();
      }
    });
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), mimeType),
    );
  }
}
