/**
 * Declarative description of the synthetic ground-truth corpus.
 *
 * Every case is generated from a known analytic function, so ground truth is
 * exact: we evaluate the same function to compare against extracted output.
 * Shared by the generator (`tools/generate-corpus.ts`) and the accuracy test.
 */

export type Fn = (x: number) => number;

export interface SeriesSpec {
  label: string;
  colour: string;
  /** Name of the analytic function, resolved through `FUNCTIONS`. */
  fn: string;
  dashed?: boolean;
  width?: number;
}

export interface CaseSpec {
  id: string;
  description: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  format?: 'png' | 'jpeg';
  jpegQuality?: number;
  dark?: boolean;
  grid?: boolean;
  xScale: 'linear' | 'logarithmic';
  yScale: 'linear' | 'logarithmic';
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Number of vertices in the drawn polyline. High = the drawn path is the function. */
  samples: number;
  series: SeriesSpec[];
  /** Render discrete markers instead of a connected line. */
  scatter?: boolean;
  /** Marker radius in px when `scatter` or `showMarkers` is set. */
  pointRadius?: number;
  /** Scale y tick labels by this factor and print the factor in the corner. */
  yOffsetAnnotation?: string;
  /** Multiply the true y values by this before plotting (paired with the annotation). */
  yDisplayDivisor?: number;
  /** Known-hard case: excluded from the pass/fail budget but still measured. */
  stretch?: boolean;
}

export const FUNCTIONS: Record<string, Fn> = {
  // Smooth, bounded, non-monotonic: the general case for curve tracing.
  damped: (x) => 50 + 40 * Math.exp(-x / 8) * Math.sin(x * 0.9),
  // Monotonic with varying slope, including steep regions.
  sigmoid: (x) => 5 + 90 / (1 + Math.exp(-(x - 6) / 1.2)),
  // Gentle parabola.
  parabola: (x) => 10 + 0.55 * (x - 6) * (x - 6) * 2,
  // Straight line: exercises the easiest possible case exactly.
  linear: (x) => 8 + 7 * x,
  // Decaying exponential for log-y axes.
  decay: (x) => 80 * Math.pow(10, -x / 4),
  // Power law for log-log axes.
  power: (x) => 0.5 * Math.pow(x, 1.8),
  // Second log-y series with a different decay constant.
  decay2: (x) => 12 * Math.pow(10, -x / 9),
  // Slow riser, used as a second series on linear axes.
  riser: (x) => 20 + 3.5 * x + 6 * Math.sin(x * 0.5),
  // Same shape as `sigmoid` but in the millions, to exercise a `1e6` axis
  // multiplier annotation: the axis is labelled 0..8 with `1e6` in the corner.
  megasigmoid: (x) => 1e6 * (0.4 + 7.2 / (1 + Math.exp(-(x - 6) / 1.2))),
};

const OKABE = {
  blue: '#0072B2',
  orange: '#E69F00',
  green: '#009E73',
  vermillion: '#D55E00',
  purple: '#CC79A7',
};

export const CASES: CaseSpec[] = [
  {
    id: 'linear-single-solid',
    description: 'Linear axes, one solid line, gridlines, light theme',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'damped', colour: OKABE.blue, fn: 'damped', width: 2 }],
  },
  {
    id: 'linear-single-nogrid',
    description: 'Linear axes, one solid line, no gridlines',
    width: 900,
    height: 560,
    grid: false,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'sigmoid', colour: OKABE.vermillion, fn: 'sigmoid', width: 2 }],
  },
  {
    id: 'linear-thin-line',
    description: 'Linear axes, 1px line, gridlines - tests thin-ink tracing',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'parabola', colour: OKABE.green, fn: 'parabola', width: 1 }],
  },
  {
    id: 'linear-thick-line',
    description: 'Linear axes, 5px line - tests centroid vs thickness',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'damped', colour: OKABE.purple, fn: 'damped', width: 5 }],
  },
  {
    id: 'linear-dashed',
    description: 'Linear axes, dashed line - tests gap bridging',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'sigmoid', colour: OKABE.blue, fn: 'sigmoid', width: 2, dashed: true }],
  },
  {
    id: 'linear-multi',
    description: 'Linear axes, three series, gridlines - tests colour separation',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [
      { label: 'damped', colour: OKABE.blue, fn: 'damped', width: 2 },
      { label: 'sigmoid', colour: OKABE.orange, fn: 'sigmoid', width: 2 },
      { label: 'riser', colour: OKABE.green, fn: 'riser', width: 2 },
    ],
  },
  {
    id: 'dark-theme',
    description: 'Dark theme, two series, gridlines',
    width: 900,
    height: 560,
    dark: true,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [
      { label: 'damped', colour: '#4FC3F7', fn: 'damped', width: 2 },
      { label: 'riser', colour: '#FFB74D', fn: 'riser', width: 2 },
    ],
  },
  {
    id: 'log-y',
    description: 'Logarithmic y axis, one series, gridlines',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'logarithmic',
    xMin: 0,
    xMax: 12,
    yMin: 0.01,
    yMax: 100,
    samples: 400,
    series: [{ label: 'decay', colour: OKABE.vermillion, fn: 'decay', width: 2 }],
  },
  {
    id: 'log-y-multi',
    description: 'Logarithmic y axis, two series',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'logarithmic',
    xMin: 0,
    xMax: 12,
    yMin: 0.01,
    yMax: 100,
    samples: 400,
    series: [
      { label: 'decay', colour: OKABE.blue, fn: 'decay', width: 2 },
      { label: 'decay2', colour: OKABE.green, fn: 'decay2', width: 2 },
    ],
  },
  {
    id: 'scatter-markers',
    description: 'Scatter plot with discrete circular markers - marker mode',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 25,
    scatter: true,
    pointRadius: 5,
    series: [{ label: 'damped', colour: OKABE.blue, fn: 'damped' }],
  },
  {
    id: 'jpeg-compressed',
    description: 'JPEG at quality 80 - tests robustness to compression artefacts',
    width: 900,
    height: 560,
    grid: true,
    format: 'jpeg',
    jpegQuality: 80,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'damped', colour: OKABE.blue, fn: 'damped', width: 2 }],
  },
  {
    id: 'offset-annotation',
    description: 'Linear y axis labelled 0..8 with a 1e6 corner multiplier',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 8e6,
    yDisplayDivisor: 1e6,
    yOffsetAnnotation: '1e6',
    samples: 400,
    series: [{ label: 'megasigmoid', colour: OKABE.blue, fn: 'megasigmoid', width: 2 }],
  },
  {
    id: 'retina-2x',
    description: 'Rendered at deviceScaleFactor 2, as a retina screenshot would be',
    width: 700,
    height: 440,
    deviceScaleFactor: 2,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'damped', colour: OKABE.blue, fn: 'damped', width: 2 }],
  },
  {
    id: 'log-log',
    description: 'Log x and log y axes, power law',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'logarithmic',
    yScale: 'logarithmic',
    xMin: 0.1,
    xMax: 100,
    yMin: 0.001,
    yMax: 1000,
    samples: 400,
    series: [{ label: 'power', colour: OKABE.purple, fn: 'power', width: 2 }],
  },
  {
    id: 'narrow-small',
    description: 'Small 480x320 plot - tests behaviour at low pixel budget',
    width: 480,
    height: 320,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 400,
    series: [{ label: 'damped', colour: OKABE.blue, fn: 'damped', width: 2 }],
  },
];
