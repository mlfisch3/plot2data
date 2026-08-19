/**
 * The interactive canvas: the image, the crop rectangle, and after extraction
 * the detected frame, the traced series and the four draggable anchors.
 *
 * Anchors are drawn as full-height (or full-width) guide lines with a chunky
 * grab handle, because on a phone a thin line is impossible to hit. The handle
 * is 44 px of touch target regardless of zoom.
 */

import type { Analysis } from '../engine/pipeline.ts';
import type { Calibration, Rect, RGB } from '../engine/types.ts';

export type AnchorId = 'xa' | 'xb' | 'ya' | 'yb';
export type CropHandle =
  | 'move'
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w';

export interface StageCallbacks {
  onCropChange(rect: Rect): void;
  onAnchorChange(id: AnchorId, px: number): void;
}

interface View {
  scale: number;
  dx: number;
  dy: number;
}

const HANDLE = 22;
const TOUCH_SLOP = 26;

export class Stage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: View = { scale: 1, dx: 0, dy: 0 };
  private bitmap: ImageBitmap | null = null;
  private cropRect: Rect | null = null;
  private analysis: Analysis | null = null;
  private calibration: Calibration | null = null;
  private visible = new Set<number>();
  private mode: 'crop' | 'anchors' = 'crop';
  private drag: { kind: 'crop'; handle: CropHandle; start: Rect; ox: number; oy: number } | null = null;
  private anchorDrag: AnchorId | null = null;
  private hover: AnchorId | CropHandle | null = null;

  constructor(canvas: HTMLCanvasElement, private callbacks: StageCallbacks) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag && !this.anchorDrag) {
        this.hover = null;
        this.render();
      }
    });
  }

  setImage(bitmap: ImageBitmap | null, cropRect: Rect | null): void {
    this.bitmap = bitmap;
    this.cropRect = cropRect;
    this.mode = 'crop';
    this.analysis = null;
    this.resize();
  }

  setAnalysis(analysis: Analysis | null, calibration: Calibration | null, visible: Set<number>): void {
    this.analysis = analysis;
    this.calibration = calibration;
    this.visible = visible;
    this.mode = analysis ? 'anchors' : 'crop';
    this.render();
  }

  setCalibration(calibration: Calibration, visible: Set<number>): void {
    this.calibration = calibration;
    this.visible = visible;
    this.render();
  }

  get cropping(): boolean {
    return this.mode === 'crop';
  }

  /** Fit the canvas to its container and recompute the image transform. */
  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent || !this.bitmap) {
      this.render();
      return;
    }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cssWidth = parent.clientWidth;
    const aspect = this.bitmap.height / this.bitmap.width;
    const cssHeight = Math.max(180, Math.min(cssWidth * aspect, window.innerHeight * 0.62));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const scale = Math.min(cssWidth / this.bitmap.width, cssHeight / this.bitmap.height);
    this.view = {
      scale,
      dx: (cssWidth - this.bitmap.width * scale) / 2,
      dy: (cssHeight - this.bitmap.height * scale) / 2,
    };
    this.render();
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return { x: this.view.dx + x * this.view.scale, y: this.view.dy + y * this.view.scale };
  }

  private toImage(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.view.dx) / this.view.scale, y: (y - this.view.dy) / this.view.scale };
  }

  private pointerPos(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!this.bitmap) return;
    const p = this.pointerPos(event);
    if (this.mode === 'anchors') {
      const id = this.anchorAt(p);
      if (!id) return;
      this.anchorDrag = id;
      this.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (!this.cropRect) return;
    const handle = this.cropHandleAt(p);
    if (!handle) return;
    const img = this.toImage(p.x, p.y);
    this.drag = { kind: 'crop', handle, start: { ...this.cropRect }, ox: img.x, oy: img.y };
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.bitmap) return;
    const p = this.pointerPos(event);

    if (this.anchorDrag) {
      const img = this.toImage(p.x, p.y);
      const value = this.anchorDrag.startsWith('x') ? img.x : img.y;
      this.callbacks.onAnchorChange(this.anchorDrag, value);
      return;
    }
    if (this.drag && this.cropRect) {
      const img = this.toImage(p.x, p.y);
      this.callbacks.onCropChange(this.applyHandle(this.drag, img.x, img.y));
      return;
    }

    const next = this.mode === 'anchors' ? this.anchorAt(p) : this.cropHandleAt(p);
    if (next !== this.hover) {
      this.hover = next;
      this.canvas.style.cursor = cursorFor(next);
      this.render();
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.drag = null;
    this.anchorDrag = null;
  };

  private applyHandle(
    drag: { handle: CropHandle; start: Rect; ox: number; oy: number },
    x: number,
    y: number,
  ): Rect {
    if (!this.bitmap) return drag.start;
    const dx = x - drag.ox;
    const dy = y - drag.oy;
    const r = { ...drag.start };
    const w = this.bitmap.width;
    const h = this.bitmap.height;
    const min = 12;

    if (drag.handle === 'move') {
      const width = r.x1 - r.x0;
      const height = r.y1 - r.y0;
      r.x0 = Math.max(0, Math.min(w - 1 - width, r.x0 + dx));
      r.y0 = Math.max(0, Math.min(h - 1 - height, r.y0 + dy));
      r.x1 = r.x0 + width;
      r.y1 = r.y0 + height;
      return r;
    }
    if (drag.handle.includes('w')) r.x0 = Math.max(0, Math.min(r.x1 - min, drag.start.x0 + dx));
    if (drag.handle.includes('e')) r.x1 = Math.min(w - 1, Math.max(r.x0 + min, drag.start.x1 + dx));
    if (drag.handle.includes('n')) r.y0 = Math.max(0, Math.min(r.y1 - min, drag.start.y0 + dy));
    if (drag.handle.includes('s')) r.y1 = Math.min(h - 1, Math.max(r.y0 + min, drag.start.y1 + dy));
    return r;
  }

  private cropHandleAt(p: { x: number; y: number }): CropHandle | null {
    if (!this.cropRect) return null;
    const a = this.toScreen(this.cropRect.x0, this.cropRect.y0);
    const b = this.toScreen(this.cropRect.x1, this.cropRect.y1);
    const near = (v: number, target: number) => Math.abs(v - target) <= TOUCH_SLOP;
    const insideX = p.x >= a.x - TOUCH_SLOP && p.x <= b.x + TOUCH_SLOP;
    const insideY = p.y >= a.y - TOUCH_SLOP && p.y <= b.y + TOUCH_SLOP;
    if (!insideX || !insideY) return null;
    const w = near(p.x, a.x);
    const e = near(p.x, b.x);
    const n = near(p.y, a.y);
    const s = near(p.y, b.y);
    if (n && w) return 'nw';
    if (n && e) return 'ne';
    if (s && w) return 'sw';
    if (s && e) return 'se';
    if (n) return 'n';
    if (s) return 's';
    if (w) return 'w';
    if (e) return 'e';
    return 'move';
  }

  private anchorPositions(): Array<{ id: AnchorId; axis: 'x' | 'y'; px: number }> {
    if (!this.calibration) return [];
    return [
      { id: 'xa', axis: 'x', px: this.calibration.x.a.px },
      { id: 'xb', axis: 'x', px: this.calibration.x.b.px },
      { id: 'ya', axis: 'y', px: this.calibration.y.a.px },
      { id: 'yb', axis: 'y', px: this.calibration.y.b.px },
    ];
  }

  private anchorAt(p: { x: number; y: number }): AnchorId | null {
    let best: AnchorId | null = null;
    let bestD = TOUCH_SLOP;
    for (const a of this.anchorPositions()) {
      const s = this.toScreen(a.axis === 'x' ? a.px : 0, a.axis === 'y' ? a.px : 0);
      const d = a.axis === 'x' ? Math.abs(p.x - s.x) : Math.abs(p.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    return best;
  }

  render(): void {
    const ctx = this.ctx;
    const cssWidth = this.canvas.width / (window.devicePixelRatio || 1);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    if (!this.bitmap) return;

    const w = this.bitmap.width * this.view.scale;
    const h = this.bitmap.height * this.view.scale;
    ctx.imageSmoothingEnabled = this.view.scale < 1;
    ctx.drawImage(this.bitmap, this.view.dx, this.view.dy, w, h);

    if (this.mode === 'crop' && this.cropRect) this.drawCrop();
    if (this.mode === 'anchors' && this.analysis) this.drawAnalysis();
    void cssWidth;
  }

  private drawCrop(): void {
    const ctx = this.ctx;
    const r = this.cropRect!;
    const a = this.toScreen(r.x0, r.y0);
    const b = this.toScreen(r.x1, r.y1);
    const full = { x: this.view.dx, y: this.view.dy, w: this.bitmap!.width * this.view.scale, h: this.bitmap!.height * this.view.scale };

    ctx.save();
    ctx.fillStyle = 'rgba(12,16,24,0.55)';
    ctx.beginPath();
    ctx.rect(full.x, full.y, full.w, full.h);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fill('evenodd');

    ctx.strokeStyle = '#4dabf7';
    ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);

    // Thirds guides help line the crop up with the plot frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const x = a.x + ((b.x - a.x) * i) / 3;
      const y = a.y + ((b.y - a.y) * i) / 3;
      ctx.beginPath();
      ctx.moveTo(x, a.y);
      ctx.lineTo(x, b.y);
      ctx.moveTo(a.x, y);
      ctx.lineTo(b.x, y);
      ctx.stroke();
    }

    ctx.fillStyle = '#4dabf7';
    for (const [hx, hy] of [
      [a.x, a.y],
      [(a.x + b.x) / 2, a.y],
      [b.x, a.y],
      [b.x, (a.y + b.y) / 2],
      [b.x, b.y],
      [(a.x + b.x) / 2, b.y],
      [a.x, b.y],
      [a.x, (a.y + b.y) / 2],
    ]) {
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE / 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawAnalysis(): void {
    const ctx = this.ctx;
    const analysis = this.analysis!;
    const frame = analysis.frame;

    ctx.save();
    // Plot frame.
    const p0 = this.toScreen(frame.rect.x0, frame.rect.y0);
    const p1 = this.toScreen(frame.rect.x1, frame.rect.y1);
    ctx.strokeStyle = 'rgba(77,171,247,0.85)';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.setLineDash([]);

    // Detected ticks.
    ctx.fillStyle = 'rgba(77,171,247,0.9)';
    for (const t of analysis.xTicks) {
      const s = this.toScreen(t.px, frame.rect.y1);
      ctx.fillRect(s.x - 0.75, s.y, 1.5, t.value !== undefined ? 9 : 5);
    }
    for (const t of analysis.yTicks) {
      const s = this.toScreen(frame.rect.x0, t.px);
      ctx.fillRect(s.x - (t.value !== undefined ? 9 : 5), s.y - 0.75, t.value !== undefined ? 9 : 5, 1.5);
    }

    // Traced series.
    analysis.series.forEach((series, i) => {
      if (!this.visible.has(i)) return;
      const colour = series.traced.colour;
      const stroke = `rgb(${Math.round(colour.r)},${Math.round(colour.g)},${Math.round(colour.b)})`;
      const points = series.traced.points;
      // The overlay has to be visibly *different* from the ink underneath it,
      // otherwise the user cannot tell a good trace from no trace at all.
      if (series.traced.mode === 'marker') {
        ctx.lineWidth = 2;
        for (const p of points) {
          const s = this.toScreen(p.px + series.mask.rect.x0, p.py + series.mask.rect.y0);
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.strokeStyle = stroke;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        const trace = () => {
          ctx.beginPath();
          points.forEach((p, j) => {
            const s = this.toScreen(p.px + series.mask.rect.x0, p.py + series.mask.rect.y0);
            if (j === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          });
          ctx.stroke();
        };
        ctx.lineJoin = 'round';
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 3.5;
        ctx.globalAlpha = 0.55;
        trace();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        trace();
        ctx.setLineDash([]);
      }
    });

    this.drawAnchors();
    ctx.restore();
  }

  private drawAnchors(): void {
    const ctx = this.ctx;
    if (!this.calibration || !this.bitmap) return;
    const left = this.view.dx;
    const top = this.view.dy;
    const right = left + this.bitmap.width * this.view.scale;
    const bottom = top + this.bitmap.height * this.view.scale;

    for (const a of this.anchorPositions()) {
      const active = this.hover === a.id || this.anchorDrag === a.id;
      const colour = a.axis === 'x' ? '#f76707' : '#12b886';
      const s = this.toScreen(a.axis === 'x' ? a.px : 0, a.axis === 'y' ? a.px : 0);
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      if (a.axis === 'x') {
        ctx.moveTo(s.x, top);
        ctx.lineTo(s.x, bottom);
      } else {
        ctx.moveTo(left, s.y);
        ctx.lineTo(right, s.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Grab handle, kept inside the canvas so it is always reachable.
      const hx = a.axis === 'x' ? s.x : left + (a.id === 'ya' ? 16 : 40);
      const hy = a.axis === 'x' ? bottom - (a.id === 'xa' ? 16 : 40) : s.y;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(hx, hy, active ? HANDLE / 2 : HANDLE / 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.id === 'xa' || a.id === 'ya' ? 'A' : 'B', hx, hy + 0.5);
      ctx.restore();
    }
  }
}

function cursorFor(handle: AnchorId | CropHandle | null): string {
  switch (handle) {
    case 'xa':
    case 'xb':
      return 'ew-resize';
    case 'ya':
    case 'yb':
      return 'ns-resize';
    case 'move':
      return 'move';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    default:
      return 'default';
  }
}

export function cssColour(c: RGB): string {
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}
