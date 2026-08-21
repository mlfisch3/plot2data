/**
 * The interactive canvas: the image, the crop rectangle, and after extraction
 * the detected frame, the detected ticks and the four draggable anchors.
 *
 * What it deliberately does *not* draw is the extraction. This is the one clean
 * view of the source the user has, and the check the tool is built around is
 * comparing it against the panels below; drawing our own points on top of the
 * chart's markers destroys the thing being compared against.
 *
 * It is driven by pointer events throughout, so a finger, a stylus and a mouse
 * take exactly the same path through the code. Two things follow from being
 * used on a phone: every grab target is at least `TOUCH_TARGET` across however
 * small the thing it grabs is drawn, and the image can be pinched and panned,
 * because the detail that decides whether a trace is right is a few pixels wide
 * and a phone screen is held at arm's length.
 *
 * Anchors are drawn as full-height (or full-width) guide lines with a chunky
 * grab handle: on a phone a thin line is impossible to hit. They are named
 * X1/X2 across the bottom and Y1/Y2 up the side, in the axis colours, and while
 * one is being dragged a magnifier opens on the pixels underneath it.
 */

import type { Analysis } from '../engine/pipeline.ts';
import type { Calibration, Rect, RGB } from '../engine/types.ts';
import { drawMagnifier, type MagnifierGuide } from './magnifier.ts';

export type AnchorId = 'xa' | 'xb' | 'ya' | 'yb';
export type CropHandle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface StageCallbacks {
  onCropChange(rect: Rect): void;
  onAnchorChange(id: AnchorId, px: number): void;
  /** Fires when the zoom or pan changes, so the UI can offer a way back to fit. */
  onViewChange?(zoomed: boolean): void;
}

/** What each anchor is called on screen, on the handle and in the export. */
export const ANCHOR_LABELS: Record<AnchorId, string> = {
  xa: 'X1',
  xb: 'X2',
  ya: 'Y1',
  yb: 'Y2',
};

export const AXIS_COLOURS = { x: '#f76707', y: '#12b886' } as const;

interface View {
  scale: number;
  dx: number;
  dy: number;
}

/** Radius of the drawn handle. The target around it is TOUCH_TARGET wide. */
const HANDLE = 22;
/** Apple and Google both land on 44px; a guide line is drawn 1.5px wide. */
const TOUCH_TARGET = 44;
const GRAB = TOUCH_TARGET / 2;
const MAX_ZOOM = 12;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 28;
const TAP_SLOP = 10;

type Gesture =
  | { kind: 'crop'; handle: CropHandle; start: Rect; ox: number; oy: number }
  | { kind: 'anchor'; id: AnchorId }
  | { kind: 'pan'; ox: number; oy: number; startDx: number; startDy: number }
  | { kind: 'pinch'; distance: number; cx: number; cy: number; startScale: number; startDx: number; startDy: number };

export class Stage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: View = { scale: 1, dx: 0, dy: 0 };
  private fitScale = 0;
  private bitmap: ImageBitmap | null = null;
  private cropRect: Rect | null = null;
  private analysis: Analysis | null = null;
  private calibration: Calibration | null = null;
  private mode: 'crop' | 'anchors' = 'crop';
  private gesture: Gesture | null = null;
  private hover: AnchorId | CropHandle | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private downAt: { x: number; y: number; time: number } | null = null;
  private lastTap: { x: number; y: number; time: number } | null = null;
  private moved = false;
  /** Where the pointer is while an anchor is being dragged, for the magnifier. */
  private probe: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, private callbacks: StageCallbacks) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    // Not passive: zooming the image must not scroll the page behind it.
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse' && !this.gesture) {
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
    this.fitScale = 0;
    this.resize();
  }

  setAnalysis(analysis: Analysis | null, calibration: Calibration | null): void {
    this.analysis = analysis;
    this.calibration = calibration;
    this.mode = analysis ? 'anchors' : 'crop';
    this.render();
  }

  setCalibration(calibration: Calibration): void {
    this.calibration = calibration;
    this.render();
  }

  get cropping(): boolean {
    return this.mode === 'crop';
  }

  get zoomed(): boolean {
    return this.fitScale > 0 && this.view.scale > this.fitScale * 1.02;
  }

  /** The image rectangle currently on screen, for a linked panel to match. */
  visibleWindow(): { x0: number; y0: number; x1: number; y1: number } {
    const a = this.toImage(0, 0);
    const b = this.toImage(this.cssWidth(), this.cssHeight());
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }

  /** Show this image rectangle: the x range exactly, the y range centred. */
  showWindow(w: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.bitmap || !(w.x1 > w.x0) || this.cssWidth() <= 0) return;
    this.view.scale = Math.max(this.fitScale, this.cssWidth() / (w.x1 - w.x0));
    this.view.dx = -w.x0 * this.view.scale;
    this.view.dy = this.cssHeight() / 2 - ((w.y0 + w.y1) / 2) * this.view.scale;
    this.clampView();
    this.render();
  }

  /** Back to the whole image, centred. */
  resetView(): void {
    if (!this.bitmap) return;
    this.view = this.fittedView();
    this.render();
    this.callbacks.onViewChange?.(false);
  }

  /**
   * Fit the canvas to its container and recompute the image transform.
   *
   * A rotation is a resize, and losing the zoom on rotate is exactly the sort of
   * thing that makes a phone app annoying, so the zoom factor and the point in
   * the middle of the view are both carried across.
   */
  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent || !this.bitmap) {
      this.render();
      return;
    }
    const previousFit = this.fitScale;
    const before = this.centreImagePoint();

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cssWidth = parent.clientWidth;
    const cssHeight = this.preferredHeight(cssWidth);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.fitScale = Math.min(cssWidth / this.bitmap.width, cssHeight / this.bitmap.height);
    const zoom = previousFit > 0 ? this.view.scale / previousFit : 1;
    this.view = this.fittedView();
    if (zoom > 1.02 && before) {
      this.view.scale = this.fitScale * zoom;
      this.centreOn(before.x, before.y);
    }
    this.clampView();
    this.render();
  }

  /**
   * How tall the stage should be.
   *
   * The image's own aspect ratio decides, but within bounds: never so short that
   * there is nowhere to zoom into, and never so tall that the controls below it
   * are pushed off a phone screen.
   */
  private preferredHeight(cssWidth: number): number {
    const bitmap = this.bitmap!;
    const viewport = window.innerHeight || 800;
    const natural = cssWidth * (bitmap.height / bitmap.width);
    const min = Math.min(280, Math.round(viewport * 0.36));
    const max = Math.round(viewport * 0.66);
    return Math.round(Math.max(min, Math.min(natural, max)));
  }

  private fittedView(): View {
    const bitmap = this.bitmap!;
    const cssWidth = this.cssWidth();
    const cssHeight = this.cssHeight();
    return {
      scale: this.fitScale,
      dx: (cssWidth - bitmap.width * this.fitScale) / 2,
      dy: (cssHeight - bitmap.height * this.fitScale) / 2,
    };
  }

  private cssWidth(): number {
    return this.canvas.clientWidth || parseFloat(this.canvas.style.width) || 0;
  }

  private cssHeight(): number {
    return this.canvas.clientHeight || parseFloat(this.canvas.style.height) || 0;
  }

  private centreImagePoint(): { x: number; y: number } | null {
    if (!this.bitmap || this.view.scale <= 0) return null;
    return this.toImage(this.cssWidth() / 2, this.cssHeight() / 2);
  }

  private centreOn(imageX: number, imageY: number): void {
    this.view.dx = this.cssWidth() / 2 - imageX * this.view.scale;
    this.view.dy = this.cssHeight() / 2 - imageY * this.view.scale;
  }

  /**
   * Keep the image from being flung out of the frame: if it is bigger than the
   * canvas it may not be dragged past its own edge, and if it is smaller it
   * stays centred on that axis.
   */
  private clampView(): void {
    if (!this.bitmap) return;
    const cssWidth = this.cssWidth();
    const cssHeight = this.cssHeight();
    const w = this.bitmap.width * this.view.scale;
    const h = this.bitmap.height * this.view.scale;
    this.view.dx = w <= cssWidth ? (cssWidth - w) / 2 : Math.min(0, Math.max(cssWidth - w, this.view.dx));
    this.view.dy = h <= cssHeight ? (cssHeight - h) / 2 : Math.min(0, Math.max(cssHeight - h, this.view.dy));
  }

  private zoomAbout(screenX: number, screenY: number, factor: number): void {
    if (!this.bitmap || this.fitScale <= 0) return;
    const next = Math.max(this.fitScale, Math.min(this.fitScale * MAX_ZOOM, this.view.scale * factor));
    if (next === this.view.scale) return;
    const anchor = this.toImage(screenX, screenY);
    this.view.scale = next;
    this.view.dx = screenX - anchor.x * next;
    this.view.dy = screenY - anchor.y * next;
    this.clampView();
    this.callbacks.onViewChange?.(this.zoomed);
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return { x: this.view.dx + x * this.view.scale, y: this.view.dy + y * this.view.scale };
  }

  private toImage(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.view.dx) / this.view.scale, y: (y - this.view.dy) / this.view.scale };
  }

  private pointerPos(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /* --------------------------------------------------------------- input */

  private onPointerDown = (event: PointerEvent) => {
    if (!this.bitmap) return;
    const p = this.pointerPos(event);
    this.pointers.set(event.pointerId, p);
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // The pointer can already be gone by the time this runs - a very fast tap,
      // or a touch the system took over. Losing capture is survivable; throwing
      // out of the handler and leaving the gesture half-started is not.
    }
    event.preventDefault();

    if (this.pointers.size === 2) {
      this.beginPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    this.downAt = { x: p.x, y: p.y, time: event.timeStamp };
    this.moved = false;

    if (this.mode === 'anchors') {
      const id = this.anchorAt(p);
      this.gesture = id ? { kind: 'anchor', id } : this.beginPan(p);
      if (id) {
        this.probe = p;
        this.render();
      }
      return;
    }

    const handle = this.cropRect ? this.cropHandleAt(p) : null;
    if (handle && this.cropRect) {
      const img = this.toImage(p.x, p.y);
      this.gesture = { kind: 'crop', handle, start: { ...this.cropRect }, ox: img.x, oy: img.y };
    } else {
      this.gesture = this.beginPan(p);
    }
  };

  private beginPan(p: { x: number; y: number }): Gesture {
    return { kind: 'pan', ox: p.x, oy: p.y, startDx: this.view.dx, startDy: this.view.dy };
  }

  private beginPinch(): void {
    const [a, b] = Array.from(this.pointers.values());
    this.gesture = {
      kind: 'pinch',
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      startScale: this.view.scale,
      startDx: this.view.dx,
      startDy: this.view.dy,
    };
    this.downAt = null;
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.bitmap) return;
    const p = this.pointerPos(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, p);

    if (this.downAt && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > TAP_SLOP) {
      this.moved = true;
    }

    const gesture = this.gesture;
    if (gesture?.kind === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = Array.from(this.pointers.values());
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const scale = Math.max(
        this.fitScale,
        Math.min(this.fitScale * MAX_ZOOM, (gesture.startScale * distance) / gesture.distance),
      );
      // Zoom about the point the fingers started around, and let the midpoint
      // moving pan at the same time - that is what a two-finger drag feels like.
      const factor = scale / gesture.startScale;
      this.view.scale = scale;
      this.view.dx = cx - (gesture.cx - gesture.startDx) * factor;
      this.view.dy = cy - (gesture.cy - gesture.startDy) * factor;
      this.clampView();
      this.render();
      this.callbacks.onViewChange?.(this.zoomed);
      return;
    }

    if (gesture?.kind === 'anchor') {
      const img = this.toImage(p.x, p.y);
      this.probe = p;
      this.callbacks.onAnchorChange(gesture.id, gesture.id.startsWith('x') ? img.x : img.y);
      return;
    }

    if (gesture?.kind === 'crop' && this.cropRect) {
      const img = this.toImage(p.x, p.y);
      this.callbacks.onCropChange(this.applyHandle(gesture, img.x, img.y));
      return;
    }

    if (gesture?.kind === 'pan') {
      this.view.dx = gesture.startDx + (p.x - gesture.ox);
      this.view.dy = gesture.startDy + (p.y - gesture.oy);
      this.clampView();
      this.render();
      return;
    }

    if (event.pointerType !== 'mouse') return;
    const next = this.mode === 'anchors' ? this.anchorAt(p) : this.cropHandleAt(p);
    if (next !== this.hover) {
      this.hover = next;
      this.canvas.style.cursor = cursorFor(next, this.mode);
      this.render();
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Same again: capture may have been dropped for us already.
    }
    this.pointers.delete(event.pointerId);

    if (this.gesture?.kind === 'pinch') {
      // Dropping to one finger continues as a pan rather than stopping dead.
      const remaining = Array.from(this.pointers.values())[0];
      this.gesture = remaining ? this.beginPan(remaining) : null;
      if (!remaining) this.callbacks.onViewChange?.(this.zoomed);
      return;
    }

    const wasAnchor = this.gesture?.kind === 'anchor';
    this.gesture = null;
    this.probe = null;
    if (wasAnchor) this.render();

    const down = this.downAt;
    this.downAt = null;
    if (!down || this.moved || this.pointers.size > 0) {
      this.lastTap = null;
      return;
    }
    this.handleTap(down, event.timeStamp);
  };

  /** Double-tap toggles between the whole image and a close look at that spot. */
  private handleTap(down: { x: number; y: number }, time: number): void {
    const previous = this.lastTap;
    const isDouble =
      previous !== null &&
      time - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(down.x - previous.x, down.y - previous.y) < DOUBLE_TAP_SLOP;
    if (!isDouble) {
      this.lastTap = { x: down.x, y: down.y, time };
      return;
    }
    this.lastTap = null;
    if (this.zoomed) this.resetView();
    else {
      this.zoomAbout(down.x, down.y, 3);
      this.render();
    }
  }

  private onWheel = (event: WheelEvent) => {
    if (!this.bitmap) return;
    event.preventDefault();
    const p = this.pointerPos(event);
    this.zoomAbout(p.x, p.y, Math.exp(-event.deltaY * 0.0016));
    this.render();
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
    // An edge target may not eat more than a third of the rectangle, or a small
    // crop becomes impossible to move because every point is an edge.
    const slop = Math.min(GRAB, Math.max(12, (b.x - a.x) / 3), Math.max(12, (b.y - a.y) / 3));
    const near = (v: number, target: number) => Math.abs(v - target) <= slop;
    if (p.x < a.x - slop || p.x > b.x + slop || p.y < a.y - slop || p.y > b.y + slop) return null;
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

  /**
   * Which anchor a press grabs: the nearest knob, and only failing that the
   * nearest guide line.
   *
   * The two passes are not interchangeable. Guide lines cross the whole canvas,
   * so an x guide that happens to run past a y anchor's knob sits a pixel or two
   * from every point of it - and a single nearest-thing-wins test would then
   * make that knob unpickable, which is precisely the case a phone user hits.
   * The knob is what looks grabbable, so the knob wins.
   */
  private anchorAt(p: { x: number; y: number }): AnchorId | null {
    const anchors = this.anchorPositions();
    let best: AnchorId | null = null;
    // Inclusive, so the target really is TOUCH_TARGET across and not a pixel shy.
    let bestD = GRAB + 0.001;

    for (const a of anchors) {
      const handle = this.handlePosition(a);
      const d = Math.hypot(p.x - handle.x, p.y - handle.y);
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    if (best) return best;

    bestD = GRAB + 0.001;
    for (const a of anchors) {
      const s = this.toScreen(a.axis === 'x' ? a.px : 0, a.axis === 'y' ? a.px : 0);
      const d = a.axis === 'x' ? Math.abs(p.x - s.x) : Math.abs(p.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    return best;
  }

  /**
   * Where an anchor's grab handle sits.
   *
   * Both coordinates are held a full grab radius inside the canvas. An anchor
   * parked against the edge of the image - which is exactly where the last tick
   * on an axis tends to be - would otherwise have most of its target off the
   * canvas and be nearly impossible to pick up. The two anchors on an axis keep
   * their own row (or column) so a clamped handle is still unambiguous.
   */
  private handlePosition(a: { id: AnchorId; axis: 'x' | 'y'; px: number }): { x: number; y: number } {
    const s = this.toScreen(a.axis === 'x' ? a.px : 0, a.axis === 'y' ? a.px : 0);
    const lane = a.id === 'xa' || a.id === 'ya' ? GRAB - 4 : GRAB + 26;
    // Zoomed in far enough, every guide is off screen and all four handles are
    // clamped to their edges - where the x row and the y column meet in the
    // corner, and two handles would sit on top of each other. Each axis's
    // handles keep clear of the other axis's lane, so the pair in the corner
    // stays two separate targets.
    const other = GRAB + 26 + HANDLE / 2 + 6;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    return a.axis === 'x'
      ? {
          x: clamp(s.x, other, this.cssWidth() - GRAB),
          y: this.cssHeight() - lane,
        }
      : {
          x: lane,
          y: clamp(s.y, GRAB, this.cssHeight() - other),
        };
  }

  /* -------------------------------------------------------------- drawing */

  render(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    if (!this.bitmap) return;

    const w = this.bitmap.width * this.view.scale;
    const h = this.bitmap.height * this.view.scale;
    // Smooth when shrinking, crisp when magnified: at 8x the user is looking at
    // individual pixels of the trace and interpolation would hide what they came
    // to check.
    ctx.imageSmoothingEnabled = this.view.scale < 1;
    ctx.drawImage(this.bitmap, this.view.dx, this.view.dy, w, h);

    if (this.mode === 'crop' && this.cropRect) this.drawCrop();
    if (this.mode === 'anchors' && this.analysis) this.drawAnalysis();
  }

  private drawCrop(): void {
    const ctx = this.ctx;
    const r = this.cropRect!;
    const a = this.toScreen(r.x0, r.y0);
    const b = this.toScreen(r.x1, r.y1);

    ctx.save();
    // Shade the whole canvas outside the crop, not just the image: when the
    // image is zoomed past the edges the shading has to reach the frame.
    ctx.fillStyle = 'rgba(12,16,24,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, this.cssWidth(), this.cssHeight());
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
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
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
      ctx.stroke();
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

    // Nothing else. The extraction goes over the image in the overlay panel and
    // nowhere else: drawing it here too costs the user the one clean view of
    // the source they have, and the captain spent real effort deciding whether
    // his chart had strange snowflake markers before realising the speckles on
    // every red triangle were ours.

    this.drawAnchors();
    ctx.restore();
  }

  private drawAnchors(): void {
    const ctx = this.ctx;
    if (!this.calibration || !this.bitmap) return;
    const width = this.cssWidth();
    const height = this.cssHeight();

    for (const a of this.anchorPositions()) {
      const active = this.hover === a.id || (this.gesture?.kind === 'anchor' && this.gesture.id === a.id);
      const colour = a.axis === 'x' ? '#f76707' : '#12b886';
      const s = this.toScreen(a.axis === 'x' ? a.px : 0, a.axis === 'y' ? a.px : 0);
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      // Guides span the canvas, so they stay grabbable when the image is panned.
      if (a.axis === 'x') {
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, height);
      } else {
        ctx.moveTo(0, s.y);
        ctx.lineTo(width, s.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const handle = this.handlePosition(a);
      // A halo makes the handle legible over dark plot ink as well as light.
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, (active ? HANDLE / 2 : HANDLE / 2.4) + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, active ? HANDLE / 2 : HANDLE / 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ANCHOR_LABELS[a.id], handle.x, handle.y + 0.5);
      ctx.restore();
    }

    this.drawDragMagnifier();
  }

  /**
   * The magnifier, while a marker is being dragged.
   *
   * Only the guide lines are passed through to it, never the handles: the
   * handles are screen furniture parked at the edge of the canvas and would
   * mean nothing blown up eight times.
   */
  private drawDragMagnifier(): void {
    const gesture = this.gesture;
    if (!gesture || gesture.kind !== 'anchor' || !this.probe || !this.bitmap || !this.calibration) return;
    const image = this.toImage(this.probe.x, this.probe.y);
    const guides: MagnifierGuide[] = this.anchorPositions().map((a) => ({
      axis: a.axis,
      px: a.px,
      colour: a.axis === 'x' ? AXIS_COLOURS.x : AXIS_COLOURS.y,
    }));
    const dragged = this.anchorPositions().find((a) => a.id === gesture.id)!;
    drawMagnifier(this.ctx, {
      bitmap: this.bitmap,
      at: this.probe,
      image,
      canvasWidth: this.cssWidth(),
      canvasHeight: this.cssHeight(),
      guides,
      label: `${ANCHOR_LABELS[gesture.id]} at ${dragged.px.toFixed(1)} px`,
    });
  }

  /**
   * Zoom about the tick nearest the middle of the view.
   *
   * Zooming in on nothing in particular is useless, and the thing a marker is
   * nearly always being lined up against is a tick. It is where the view
   * *lands*, never where the marker snaps to: an anchor may be put anywhere,
   * including somewhere no tick was drawn.
   */
  zoomStep(factor: number): void {
    if (!this.bitmap) return;
    const centre = this.toImage(this.cssWidth() / 2, this.cssHeight() / 2);
    const target = factor > 1 ? this.nearestTick(centre) : centre;
    const screen = this.toScreen(target.x, target.y);
    this.zoomAbout(screen.x, screen.y, factor);
    this.render();
  }

  private nearestTick(to: { x: number; y: number }): { x: number; y: number } {
    const analysis = this.analysis;
    if (!analysis) return to;
    const near = (values: number[], v: number) =>
      values.length ? values.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : v;
    const x = near(analysis.xTicks.map((t) => t.px), to.x);
    const y = near(analysis.yTicks.map((t) => t.px), to.y);
    // Only pull towards a tick that is actually close by; a tick half a plot
    // away is not what the user is looking at.
    const limit = Math.max(40, this.cssWidth() / (4 * Math.max(1e-6, this.view.scale)));
    return {
      x: Math.abs(x - to.x) < limit ? x : to.x,
      y: Math.abs(y - to.y) < limit ? y : to.y,
    };
  }
}

function cursorFor(handle: AnchorId | CropHandle | null, mode: 'crop' | 'anchors'): string {
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
      return mode === 'anchors' ? 'grab' : 'default';
  }
}

export function cssColour(c: RGB): string {
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}
