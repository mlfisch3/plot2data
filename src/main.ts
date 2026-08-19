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
  toXlsx,
  DELIMITERS,
  type Analysis,
  type AxisScale,
  type Calibration,
  type DataSeries,
  type DelimiterName,
  type ImageBuffer,
  type Rect,
  type SamplingSuggestion,
} from './engine/index.ts';
import { calibrateAxis } from './engine/calibration.ts';
import { BrowserOcr } from './ui/ocr.ts';
import { ACCEPT_ATTRIBUTE, cropBuffer, fileFromTransfer, loadImageFile } from './ui/image-io.ts';
import { Stage, cssColour, type AnchorId } from './ui/stage.ts';
import { ReplotChart } from './ui/chart.ts';
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
  /** `auto` follows the suggestion; the other two are the user's own choice. */
  sampling: 'auto' | 'uniform' | 'native';
  count: number;
  suggestion: SamplingSuggestion | null;
  modeOverride: 'auto' | 'curve' | 'marker';
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
  sampling: 'auto',
  count: 100,
  suggestion: null,
  modeOverride: 'auto',
  delimiter: 'comma',
  withHeader: true,
  imageOpacity: 0.45,
  pointRadius: 1.5,
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
        <div class="panel-canvas"><canvas id="replot" aria-label="The extracted data re-plotted"></canvas></div>
        <div class="panel-tools">
          <label class="check-row"><input type="checkbox" id="link-zoom" checked /> Share zoom across panels</label>
          <button id="replot-fit">Fit</button>
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
          <label for="point-size">Points</label>
          <input type="range" id="point-size" min="0" max="6" step="0.5" value="1.5"
            aria-label="Point marker size" />
          <label class="check-row"><input type="checkbox" id="magnify" /> Magnifier</label>
          <button id="overlay-fit">Fit</button>
        </div>
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
const replotNote = document.getElementById('replot-note')!;

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
  document.getElementById('replot') as HTMLCanvasElement,
  () => chartTheme(),
  (v) => mirrorZoom(() => v.visibleWindow(), 'chart'),
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

function mirrorZoom(window_: () => WorldRect, from: 'stage' | 'chart' | 'overlay'): void {
  if (mirroring || !state.linkZoom || state.phase !== 'ready') return;
  mirroring = true;
  const w = window_();
  if (from !== 'stage') stage.showWindow(w);
  if (from !== 'chart') chart.viewport.showWindow(w);
  if (from !== 'overlay') overlay.viewport.showWindow(w);
  mirroring = false;
}

function chartTheme() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: pick('--surface', '#fff'),
    axis: pick('--border', '#d7dce3'),
    grid: pick('--surface-2', '#eef1f5'),
    text: pick('--text-dim', '#5b6472'),
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
    stage.setAnalysis(state.analysis, state.calibration, state.visible);
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
document.getElementById('replot-fit')!.addEventListener('click', () => chart.viewport.resetView());
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
    });
    state.analysis = analysis;
    state.calibration = analysis.calibration;
    state.visible = new Set(analysis.series.map((_, i) => i));
    state.names = analysis.series.map((_, i) => `series_${i + 1}`);
    state.suggestion = suggestPointCount(analysis);
    if (state.sampling === 'auto') state.count = state.suggestion.count;
    state.phase = 'ready';
    pushStep('ready');
    render();
    stage.setImage(state.croppedBitmap, null);
    stage.setAnalysis(analysis, state.calibration, state.visible);
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
  state.suggestion = suggestPointCount(state.analysis);
  if (state.sampling === 'auto') state.count = state.suggestion.count;
  renderPanel();
  refresh();
}

function currentSeries(): DataSeries[] {
  if (!state.analysis || !state.calibration) return [];
  return buildSeries(state.analysis, {
    calibration: state.calibration,
    resample:
      state.sampling === 'native'
        ? { kind: 'native' }
        : { kind: 'uniform', count: Math.max(2, state.count) },
    names: state.names,
    include: state.visible,
  });
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
  stage.setCalibration(state.calibration, state.visible);
  chart.setData({
    series,
    calibration: state.calibration,
    rect: state.analysis.frame.rect,
    units: state.analysis.units,
    pointRadius: state.sampling === 'native' ? 0 : Math.min(2.5, state.pointRadius),
  });
  if (state.croppedBitmap) {
    overlay.setData({
      bitmap: state.croppedBitmap,
      series,
      calibration: state.calibration,
      imageOpacity: state.imageOpacity,
      pointRadius: state.pointRadius,
      magnify: state.magnify,
    });
  }
  replotNote.textContent = `${series.length} of ${state.analysis.series.length} series, ${
    series[0]?.points.length ?? 0
  } points`;

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
  const preview = document.getElementById('preview');
  if (preview) preview.textContent = previewText(series);
  const countInput = document.getElementById('count') as HTMLInputElement | null;
  if (countInput && document.activeElement !== countInput) countInput.value = String(state.count);
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
      <div id="series-list">
        ${analysis.series
          .map((s, i) => {
            const built = series.find((d) => d.name === state.names[i]);
            return `
          <div class="series-row">
            <input type="checkbox" id="vis-${i}" ${state.visible.has(i) ? 'checked' : ''}
              aria-label="Include ${escapeHtml(state.names[i])}" />
            <span class="swatch" style="background:${cssColour(s.traced.colour)}"></span>
            <span class="series-name"><input type="text" id="name-${i}" value="${escapeHtml(state.names[i])}" aria-label="Name for series ${i + 1}" /></span>
            <span class="series-meta">${s.traced.mode === 'marker' ? `${s.traced.points.length} pts` : 'curve'}${
              built ? `<br>±${escapeHtml(compact(built.uncertainty.y))}` : ''
            }</span>
          </div>`;
          })
          .join('')}
      </div>
      ${analysis.series.length === 0 ? '<p class="status">No series were found. Try a tighter crop.</p>' : ''}
    </div>

    <div class="card">
      <h2>Output</h2>
      <div class="row">
        <div>
          <label for="sampling">Point count</label>
          <select id="sampling">
            <option value="auto">Automatic</option>
            <option value="uniform">Choose a number</option>
            <option value="native">One per pixel column</option>
          </select>
        </div>
        <div>
          <label for="count">Points</label>
          <input type="number" id="count" min="2" max="20000" step="1" value="${state.count}"
            ${state.sampling === 'auto' || state.sampling === 'native' ? 'disabled' : ''} />
        </div>
      </div>
      <p class="status" id="sampling-reason">${escapeHtml(state.suggestion?.reason ?? '')}</p>
      <p class="status" id="output-summary">${escapeHtml(outputSummary(series))}</p>
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

function outputSummary(series: DataSeries[]): string {
  if (series.length === 0) return 'Nothing selected.';
  const rows = Math.max(...series.map((s) => s.points.length));
  const marker = series.some((s) => s.mode === 'marker');
  return `${series.length} series, ${rows} rows, evenly spaced in x. ${
    marker
      ? 'Marker rows are detected data points, at the x positions they were drawn at.'
      : 'Curve rows are a resampling of the drawn line, not the original data points.'
  }`;
}

function previewText(series: DataSeries[]): string {
  if (!state.analysis || !state.calibration || series.length === 0) return '';
  const csv = toCsv(state.analysis, series, csvOptions());
  const lines = csv.split('\n');
  const head = lines.filter((l) => l.startsWith('#'));
  const body = lines.filter((l) => !l.startsWith('#') && l.trim());
  return [...head, ...body.slice(0, 6), body.length > 6 ? `… ${body.length - 1} rows` : ''].join('\n');
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
