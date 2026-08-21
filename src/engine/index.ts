/**
 * plot2data extraction engine - public API.
 *
 * Pure TypeScript with no DOM dependency: images are plain RGBA buffers, so the
 * same code runs in the browser, in Node tests, and inside the Android wrapper.
 */

export type {
  Anchor,
  AxisCalibration,
  AxisScale,
  AxisSide,
  Calibration,
  DataSeries,
  ExtractionMode,
  ImageBuffer,
  LabelledTick,
  OffsetAnnotation,
  PlotFrame,
  Rect,
  RGB,
  ScaleFitReport,
  SeriesCandidate,
  SpineLine,
  Tick,
  TracedSeries,
  TracePoint,
  Uncertainty,
} from './types.ts';

export { detectFrame, DEFAULT_FRAME_OPTIONS, insetRect, type FrameOptions } from './frame.ts';
export {
  detectTicks,
  findLabelBand,
  findLabelBlobs,
  labelRect,
  medianGap,
  resolveTickOptions,
  DEFAULT_TICK_OPTIONS,
  type TickOptions,
  type TickScan,
} from './ticks.ts';
export { parseLabel, parseOffsetAnnotation, unsuperscript, type ParsedLabel } from './parse-number.ts';
export {
  anchorsFromFit,
  calibrateAxis,
  describeAxis,
  fitAxis,
  formatValue,
  isValid,
  pixelToValue,
  scaleAt,
  valueToPixel,
  type AxisFit,
  type FitSample,
} from './calibration.ts';
export {
  buildMask,
  detectGridlines,
  findBlendArtefacts,
  findComponents,
  findSeriesCandidates,
  maskOfComponents,
  selectDataComponents,
  DEFAULT_SEGMENT_OPTIONS,
  clampInterior,
  type BlendArtefact,
  type Component,
  type GridInfo,
  type SegmentOptions,
  type SeriesMask,
} from './segment.ts';
export { traceCurve, traceMarkers, DEFAULT_TRACE_OPTIONS, type TraceOptions } from './trace.ts';
export {
  calibrateSeries,
  estimateUncertainty,
  resamplePixels,
  type ResampleMode,
} from './resample.ts';
export {
  annotationRects,
  axisUnit,
  readOffsetAnnotations,
  readTickLabels,
  splitSuperscript,
  NUMERIC_CHARSET,
  type OcrProvider,
  type OcrResult,
} from './labels.ts';
export {
  analyse,
  buildSeries,
  sharedSpan,
  suggestPointCount,
  tracedAs,
  type AnalyseOptions,
  type Analysis,
  type AnalysedSeries,
  type BuildOptions,
  type Warning,
  type WarningCode,
} from './pipeline.ts';
export { suggestSampling, type SamplingSuggestion } from './sampling.ts';
export {
  compact,
  csvHeader,
  describeUncertainty,
  toCsv,
  toTable,
  toXlsx,
  DELIMITERS,
  TOOL_VERSION,
  type CsvOptions,
  type DelimiterName,
} from './csv.ts';
export { writeXlsx, columnName, type Cell, type Sheet } from './xlsx.ts';
export {
  blendDistance,
  blendFit,
  colourDistance,
  createImage,
  cropImage,
  dominantColour,
  getPixel,
  inkAlpha,
  inkStrength,
  isGray,
  luma,
  saturation,
  scaleImage,
  setPixel,
  type BlendFit,
} from './image.ts';
