/**
 * Core data types for the plot2data extraction engine.
 *
 * Everything in `src/engine` is pure TypeScript with no DOM dependency: images
 * are plain RGBA buffers, never `HTMLCanvasElement` or `ImageData`. This keeps
 * the engine unit-testable under Node and reusable from the Android wrapper.
 */

/** A raw RGBA image buffer. Structurally compatible with `ImageData`. */
export interface ImageBuffer {
  readonly width: number;
  readonly height: number;
  /** Length must be `width * height * 4`, in R,G,B,A order. */
  readonly data: Uint8ClampedArray;
}

/** An axis-aligned rectangle in pixel coordinates. `x1`/`y1` are inclusive. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Which side of the plot area an axis lives on. */
export type AxisSide = 'bottom' | 'left';

/** A detected straight axis line (spine). */
export interface SpineLine {
  /** Position across the perpendicular direction: y for horizontal, x for vertical. */
  pos: number;
  /** Thickness in pixels. */
  thickness: number;
  /** Extent of the line along its own direction, inclusive. */
  start: number;
  end: number;
  /** Mean ink strength along the run, 0..1. Higher is a stronger/darker line. */
  strength: number;
}

/** The detected plot frame: the rectangle enclosing the data area. */
export interface PlotFrame {
  /** Data area in image pixel coordinates (inside the spines). */
  rect: Rect;
  bottom: SpineLine | null;
  left: SpineLine | null;
  top: SpineLine | null;
  right: SpineLine | null;
  /** Estimated background colour of the plot interior. */
  background: RGB;
  /** True when the background is darker than the ink (dark-theme plot). */
  darkTheme: boolean;
  /** 0..1 confidence that this is a real plot frame rather than a guess. */
  confidence: number;
}

/** A tick mark found geometrically on an axis. */
export interface Tick {
  /** Pixel position along the axis (x for bottom axis, y for left axis). */
  px: number;
  /** Tick length in pixels. */
  length: number;
  /** True for the longer of the two length populations when minor ticks exist. */
  major: boolean;
}

/** A tick together with whatever label text was read next to it. */
export interface LabelledTick extends Tick {
  /** Raw OCR text, if any. */
  text?: string;
  /** Parsed numeric value, if the text parsed cleanly. */
  value?: number;
  /** OCR confidence 0..1, if the provider reported one. */
  confidence?: number;
}

export type AxisScale = 'linear' | 'log';

/** One calibration anchor: a pixel position with a known data value. */
export interface Anchor {
  px: number;
  value: number;
  /** Where this anchor came from, for UI display. */
  source: 'ocr' | 'manual' | 'default';
}

/**
 * Maps pixels to data values along one axis.
 *
 * The mapping is always defined by exactly two anchors, so it is always fully
 * visible and editable by the user. Extra labelled ticks are used only to
 * *choose* between the linear and log models, never to silently fit a curve.
 */
export interface AxisCalibration {
  side: AxisSide;
  scale: AxisScale;
  a: Anchor;
  b: Anchor;
  /** Multiplicative factor from an axis offset annotation, e.g. `1e6`. */
  multiplier: number;
  /** Additive offset from an axis offset annotation, e.g. `+3.14`. */
  offset: number;
  /** How the scale was chosen. */
  scaleSource: 'fit' | 'default' | 'manual';
  /** Residual comparison that produced `scaleSource === 'fit'`, if available. */
  scaleFit?: ScaleFitReport;
}

export interface ScaleFitReport {
  linearResidual: number;
  logResidual: number | null;
  /** Number of labelled ticks the comparison used. */
  samples: number;
  chosen: AxisScale;
  /** True when the residuals were too close to call and linear was assumed. */
  ambiguous: boolean;
}

/** An axis offset/multiplier annotation found in a corner of the axis region. */
export interface OffsetAnnotation {
  side: AxisSide;
  text: string;
  multiplier: number;
  offset: number;
  /** Pixel region the text was read from, for UI highlighting. */
  rect: Rect;
}

/** A colour cluster over the plot interior that is a candidate data series. */
export interface SeriesCandidate {
  colour: RGB;
  /** Number of ink pixels assigned to this cluster. */
  pixelCount: number;
  /** Fraction of plot-width columns that contain at least one pixel, 0..1. */
  columnCoverage: number;
  /** Bounding box of the cluster's pixels. */
  bounds: Rect;
  /** True when the cluster is nearly achromatic. */
  gray: boolean;
}

/** One traced point in pixel space, before calibration. */
export interface TracePoint {
  px: number;
  py: number;
  /** Total ink weight in this column; a proxy for line thickness. */
  weight: number;
  /** True when this point was interpolated across a gap rather than measured. */
  interpolated: boolean;
}

export type ExtractionMode = 'curve' | 'marker';

/** A fully traced series in pixel space. */
export interface TracedSeries {
  colour: RGB;
  mode: ExtractionMode;
  points: TracePoint[];
  /** Median vertical ink thickness in pixels; drives the uncertainty estimate. */
  thicknessPx: number;
  /** Median horizontal extent of a marker in pixels (marker mode only). */
  markerWidthPx: number;
}

/** Uncertainty in data units, derived from line thickness and axis scale. */
export interface Uncertainty {
  /** Half the line thickness expressed in x data units, at mid-axis. */
  x: number;
  y: number;
  /** For log axes the absolute error varies; this is the relative factor. */
  xRelative?: number;
  yRelative?: number;
}

/** A series after calibration, ready for export. */
export interface DataSeries {
  name: string;
  colour: RGB;
  mode: ExtractionMode;
  points: Array<{ x: number; y: number }>;
  uncertainty: Uncertainty;
}

export interface Calibration {
  x: AxisCalibration;
  y: AxisCalibration;
}
