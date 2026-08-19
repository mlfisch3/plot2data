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
  Android app declares no permissions at all, so it cannot reach the network even by mistake.

## Two builds of the same page

`npm run build` produces `dist/`: a classic script inlined into one HTML file, because Chrome blocks ES modules and workers over
`file://`, so that build has no OCR and says so.
`npm run build:android` produces `dist-android/` as ES modules and syncs it into the app's assets; the WebView serves it from an
asset-loader https origin, which is a normal secure context, so **OCR does run there**. Keep both working - `vite.config.ts` switches on
`P2D_ANDROID`. Build the APK with `npm run android:apk`, which also resolves the SDK and a JDK 17+ (the system JDK is too old for AGP).

## Testing

`npm test` runs unit tests *and* `test/accuracy.test.ts`, which extracts every corpus case and asserts a hard error budget,
so an accuracy regression fails the build. `npm run accuracy` prints the per-case table; `npm run report` regenerates `ACCURACY.md`.

Corpus images are committed. Regenerate them with `npm run corpus` (headless Chrome via `puppeteer-core`, using the system Chrome)
only when `tools/corpus-spec.ts` changes - the ground-truth CSVs and the accuracy numbers move with them.

`tools/diagnose.ts` and `tools/diagnose-series.ts` dump what each detection stage found for every corpus and example image;
`tools/report-one.ts` prints the full analysis and CSV for one image. Reach for these before changing a threshold.

## Sharp edges learned the hard way

- A low RMS error does not mean a good extraction: a trace truncated where another series crossed it still scored 0.04%.
  The accuracy suite asserts x **coverage** separately for that reason.
- The overlay the UI draws over the traced path is deliberately unlike the ink beneath it. That is what makes a bad trace visible;
  drawing the trace in the series colour hides exactly the failures worth seeing.
- **Android's asset merger gunzips any `.gz` in `assets/` and drops the extension.** That is why the language data is vendored gzipped
  under `vendor/` and shipped expanded. Anything added to the bundle should be checked for by name inside the APK
  (`unzip -l app-debug.apk | grep assets/`); a missing asset costs OCR silently, because the tool is designed to carry on without it.
- Touch targets are worth measuring rather than assuming. Two anchor-handle bugs only showed up when the hit region was actually swept:
  a handle at the canvas edge had half its target off screen, and a guide line crossing a handle out-competed it entirely.
- Thresholds that are absolute in pixels or in colour distance break on the next image. Prefer limits relative to the plot size,
  to the strongest ink in the image, or to the label text's own measured size - most bugs here were a constant that did not scale.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
