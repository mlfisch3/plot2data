/**
 * Pan and zoom over a canvas, in whatever coordinates the panel thinks in.
 *
 * The three result panels all show the same plot in the same pixel coordinates -
 * the cropped image's - so one class drives all of them, and linking their zoom
 * is then a matter of handing the same visible window to each.
 *
 * Everything is pointer events, so a finger, a stylus and a mouse take one path
 * through the code, and the gestures match the crop stage: drag to pan, wheel or
 * pinch to zoom, double-tap between fit and a close look.
 */

/** A rectangle in world (image pixel) coordinates. */
export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ViewportOptions {
  /** Full extent of the content, in world coordinates. */
  world(): WorldRect;
  /** Repaint. Called after every view change. */
  draw(): void;
  /** Fires when the user changes the view, so a link can mirror it. */
  onUserView?(view: Viewport): void;
  /** Called on press/drag/release, for a panel that wants a magnifier. */
  onProbe?(point: { x: number; y: number } | null): void;
  /**
   * Padding, in CSS pixels, between the canvas edge and the content box.
   *
   * The chart panel keeps a gutter for its axis labels. The content has to be
   * fitted into what is left, or the left-hand end of the plot disappears under
   * the y labels - and, worse, two linked panels with different gutters would
   * disagree about which part of the plot they are showing.
   */
  inset?(): { left: number; right: number; top: number; bottom: number };
  /** Height of the canvas as a fraction of its width. */
  aspect?: number;
  /** Hard bounds on that height, in CSS pixels. */
  minHeight?: number;
  maxHeight?: number;
  maxZoom?: number;
}

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 28;
const TAP_SLOP = 10;

type Gesture =
  | { kind: 'pan'; ox: number; oy: number; startDx: number; startDy: number }
  | { kind: 'pinch'; distance: number; cx: number; cy: number; startScale: number; startDx: number; startDy: number };

export class Viewport {
  scale = 1;
  dx = 0;
  dy = 0;
  private fitScale = 0;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private downAt: { x: number; y: number; time: number } | null = null;
  private lastTap: { x: number; y: number; time: number } | null = null;
  private moved = false;
  /** Set while a linked viewport is being driven, so it does not echo back. */
  private mirroring = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly ctx: CanvasRenderingContext2D,
    private options: ViewportOptions,
  ) {
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get zoomed(): boolean {
    return this.fitScale > 0 && this.scale > this.fitScale * 1.02;
  }

  get cssWidth(): number {
    return this.canvas.clientWidth || parseFloat(this.canvas.style.width) || 0;
  }

  get cssHeight(): number {
    return this.canvas.clientHeight || parseFloat(this.canvas.style.height) || 0;
  }

  /** The box the content is fitted into, in CSS pixels. */
  private box(): { x: number; y: number; w: number; h: number } {
    const pad = this.options.inset?.() ?? { left: 0, right: 0, top: 0, bottom: 0 };
    return {
      x: pad.left,
      y: pad.top,
      w: Math.max(1, this.cssWidth - pad.left - pad.right),
      h: Math.max(1, this.cssHeight - pad.top - pad.bottom),
    };
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: this.dx + x * this.scale, y: this.dy + y * this.scale };
  }

  toWorld(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.dx) / this.scale, y: (y - this.dy) / this.scale };
  }

  pointerPos(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Size the backing store to the container and refit, keeping the zoom. */
  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const previousFit = this.fitScale;
    const before = this.scale > 0 ? this.toWorld(this.cssWidth / 2, this.cssHeight / 2) : null;

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cssWidth = Math.max(1, parent.clientWidth);
    const cssHeight = this.preferredHeight(cssWidth);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const zoom = previousFit > 0 ? this.scale / previousFit : 1;
    this.fit();
    if (zoom > 1.02 && before) {
      this.scale = this.fitScale * zoom;
      this.centreOn(before.x, before.y);
      this.clamp();
    }
    this.options.draw();
  }

  private preferredHeight(cssWidth: number): number {
    const world = this.options.world();
    const aspect = this.options.aspect ?? (world.y1 - world.y0) / Math.max(1, world.x1 - world.x0);
    const viewport = window.innerHeight || 800;
    const min = this.options.minHeight ?? Math.min(200, Math.round(viewport * 0.28));
    const max = this.options.maxHeight ?? Math.round(viewport * 0.6);
    return Math.round(Math.max(min, Math.min(cssWidth * aspect, max)));
  }

  /** Back to the whole content, centred in the content box. */
  fit(): void {
    const world = this.options.world();
    const w = world.x1 - world.x0;
    const h = world.y1 - world.y0;
    if (!(w > 0 && h > 0)) return;
    const box = this.box();
    this.fitScale = Math.min(box.w / w, box.h / h);
    this.scale = this.fitScale;
    this.dx = box.x + (box.w - w * this.scale) / 2 - world.x0 * this.scale;
    this.dy = box.y + (box.h - h * this.scale) / 2 - world.y0 * this.scale;
  }

  resetView(): void {
    this.fit();
    this.options.draw();
    if (!this.mirroring) this.options.onUserView?.(this);
  }

  /** The world rectangle currently on screen, inside the content box. */
  visibleWindow(): WorldRect {
    const box = this.box();
    const a = this.toWorld(box.x, box.y);
    const b = this.toWorld(box.x + box.w, box.y + box.h);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }

  /**
   * Show this world rectangle.
   *
   * Panels are not the same shape, so the x range is matched exactly and the
   * extra height, if any, is shared out around the middle: the same *region* is
   * on screen in each, which is what "share a zoom" has to mean when one panel
   * is a chart and another is a photograph.
   */
  showWindow(window_: WorldRect): void {
    const w = window_.x1 - window_.x0;
    if (!(w > 0) || this.cssWidth <= 0) return;
    const box = this.box();
    this.mirroring = true;
    this.scale = box.w / w;
    this.dx = box.x - window_.x0 * this.scale;
    this.dy = box.y + box.h / 2 - ((window_.y0 + window_.y1) / 2) * this.scale;
    this.clamp();
    this.options.draw();
    this.mirroring = false;
  }

  private centreOn(x: number, y: number): void {
    const box = this.box();
    this.dx = box.x + box.w / 2 - x * this.scale;
    this.dy = box.y + box.h / 2 - y * this.scale;
  }

  /**
   * Keep the content in the frame: bigger than the canvas, it may not be
   * dragged past its own edge; smaller, it stays centred on that axis.
   */
  private clamp(): void {
    const world = this.options.world();
    const box = this.box();
    const w = (world.x1 - world.x0) * this.scale;
    const h = (world.y1 - world.y0) * this.scale;
    const left = world.x0 * this.scale;
    const top = world.y0 * this.scale;
    this.dx =
      w <= box.w
        ? box.x + (box.w - w) / 2 - left
        : Math.min(box.x - left, Math.max(box.x + box.w - w - left, this.dx));
    this.dy =
      h <= box.h
        ? box.y + (box.h - h) / 2 - top
        : Math.min(box.y - top, Math.max(box.y + box.h - h - top, this.dy));
  }

  zoomAbout(screenX: number, screenY: number, factor: number): void {
    if (this.fitScale <= 0) return;
    const max = this.options.maxZoom ?? 14;
    const next = Math.max(this.fitScale, Math.min(this.fitScale * max, this.scale * factor));

    if (next === this.scale) return;
    const anchor = this.toWorld(screenX, screenY);
    this.scale = next;
    this.dx = screenX - anchor.x * next;
    this.dy = screenY - anchor.y * next;
    this.clamp();
  }

  /** Zoom in or out about the centre of the view, or about a world point. */
  step(factor: number, about?: { x: number; y: number }): void {
    const screen = about ? this.toScreen(about.x, about.y) : { x: this.cssWidth / 2, y: this.cssHeight / 2 };
    this.zoomAbout(screen.x, screen.y, factor);
    this.options.draw();
    this.options.onUserView?.(this);
  }

  /* --------------------------------------------------------------- input */

  private onPointerDown = (event: PointerEvent) => {
    const p = this.pointerPos(event);
    this.pointers.set(event.pointerId, p);
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A very fast tap can be gone before capture lands; losing it is
      // survivable, leaving the gesture half-started is not.
    }
    event.preventDefault();
    if (this.pointers.size === 2) {
      const [a, b] = Array.from(this.pointers.values());
      this.gesture = {
        kind: 'pinch',
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        startScale: this.scale,
        startDx: this.dx,
        startDy: this.dy,
      };
      this.downAt = null;
      this.options.onProbe?.(null);
      return;
    }
    if (this.pointers.size > 2) return;
    this.downAt = { x: p.x, y: p.y, time: event.timeStamp };
    this.moved = false;
    this.gesture = { kind: 'pan', ox: p.x, oy: p.y, startDx: this.dx, startDy: this.dy };
    this.options.onProbe?.(p);
  };

  private onPointerMove = (event: PointerEvent) => {
    const p = this.pointerPos(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, p);
    if (this.downAt && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > TAP_SLOP) this.moved = true;

    const gesture = this.gesture;
    if (gesture?.kind === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = Array.from(this.pointers.values());
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const max = this.options.maxZoom ?? 14;
      const scale = Math.max(
        this.fitScale,
        Math.min(this.fitScale * max, (gesture.startScale * distance) / gesture.distance),
      );
      const factor = scale / gesture.startScale;
      this.scale = scale;
      this.dx = cx - (gesture.cx - gesture.startDx) * factor;
      this.dy = cy - (gesture.cy - gesture.startDy) * factor;
      this.clamp();
      this.options.draw();
      this.options.onUserView?.(this);
      return;
    }
    if (gesture?.kind === 'pan') {
      this.dx = gesture.startDx + (p.x - gesture.ox);
      this.dy = gesture.startDy + (p.y - gesture.oy);
      this.clamp();
      this.options.onProbe?.(p);
      this.options.draw();
      this.options.onUserView?.(this);
      return;
    }
    if (event.pointerType === 'mouse') this.options.onProbe?.(p);
  };

  private onPointerUp = (event: PointerEvent) => {
    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may have been dropped for us already.
    }
    this.pointers.delete(event.pointerId);
    if (this.gesture?.kind === 'pinch') {
      const remaining = Array.from(this.pointers.values())[0];
      this.gesture = remaining
        ? { kind: 'pan', ox: remaining.x, oy: remaining.y, startDx: this.dx, startDy: this.dy }
        : null;
      return;
    }
    this.gesture = null;
    if (event.pointerType !== 'mouse') this.options.onProbe?.(null);

    const down = this.downAt;
    this.downAt = null;
    if (!down || this.moved || this.pointers.size > 0) {
      this.lastTap = null;
      return;
    }
    const previous = this.lastTap;
    const isDouble =
      previous !== null &&
      event.timeStamp - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(down.x - previous.x, down.y - previous.y) < DOUBLE_TAP_SLOP;
    if (!isDouble) {
      this.lastTap = { x: down.x, y: down.y, time: event.timeStamp };
      return;
    }
    this.lastTap = null;
    if (this.zoomed) this.resetView();
    else {
      this.zoomAbout(down.x, down.y, 3);
      this.options.draw();
      this.options.onUserView?.(this);
    }
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const p = this.pointerPos(event);
    this.zoomAbout(p.x, p.y, Math.exp(-event.deltaY * 0.0016));
    this.options.draw();
    this.options.onUserView?.(this);
  };
}
