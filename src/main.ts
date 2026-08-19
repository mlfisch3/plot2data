/**
 * plot2data UI.
 *
 * A thin layer over `src/engine`: it loads pixels, lets the user crop, runs the
 * engine once, and then re-applies the calibration on every edit. All of the
 * numerical work lives in the engine, which knows nothing about the DOM.
 *
 * The same page runs in a browser tab and inside the Android shell. The three
 * differences a phone forces - an image arriving from a share sheet, a back
 * button that has to mean something, and a CSV that cannot simply be
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
  toCsv,
  type Analysis,
  type AxisScale,
  type Calibration,
  type DataSeries,
  type ImageBuffer,
  type Rect,
} from './engine/index.ts';
import { calibrateAxis } from './engine/calibration.ts';
import { BrowserOcr } from './ui/ocr.ts';
import { ACCEPT_ATTRIBUTE, cropBuffer, fileFromTransfer, loadImageFile } from './ui/image-io.ts';
import { Stage, cssColour, type AnchorId } from './ui/stage.ts';
import {
  canShareCsv,
  exportCsv,
  fetchIncoming,
  installHost,
  onAndroid,
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
  resample: 'uniform' | 'native';
  count: number;
  modeOverride: 'auto' | 'curve' | 'marker';
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
  resample: 'uniform',
  count: 100,
  modeOverride: 'auto',
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
        <canvas id="stage" aria-label="Plot image with crop and calibration overlay"></canvas>
        <div class="stage-bar">
          <span class="filename" id="filename"></span>
          <button id="fit" hidden>Fit</button>
          <button id="reset">New image</button>
          <button id="recrop" hidden>Adjust crop</button>
          <button id="extract" class="primary" hidden>Extract data</button>
        </div>
      </div>
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
  },
});

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
    stage.resize();
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
  stage.resize();
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
  forgetSession();
  stage.setImage(null, null);
  render();
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
  resample: State['resample'];
  count: number;
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
    resample: state.resample,
    count: state.count,
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
      state.resample = restored.resample;
      state.count = restored.count;
    }
    state.analysis = null;
    state.calibration = null;
    state.choices = [];
    if (state.phase === 'empty') pushStep('cropping');
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
    state.choices = images;
    // A new share always starts over, whatever the user was in the middle of.
    if (state.phase !== 'empty') clearImage();
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
window.addEventListener('resize', () => stage.resize());
window.addEventListener('orientationchange', () => setTimeout(() => stage.resize(), 120));

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
fitBtn.addEventListener('click', () => stage.resetView());

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
    state.phase = 'ready';
    pushStep('ready');
    render();
    stage.setImage(state.croppedBitmap, null);
    stage.setAnalysis(analysis, state.calibration, state.visible);
    stage.resize();
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

function updateCalibration(id: AnchorId, patch: { px?: number; value?: number }): void {
  if (!state.calibration) return;
  const axis = id.startsWith('x') ? 'x' : 'y';
  const which = id.endsWith('a') ? 'a' : 'b';
  const cal = state.calibration[axis];
  const anchor = { ...cal[which], ...patch, source: 'manual' as const };
  state.calibration = { ...state.calibration, [axis]: { ...cal, [which]: anchor } };
  stage.setCalibration(state.calibration, state.visible);
  renderPanel();
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
  stage.setCalibration(state.calibration, state.visible);
  renderPanel();
}

function setAnnotation(axis: 'x' | 'y', enabled: boolean): void {
  if (!state.calibration || !state.analysis) return;
  const found = state.analysis.annotations.find(
    (a) => (a.side === 'left' ? 'y' : 'x') === axis,
  );
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
  stage.setCalibration(state.calibration, state.visible);
  renderPanel();
}

function currentSeries(): DataSeries[] {
  if (!state.analysis || !state.calibration) return [];
  const all = buildSeries(state.analysis, {
    calibration: state.calibration,
    resample: state.resample === 'native' ? { kind: 'native' } : { kind: 'uniform', count: state.count },
    names: state.names,
  });
  return all.filter((_, i) => state.visible.has(i));
}

function csvFileName(): string {
  return `${state.fileName.replace(/\.[^.]+$/, '') || 'plot'}-data.csv`;
}

/* ----------------------------------------------------------------- render */

function render(): void {
  renderIntake();
  filenameEl.textContent = state.fileName;
  extractBtn.hidden = state.phase !== 'cropping';
  extractBtn.disabled = state.phase === 'working';
  recropBtn.hidden = state.phase !== 'ready';
  fitBtn.hidden = !stage.zoomed;
  renderPanel();
}

function renderPanel(): void {
  if (state.phase === 'empty') {
    panel.innerHTML = `
      <div class="card">
        <h2>How it works</h2>
        <ol class="steps">
          <li>Load a screenshot of a line or scatter plot.</li>
          <li>Crop to a single plot area.</li>
          <li>Check the four axis anchors. They are pre-filled from the tick labels but you decide what is right.</li>
          <li>${onAndroid ? 'Save or share' : 'Download'} the CSV, uncertainty and all.</li>
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
      ${axisBlock('x', 'X axis')}
      ${axisBlock('y', 'Y axis')}
      <div class="mapping" id="mapping">${escapeHtml(mappingText())}</div>
    </div>

    <div class="card">
      <h2>Series</h2>
      <div id="series-list">
        ${analysis.series
          .map((s, i) => {
            const uncertain = series.find((d) => d.name === state.names[i]);
            return `
          <div class="series-row">
            <input type="checkbox" id="vis-${i}" ${state.visible.has(i) ? 'checked' : ''}
              aria-label="Include ${escapeHtml(state.names[i])}" />
            <span class="swatch" style="background:${cssColour(s.traced.colour)}"></span>
            <span class="series-name"><input type="text" id="name-${i}" value="${escapeHtml(state.names[i])}" aria-label="Name for series ${i + 1}" /></span>
            <span class="series-meta">${s.traced.mode === 'marker' ? `${s.traced.points.length} pts` : 'curve'}${
              uncertain ? `<br>±${escapeHtml(compact(uncertain.uncertainty.y))}` : ''
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
          <label for="resample">Sampling</label>
          <select id="resample">
            <option value="uniform">Uniform</option>
            <option value="native">Native (per pixel column)</option>
          </select>
        </div>
        <div>
          <label for="count">Points</label>
          <input type="number" id="count" min="2" max="20000" step="1" value="${state.count}" />
        </div>
      </div>
      <div class="row export-row">
        <button class="primary" id="save" ${series.length === 0 ? 'disabled' : ''}>
          ${onAndroid ? 'Save CSV' : 'Download CSV'}
        </button>
        ${
          shareable
            ? `<button id="share" ${series.length === 0 ? 'disabled' : ''}>Share CSV</button>`
            : ''
        }
      </div>
      <p class="status">${escapeHtml(outputSummary(series))}</p>
      <div class="preview" id="preview">${escapeHtml(previewText(series))}</div>
    </div>
  `;

  wirePanel();

  function axisBlock(axis: 'x' | 'y', title: string): string {
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
          <span class="tag">A</span>
          <div><label for="${axis}a-px">pixel</label><input type="number" id="${axis}a-px" step="0.1" value="${round(a.a.px)}" /></div>
          <div><label for="${axis}a-val">value</label><input type="text" inputmode="decimal" id="${axis}a-val" value="${formatValue(a.a.value)}" /></div>
          <span class="tag">B</span>
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

  function mappingText(): string {
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

  const list = document.getElementById('series-list');
  if (list && state.analysis) {
    state.analysis.series.forEach((_, i) => {
      const vis = document.getElementById(`vis-${i}`) as HTMLInputElement | null;
      vis?.addEventListener('change', () => {
        if (vis.checked) state.visible.add(i);
        else state.visible.delete(i);
        stage.setCalibration(state.calibration!, state.visible);
        renderPanel();
      });
      const name = document.getElementById(`name-${i}`) as HTMLInputElement | null;
      name?.addEventListener('change', () => {
        state.names[i] = name.value.trim() || `series_${i + 1}`;
        renderPanel();
      });
    });
  }

  const resample = document.getElementById('resample') as HTMLSelectElement | null;
  if (resample) {
    resample.value = state.resample;
    resample.addEventListener('change', () => {
      state.resample = resample.value as State['resample'];
      scheduleSave();
      renderPanel();
    });
  }
  const count = document.getElementById('count') as HTMLInputElement | null;
  count?.addEventListener('change', () => {
    const v = Math.round(Number(count.value));
    if (Number.isFinite(v) && v >= 2) state.count = Math.min(20000, v);
    scheduleSave();
    renderPanel();
  });

  document.getElementById('save')?.addEventListener('click', () => void send('save'));
  document.getElementById('share')?.addEventListener('click', () => void send('share'));
}

async function send(destination: 'save' | 'share'): Promise<void> {
  if (!state.analysis || !state.calibration) return;
  const csv = toCsv(state.analysis, currentSeries(), {
    source: state.fileName,
    calibration: state.calibration,
  });
  await exportCsv(destination, csvFileName(), csv);
}

function outputSummary(series: DataSeries[]): string {
  if (series.length === 0) return 'Nothing selected.';
  const rows = Math.max(...series.map((s) => s.points.length));
  const marker = series.some((s) => s.mode === 'marker');
  return `${series.length} series, ${rows} rows. ${
    marker
      ? 'Marker rows are detected data points.'
      : 'Curve rows are a resampling of the drawn line, not the original data points.'
  }`;
}

function previewText(series: DataSeries[]): string {
  if (!state.analysis || !state.calibration || series.length === 0) return '';
  const csv = toCsv(state.analysis, series, {
    source: state.fileName,
    calibration: state.calibration,
  });
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
