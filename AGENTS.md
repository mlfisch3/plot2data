# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this project is

A fully client-side tool that reads numbers back out of plot images: a browser app, and a minimal Kotlin WebView shell in `android/`
that hosts the same bundle so a Smart Select crop can be shared to it.
`README.md` covers running it, the workflow and the engine's public API; `ACCURACY.md` carries the measured error numbers;
`ANDROID.md` covers the app, sideloading, and what remains unverified without a phone.

## Hard constraints

- **`src/engine/` must stay DOM-free.** It operates on `{width, height, data: Uint8ClampedArray}` RGBA buffers, never on canvases or images.
  The Android app in `android/` runs this engine unchanged inside a WebView, and the whole test suite depends on running it under Node.
  Anything needing the DOM goes in `src/ui/`; OCR reaches the engine through the injected `OcrProvider` interface.
- **No network at runtime.** The tesseract worker, WASM core and language data are served from the bundle (`npm run assets` assembles
  all of `public/`, which is generated and ignored in full). `dist/` must stay a self-contained static bundle with relative URLs, and the
  Android app requests no `INTERNET` permission, so it cannot reach the network even by mistake - check with
  `aapt2 dump badging app-debug.apk | grep uses-permission` after touching the manifest or adding a dependency.

## Two builds of the same page

`npm run build` produces `dist/`: a classic script inlined into one HTML file, because Chrome blocks ES modules and workers over
`file://`, so that build has no OCR and says so.
`npm run build:android` produces `dist-android/` as ES modules and syncs it into the app's assets; the WebView serves it from an
asset-loader https origin, which is a normal secure context, so **OCR does run there**. Keep both working - `vite.config.ts` switches on
`P2D_ANDROID`. Build the APK with `npm run android:apk`, which also resolves the SDK and a JDK 17+ (the system JDK is too old for AGP).

## Testing

`npm test` runs unit tests *and* `test/accuracy.test.ts`, which extracts every corpus case and asserts hard budgets on **two** metrics,
so an accuracy regression fails the build. RMS over the whole trace is one; the signed shortfall at the turning points is the other, and
it exists because RMS hid a defect that lost a third of every spike. Any change to `src/engine/trace.ts` must be judged on both.
`npm run accuracy` prints the per-case table; `npm run report` regenerates `ACCURACY.md`.

Corpus images are committed. Regenerate them with `npm run corpus` (headless Chrome via `puppeteer-core`, using the system Chrome)
only when `tools/corpus-spec.ts` changes, and **name the cases you mean** (`npm run corpus -- narrow-peaks`): a bare `npm run corpus`
re-renders all of them and moves every number in `ACCURACY.md` with them.

`tools/diagnose.ts` and `tools/diagnose-series.ts` dump what each detection stage found for every corpus and example image;
`tools/report-one.ts` prints the full analysis and CSV for one image. Reach for these before changing a threshold.

## Sharp edges learned the hard way

- A low RMS error does not mean a good extraction, twice over: a trace truncated where another series crossed it still scored 0.04%,
  and a trace that shaved a third off every spike still scored 0.26%. A plot has few peaks and many columns, so an average over x hides
  both. The accuracy suite asserts x **coverage** and **peak shortfall** separately for that reason.
- **The synthetic corpus alone would not have caught the peak clipping.** Chart.js mitres its corners, and a miter overruns the vertex
  by enough to mask a clipped centroid; matplotlib, which drew the captain's charts, rounds them. `narrow-peaks` carries round corners and
  `sawtooth-sharp` mitred ones on purpose. Measure a real screenshot before believing a corpus result about peaks.
- The overlay the UI draws over the traced path is deliberately unlike the ink beneath it. That is what makes a bad trace visible;
  drawing the trace in the series colour hides exactly the failures worth seeing.
- **Android's asset merger gunzips any `.gz` in `assets/` and drops the extension.** That is why the language data is vendored gzipped
  under `vendor/` and shipped expanded. Anything added to the bundle should be checked for by name inside the APK
  (`unzip -l app-debug.apk | grep assets/`); a missing asset costs OCR silently, because the tool is designed to carry on without it.
- Touch targets are worth measuring rather than assuming. Three marker-handle bugs only showed up when the hit region was actually swept:
  a handle at the canvas edge had half its target off screen, a guide line crossing a handle out-competed it entirely, and zoomed in far
  enough all four handles clamp to their edges and two of them land in the same corner.
- Thresholds that are absolute in pixels or in colour distance break on the next image. Prefer limits relative to the plot size,
  to the strongest ink in the image, or to the label text's own measured size - most bugs here were a constant that did not scale.
- **Stroke thickness is measured perpendicular to the path**, as ink area over path length, and the path it divides by is the *corrected*
  trace. Both parts matter: the median vertical extent of a column reads 4x too high on a spiky series, and the raw centroid path cuts
  every corner and comes out a third short, which inflates the width again. Anything derived from thickness - the apex correction, the
  reported uncertainty - is wrong by the same factor if this is got wrong.
- A rule that fires *sometimes* has to be gated on something with a wide margin, not on a fine comparison. The mitred-corner correction
  compares the ink's cross-section against the stroke width; gated on a near-equality it fired everywhere and undid most of the peak fix,
  and gated on "is this a sliver or most of a stroke" it fires only where it should.
- The three result panels share one pan/zoom class (`src/ui/viewport.ts`) over **image pixel coordinates**, which is why the chart panel
  is drawn in pixels and labelled in data units. A panel with an axis gutter passes an `inset`, or its content is fitted to the wrong box
  and two linked panels disagree about what they are showing.
- `hidden` loses to any explicit `display` in the stylesheet, and several controls here are laid out with flex and toggled with `hidden`.
  `styles.css` forces `[hidden] { display: none !important }` for that reason.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
