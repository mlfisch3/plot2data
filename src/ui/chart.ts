/**
 * The middle panel: the extracted numbers, drawn as a chart in their own right.
 *
 * Not a picture of the trace over the image - that is the panel below - but a
 * plot built from the exported values, so that what you are looking at is what
 * the CSV contains. Checking an extraction by pasting it into a spreadsheet and
 * drawing a chart is exactly what the captain did; this is that check, built in.
 *
 * It is drawn in *image* pixel coordinates and labelled in data units. That
 * sounds backwards until you want the three panels to share a zoom: they then
 * all speak the same coordinates, and the axis labels are simply the
 * calibration applied to whatever pixels are on screen.
 */

import { formatValue, pixelToValue, valueToPixel } from '../engine/calibration.ts';
import type { Calibration, DataSeries, Rect } from '../engine/types.ts';
import { Viewport, type WorldRect } from './viewport.ts';
import { cssColour } from './stage.ts';

export interface ChartTheme {
  background: string;
  axis: string;
  grid: string;
  text: string;
}

export interface ChartData {
  series: DataSeries[];
  calibration: Calibration;
  /** Plot rectangle in image pixels; the chart's own drawing area. */
  rect: Rect;
  units: { x?: string; y?: string };
  /** Marker radius in CSS pixels; 0 draws lines only. */
  pointRadius: number;
}

/** Room for the axis labels, in CSS pixels. */
const PAD = { left: 58, right: 12, top: 12, bottom: 26 };
const PLOT_BOX = (w: number, h: number) => ({
  x: PAD.left,
  y: PAD.top,
  w: w - PAD.left - PAD.right,
  h: h - PAD.top - PAD.bottom,
});

export class ReplotChart {
  readonly viewport: Viewport;
  private ctx: CanvasRenderingContext2D;
  private data: ChartData | null = null;
  private hover: { x: number; y: number } | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private theme: () => ChartTheme,
    onUserView?: (v: Viewport) => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.viewport = new Viewport(canvas, ctx, {
      world: () => this.world(),
      draw: () => this.render(),
      onUserView,
      onProbe: (p) => {
        this.hover = p;
        this.render();
      },
      inset: () => PAD,
      aspect: 0.52,
      minHeight: 190,
      maxHeight: 380,
    });
  }

  setData(data: ChartData | null): void {
    this.data = data;
    this.render();
  }

  resize(): void {
    this.viewport.resize();
  }

  private world(): WorldRect {
    const r = this.data?.rect;
    if (!r) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
  }

  /**
   * The plot area, inset for the axis labels.
   *
   * The viewport transform covers the whole canvas, so the inset is applied by
   * clipping and by drawing the labels outside the clip - not by shrinking the
   * transform, which would stop the panels from sharing a window.
   */
  render(): void {
    const ctx = this.ctx;
    const theme = this.theme();
    const w = this.viewport.cssWidth;
    const h = this.viewport.cssHeight;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    if (!this.data || w <= 0) return;

    const { calibration, series } = this.data;
    const plot = PLOT_BOX(w, h);
    if (plot.w <= 10 || plot.h <= 10) return;

    ctx.fillStyle = theme.background;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    // Data values at the edges of the plot area, through the calibration.
    const left = pixelToValue(calibration.x, this.viewport.toWorld(plot.x, 0).x);
    const right = pixelToValue(calibration.x, this.viewport.toWorld(plot.x + plot.w, 0).x);
    const top = pixelToValue(calibration.y, this.viewport.toWorld(0, plot.y).y);
    const bottom = pixelToValue(calibration.y, this.viewport.toWorld(0, plot.y + plot.h).y);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    const xTicks = niceTicks(left, right, calibration.x.scale, Math.max(2, Math.round(plot.w / 90)));
    const yTicks = niceTicks(bottom, top, calibration.y.scale, Math.max(2, Math.round(plot.h / 46)));
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (const v of xTicks) {
      const s = this.viewport.toScreen(valueToPixel(calibration.x, v), 0).x;
      ctx.beginPath();
      ctx.moveTo(Math.round(s) + 0.5, plot.y);
      ctx.lineTo(Math.round(s) + 0.5, plot.y + plot.h);
      ctx.stroke();
    }
    for (const v of yTicks) {
      const s = this.viewport.toScreen(0, valueToPixel(calibration.y, v)).y;
      ctx.beginPath();
      ctx.moveTo(plot.x, Math.round(s) + 0.5);
      ctx.lineTo(plot.x + plot.w, Math.round(s) + 0.5);
      ctx.stroke();
    }

    for (const s of series) this.drawSeries(s);
    ctx.restore();

    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);

    ctx.fillStyle = theme.text;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xTicks) {
      const s = this.viewport.toScreen(valueToPixel(calibration.x, v), 0).x;
      if (s < plot.x - 2 || s > plot.x + plot.w + 2) continue;
      ctx.fillText(formatValue(v), s, plot.y + plot.h + 6);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yTicks) {
      const s = this.viewport.toScreen(0, valueToPixel(calibration.y, v)).y;
      if (s < plot.y - 2 || s > plot.y + plot.h + 2) continue;
      ctx.fillText(formatValue(v), plot.x - 6, s);
    }

    this.drawReadout(plot, theme);
  }

  private drawSeries(series: DataSeries): void {
    const ctx = this.ctx;
    const { calibration, pointRadius } = this.data!;
    const stroke = cssColour(series.colour);
    const screen = series.points.map((p) => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      const s = this.viewport.toScreen(
        valueToPixel(calibration.x, p.x),
        valueToPixel(calibration.y, p.y),
      );
      return Number.isFinite(s.x) && Number.isFinite(s.y) ? s : null;
    });

    if (series.mode === 'curve') {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (const s of screen) {
        if (!s) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
        pen = true;
      }
      ctx.stroke();
    }
    if (series.mode === 'marker' || pointRadius > 0) {
      ctx.fillStyle = stroke;
      const r = series.mode === 'marker' ? Math.max(1.5, pointRadius) : pointRadius;
      for (const s of screen) {
        if (!s) continue;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** The value under the pointer, so a spike can be read off without exporting. */
  private drawReadout(
    plot: { x: number; y: number; w: number; h: number },
    theme: ChartTheme,
  ): void {
    const at = this.hover;
    if (!at || !this.data) return;
    if (at.x < plot.x || at.x > plot.x + plot.w || at.y < plot.y || at.y > plot.y + plot.h) return;
    const { calibration, series } = this.data;
    const world = this.viewport.toWorld(at.x, at.y);
    const x = pixelToValue(calibration.x, world.x);

    const rows: string[] = [`x ${formatValue(x)}${this.data.units.x ? ` ${this.data.units.x}` : ''}`];
    for (const s of series) {
      const near = nearestByX(s, x);
      if (near) rows.push(`${s.name} ${formatValue(near.y)}`);
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const width = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 14;
    const height = rows.length * 14 + 8;
    const bx = Math.min(plot.x + plot.w - width - 4, at.x + 12);
    const by = Math.min(plot.y + plot.h - height - 4, at.y + 12);
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(at.x) + 0.5, plot.y);
    ctx.lineTo(Math.round(at.x) + 0.5, plot.y + plot.h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(16,20,28,0.88)';
    ctx.fillRect(bx, by, width, height);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    rows.forEach((r, i) => ctx.fillText(r, bx + 7, by + 5 + i * 14));
    ctx.restore();
  }
}

function nearestByX(series: DataSeries, x: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const p of series.points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d = Math.abs(p.x - x);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * Tick values a person would choose: 1, 2 or 5 times a power of ten, and whole
 * decades on a log axis.
 */
export function niceTicks(lo: number, hi: number, scale: 'linear' | 'log', target: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  if (!(max > min)) return [];

  if (scale === 'log') {
    const from = Math.floor(Math.log10(Math.max(min, 1e-300)));
    const to = Math.ceil(Math.log10(Math.max(max, 1e-300)));
    const stride = Math.max(1, Math.ceil((to - from) / Math.max(1, target)));
    const out: number[] = [];
    for (let e = from; e <= to; e += stride) out.push(Math.pow(10, e));
    return out.filter((v) => v >= min * 0.999 && v <= max * 1.001);
  }

  const raw = (max - min) / Math.max(1, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    // Snap away the accumulated float error so 0.30000000000000004 never shows.
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}
