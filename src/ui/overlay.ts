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
import { cssColour } from './stage.ts';

export interface OverlayData {
  bitmap: ImageBitmap;
  series: DataSeries[];
  calibration: Calibration;
  /** Opacity of the underlying image, 0..1. */
  imageOpacity: number;
  /** Point marker radius in CSS pixels. */
  pointRadius: number;
  /** Show the magnifier under the pointer. */
  magnify: boolean;
}

export class OverlayPanel {
  readonly viewport: Viewport;
  private ctx: CanvasRenderingContext2D;
  private data: OverlayData | null = null;
  private probe: { x: number; y: number } | null = null;

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

    for (const series of data.series) {
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
      if (points.length === 0) continue;

      const stroke = cssColour(series.colour);
      if (series.mode === 'curve') {
        // A dark halo under a light dashed line reads against ink of any colour,
        // and neither of them looks like the drawn series.
        const path = () => {
          ctx.beginPath();
          points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
          ctx.stroke();
        };
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(16,20,28,0.55)';
        ctx.lineWidth = 3;
        path();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 4]);
        path();
        ctx.setLineDash([]);
      }
      if (data.pointRadius > 0) {
        for (const p of points) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, data.pointRadius, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = stroke;
          ctx.stroke();
        }
      }
    }
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
    for (const series of data.series) {
      const points = series.points
        .map((p) => {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
          return toBox(
            valueToPixel(data.calibration.x, p.x),
            valueToPixel(data.calibration.y, p.y),
          );
        })
        .filter((p): p is { x: number; y: number } => p !== null);
      if (points.length === 0) continue;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(16,20,28,0.6)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssColour(series.colour);
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
