# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this project is

A fully client-side tool that reads numbers back out of plot images: a browser app, and a minimal Kotlin WebView shell in `android/`
that hosts the same bundle so a Smart Select crop can be shared to it.
`README.md` covers running it, the workflow and the engine's public API; `ACCURACY.md` carries the measured error numbers;
`ANDROID.md` covers the app, sideloading, and what was verified on a Galaxy S24 Ultra.

Two rules run through the whole design and are worth knowing before changing anything: **a marker series returns one point per drawn
marker and never an estimate of how many there should be**, and **anything cosmetic - a name read off a legend, a marker shape - must not
be able to reach a number**.

## Hard constraints

- **`src/engine/` must stay DOM-free.** It operates on `{width, height, data: Uint8ClampedArray}` RGBA buffers, never on canvases or images.
  The Android app in `android/` runs this engine unchanged inside a WebView, and the whole test suite depends on running it under Node.
  Anything needing the DOM goes in `src/ui/`; OCR reaches the engine through the injected `OcrProvider` interface.
- **No network at runtime.** The tesseract worker, WASM core and language data are served from the bundle (`npm run assets` assembles
  all of `public/`, which is generated and ignored in full). `dist/` must stay a self-contained static bundle with relative URLs, and the
  Android app requests no `INTERNET` permission, so it cannot reach the network even by mistake - check with
  `aapt2 dump badging app-debug.apk | grep uses-permission` after touching the manifest or adding a dependency.

## Three builds of the same page

`npm run build` produces `dist/`: a classic script inlined into one HTML file, because Chrome blocks ES modules and workers over
`file://`, so that build has no OCR and says so.
`npm run build:android` produces `dist-android/` as ES modules and syncs it into the app's assets; the WebView serves it from an
asset-loader https origin, which is a normal secure context, so **OCR does run there**.
`npm run build:review` produces `review/plot2data-review.html`, the same modules folded into one file that carries its own OCR assets
gzipped inside the page, for putting on an arbitrary https host with nothing beside it; README and `tools/single-file.ts` say what it
drops and why. Keep all three working - `vite.config.ts` switches on `P2D_ANDROID` and `P2D_SINGLE`. Build the APK with
`npm run android:apk`, which also resolves the SDK and a JDK 17+ (the system JDK is too old for AGP).

## Testing

`npm test` runs unit tests *and* `test/accuracy.test.ts`, which extracts every corpus case and asserts hard budgets on **two** metrics,
so an accuracy regression fails the build. RMS over the whole trace is one; the signed shortfall at the turning points is the other, and
it exists because RMS hid a defect that lost a third of every spike. Any change to `src/engine/trace.ts` must be judged on both.

`test/halo.test.ts` and `test/legend.test.ts` are the other two that measure rather than assert shapes: the first that no series is
another's antialiased edge and that every series lands where it was drawn, the second that the names read off a legend change no number.
Both run against `examples/real/02-microprocessor-log-scatter.png`, which is the chart they exist for.

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
- **A pixel belongs to the series whose blend it is, not the colour it is nearest.** An antialiased pixel is a point on the segment from
  the paper to its series' ink, so that is what `image.ts:blendDistance` measures it against. Comparing saturated colours instead is wrong
  in a way that only shows on a chart where one series' fade to white passes near another's colour - dark red fading to white passes
  squarely through orange - and it put 123 halo specks into the orange series on the microprocessor chart while losing all 54 real markers.
  The one rival still judged on its solid colour is the **gridline**: grey on white lies exactly on any black series' segment.
- **A statistic is only as good as the population it is taken over.** The marker size window's median was dragged to 0.79 px by a cloud of
  sub-pixel dust that outnumbered the markers, so it kept the dust and threw away the data. Anything that sets a scale from a population
  should be floored or weighted by ink, which dust cannot move.
- **A marker is its cross-section.** An inward-pointing tick mark inside the plot frame has the area of a small marker and is a two-pixel
  sliver; a row of markers drawn touching has several markers' area and is still exactly one marker tall. Size alone gets both wrong.
- **Stroke thickness is measured perpendicular to the path**, as ink area over path length, and the path it divides by is the *corrected*
  trace. Both parts matter: the median vertical extent of a column reads 4x too high on a spiky series, and the raw centroid path cuts
  every corner and comes out a third short, which inflates the width again. Anything derived from thickness - the apex correction, the
  reported uncertainty - is wrong by the same factor if this is got wrong.
- A rule that fires *sometimes* has to be gated on something with a wide margin, not on a fine comparison. The mitred-corner correction
  compares the ink's cross-section against the stroke width; gated on a near-equality it fired everywhere and undid most of the peak fix,
  and gated on "is this a sliver or most of a stroke" it fires only where it should.
- The stage and overlay panels share one pan/zoom class (`src/ui/viewport.ts`) over **image pixel coordinates**; the chart panel is
  ECharts and speaks **data units**, and the calibration converts between them (`src/ui/chart.ts`). A shared zoom therefore goes through
  the same round trip the overlay is built on and cannot drift from what is drawn. The library lives in `src/ui/` only - the engine has no
  dependencies and `test/engine-purity.test.ts` enforces it.
- **The three plot panels are fixed light in both colour schemes** (the `--panel-*` tokens, which the dark block does not redefine). The
  series colours belong to the chart and were chosen against white paper. The chrome around them still follows the system setting - which
  means anything laid *inside* `.stage` inherits the light mat and needs its own colour.
- **The original panel draws no extraction.** Frame, ticks and the four anchors only. It is the clean view everything else is compared
  against, and drawing our points over the chart's own markers cost the captain real time working out whether his chart had strange
  markers before he realised the speckles were ours.
- `tools/inline-bundle.ts` must never use a *string* replacement to splice the bundle into the HTML: `String.replace` expands `$&`,
  `` $` `` and `$'`, and a minified bundle is full of them. It corrupted `dist/index.html` silently, because nothing else in the build
  looks at what came out. The tool now checks the script it wrote matches the bundle it read.
- **A mirror is invisible to any check that compares values.** A left-to-right flip cancels itself out of a desktop-versus-phone
  comparison, out of a CSV diff, and out of every panel that is symmetric; `test/orientation.test.ts` therefore asserts *direction* on a
  chart drawn asymmetrically on purpose, on both the exported numbers and the `valueToPixel` round trip the overlay draws with. When
  chasing a claim that something is mirrored, check the direction invariant over every corpus and example image before reading code:
  `pixelToValue` across the frame must rise with pixel x, and the round trip back must be exact.
- **Every view change has to be announced or the three panels drift apart.** They share a zoom by handing each other one window, so a
  gesture that moves a panel without calling its view-change callback leaves the other two behind - and a panel that keeps its zoom when
  its content is replaced opens on a region the new image does not have, or on none of it. Both happened.
- `hidden` loses to any explicit `display` in the stylesheet, and several controls here are laid out with flex and toggled with `hidden`.
  `styles.css` forces `[hidden] { display: none !important }` for that reason.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
