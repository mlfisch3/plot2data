/**
 * The middle panel: the extracted numbers, drawn as a chart in their own right.
 *
 * Not a picture of the trace over the image - that is the panel below - but a
 * plot built from the exported values, so that what you are looking at is what
 * the CSV contains. Checking an extraction by pasting it into a spreadsheet and
 * drawing a chart is exactly what the captain did; this is that check, built in.
 *
 * It is an Apache ECharts chart, tree-shaken to the pieces used, because the
 * things you want to do to a chart you are checking - drag a box round a region
 * and zoom into it, pan, hover a point and read its value, hide a series - are
 * a charting library's job and not worth rewriting by hand on a canvas. ECharts
 * was chosen over the alternatives on three constraints, in this order:
 *
 * - **It bundles.** No CDN, no runtime fetch, nothing to load on a phone with
 *   no signal. The engine's no-network rule is absolute and the Android app
 *   holds no INTERNET permission, so a library that wants a network at runtime
 *   is not a candidate at all.
 * - **Touch works.** Pinch to zoom, drag to pan and drag-to-select a region are
 *   all first-class in ECharts rather than mouse events with touch bolted on,
 *   which is what decides whether the tool is usable on the S24 it targets.
 * - **Region-select zoom is built in**, as the toolbox `dataZoom` feature, so
 *   the interaction the captain asked for is configuration rather than code.
 *
 * Chart.js was the other candidate and is already a devDependency for the
 * corpus generator; its zoom plugin is a separate package and its touch story
 * is weaker. uPlot is smaller and faster but has no built-in region select.
 *
 * The chart speaks *data units*; the two other panels speak image pixels. The
 * calibration converts between them, which is the same round trip the overlay
 * panel is built on, so a shared zoom cannot drift from what is being drawn.
 */

import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { formatValue, pixelToValue, valueToPixel } from '../engine/calibration.ts';
import type { Calibration, DataSeries, Rect } from '../engine/types.ts';
import { cssColour } from './stage.ts';
import type { WorldRect } from './viewport.ts';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  ToolboxComponent,
  DataZoomInsideComponent,
  CanvasRenderer,
]);

/** Marker shapes offered per series. `none` draws no marker at all. */
export const MARKER_SHAPES = [
  'circle',
  'rect',
  'triangle',
  'diamond',
  'roundRect',
  'pin',
  'arrow',
  'none',
] as const;

export type MarkerShape = (typeof MARKER_SHAPES)[number];

/** How one series is drawn, in both this panel and the overlay. */
export interface SeriesStyle {
  colour: string;
  shape: MarkerShape;
  /** Marker diameter in CSS pixels. */
  size: number;
  /** Draw a line through the points. */
  line: boolean;
  lineWidth: number;
}

export interface ChartTheme {
  background: string;
  axis: string;
  grid: string;
  text: string;
}

export interface ChartData {
  series: DataSeries[];
  /** One style per entry of `series`, in the same order. */
  styles: SeriesStyle[];
  calibration: Calibration;
  /** Plot rectangle in image pixels; the window the panel opens on. */
  rect: Rect;
  units: { x?: string; y?: string };
}

/** The x/y data window a chart is showing. */
interface DataWindow {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export class ReplotChart {
  private chart: echarts.ECharts | null = null;
  private data: ChartData | null = null;
  /** Guards against echoing a window we were just handed back out again. */
  private applying = false;

  constructor(
    readonly host: HTMLElement,
    private theme: () => ChartTheme,
    private onUserView?: (window: WorldRect) => void,
  ) {}

  private ensure(): echarts.ECharts {
    if (!this.chart) {
      this.chart = echarts.init(this.host, undefined, { renderer: 'canvas' });
      this.chart.on('dataZoom', () => {
        if (this.applying) return;
        const w = this.visibleWindow();
        if (w) this.onUserView?.(w);
      });
    }
    return this.chart;
  }

  setData(data: ChartData | null): void {
    this.data = data;
    if (!data) {
      this.chart?.clear();
      return;
    }
    const chart = this.ensure();
    chart.setOption(this.option(data), { notMerge: true });
  }

  /** Redraw with new styles or values, keeping the current zoom. */
  update(data: ChartData): void {
    const before = this.rawWindow();
    this.data = data;
    const chart = this.ensure();
    chart.setOption(this.option(data), { notMerge: true });
    if (!before) return;
    // Restoring our own window is not the user moving the chart, and letting it
    // escape as one would drag the other two panels along on every repaint.
    this.applying = true;
    this.applyWindow(before);
    this.applying = false;
  }

  resize(): void {
    this.chart?.resize();
  }

  resetView(): void {
    const data = this.data;
    if (!data) return;
    this.applyWindow(fullExtent(data));
  }

  dispose(): void {
    this.chart?.dispose();
    this.chart = null;
  }

  /** The visible window in *image pixel* coordinates, for the other panels. */
  visibleWindow(): WorldRect | null {
    const data = this.data;
    const w = this.rawWindow();
    if (!data || !w) return null;
    const cal = data.calibration;
    return {
      x0: valueToPixel(cal.x, w.x0),
      x1: valueToPixel(cal.x, w.x1),
      // Pixel y runs downwards, so the larger value is the smaller pixel.
      y0: valueToPixel(cal.y, w.y1),
      y1: valueToPixel(cal.y, w.y0),
    };
  }

  /** Show the same place another panel is showing. */
  showWindow(window: WorldRect): void {
    const data = this.data;
    if (!data) return;
    const cal = data.calibration;
    const y0 = pixelToValue(cal.y, window.y1);
    const y1 = pixelToValue(cal.y, window.y0);
    this.applying = true;
    this.applyWindow({
      x0: pixelToValue(cal.x, window.x0),
      x1: pixelToValue(cal.x, window.x1),
      y0: Math.min(y0, y1),
      y1: Math.max(y0, y1),
    });
    this.applying = false;
  }

  private rawWindow(): DataWindow | null {
    const chart = this.chart;
    const data = this.data;
    if (!chart || !data) return null;
    const zooms = (chart.getOption() as { dataZoom?: Array<Record<string, unknown>> }).dataZoom;
    if (!zooms || zooms.length < 2) return null;
    const value = (i: number, key: string, fallback: number) => {
      const v = zooms[i][key];
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    };
    const full = fullExtent(data);
    return {
      x0: value(0, 'startValue', full.x0),
      x1: value(0, 'endValue', full.x1),
      y0: value(1, 'startValue', full.y0),
      y1: value(1, 'endValue', full.y1),
    };
  }

  private applyWindow(w: DataWindow): void {
    const chart = this.chart;
    if (!chart) return;
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: w.x0, endValue: w.x1 });
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: w.y0, endValue: w.y1 });
  }

  private option(data: ChartData): echarts.EChartsCoreOption {
    const theme = this.theme();
    const cal = data.calibration;
    const xLog = cal.x.scale === 'log';
    const yLog = cal.y.scale === 'log';
    const axis = (log: boolean, unit: string | undefined, name: string) => ({
      type: log ? ('log' as const) : ('value' as const),
      name: unit ? `${name} (${unit})` : undefined,
      nameTextStyle: { color: theme.text },
      scale: true,
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.text, hideOverlap: true, formatter: axisLabel },
      splitLine: { lineStyle: { color: theme.grid } },
    });

    return {
      animation: false,
      backgroundColor: theme.background,
      // The box below holds the grid *and its axis labels*, so a wide label
      // shrinks the plot rather than being clipped by it. (`outerBoundsMode`
      // and `outerBoundsContain` are what `containLabel` was, before it was
      // deprecated in ECharts 6.)
      grid: {
        left: 6,
        right: 14,
        top: 30,
        bottom: 6,
        outerBoundsMode: 'same',
        outerBoundsContain: 'axisLabel',
      },
      legend: {
        type: 'scroll',
        top: 4,
        left: 6,
        // Room for the toolbox, which lives in the same strip on the right.
        right: 68,
        textStyle: { color: theme.text, fontSize: 11 },
        inactiveColor: theme.axis,
        // Names read off a chart's legend are sentences, and five of them do
        // not fit across a phone. Truncated at a whole number of characters
        // with the full name a tap away, rather than half-clipped by the edge.
        formatter: (name: string) => (name.length > 26 ? `${name.slice(0, 25)}…` : name),
        tooltip: { show: true },
        data: data.series.map((s) => s.name),
      },
      toolbox: {
        right: 8,
        top: 2,
        itemSize: 16,
        iconStyle: { borderColor: theme.text },
        feature: {
          dataZoom: {
            yAxisIndex: 'all',
            title: { zoom: 'Drag a box to zoom', back: 'Undo zoom' },
            brushStyle: { color: 'rgba(20,98,184,0.16)', borderColor: 'rgba(20,98,184,0.7)' },
          },
          restore: { title: 'Reset' },
        },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { formatter: ({ value }: { value: number }) => formatValue(value) } },
        confine: true,
        // A finger is not a mouse pointer: without this the readout only ever
        // appears where the finger already is, which is where it is hidden.
        triggerOn: 'mousemove|click',
        valueFormatter: (v: number) => formatValue(v),
      },
      xAxis: axis(xLog, data.units.x, 'x'),
      yAxis: axis(yLog, data.units.y, 'y'),
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true },
        { type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true },
      ],
      series: data.series.map((s, i) => seriesOption(s, data.styles[i], yLog, xLog)),
    };
  }
}

/**
 * One series, drawn to match what it came from and to show its points.
 *
 * A scatter source draws as unconnected markers and a curve source draws as a
 * line - and both show their markers by default, because the points are what
 * was actually extracted and hiding them behind a smooth line is how a bad
 * extraction looks fine.
 */
function seriesOption(
  s: DataSeries,
  style: SeriesStyle,
  yLog: boolean,
  xLog: boolean,
): Record<string, unknown> {
  const points = s.points.map((p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [null, null];
    // A log axis cannot show a value at or below zero; drop it rather than
    // letting the whole series fail to render.
    if ((yLog && p.y <= 0) || (xLog && p.x <= 0)) return [null, null];
    return [p.x, p.y];
  });
  const showMarker = style.shape !== 'none';
  const common = {
    name: s.name,
    data: points,
    symbol: showMarker ? style.shape : 'none',
    symbolSize: style.size,
    itemStyle: { color: style.colour },
    emphasis: { scale: 1.4 },
  };
  if (!style.line) {
    return { ...common, type: 'scatter', large: points.length > 2000, largeThreshold: 2000 };
  }
  return {
    ...common,
    type: 'line',
    showSymbol: showMarker,
    lineStyle: { color: style.colour, width: style.lineWidth },
    connectNulls: false,
    sampling: 'lttb',
  };
}

/**
 * Axis labels a person reads at a glance.
 *
 * A log axis is all powers of ten, and `1.000e+08` beside `10000` is the worst
 * of both conventions; whole decades get the short form and everything else
 * gets the engine's own formatting.
 */
function axisLabel(v: number): string {
  if (v > 0) {
    const e = Math.log10(v);
    if (Math.abs(e - Math.round(e)) < 1e-9 && (v >= 1e5 || v <= 1e-4)) {
      return `1e${Math.round(e)}`;
    }
  }
  return formatValue(v);
}

/** The window that shows everything, in data units. */
function fullExtent(data: ChartData): DataWindow {
  const cal = data.calibration;
  const x0 = pixelToValue(cal.x, data.rect.x0);
  const x1 = pixelToValue(cal.x, data.rect.x1);
  const ya = pixelToValue(cal.y, data.rect.y0);
  const yb = pixelToValue(cal.y, data.rect.y1);
  return {
    x0: Math.min(x0, x1),
    x1: Math.max(x0, x1),
    y0: Math.min(ya, yb),
    y1: Math.max(ya, yb),
  };
}

/** The default style for a series, from the way it was drawn. */
export function defaultStyle(series: DataSeries, index: number): SeriesStyle {
  const shapes: MarkerShape[] = ['circle', 'rect', 'triangle', 'diamond', 'roundRect', 'pin'];
  return {
    colour: cssColour(series.colour),
    shape: shapes[index % shapes.length],
    size: series.mode === 'marker' ? 7 : 5,
    line: series.mode === 'curve',
    lineWidth: 2,
  };
}
