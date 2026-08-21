/**
 * plot2data UI.
 *
 * A thin layer over `src/engine`: it loads pixels, lets the user crop, runs the
 * engine once, and then re-applies the calibration on every edit. All of the
 * numerical work lives in the engine, which knows nothing about the DOM.
 *
 * After extraction the page is three panels stacked one above the other - the
 * original, the extracted numbers re-plotted, and the two overlaid - because
 * that is the check a careful user performs anyway, and performing it in a
 * spreadsheet is how the peak clipping was found. Everything regenerates live:
 * move a marker, retype a value or change the point count and all three panels
 * and the export follow immediately.
 *
 * The same page runs in a browser tab and inside the Android shell. The three
 * differences a phone forces - an image arriving from a share sheet, a back
 * button that has to mean something, and a file that cannot simply be
 * "downloaded" - are handled here and in `ui/android.ts`, not by a second app.
 */

import './styles.css';
import {
  analyse,
  buildSeries,
  compact,
  describeAxis,
  describeUncertainty,
  formatValue,
  suggestPointCount,
  toCsv,
  toTable,
  toXlsx,
  DELIMITERS,
  type Analysis,
  type AxisScale,
  type Calibration,
  type DataSeries,
  type DelimiterName,
  type ExtractionMode,
  type ImageBuffer,
  type Rect,
  type SamplingSuggestion,
} from './engine/index.ts';
import { calibrateAxis } from './engine/calibration.ts';
import { BrowserOcr } from './ui/ocr.ts';
import { ACCEPT_ATTRIBUTE, cropBuffer, fileFromTransfer, loadImageFile } from './ui/image-io.ts';
import { Stage, cssColour, type AnchorId } from './ui/stage.ts';
import { defaultStyle, MARKER_SHAPES, ReplotChart, type SeriesStyle } from './ui/chart.ts';
import { OverlayPanel } from './ui/overlay.ts';
import type { WorldRect } from './ui/viewport.ts';
import {
  canShareCsv,
  exportFile,
  fetchIncoming,
  installHost,
  onAndroid,
  CSV_MIME,
  XLSX_MIME,
  type IncomingImage,
} from './ui/android.ts';

type Phase = 'empty' | 'cropping' | 'working' | 'ready';

interface State {
  phase: Phase;
  fileName: string;
  full: ImageBuffer | null;
  fullBitmap: ImageBitmap | null;
  crop: Rect | null;
  cropped: ImageBuffer | null;
  croppedBitmap: ImageBitmap | null;
  analysis: Analysis | null;
  calibration: Calibration | null;
  visible: Set<number>;
  names: string[];
  /** The name the chart's own legend gave each series, where it gave one. */
  readNames: string[];
  /** How each series is drawn, in the chart panel and in the overlay. */
  styles: SeriesStyle[];
  /** Per-series curve/marker choice; `auto` follows the shape of the ink. */
  modes: Array<'auto' | 'curve' | 'marker'>;
  /** `auto` follows the suggestion; the other two are the user's own choice. */
  sampling: 'auto' | 'uniform' | 'native';
  count: number;
  suggestion: SamplingSuggestion | null;
  modeOverride: 'auto' | 'curve' | 'marker';
  /** Read series names off the chart's legend. */
  readLabels: 'auto' | 'on' | 'off';
  delimiter: DelimiterName;
  withHeader: boolean;
  imageOpacity: number;
  pointRadius: number;
  magnify: boolean;
  linkZoom: boolean;
  busyMessage: string;
  error: string | null;
  /** More than one image was shared at once and the user has to pick. */
  choices: IncomingImage[];
  /** Id of the shared image the shell holds, so a restart can restore it. */
  token: string | null;
}

const state: State = {
  phase: 'empty',
  fileName: '',
  full: null,
  fullBitmap: null,
  crop: null,
  cropped: null,
  croppedBitmap: null,
  analysis: null,
  calibration: null,
  visible: new Set(),
  names: [],
  readNames: [],
  styles: [],
  modes: [],
  sampling: 'auto',
  count: 100,
  suggestion: null,
  modeOverride: 'auto',
  readLabels: 'auto',
  delimiter: 'comma',
  withHeader: true,
  imageOpacity: 0.45,
  pointRadius: 1,
  magnify: false,
  linkZoom: true,
  busyMessage: '',
  error: null,
  choices: [],
  token: null,
};

const ocr = new BrowserOcr();
const app = document.getElementById('app')!;

app.innerHTML = `
  <header class="masthead">
    <h1>plot2data</h1>
    <p>Read the numbers back out of a plot image. Everything runs on this device; nothing is uploaded.</p>
  </header>
  <div class="layout">
    <div class="stage-column">
      <div id="intake"></div>
      <div class="stage" id="stage-wrap" hidden>
        <header class="panel-head" id="stage-head" hidden>
          <h2>Original plot</h2>
          <span class="panel-note">Drag X1, X2, Y1 and Y2 onto ticks you can name.</span>
        </header>
        <canvas id="stage" aria-label="Plot image with crop and calibration overlay"></canvas>
        <div class="stage-bar">
          <span class="filename" id="filename"></span>
          <span class="zoomer" id="zoomer" hidden>
            <button id="zoom-out" aria-label="Zoom out" title="Zoom out">&minus;</button>
            <button id="zoom-in" aria-label="Zoom in" title="Zoom in to the nearest tick">+</button>
          </span>
          <button id="fit" hidden>Fit</button>
          <button id="reset">New image</button>
          <button id="recrop" hidden>Adjust crop</button>
          <button id="extract" class="primary" hidden>Extract data</button>
        </div>
      </div>

      <section class="panel-block" id="replot-block" hidden>
        <header class="panel-head">
          <h2>Extracted data</h2>
          <span class="panel-note" id="replot-note"></span>
        </header>
        <div class="chart-host" id="replot" role="img" aria-label="The extracted data re-plotted"></div>
        <div class="panel-tools">
          <button id="box-zoom" aria-pressed="false">Zoom to a box</button>
          <button id="replot-fit">Reset zoom</button>
          <label class="check-row"><input type="checkbox" id="link-zoom" checked /> Share zoom across panels</label>
          <span class="panel-note" id="replot-hint">Drag to pan, pinch or scroll to zoom.</span>
        </div>
      </section>

      <section class="panel-block" id="overlay-block" hidden>
        <header class="panel-head">
          <h2>Overlay on the original</h2>
          <span class="panel-note">Aligned through the calibration, not stretched to fit.</span>
        </header>
        <div class="panel-canvas"><canvas id="overlay" aria-label="The extracted data drawn over the original image"></canvas></div>
        <div class="panel-tools">
          <label for="opacity">Image</label>
          <input type="range" id="opacity" min="0" max="100" step="5" value="45"
            aria-label="Original image opacity" />
          <label for="point-size">Point size</label>
          <input type="range" id="point-size" min="0" max="2.5" step="0.1" value="1"
            aria-label="Point marker size" />
          <label class="check-row"><input type="checkbox" id="magnify" /> Magnifier</label>
          <button id="overlay-fit">Fit</button>
        </div>
      </section>

      <section class="panel-block" id="table-block" hidden>
        <header class="panel-head">
          <h2>Extracted numbers</h2>
          <span class="panel-note" id="table-note"></span>
        </header>
        <div class="data-table" id="data-table" tabindex="0"
          aria-label="The extracted numbers as a table"></div>
      </section>
    </div>
    <div id="panel"></div>
  </div>
`;

const intake = document.getElementById('intake')!;
const stageWrap = document.getElementById('stage-wrap') as HTMLDivElement;
const panel = document.getElementById('panel')!;
const filenameEl = document.getElementById('filename')!;
const extractBtn = document.getElementById('extract') as HTMLButtonElement;
const recropBtn = document.getElementById('recrop') as HTMLButtonElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const fitBtn = document.getElementById('fit') as HTMLButtonElement;
const zoomer = document.getElementById('zoomer') as HTMLSpanElement;
const stageHead = document.getElementById('stage-head') as HTMLElement;
const replotBlock = document.getElementById('replot-block') as HTMLElement;
const overlayBlock = document.getElementById('overlay-block') as HTMLElement;
const tableBlock = document.getElementById('table-block') as HTMLElement;
const replotNote = document.getElementById('replot-note')!;
const tableNote = document.getElementById('table-note')!;
const tableHost = document.getElementById('data-table')!;

const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, {
  onCropChange(rect) {
    state.crop = rect;
    stage.setImage(state.fullBitmap, rect);
    scheduleSave();
  },
  onAnchorChange(id, px) {
    applyAnchorPixel(id, px);
  },
  onViewChange(zoomed) {
    fitBtn.hidden = !zoomed;
    mirrorZoom(() => stage.visibleWindow(), 'stage');
  },
});

const chart = new ReplotChart(
  document.getElementById('replot') as HTMLDivElement,
  () => chartTheme(),
  (window_) => mirrorZoom(() => window_, 'chart'),
);
const overlay = new OverlayPanel(document.getElementById('overlay') as HTMLCanvasElement, (v) =>
  mirrorZoom(() => v.visibleWindow(), 'overlay'),
);

/**
 * Keep the panels looking at the same place.
 *
 * Guarded against echo: handing a window to a panel makes it fire its own view
 * change, and without the flag the three would push each other around forever.
 */
let mirroring = false;

function mirrorZoom(window_: () => WorldRect | null, from: 'stage' | 'chart' | 'overlay'): void {
  if (mirroring || !state.linkZoom || state.phase !== 'ready') return;
  const w = window_();
  if (!w || !Number.isFinite(w.x0 + w.x1 + w.y0 + w.y1)) return;
  mirroring = true;
  if (from !== 'stage') stage.showWindow(w);
  if (from !== 'chart') chart.showWindow(w);
  if (from !== 'overlay') overlay.viewport.showWindow(w);
  mirroring = false;
}

/**
 * The chart panel's palette, fixed light whatever the system asks for.
 *
 * The series colours are the chart's own, picked by whoever drew it against
 * white paper. On a near-black panel a dark blue or a saturated red is
 * unreadable, and the panel exists to be compared against the source by eye.
 * The tokens it reads are defined once in `styles.css` and are not redefined
 * under `prefers-color-scheme: dark`.
 */
function chartTheme() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: pick('--panel-paper', '#ffffff'),
    axis: pick('--panel-axis', '#aeb6c2'),
    grid: pick('--panel-grid', '#e4e8ee'),
    text: pick('--panel-ink', '#4a5361'),
  };
}

/* ------------------------------------------------------------------ steps */

/**
 * Each step of the workflow is a history entry.
 *
 * That is what makes the Android back button navigate the app rather than close
 * it: the shell calls `goBack()` whenever the WebView has history, and these are
 * the entries it walks. It costs nothing in a browser, where the same presses
 * now step back through the workflow too.
 */
let depth = 0;

function replaceStep(phase: Phase): void {
  history.replaceState({ p: phase, d: depth }, '');
}

function pushStep(phase: Phase): void {
  depth += 1;
  history.pushState({ p: phase, d: depth }, '');
}

window.addEventListener('popstate', (event) => {
  const entry = event.state as { p?: Phase; d?: number } | null;
  depth = entry?.d ?? 0;
  applyStep(entry?.p ?? 'empty');
});

/** Move to the step the history says we are on, degrading if it is no longer reachable. */
function applyStep(phase: Phase): void {
  if (phase === 'ready' && state.analysis) {
    state.phase = 'ready';
    stage.setImage(state.croppedBitmap, null);
    stage.setAnalysis(state.analysis, state.calibration);
    render();
    resizeAll();
    return;
  }
  if ((phase === 'cropping' || phase === 'ready' || phase === 'working') && state.fullBitmap) {
    showCropping();
    return;
  }
  clearImage();
}

function showCropping(): void {
  state.phase = 'cropping';
  state.analysis = null;
  state.calibration = null;
  stage.setImage(state.fullBitmap, state.crop);
  render();
  resizeAll();
}

function clearImage(): void {
  state.phase = 'empty';
  state.full = null;
  state.fullBitmap = null;
  state.cropped = null;
  state.croppedBitmap = null;
  state.analysis = null;
  state.calibration = null;
  state.crop = null;
  state.token = null;
  state.fileName = '';
  state.choices = [];
  state.suggestion = null;
  forgetSession();
  stage.setImage(null, null);
  chart.setData(null);
  overlay.setData(null);
  // The entry we are standing on no longer describes anything reachable.
  replaceStep('empty');
  render();
}

function resizeAll(): void {
  stage.resize();
  if (state.phase === 'ready') {
    chart.resize();
    overlay.resize();
  }
}

/* ---------------------------------------------------------------- session */

/**
 * Enough state to survive the app's process being killed.
 *
 * Android will kill a backgrounded app whenever it wants the memory, and the
 * shell hands the image back on restart. What it cannot hand back is the crop
 * the user had already dragged, so that is kept here, keyed to the image so it
 * is never applied to a different one.
 */
const SESSION_KEY = 'plot2data.session';

interface SavedSession {
  token: string;
  crop: Rect;
  modeOverride: State['modeOverride'];
  readLabels: State['readLabels'];
  sampling: State['sampling'];
  count: number;
  delimiter: DelimiterName;
  withHeader: boolean;
}

let saveTimer: number | undefined;

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSession, 400);
}

function saveSession(): void {
  if (!state.token || !state.crop) return;
  const payload: SavedSession = {
    token: state.token,
    crop: state.crop,
    modeOverride: state.modeOverride,
    readLabels: state.readLabels,
    sampling: state.sampling,
    count: state.count,
    delimiter: state.delimiter,
    withHeader: state.withHeader,
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Storage being unavailable costs a crop rectangle, nothing more.
  }
}

function readSession(token: string): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    return parsed && parsed.token === token && parsed.crop ? parsed : null;
  } catch {
    return null;
  }
}

function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do; the next save will overwrite it anyway.
  }
}

/* ---------------------------------------------------------------- intake */

function renderIntake(): void {
  if (state.phase !== 'empty') {
    intake.innerHTML = '';
    intake.hidden = true;
    stageWrap.hidden = false;
    return;
  }
  intake.hidden = false;
  stageWrap.hidden = true;

  if (state.choices.length > 1) {
    renderChooser();
    return;
  }

  intake.innerHTML = `
    <div class="dropzone" id="dropzone">
      <input type="file" id="file" accept="${ACCEPT_ATTRIBUTE}" class="file-input"
        aria-label="Choose a plot image" />
      <p><strong>${onAndroid ? 'Choose a plot image' : 'Drop a plot image here'}</strong></p>
      <span class="pseudo-button">Browse images</span>
      ${
        onAndroid
          ? `<p class="hint">Or crop a plot with the S Pen's Smart Select and share it to plot2data.</p>`
          : `<p class="hint">or paste one from the clipboard (${
              navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
            }+V)</p>`
      }
      <p class="hint">Works best on a clean line or scatter plot with straight axes. Crop to a single plot first.</p>
    </div>
    ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ''}
  `;
  const fileInput = document.getElementById('file') as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void accept(file);
  });
  const zone = document.getElementById('dropzone')!;
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, () => zone.classList.remove('is-over'));
  }
}

/** Several images were shared at once; the app does one plot at a time. */
function renderChooser(): void {
  intake.innerHTML = `
    <div class="card">
      <h2>Which plot?</h2>
      <p class="status" style="margin-top:0">${state.choices.length} images were shared. Pick the one to read.</p>
      <div class="choices">
        ${state.choices
          .map(
            (image, i) => `
          <button class="choice" data-pick="${i}">
            <img src="${escapeHtml(image.url)}" alt="" />
            <span>${escapeHtml(image.name)}</span>
          </button>`,
          )
          .join('')}
      </div>
    </div>
    ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ''}
  `;
  for (const button of Array.from(intake.querySelectorAll<HTMLButtonElement>('[data-pick]'))) {
    button.addEventListener('click', () => {
      const picked = state.choices[Number(button.dataset.pick)];
      state.choices = [];
      void takeIncoming(picked);
    });
  }
}

async function accept(file: File, incoming?: IncomingImage): Promise<void> {
  state.error = null;
  try {
    const loaded = await loadImageFile(file);
    const restored = incoming ? readSession(incoming.token) : null;
    state.full = loaded.buffer;
    state.fullBitmap = loaded.bitmap;
    state.fileName = loaded.name;
    state.token = incoming?.token ?? null;
    state.crop = clampCrop(restored?.crop, loaded.buffer);
    if (restored) {
      state.modeOverride = restored.modeOverride;
      state.readLabels = restored.readLabels ?? 'auto';
      state.sampling = restored.sampling ?? 'auto';
      state.count = restored.count;
      state.delimiter = restored.delimiter ?? 'comma';
      state.withHeader = restored.withHeader ?? true;
    }
    state.analysis = null;
    state.calibration = null;
    state.choices = [];
    // Push only from the root entry; otherwise relabel the step we are standing
    // on, so loading a second image never stacks up entries the back button then
    // has to be pressed through twice.
    if (depth === 0) pushStep('cropping');
    else replaceStep('cropping');
    showCropping();
    saveSession();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.choices = [];
    render();
  }
}

/** A crop restored from a previous run has to still fit the image it is applied to. */
function clampCrop(crop: Rect | undefined, image: ImageBuffer): Rect {
  const whole = { x0: 0, y0: 0, x1: image.width - 1, y1: image.height - 1 };
  if (!crop) return whole;
  const x0 = Math.max(0, Math.min(image.width - 2, crop.x0));
  const y0 = Math.max(0, Math.min(image.height - 2, crop.y0));
  const x1 = Math.max(x0 + 1, Math.min(image.width - 1, crop.x1));
  const y1 = Math.max(y0 + 1, Math.min(image.height - 1, crop.y1));
  return Number.isFinite(x0 + y0 + x1 + y1) ? { x0, y0, x1, y1 } : whole;
}

async function takeIncoming(image: IncomingImage): Promise<void> {
  try {
    await accept(await fetchIncoming(image), image);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.choices = [];
    render();
  }
}

installHost({
  onImages(images) {
    if (images.length === 1) {
      void takeIncoming(images[0]);
      return;
    }
    // A new share always starts over, whatever the user was in the middle of -
    // and the reset has to come before the choices are handed over, because it
    // clears those too.
    if (state.phase !== 'empty') clearImage();
    state.choices = images;
    render();
  },
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = fileFromTransfer(e.dataTransfer?.items ?? null, e.dataTransfer?.files ?? null);
  if (file) void accept(file);
});
window.addEventListener('paste', (e) => {
  const file = fileFromTransfer(e.clipboardData?.items ?? null, e.clipboardData?.files ?? null);
  if (file) void accept(file);
});
window.addEventListener('resize', () => resizeAll());
window.addEventListener('orientationchange', () => setTimeout(() => resizeAll(), 120));

/* ------------------------------------------------------------- extraction */

extractBtn.addEventListener('click', () => void runExtraction());
recropBtn.addEventListener('click', () => {
  // The same move the back button makes, so the two never disagree.
  if (depth > 1) history.back();
  else showCropping();
});
resetBtn.addEventListener('click', () => {
  if (depth > 0) {
    const back = depth;
    depth = 0;
    history.go(-back);
  } else {
    clearImage();
  }
});
fitBtn.addEventListener('click', () => {
  stage.resetView();
  mirrorZoom(() => stage.visibleWindow(), 'stage');
});
document.getElementById('zoom-in')!.addEventListener('click', () => {
  stage.zoomStep(1.6);
  mirrorZoom(() => stage.visibleWindow(), 'stage');
});
document.getElementById('zoom-out')!.addEventListener('click', () => {
  stage.zoomStep(1 / 1.6);
  mirrorZoom(() => stage.visibleWindow(), 'stage');
});
document.getElementById('replot-fit')!.addEventListener('click', () => {
  chart.resetView();
  mirrorZoom(() => chart.visibleWindow(), 'chart');
});
const boxZoomBtn = document.getElementById('box-zoom') as HTMLButtonElement;
const replotHint = document.getElementById('replot-hint')!;
let boxZoom = false;
boxZoomBtn.addEventListener('click', () => {
  boxZoom = !boxZoom;
  chart.setBoxZoom(boxZoom);
  boxZoomBtn.setAttribute('aria-pressed', String(boxZoom));
  replotHint.textContent = boxZoom
    ? 'Drag a box across the chart to zoom into it.'
    : 'Drag to pan, pinch or scroll to zoom.';
});
document.getElementById('overlay-fit')!.addEventListener('click', () => overlay.viewport.resetView());

const linkBox = document.getElementById('link-zoom') as HTMLInputElement;
linkBox.addEventListener('change', () => {
  state.linkZoom = linkBox.checked;
  if (state.linkZoom) mirrorZoom(() => stage.visibleWindow(), 'stage');
});
const opacityInput = document.getElementById('opacity') as HTMLInputElement;
opacityInput.addEventListener('input', () => {
  state.imageOpacity = Number(opacityInput.value) / 100;
  refresh();
});
const pointInput = document.getElementById('point-size') as HTMLInputElement;
pointInput.addEventListener('input', () => {
  state.pointRadius = Number(pointInput.value);
  refresh();
});
const magnifyBox = document.getElementById('magnify') as HTMLInputElement;
magnifyBox.addEventListener('change', () => {
  state.magnify = magnifyBox.checked;
  refresh();
});

async function runExtraction(): Promise<void> {
  if (!state.full || !state.crop) return;
  state.phase = 'working';
  state.busyMessage = 'Reading tick labels…';
  state.error = null;
  render();
  // Yield so the busy state paints before the synchronous engine work starts.
  await new Promise((r) => setTimeout(r, 16));

  try {
    await ocr.start();
    const cropped = cropBuffer(state.full, state.crop);
    state.cropped = cropped;
    state.croppedBitmap = await createImageBitmap(
      new ImageData(new Uint8ClampedArray(cropped.data), cropped.width, cropped.height),
    );
    state.busyMessage = 'Tracing the series…';
    render();
    await new Promise((r) => setTimeout(r, 16));

    const analysis = await analyse(cropped, {
      ocr: ocr.available ? ocr : null,
      mode: state.modeOverride === 'auto' ? undefined : state.modeOverride,
      readLabels: state.readLabels !== 'off',
    });
    state.analysis = analysis;
    state.calibration = analysis.calibration;
    state.visible = new Set(analysis.series.map((_, i) => i));
    state.readNames = analysis.series.map((s) => s.label?.text ?? '');
    state.names = analysis.series.map((s, i) => seriesName(s.label?.text, i));
    state.modes = analysis.series.map(() => 'auto');
    state.styles = [];
    state.suggestion = suggestPointCount(analysis, currentModes());
    if (state.sampling === 'auto') state.count = state.suggestion.count;
    state.phase = 'ready';
    pushStep('ready');
    render();
    stage.setImage(state.croppedBitmap, null);
    stage.setAnalysis(analysis, state.calibration);
    resizeAll();
    refresh();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.phase = 'cropping';
    render();
  }
}

/* ------------------------------------------------------------ calibration */

function applyAnchorPixel(id: AnchorId, px: number): void {
  if (!state.calibration || !state.cropped) return;
  const clamped =
    id.startsWith('x')
      ? Math.max(0, Math.min(state.cropped.width - 1, px))
      : Math.max(0, Math.min(state.cropped.height - 1, px));
  updateCalibration(id, { px: clamped });
}

/**
 * Change one anchor and regenerate everything from it.
 *
 * This runs on every pointer move of a marker drag, so it repaints rather than
 * rebuilding the controls: rebuilding the panel's markup mid-drag would throw
 * away the focus and the caret of whatever field the user was in.
 */
function updateCalibration(id: AnchorId, patch: { px?: number; value?: number }): void {
  if (!state.calibration) return;
  const axis = id.startsWith('x') ? 'x' : 'y';
  const which = id.endsWith('a') ? 'a' : 'b';
  const cal = state.calibration[axis];
  const anchor = { ...cal[which], ...patch, source: 'manual' as const };
  state.calibration = { ...state.calibration, [axis]: { ...cal, [which]: anchor } };
  refresh();
}

function setScale(axis: 'x' | 'y', scale: AxisScale): void {
  if (!state.calibration || !state.analysis) return;
  const ticks = axis === 'x' ? state.analysis.xTicks : state.analysis.yTicks;
  const current = state.calibration[axis];
  // Refit from the read labels under the chosen model so the anchor values move
  // with the toggle instead of silently keeping the other model's numbers.
  const refit = calibrateAxis(current.side, ticks, current.a.px, current.b.px, {
    scale,
    multiplier: current.multiplier,
    offset: current.offset,
  });
  state.calibration = { ...state.calibration, [axis]: { ...refit, scaleSource: 'manual' } };
  renderPanel();
  refresh();
}

function setAnnotation(axis: 'x' | 'y', enabled: boolean): void {
  if (!state.calibration || !state.analysis) return;
  const found = state.analysis.annotations.find((a) => (a.side === 'left' ? 'y' : 'x') === axis);
  if (!found) return;
  const cal = state.calibration[axis];
  state.calibration = {
    ...state.calibration,
    [axis]: {
      ...cal,
      multiplier: enabled ? found.multiplier : 1,
      offset: enabled ? found.offset : 0,
    },
  };
  refresh();
}

/**
 * Re-run everything downstream of the calibration.
 *
 * The captain moved markers, typed new values and could not find a way to make
 * the tool re-read the plot, so this is wired to every edit *and* to a visible
 * Recalculate button. Both do the same thing, which is the point: the button
 * exists so the behaviour is never in doubt.
 */
function recalculate(): void {
  if (!state.analysis) return;
  state.suggestion = suggestPointCount(state.analysis, currentModes());
  if (state.sampling === 'auto') state.count = state.suggestion.count;
  renderPanel();
  refresh();
}

/** The per-series mode overrides, in the form the engine takes them. */
function currentModes(): Array<ExtractionMode | undefined> {
  return state.modes.map((m) => (m === 'auto' ? undefined : m));
}

/** Which analysed series are ticked, in order. Styles are indexed by these. */
function shownIndices(): number[] {
  if (!state.analysis) return [];
  return state.analysis.series.map((_, i) => i).filter((i) => state.visible.has(i));
}

/** Points that carry a value, as opposed to a cell the grid ran past. */
function finitePoints(s: DataSeries): number {
  return s.points.reduce(
    (n, p) => n + (Number.isFinite(p.x) && Number.isFinite(p.y) ? 1 : 0),
    0,
  );
}

/** A legend name if one was read and adopted, otherwise the generic one. */
function seriesName(read: string | undefined, index: number): string {
  if (state.readLabels === 'off') return `series_${index + 1}`;
  return read && read.trim() ? read.trim() : `series_${index + 1}`;
}

function currentSeries(): DataSeries[] {
  if (!state.analysis || !state.calibration) return [];
  const series = buildSeries(state.analysis, {
    calibration: state.calibration,
    resample:
      state.sampling === 'native'
        ? { kind: 'native' }
        : { kind: 'uniform', count: Math.max(2, state.count) },
    names: state.names,
    include: state.visible,
    modes: currentModes(),
  });
  // Styles are held per *analysed* series so they survive a series being
  // unticked and ticked again, and are seeded from the way it was drawn.
  shownIndices().forEach((index, position) => {
    state.styles[index] ??= defaultStyle(series[position], index);
  });
  return series;
}

function exportName(extension: string): string {
  return `${state.fileName.replace(/\.[^.]+$/, '') || 'plot'}-data.${extension}`;
}

/* ----------------------------------------------------------------- render */

function render(): void {
  renderIntake();
  filenameEl.textContent = state.fileName;
  extractBtn.hidden = state.phase !== 'cropping';
  extractBtn.disabled = state.phase === 'working';
  recropBtn.hidden = state.phase !== 'ready';
  fitBtn.hidden = !stage.zoomed;
  zoomer.hidden = state.phase !== 'ready';
  stageHead.hidden = state.phase !== 'ready';
  replotBlock.hidden = state.phase !== 'ready';
  overlayBlock.hidden = state.phase !== 'ready';
  tableBlock.hidden = state.phase !== 'ready';
  renderPanel();
  if (state.phase === 'ready') refresh();
}

/**
 * Repaint everything the calibration feeds, without touching the controls.
 *
 * One series build serves all three panels and the export preview, so they can
 * never show different numbers.
 */
function refresh(): void {
  if (state.phase !== 'ready' || !state.analysis || !state.calibration) return;
  const series = currentSeries();
  const styles = shownIndices().map((i) => state.styles[i]);
  stage.setCalibration(state.calibration);
  chart.update({
    series,
    styles,
    calibration: state.calibration,
    rect: state.analysis.frame.rect,
    units: state.analysis.units,
  });
  if (state.croppedBitmap) {
    overlay.setData({
      bitmap: state.croppedBitmap,
      series,
      styles,
      calibration: state.calibration,
      imageOpacity: state.imageOpacity,
      pointScale: state.pointRadius,
      magnify: state.magnify,
    });
  }
  // Every count on the page comes from this one build, and each says exactly
  // what it counts. The header said "27 points" beside a series list reading
  // 27/26/123/40/55 and an output panel reading "123 rows", and all three were
  // measuring different things without saying so.
  const total = series.reduce((n, s) => n + finitePoints(s), 0);
  replotNote.textContent =
    `${series.length} of ${state.analysis.series.length} series shown, ` +
    `${total} extracted point${total === 1 ? '' : 's'} between them`;
  renderTable(series);

  // The controls stay put; only the values they display are refreshed.
  for (const id of ['xa', 'xb', 'ya', 'yb'] as AnchorId[]) {
    const axis = id.startsWith('x') ? 'x' : 'y';
    const which = id.endsWith('a') ? 'a' : 'b';
    const anchor = state.calibration[axis][which];
    const px = document.getElementById(`${id}-px`) as HTMLInputElement | null;
    if (px && document.activeElement !== px) px.value = round(anchor.px);
    const value = document.getElementById(`${id}-val`) as HTMLInputElement | null;
    if (value && document.activeElement !== value) value.value = formatValue(anchor.value);
  }
  const mapping = document.getElementById('mapping');
  if (mapping) mapping.textContent = mappingText(series);
  const summary = document.getElementById('output-summary');
  if (summary) summary.textContent = outputSummary(series);
  const explain = document.getElementById('output-explain');
  if (explain) explain.innerHTML = explainHtml(series);
  const preview = document.getElementById('preview');
  if (preview) preview.textContent = previewText(series);
  const countInput = document.getElementById('count') as HTMLInputElement | null;
  if (countInput && document.activeElement !== countInput) {
    const curves = curveCount(series);
    countInput.disabled = state.sampling !== 'uniform' || curves === 0;
    countInput.value = curves === 0 ? '' : String(state.count);
    countInput.placeholder = curves === 0 ? 'no curves' : '';
  }
}

function mappingText(series: DataSeries[]): string {
  const analysis = state.analysis!;
  const cal = state.calibration!;
  const rect = analysis.frame.rect;
  const lines = [
    describeAxis(cal.x, 'x', analysis.units.x, [rect.x0, rect.x1]),
    describeAxis(cal.y, 'y', analysis.units.y, [rect.y1, rect.y0]),
  ];
  for (const s of series) {
    lines.push(`${s.name}: ${describeUncertainty(s)} (from line thickness)`);
  }
  return lines.join('\n');
}

function renderPanel(): void {
  if (state.phase === 'empty') {
    panel.innerHTML = `
      <div class="card">
        <h2>How it works</h2>
        <ol class="steps">
          <li>Load a screenshot of a line or scatter plot.</li>
          <li>Crop to a single plot area.</li>
          <li>Check the four axis markers - X1, X2 on the bottom and Y1, Y2 up the side. They are pre-filled from the tick labels but you decide what is right.</li>
          <li>Read the result off the three panels, then ${onAndroid ? 'save or share' : 'download'} a CSV or an Excel workbook.</li>
        </ol>
      </div>`;
    return;
  }

  if (state.phase === 'cropping') {
    panel.innerHTML = `
      <div class="card">
        <h2>Crop</h2>
        <p class="status" style="margin-top:0">
          Drag the rectangle so it holds one plot: the axes, the tick labels and the data, and as little else as possible.
          Pinch to zoom in, double-tap to zoom back out.
        </p>
        <div class="row">
          <div>
            <label for="mode-select">Extraction mode</label>
            <select id="mode-select">
              <option value="auto">Auto-detect</option>
              <option value="curve">Curve (trace the drawn line)</option>
              <option value="marker">Markers (find data points)</option>
            </select>
          </div>
        </div>
        ${state.error ? `<div class="notice error" style="margin-top:10px">${escapeHtml(state.error)}</div>` : ''}
      </div>`;
    const sel = document.getElementById('mode-select') as HTMLSelectElement;
    sel.value = state.modeOverride;
    sel.addEventListener('change', () => {
      state.modeOverride = sel.value as State['modeOverride'];
      scheduleSave();
    });
    return;
  }

  if (state.phase === 'working') {
    panel.innerHTML = `<div class="card"><span class="busy"></span>${escapeHtml(state.busyMessage)}</div>`;
    return;
  }

  const analysis = state.analysis!;
  const cal = state.calibration!;
  const series = currentSeries();
  const warnings = analysis.warnings
    .map((w) => `<div class="notice ${w.level === 'info' ? 'info' : ''}">${escapeHtml(w.message)}</div>`)
    .join('');
  const shareable = canShareCsv();

  panel.innerHTML = `
    ${warnings}
    <div class="card">
      <h2>Calibration</h2>
      ${axisBlock('x', 'X axis', 'X1', 'X2')}
      ${axisBlock('y', 'Y axis', 'Y1', 'Y2')}
      <div class="mapping" id="mapping">${escapeHtml(mappingText(series))}</div>
      <div class="row export-row">
        <button class="primary" id="recalc">Recalculate</button>
      </div>
      <p class="status">Everything updates as you drag or type; the button re-runs it all if you would rather be sure.</p>
    </div>

    <div class="card">
      <h2>Series</h2>
      <label class="check-row" style="margin-bottom:8px">
        <input type="checkbox" id="read-labels" ${state.readLabels !== 'off' ? 'checked' : ''} />
        Take names from legible labels on the chart
      </label>
      <div id="series-list">
        ${analysis.series.map((s, i) => seriesCard(s, i, series)).join('')}
      </div>
      ${analysis.series.length === 0 ? '<p class="status">No series were found. Try a tighter crop.</p>' : ''}
    </div>

    <div class="card">
      <h2>Output</h2>
      <div class="row">
        <div>
          <label for="sampling">Point count for curves</label>
          <select id="sampling">
            <option value="auto">Automatic</option>
            <option value="uniform">Choose a number</option>
            <option value="native">One per pixel column</option>
          </select>
        </div>
        <div>
          <label for="count">Points</label>
          <input type="number" id="count" min="2" max="20000" step="1"
            value="${curveCount(series) === 0 ? '' : state.count}"
            placeholder="${curveCount(series) === 0 ? 'no curves' : ''}"
            ${state.sampling !== 'uniform' || curveCount(series) === 0 ? 'disabled' : ''} />
        </div>
      </div>
      <p class="status" id="output-summary">${escapeHtml(outputSummary(series))}</p>
      <div class="explain" id="output-explain">${explainHtml(series)}</div>
    </div>

    <div class="card">
      <h2>Export</h2>
      <div class="row">
        <div>
          <label for="delimiter">CSV separator</label>
          <select id="delimiter">
            <option value="comma">Comma ,</option>
            <option value="tab">Tab</option>
            <option value="semicolon">Semicolon ;</option>
            <option value="pipe">Pipe |</option>
          </select>
        </div>
      </div>
      <label class="check-row">
        <input type="checkbox" id="with-header" ${state.withHeader ? 'checked' : ''} />
        Header row, with the calibration and uncertainty above it
      </label>
      <div class="row export-row">
        <button class="primary" id="save-csv" ${series.length === 0 ? 'disabled' : ''}>
          ${onAndroid ? 'Save CSV' : 'Download CSV'}
        </button>
        <button id="save-xlsx" ${series.length === 0 ? 'disabled' : ''}>
          ${onAndroid ? 'Save Excel' : 'Download Excel'}
        </button>
        ${shareable ? `<button id="share-csv" ${series.length === 0 ? 'disabled' : ''}>Share CSV</button>` : ''}
      </div>
      <div class="preview" id="preview">${escapeHtml(previewText(series))}</div>
    </div>
  `;

  wirePanel();

  /**
   * One series: whether it is exported, what it is called, how it was read and
   * how it is drawn.
   *
   * The mode is per series and visible rather than buried in a pre-extraction
   * setting, because a chart may carry a curve and a scatter at once and the
   * automatic choice is a judgement about ink that the user is entitled to
   * overrule. It costs a rebuild, not a re-analysis, so it applies instantly.
   */
  function seriesCard(s: Analysis['series'][number], i: number, built: DataSeries[]): string {
    const style = state.styles[i];
    const mode = state.modes[i] === 'auto' ? s.autoMode : state.modes[i];
    const data = built.find((d) => d.name === state.names[i]);
    const points = data ? finitePoints(data) : (mode === 'marker' ? s.marker.points.length : 0);
    const how =
      mode === 'marker'
        ? `${points} points, one per marker`
        : `${points} points, resampled from the drawn line`;
    const shapes = MARKER_SHAPES.map(
      (shape) =>
        `<option value="${shape}"${style?.shape === shape ? ' selected' : ''}>${SHAPE_NAMES[shape]}</option>`,
    ).join('');
    return `
      <div class="series-row">
        <input type="checkbox" id="vis-${i}" ${state.visible.has(i) ? 'checked' : ''}
          aria-label="Include ${escapeHtml(state.names[i])}" />
        <span class="swatch" style="background:${escapeHtml(style?.colour ?? cssColour(s.traced.colour))}"></span>
        <span class="series-name"><input type="text" id="name-${i}"
          value="${escapeHtml(state.names[i])}" aria-label="Name for series ${i + 1}" /></span>
        <span class="series-meta">${escapeHtml(how)}${
          data ? `<br>±${escapeHtml(compact(data.uncertainty.y))}` : ''
        }</span>
        <details class="series-more">
          <summary>How it is read and drawn</summary>
          <div class="series-options">
            <label for="mode-${i}">Read as</label>
            <select id="mode-${i}">
              <option value="auto"${state.modes[i] === 'auto' ? ' selected' : ''}>Automatic (${s.autoMode})</option>
              <option value="marker"${state.modes[i] === 'marker' ? ' selected' : ''}>Markers - one point per marker</option>
              <option value="curve"${state.modes[i] === 'curve' ? ' selected' : ''}>Curve - trace and resample</option>
            </select>
            <label for="shape-${i}">Marker</label>
            <select id="shape-${i}">${shapes}</select>
            <label for="size-${i}">Marker size</label>
            <input type="range" id="size-${i}" min="0" max="20" step="1" value="${style?.size ?? 6}" />
            <label for="linew-${i}">Line width</label>
            <input type="range" id="linew-${i}" min="0" max="8" step="0.5" value="${style?.lineWidth ?? 2}" />
            <label for="colour-${i}">Colour</label>
            <input type="color" id="colour-${i}" value="${hexColour(style?.colour ?? cssColour(s.traced.colour))}" />
            <label class="check-row" style="grid-column:1/-1">
              <input type="checkbox" id="line-${i}" ${style?.line ? 'checked' : ''} />
              Join the points with a line
            </label>
          </div>
        </details>
      </div>`;
  }

  function axisBlock(axis: 'x' | 'y', title: string, first: string, second: string): string {
    const a = cal[axis];
    const annotation = analysis.annotations.find((n) => (n.side === 'left' ? 'y' : 'x') === axis);
    const applied = a.multiplier !== 1 || a.offset !== 0;
    return `
      <div class="axis">
        <div class="axis-head">
          <span class="axis-dot ${axis}"></span>
          <span class="axis-title">${title}</span>
          <span class="segmented" role="group" aria-label="${title} scale">
            <button data-scale="${axis}:linear" aria-pressed="${a.scale === 'linear'}">Linear</button>
            <button data-scale="${axis}:log" aria-pressed="${a.scale === 'log'}">Log</button>
          </span>
        </div>
        <div class="anchor-grid">
          <span class="tag ${axis}">${first}</span>
          <div><label for="${axis}a-px">pixel</label><input type="number" id="${axis}a-px" step="0.1" value="${round(a.a.px)}" /></div>
          <div><label for="${axis}a-val">value</label><input type="text" inputmode="decimal" id="${axis}a-val" value="${formatValue(a.a.value)}" /></div>
          <span class="tag ${axis}">${second}</span>
          <div><label for="${axis}b-px">pixel</label><input type="number" id="${axis}b-px" step="0.1" value="${round(a.b.px)}" /></div>
          <div><label for="${axis}b-val">value</label><input type="text" inputmode="decimal" id="${axis}b-val" value="${formatValue(a.b.value)}" /></div>
        </div>
        ${
          annotation
            ? `<label class="check-row">
                 <input type="checkbox" data-annotation="${axis}" ${applied ? 'checked' : ''} />
                 Apply the "${escapeHtml(annotation.text)}" annotation found beside this axis
               </label>`
            : ''
        }
      </div>`;
  }
}

function wirePanel(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-scale]'))) {
    btn.addEventListener('click', () => {
      const [axis, scale] = btn.dataset.scale!.split(':');
      setScale(axis as 'x' | 'y', scale as AxisScale);
    });
  }
  for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('[data-annotation]'))) {
    box.addEventListener('change', () => setAnnotation(box.dataset.annotation as 'x' | 'y', box.checked));
  }
  for (const id of ['xa', 'xb', 'ya', 'yb'] as AnchorId[]) {
    const pxInput = document.getElementById(`${id}-px`) as HTMLInputElement | null;
    const valInput = document.getElementById(`${id}-val`) as HTMLInputElement | null;
    pxInput?.addEventListener('change', () => {
      const v = Number(pxInput.value);
      if (Number.isFinite(v)) applyAnchorPixel(id, v);
    });
    valInput?.addEventListener('change', () => {
      const v = Number(valInput.value.replace(/,/g, ''));
      if (Number.isFinite(v)) updateCalibration(id, { value: v });
    });
  }
  document.getElementById('recalc')?.addEventListener('click', () => recalculate());

  const readLabelsBox = document.getElementById('read-labels') as HTMLInputElement | null;
  readLabelsBox?.addEventListener('change', () => {
    state.readLabels = readLabelsBox.checked ? 'auto' : 'off';
    // Only names the user has not typed over are replaced, so turning this on
    // and off never discards work.
    state.names = state.names.map((current, i) =>
      current === state.readNames[i] || current === `series_${i + 1}`
        ? seriesName(state.readNames[i], i)
        : current,
    );
    scheduleSave();
    renderPanel();
    refresh();
  });

  const list = document.getElementById('series-list');
  if (list && state.analysis) {
    state.analysis.series.forEach((_, i) => {
      const vis = document.getElementById(`vis-${i}`) as HTMLInputElement | null;
      vis?.addEventListener('change', () => {
        if (vis.checked) state.visible.add(i);
        else state.visible.delete(i);
        renderPanel();
        refresh();
      });
      const name = document.getElementById(`name-${i}`) as HTMLInputElement | null;
      name?.addEventListener('change', () => {
        state.names[i] = name.value.trim() || `series_${i + 1}`;
        renderPanel();
        refresh();
      });
      const mode = document.getElementById(`mode-${i}`) as HTMLSelectElement | null;
      mode?.addEventListener('change', () => {
        state.modes[i] = mode.value as State['modes'][number];
        // The mode changes what a series *is*, so the drawing default and the
        // proposed point count both have to follow it.
        state.styles[i] = undefined as unknown as SeriesStyle;
        if (state.analysis) {
          state.suggestion = suggestPointCount(state.analysis, currentModes());
          if (state.sampling === 'auto') state.count = state.suggestion.count;
        }
        scheduleSave();
        renderPanel();
        refresh();
      });

      const restyle = (patch: Partial<SeriesStyle>) => {
        const current = state.styles[i];
        if (!current) return;
        state.styles[i] = { ...current, ...patch };
        refresh();
        const swatch = list.querySelectorAll('.swatch')[i] as HTMLElement | undefined;
        if (swatch && patch.colour) swatch.style.background = patch.colour;
      };
      const shape = document.getElementById(`shape-${i}`) as HTMLSelectElement | null;
      shape?.addEventListener('change', () => restyle({ shape: shape.value as SeriesStyle['shape'] }));
      const size = document.getElementById(`size-${i}`) as HTMLInputElement | null;
      size?.addEventListener('input', () => restyle({ size: Number(size.value) }));
      const lineWidth = document.getElementById(`linew-${i}`) as HTMLInputElement | null;
      lineWidth?.addEventListener('input', () => restyle({ lineWidth: Number(lineWidth.value) }));
      const colour = document.getElementById(`colour-${i}`) as HTMLInputElement | null;
      colour?.addEventListener('input', () => restyle({ colour: colour.value }));
      const line = document.getElementById(`line-${i}`) as HTMLInputElement | null;
      line?.addEventListener('change', () => restyle({ line: line.checked }));
    });
  }

  const sampling = document.getElementById('sampling') as HTMLSelectElement | null;
  if (sampling) {
    sampling.value = state.sampling;
    sampling.addEventListener('change', () => {
      state.sampling = sampling.value as State['sampling'];
      if (state.sampling === 'auto' && state.suggestion) state.count = state.suggestion.count;
      scheduleSave();
      renderPanel();
      refresh();
    });
  }
  const count = document.getElementById('count') as HTMLInputElement | null;
  count?.addEventListener('change', () => {
    const v = Math.round(Number(count.value));
    if (Number.isFinite(v) && v >= 2) state.count = Math.min(20000, v);
    scheduleSave();
    refresh();
  });

  const delimiter = document.getElementById('delimiter') as HTMLSelectElement | null;
  if (delimiter) {
    delimiter.value = state.delimiter;
    delimiter.addEventListener('change', () => {
      state.delimiter = delimiter.value as DelimiterName;
      scheduleSave();
      refresh();
    });
  }
  const header = document.getElementById('with-header') as HTMLInputElement | null;
  header?.addEventListener('change', () => {
    state.withHeader = header.checked;
    scheduleSave();
    refresh();
  });

  document.getElementById('save-csv')?.addEventListener('click', () => void send('save', 'csv'));
  document.getElementById('share-csv')?.addEventListener('click', () => void send('share', 'csv'));
  document.getElementById('save-xlsx')?.addEventListener('click', () => void send('save', 'xlsx'));
}

function csvOptions() {
  return {
    source: state.fileName,
    calibration: state.calibration ?? undefined,
    delimiter: DELIMITERS[state.delimiter],
    header: state.withHeader,
  };
}

async function send(destination: 'save' | 'share', format: 'csv' | 'xlsx'): Promise<void> {
  if (!state.analysis || !state.calibration) return;
  const series = currentSeries();
  try {
    if (format === 'xlsx') {
      await exportFile(destination, exportName('xlsx'), toXlsx(state.analysis, series, csvOptions()), XLSX_MIME);
      return;
    }
    await exportFile(destination, exportName('csv'), toCsv(state.analysis, series, csvOptions()), CSV_MIME);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    renderPanel();
    refresh();
  }
}

/**
 * What the tool did to *this* chart, in sentences.
 *
 * The captain asked to be taught what happened rather than shown a parameter
 * dump, and the specific thing he wanted to be able to do is predict what
 * pressing Recalculate would produce before pressing it. So each paragraph
 * names the numbers this extraction actually has, and the last one says what
 * the other settings would give instead.
 */
function outputExplanation(series: DataSeries[]): string[] {
  if (series.length === 0) return ['Nothing is ticked, so there is nothing to export.'];
  const table = toTable(series);
  const markers = series.filter((s) => s.mode === 'marker');
  const curves = series.filter((s) => s.mode === 'curve');
  const suggestion = state.suggestion;
  const out: string[] = [];

  const list = (names: string[]) =>
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  out.push(
    `The file will have ${table.rows.length} row${table.rows.length === 1 ? '' : 's'} and ` +
      `${table.columns.length} column${table.columns.length === 1 ? '' : 's'}.`,
  );

  if (markers.length) {
    out.push(
      `${list(markers.map((s) => s.name))} ${markers.length === 1 ? 'is' : 'are'} scattered points: ` +
        `each drawn marker was found separately and returns one row, at the position it was drawn at. ` +
        `That is ${markers.map((s) => `${finitePoints(s)} for ${s.name}`).join(', ')}. ` +
        'There is no point count to choose for these - the markers are the answer - so they keep ' +
        'their own x column rather than being moved onto the shared grid.',
    );
  }

  if (curves.length) {
    const rows = finitePoints(curves[0]);
    out.push(
      `${list(curves.map((s) => s.name))} ${curves.length === 1 ? 'is a' : 'are'} drawn ` +
        `curve${curves.length === 1 ? '' : 's'}: there are no separate markers to find, so the drawn ` +
        `line is traced and then sampled at ${rows} positions evenly spaced across the x axis. ` +
        'Those rows are a resampling of the line, not the points whoever drew the chart plotted.',
    );
    if (state.sampling === 'auto' && suggestion) {
      out.push(
        suggestion.confident
          ? `The count came from the trace itself: it kinks every ${suggestion.spacingPx?.toFixed(1)} px ` +
            `or so, ${suggestion.vertices} times across the plot, and each kink is a vertex of the ` +
            'drawn polyline - a real data point. It is an estimate, and it reads low where the line is ' +
            'drawn wider than the spacing of its own points, because then some kinks are not separable ' +
            'from the ink.'
          : `No regular vertex spacing could be read off the trace, so the count is one row per pixel ` +
            'column. That neither invents a value nor discards one, and it is the honest default when ' +
            'the picture will not say what the sampling rate was.',
      );
    } else if (state.sampling === 'uniform') {
      out.push(
        `The count is yours: ${state.count} rows, evenly spaced across the same x range. ` +
          (suggestion
            ? `The trace itself suggests ${suggestion.count}.`
            : ''),
      );
    } else {
      out.push(
        'One row per pixel column of the plot, which neither invents a value nor discards one.',
      );
    }
  }

  const nextLines: string[] = [];
  if (curves.length) {
    const columns = state.analysis
      ? state.analysis.frame.rect.x1 - state.analysis.frame.rect.x0 + 1
      : 0;
    if (state.sampling !== 'uniform') {
      nextLines.push(
        'Choosing a number instead gives you exactly that many rows across the same x range, ' +
          'each one interpolated between the same traced pixels: fewer rows do not change the shape ' +
          'of the curve, they sample it more coarsely.',
      );
    }
    if (state.sampling !== 'native' && columns > 0) {
      nextLines.push(`One row per pixel column would give ${columns} rows.`);
    }
    if (state.sampling !== 'auto' && suggestion) {
      nextLines.push(`Automatic would give ${suggestion.count}.`);
    }
  }
  if (markers.length) {
    nextLines.push(
      `Setting ${markers[0].name} to Curve instead would stop treating its markers as separate ` +
        'points: the tool would take one y for every x column its ink covers and put that on the ' +
        `shared grid, so its ${finitePoints(markers[0])} measured positions would be replaced by ` +
        'interpolated ones.',
    );
  }
  if (curves.length) {
    nextLines.push(
      `Setting ${curves[0].name} to Markers would return one point per separate blob of its ink, ` +
        'which is right for a scatter and wrong for a line - a solid line is one blob and comes ' +
        'back as one point.',
    );
  }
  if (nextLines.length) out.push(nextLines.join(' '));

  const merged = state.analysis?.series.reduce((n, s, i) => {
    const mode = state.modes[i] === 'auto' ? s.autoMode : state.modes[i];
    return n + (state.visible.has(i) && mode === 'marker' ? s.mergedComponents : 0);
  }, 0);
  if (merged) {
    out.push(
      `${merged} of those blobs ${merged === 1 ? 'is' : 'are'} wider than a single marker, so ` +
        `${merged === 1 ? 'it holds' : 'they hold'} several markers drawn close enough to touch and ` +
        `${merged === 1 ? 'comes' : 'come'} back as one point at the shared centre. There is nothing ` +
        'in the picture that says where one marker ends and the next begins, so the count reported ' +
        'is the count found rather than an extrapolation.',
    );
  }
  return out;
}

/** One line for the panel header, saying exactly what it counts. */
function outputSummary(series: DataSeries[]): string {
  if (series.length === 0) return 'Nothing selected.';
  const table = toTable(series);
  return `${series.length} series, ${table.rows.length} rows, ${table.columns.length} columns.`;
}

/**
 * The extracted numbers as a table.
 *
 * The same table the export writes, so what is on screen and what lands in the
 * file cannot disagree. Selectable, scrollable in both directions, and with the
 * header row and the first column pinned so a wide table stays readable on a
 * phone.
 */
function renderTable(series: DataSeries[]): void {
  const table = toTable(series);
  if (table.columns.length === 0) {
    tableHost.innerHTML = '<p class="status">Nothing is ticked, so there is nothing to show.</p>';
    tableNote.textContent = '';
    return;
  }
  const shown = table.rows.slice(0, TABLE_ROW_LIMIT);
  tableNote.textContent =
    shown.length < table.rows.length
      ? `first ${shown.length} of ${table.rows.length} rows - the export has all of them`
      : `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} x ${table.columns.length} columns`;
  const head = table.columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('');
  const body = shown
    .map(
      (row) =>
        `<tr>${row
          .map((v) => `<td>${v === null ? '' : escapeHtml(cell(v))}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  tableHost.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * How many rows the on-screen table draws.
 *
 * A one-point-per-pixel-column export is thousands of rows, and putting all of
 * them in the DOM costs a phone more than it is worth for a table nobody reads
 * past the top of. The export is never truncated, and the note says so.
 */
const TABLE_ROW_LIMIT = 500;

/** Six significant figures, which is what the CSV writes. */
function cell(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential(6);
  return String(Number(v.toFixed(6)));
}

function previewText(series: DataSeries[]): string {
  if (!state.analysis || !state.calibration || series.length === 0) return '';
  const csv = toCsv(state.analysis, series, csvOptions());
  const lines = csv.split('\n');
  const head = lines.filter((l) => l.startsWith('#'));
  const body = lines.filter((l) => !l.startsWith('#') && l.trim());
  return [...head, ...body.slice(0, 6), body.length > 6 ? `… ${body.length - 1} rows` : ''].join('\n');
}

/** Human names for the marker shapes offered per series. */
const SHAPE_NAMES: Record<string, string> = {
  circle: 'Circle',
  rect: 'Square',
  triangle: 'Triangle',
  diamond: 'Diamond',
  roundRect: 'Rounded square',
  pin: 'Pin',
  arrow: 'Arrow',
  none: 'No marker',
};

/** How many of the shown series are curves, which is what a count applies to. */
function curveCount(series: DataSeries[]): number {
  return series.filter((s) => s.mode === 'curve').length;
}

function explainHtml(series: DataSeries[]): string {
  return outputExplanation(series)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('');
}

/** `#rrggbb` for a colour input, from whatever CSS colour is stored. */
function hexColour(css: string): string {
  const m = css.match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return '#000000';
  const hex = (v: string) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function round(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

replaceStep('empty');
render();
// Warm the OCR worker while the user is still cropping.
void ocr.start();
