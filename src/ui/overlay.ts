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
import type { MarkerShape, SeriesStyle } from './chart.ts';

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
 * Draw one marker.
 *
 * The overlay's markers are deliberately hollow, with a light fill and the
 * series colour as the outline: the point of this panel is to see whether the
 * extracted point lands on the ink underneath it, and a solid marker hides the
 * very thing being checked.
 */
function markerPath(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  switch (shape) {
    case 'rect':
    case 'roundRect':
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case 'triangle':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case 'arrow':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x, y + r * 0.4);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      break;
    case 'pin':
      ctx.arc(x, y - r * 0.3, r * 0.8, 0, Math.PI * 2);
      break;
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
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
      const radius = (style.size / 2) * data.pointScale;
      if (style.shape !== 'none' && radius > 0.2) {
        for (const p of points) {
          markerPath(ctx, style.shape, p.x, p.y, radius);
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = style.colour;
          ctx.stroke();
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
        markerPath(ctx, style.shape, p.x, p.y, 2.5);
        ctx.fill();
      }
    });
  }
}
