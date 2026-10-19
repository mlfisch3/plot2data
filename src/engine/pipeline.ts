/**
 * The extraction pipeline: image in, calibrated series out.
 *
 * `analyse` does the expensive work once (frame, ticks, OCR, segmentation,
 * tracing) and returns everything in pixel space. `buildSeries` then applies a
 * calibration, which is cheap, so the UI can re-run it on every anchor edit.
 */

import { detectFrame, type FrameOptions } from './frame.ts';
import { detectTicks, type TickOptions, type TickScan } from './ticks.ts';
import { readOffsetAnnotations, readTickLabels, axisUnit, type OcrProvider } from './labels.ts';
import { readLegendLabels, type LegendLabel } from './legend.ts';
import { readTextAnnotations, type TextAnnotations } from './text-annotations.ts';
import { calibrateAxis, isValid } from './calibration.ts';
import {
  buildMask,
  clampInterior,
  detectGridlines,
  findBlendArtefacts,
  findComponents,
  findSeriesCandidates,
  maskOfComponents,
  selectDataComponents,
  type Component,
  type SegmentOptions,
  type SeriesMask,
} from './segment.ts';
import { traceCurve, traceMarkers, type TraceOptions } from './trace.ts';
import { calibrateSeries, type ResampleMode } from './resample.ts';
import { suggestSampling, type SamplingSuggestion } from './sampling.ts';
import type {
  AxisScale,
  Calibration,
  DataSeries,
  ExtractionMode,
  ImageBuffer,
  LabelledTick,
  OffsetAnnotation,
  PlotFrame,
  SeriesCandidate,
  TracedSeries,
} from './types.ts';

export type WarningCode =
  | 'frame-uncertain'
  | 'no-ticks'
  | 'few-labels'
  | 'scale-ambiguous'
  | 'fit-residual'
  | 'offset-annotation'
  | 'no-ocr'
  | 'no-series'
  | 'halo-rejected'
  | 'markers-merged';

export interface Warning {
  code: WarningCode;
  /** 'info' is worth reading, 'warn' means check before you trust the export. */
  level: 'info' | 'warn';
  message: string;
}

export interface AnalyseOptions {
  ocr?: OcrProvider | null;
  frame?: Partial<FrameOptions>;
  ticks?: Partial<TickOptions>;
  segment?: Partial<SegmentOptions>;
  trace?: Partial<TraceOptions>;
  /** Force the extraction mode instead of auto-selecting it. */
  mode?: ExtractionMode;
  /** Cap on how many series to trace. */
  maxSeries?: number;
  /**
   * Read series names off the chart's legend. Defaults to doing it whenever an
   * OCR provider is available; `false` skips the work entirely.
   */
  readLabels?: boolean;
}

export interface AnalysedSeries {
  /** The reading for the mode currently in force. */
  traced: TracedSeries;
  /** The mode chosen from the shape of the ink, before any override. */
  autoMode: ExtractionMode;
  /** The same ink read as a drawn path. */
  curve: TracedSeries;
  /** The same ink read as discrete markers, one point per blob. */
  marker: TracedSeries;
  /** The mask the trace came from, kept so the UI can draw an overlay. */
  mask: SeriesMask;
  /** The components the trace was built from, in mask-local coordinates. */
  components: Component[];
  /** The colour cluster this series came from. */
  candidate: SeriesCandidate;
  /** Number of components discarded as in-plot text or stray marks. */
  rejectedComponents: number;
  /** Kept blobs wider than one marker: several markers drawn touching. */
  mergedComponents: number;
  /** A name read off the chart's legend, when one matched this colour. */
  label?: LegendLabel;
}

/** The reading of one analysed series under a given mode. */
export function tracedAs(series: AnalysedSeries, mode: ExtractionMode): TracedSeries {
  return mode === 'marker' ? series.marker : series.curve;
}

export interface Analysis {
  width: number;
  height: number;
  frame: PlotFrame;
  xScan: TickScan;
  yScan: TickScan;
  xTicks: LabelledTick[];
  yTicks: LabelledTick[];
  annotations: OffsetAnnotation[];
  candidates: SeriesCandidate[];
  series: AnalysedSeries[];
  /** Legend text matched to a series by colour. Cosmetic; see `legend.ts`. */
  legend: LegendLabel[];
  /** Chart title and axis titles OCR'd from text outside the plot frame. */
  textAnnotations: TextAnnotations;
  /** Calibration pre-filled from OCR; every field is user-editable. */
  calibration: Calibration;
  units: { x?: string; y?: string };
  warnings: Warning[];
}

/** Run the whole detection pipeline over one image. */
export async function analyse(img: ImageBuffer, options: AnalyseOptions = {}): Promise<Analysis> {
  const warnings: Warning[] = [];
  const frame = detectFrame(img, options.frame);
  if (frame.confidence < 0.5) {
    warnings.push({
      code: 'frame-uncertain',
      level: 'warn',
      message:
        'The plot frame could not be identified confidently. Crop to a single plot area and try again.',
    });
  }

  const xScan = detectTicks(img, frame, 'bottom', options.ticks);
  const yScan = detectTicks(img, frame, 'left', options.ticks);
  if (xScan.ticks.length < 2 || yScan.ticks.length < 2) {
    warnings.push({
      code: 'no-ticks',
      level: 'warn',
      message: 'Too few ticks or tick labels were found. Set the axis anchors by hand.',
    });
  }

  const ocr = options.ocr ?? null;
  if (!ocr) {
    warnings.push({
      code: 'no-ocr',
      level: 'info',
      message: 'Tick labels were not read automatically. Type the anchor values in.',
    });
  }

  const [xTicks, yTicks, annotations] = await Promise.all([
    readTickLabels(img, frame, xScan, ocr),
    readTickLabels(img, frame, yScan, ocr),
    readOffsetAnnotations(img, frame, ocr),
  ]);

  const units = { x: axisUnit(xTicks), y: axisUnit(yTicks) };
  const xAnn = annotations.find((a) => a.side === 'bottom');
  const yAnn = annotations.find((a) => a.side === 'left');
  for (const a of annotations) {
    warnings.push({
      code: 'offset-annotation',
      level: 'warn',
      message: `Found "${a.text}" next to the ${a.side === 'left' ? 'y' : 'x'} axis and read it as ${
        a.multiplier !== 1 ? `a x${a.multiplier} multiplier` : `a ${a.offset >= 0 ? '+' : ''}${a.offset} offset`
      }. Confirm this is right.`,
    });
  }

  const calibration: Calibration = {
    x: calibrateAxis('bottom', xTicks, frame.rect.x0, frame.rect.x1, {
      multiplier: xAnn?.multiplier,
      offset: xAnn?.offset,
    }),
    y: calibrateAxis('left', yTicks, frame.rect.y1, frame.rect.y0, {
      multiplier: yAnn?.multiplier,
      offset: yAnn?.offset,
    }),
  };

  for (const [name, cal] of [
    ['x', calibration.x],
    ['y', calibration.y],
  ] as const) {
    const fit = cal.scaleFit;
    if (!fit || fit.samples < 2) {
      warnings.push({
        code: 'few-labels',
        level: 'warn',
        message: `No ${name}-axis tick labels were read. Set both ${name} anchors by hand.`,
      });
      continue;
    }
    if (fit.ambiguous) {
      warnings.push({
        code: 'scale-ambiguous',
        level: 'warn',
        message:
          fit.samples < 3
            ? `Only ${fit.samples} ${name}-axis labels were read, which fit linear and log equally well. Linear was assumed - check the toggle.`
            : `The ${name} axis fits linear and log almost equally well. Check the scale toggle.`,
      });
    }
    if (fit.droppedLabels > 0) {
      warnings.push({
        code: 'fit-residual',
        level: 'warn',
        message: `${fit.droppedLabels} ${name}-axis tick label${fit.droppedLabels > 1 ? 's were' : ' was'} discarded as a misread before fitting. Check the ${name} anchors.`,
      });
    }
    const residual = cal.scale === 'log' ? (fit.logResidual ?? 0) : fit.linearResidual;
    if (residual > 0.02) {
      warnings.push({
        code: 'fit-residual',
        level: 'warn',
        message: `The ${name}-axis tick labels do not fit a straight ${cal.scale} scale well (residual ${(residual * 100).toFixed(1)}% of range). A label was probably misread.`,
      });
    }
  }

  // The gridline scan walks the whole interior, so do it once and share it.
  const grid = detectGridlines(img, frame, clampInterior(frame.rect, img, frame));
  // Nothing readable on either axis usually means the crop holds more than one
  // plot, or no plot at all. Say that, rather than exporting against a
  // placeholder 0-1 mapping the user might not notice.
  if (
    ocr &&
    !xTicks.some((t) => t.value !== undefined) &&
    !yTicks.some((t) => t.value !== undefined)
  ) {
    warnings.unshift({
      code: 'frame-uncertain',
      level: 'warn',
      message:
        'No tick labels were read on either axis. Crop to a single plot area, then set the four anchors by hand if they are still empty.',
    });
  }

  let candidates = findSeriesCandidates(img, frame, options.segment, grid).slice(
    0,
    options.maxSeries ?? 6,
  );
  const maskFor = (list: SeriesCandidate[]) => {
    const colours = list.map((c) => c.colour);
    return list.map((c) => buildMask(img, frame, c.colour, colours, options.segment, grid));
  };
  let masks = maskFor(candidates);

  // A halo is not a series. Drop any candidate that turns out to be the
  // antialiased edge of another, then rebuild the surviving masks without it,
  // so the ink it was holding goes back to the series it belongs to.
  const artefacts = findBlendArtefacts(candidates, masks, frame.background);
  if (artefacts.length > 0) {
    const dropped = new Set(artefacts.map((a) => a.index));
    for (const a of artefacts) {
      warnings.push({
        code: 'halo-rejected',
        level: 'info',
        message:
          `A colour found over ${Math.round(a.wrapShare * 100)}% of the ink of another series was ` +
          'rejected as its antialiased edge rather than reported as a series of its own.',
      });
    }
    candidates = candidates.filter((_, i) => !dropped.has(i));
    masks = maskFor(candidates);
  }

  const series: AnalysedSeries[] = [];
  candidates.forEach((candidate, index) => {
    const full = masks[index];
    const components = findComponents(full);
    if (components.length === 0) return;
    const selection = selectDataComponents(components, full);
    if (selection.kept.length === 0) return;
    const mask = maskOfComponents(full, selection.kept);

    // Both readings are computed and kept. Which one is right is a judgement
    // about the ink, and the user is entitled to disagree with it - per series,
    // on a chart that may well carry one of each - without paying for the whole
    // analysis a second time.
    const m = traceMarkers(selection.kept);
    const marker: TracedSeries = {
      colour: candidate.colour,
      mode: 'marker',
      points: m.points,
      thicknessPx: m.heightPx,
      markerWidthPx: m.markerWidthPx,
    };
    const t = traceCurve(mask, options.trace);
    const curve: TracedSeries = {
      colour: candidate.colour,
      mode: 'curve',
      points: t.points,
      thicknessPx: t.thicknessPx,
      markerWidthPx: 0,
    };

    // Markers drawn close enough to touch come back as one blob and so as one
    // point. That is the honest reading of the ink - there is nothing in the
    // picture that says where one marker ends and the next begins - but it is
    // worth saying out loud, because it is why a dense scatter reports fewer
    // points than were plotted.
    const mergedComponents = selection.kept.filter(
      (c) => c.bounds.x1 - c.bounds.x0 + 1 > marker.markerWidthPx * 1.6,
    ).length;

    const autoMode: ExtractionMode = selection.markerLike ? 'marker' : 'curve';
    const mode = options.mode ?? autoMode;
    if (mode === 'curve' && curve.points.length < 2) return;
    series.push({
      traced: mode === 'marker' ? marker : curve,
      autoMode,
      curve,
      marker,
      mask,
      components: selection.kept,
      candidate,
      rejectedComponents: selection.rejected.length,
      mergedComponents,
    });
  });

  const mergedTotal = series.reduce(
    (n, s) => n + (s.autoMode === 'marker' ? s.mergedComponents : 0),
    0,
  );
  if (mergedTotal > 0) {
    warnings.push({
      code: 'markers-merged',
      level: 'info',
      message:
        `${mergedTotal} blob${mergedTotal > 1 ? 's are' : ' is'} wider than a single marker, so ` +
        `${mergedTotal > 1 ? 'they hold' : 'it holds'} markers drawn close enough to touch. ` +
        'See the Output panel.',
    });
  }

  if (series.length === 0) {
    warnings.push({
      code: 'no-series',
      level: 'warn',
      message: 'No data series were found inside the plot area.',
    });
  }

  // Names last, and only after the data ink is known, so a marker can never be
  // mistaken for a letter. Nothing downstream of this touches a number.
  const legend =
    (options.readLabels ?? true)
      ? await readLegendLabels(
          img,
          frame,
          series.map((s) => s.traced.colour),
          ocr,
          { dataMasks: series.map((s) => s.mask) },
        )
      : [];
  for (const label of legend) series[label.index].label = label;

  // Chart title, axis titles, units. Cosmetic: these only reach the export
  // header and never change a number.
  const textAnnotations = await readTextAnnotations(
    img,
    frame,
    xScan.labelBand,
    yScan.labelBand,
    ocr,
  );
  if (textAnnotations.xUnit && !units.x) units.x = textAnnotations.xUnit;
  if (textAnnotations.yUnit && !units.y) units.y = textAnnotations.yUnit;

  return {
    width: img.width,
    height: img.height,
    frame,
    xScan,
    yScan,
    xTicks,
    yTicks,
    annotations,
    candidates,
    series,
    legend,
    textAnnotations,
    calibration,
    units,
    warnings,
  };
}

/**
 * A per-series mode choice. `undefined` at an index leaves that series on the
 * mode the ink itself suggested.
 */
export type ModeChoice = ReadonlyArray<ExtractionMode | undefined> | undefined;

export interface BuildOptions {
  calibration?: Calibration;
  resample?: ResampleMode;
  /** Override the auto-detected axis scales. */
  xScale?: AxisScale;
  yScale?: AxisScale;
  names?: string[];
  /** Series indices to build; the rest are left out entirely. */
  include?: ReadonlySet<number>;
  /** Per-series mode overrides; see `ModeChoice`. */
  modes?: ModeChoice;
}

/** The mode each series will actually be read in. */
export function resolveModes(analysis: Analysis, modes?: ModeChoice): ExtractionMode[] {
  return analysis.series.map((s, i) => modes?.[i] ?? s.autoMode);
}

/** The traced series in image coordinates rather than mask-local ones. */
function inImageSpace(analysis: Analysis, modes?: ModeChoice): TracedSeries[] {
  const chosen = resolveModes(analysis, modes);
  return analysis.series.map((s, i) => {
    const traced = tracedAs(s, chosen[i]);
    return {
      ...traced,
      points: traced.points.map((p) => ({
        ...p,
        px: p.px + s.mask.rect.x0,
        py: p.py + s.mask.rect.y0,
      })),
    };
  });
}

/**
 * The pixel range every curve series is resampled across.
 *
 * One grid for all of them, so the export is a single table with a single x
 * column rather than a column pair per series. Markers keep their own x, since
 * those are real sample positions and moving them onto a grid would be an
 * invention.
 */
export function sharedSpan(analysis: Analysis, modes?: ModeChoice): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of inImageSpace(analysis, modes)) {
    if (s.mode !== 'curve') continue;
    for (const p of s.points) {
      if (p.px < lo) lo = p.px;
      if (p.px > hi) hi = p.px;
    }
  }
  return hi > lo ? [lo, hi] : null;
}

/**
 * How many points to export, proposed from the drawn line itself.
 *
 * Cheap, and independent of the calibration, so the UI can ask for it once and
 * offer it as a default the user is free to overrule. It speaks only for the
 * curve series: a marker series has no count to propose, because the markers
 * themselves are the answer.
 */
export function suggestPointCount(analysis: Analysis, modes?: ModeChoice): SamplingSuggestion {
  const span = sharedSpan(analysis, modes);
  const width = span ? span[1] - span[0] : analysis.frame.rect.x1 - analysis.frame.rect.x0;
  return suggestSampling(inImageSpace(analysis, modes), width);
}

/** Apply a calibration to the analysed series. Cheap: safe to call per edit. */
export function buildSeries(analysis: Analysis, options: BuildOptions = {}): DataSeries[] {
  const cal = options.calibration ?? analysis.calibration;
  if (!isValid(cal.x) || !isValid(cal.y)) return [];
  const requested = options.resample ?? { kind: 'uniform' as const, count: 100 };
  const span = sharedSpan(analysis, options.modes);
  const mode: ResampleMode =
    requested.kind === 'uniform' && !requested.range && span
      ? { ...requested, range: span }
      : requested;
  const traced = inImageSpace(analysis, options.modes);
  const out: DataSeries[] = [];
  traced.forEach((s, i) => {
    if (options.include && !options.include.has(i)) return;
    out.push(calibrateSeries(s, cal, mode, options.names?.[i] ?? `series_${i + 1}`));
  });
  return out;
}
