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
  /**
   * Draw corners round rather than mitred.
   *
   * It matters at a sharp vertex, and only there. A mitred corner runs on past
   * the vertex - several pixels past it, for a 2 px line meeting itself at an
   * acute angle - so the ink at the tip of a spike is not where the data point
   * is. Matplotlib rounds by default and Chart.js mitres, so a corpus that
   * tests peak recovery has to carry one of each.
   */
  roundJoin?: boolean;
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
  /**
   * RMS budget for this case, as a percentage of full scale. Defaults to
   * `DEFAULT_RMS_BUDGET`. A series whose value moves a fifth of full scale
   * inside one pixel column cannot be read to a fifth of a percent at every x -
   * what matters there is whether the peaks come back at the right height, and
   * that is asserted separately and tightly.
   */
  rmsBudgetPercent?: number;
}

/** Default hard budget for the RMS error, as a percentage of full scale. */
export const DEFAULT_RMS_BUDGET = 0.5;

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
  // Four well-separated bands for the antialiasing-halo case. They never meet,
  // so every marker stands alone and the point count is unambiguous - what is
  // being tested there is colour, not merging.
  band1: (x) => 84 + 5 * Math.sin(x * 0.8),
  band2: (x) => 62 + 5 * Math.sin(x * 0.9 + 1),
  band3: (x) => 40 + 5 * Math.sin(x * 0.7 + 2),
  band4: (x) => 18 + 5 * Math.sin(x * 1.1 + 3),
  // Same shape as `sigmoid` but in the millions, to exercise a `1e6` axis
  // multiplier annotation: the axis is labelled 0..8 with `1e6` in the corner.
  megasigmoid: (x) => 1e6 * (0.4 + 7.2 / (1 + Math.exp(-(x - 6) / 1.2))),
  // Triangle wave: every extremum is a sharp vertex, so the drawn polyline *is*
  // the function and the apexes are exactly where a per-column centroid gets
  // dragged down off the tip. Period and phase are chosen so the extrema land
  // on sample points; see `TRIANGLE_PERIOD`.
  triangle: (x) => 12 + 76 * (1 - Math.abs(2 * frac(x / TRIANGLE_PERIOD) - 1)),
  // A slowly rising base with a narrow spike every two units - the shape of the
  // captain's monthly retail-sales chart, where the defect was found.
  narrowPeaks: (x) =>
    18 + 2.6 * x + 34 * Math.max(0, 1 - distanceToOddInteger(x) / SPIKE_HALF_WIDTH),
};

/** Period of the `triangle` wave, in x units. */
const TRIANGLE_PERIOD = 1.5;
/** Half-width of a `narrowPeaks` spike, in x units. */
const SPIKE_HALF_WIDTH = 0.15;

function frac(v: number): number {
  return v - Math.floor(v);
}

/** Spikes sit on the odd integers; this is how far x is from the nearest one. */
function distanceToOddInteger(x: number): number {
  const p = frac((x - 1) / 2);
  return 2 * Math.min(p, 1 - p);
}

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
    /**
     * Antialiasing halos must never be promoted to a series.
     *
     * Every marker here is drawn with a hard edge against white paper, so each
     * one is ringed by a one-pixel band of intermediate colours. Two of the
     * four colours are chosen to make that band dangerous:
     *
     * - `#ba0000` against white passes through mid-tones that are *nearer* the
     *   saturated `#cc6600` than the red they came from, in plain RGB distance.
     *   That is the microprocessor chart's defect exactly: read by nearest
     *   colour, every red marker donates a ring of specks to the orange series,
     *   which then measures one pixel thick and swamps the real orange markers.
     * - `#0000ba` and `#008700` are dark enough that their own edges run through
     *   the same mid-tone band, so all four series cast halos at once and the
     *   ink has to be attributed to four hosts rather than one.
     *
     * A tint of another series' colour - `#6666cc` beside `#0000ba`, say - is
     * deliberately *not* here: that is genuinely inseparable from an antialiased
     * edge by colour, and is recorded as a known limit rather than tested as if
     * it were solved.
     */
    id: 'scatter-halo-colours',
    description: 'Four antialiased marker series, two colours chosen to be mistaken for halos',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    samples: 22,
    scatter: true,
    pointRadius: 6,
    series: [
      { label: 'red', colour: '#ba0000', fn: 'band1' },
      { label: 'orange', colour: '#cc6600', fn: 'band2' },
      { label: 'blue', colour: '#0000ba', fn: 'band3' },
      { label: 'green', colour: '#008700', fn: 'band4' },
    ],
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
    id: 'sawtooth-sharp',
    description: 'Triangle wave, sharp mitred apexes and troughs - tests peak recovery',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    // 0.15 x units per vertex, so every extremum of the wave is a drawn vertex.
    samples: 81,
    rmsBudgetPercent: 0.6,
    series: [{ label: 'triangle', colour: OKABE.vermillion, fn: 'triangle', width: 2 }],
  },
  {
    id: 'narrow-peaks',
    description: 'Rising base with narrow tall spikes, corners rounded - a monthly series',
    width: 900,
    height: 560,
    grid: true,
    xScale: 'linear',
    yScale: 'linear',
    xMin: 0,
    xMax: 12,
    yMin: 0,
    yMax: 100,
    // 0.05 x units per vertex, so each spike is drawn as a narrow triangle.
    samples: 241,
    rmsBudgetPercent: 0.6,
    series: [{ label: 'narrowPeaks', colour: OKABE.blue, fn: 'narrowPeaks', width: 2, roundJoin: true }],
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
