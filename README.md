# plot2data

Extract numerical data from an image of a plot, entirely in your browser.

You have a screenshot of a line or scatter chart and you want the numbers back.
Drop the image in, crop to one plot, check the four axis markers, read the result off the stacked panels and the table beneath them, and download a CSV or an Excel workbook.
Nothing is uploaded: the whole pipeline, OCR included, runs on your machine and works offline.

![the workflow: load, crop, check the calibration, export](examples/real/01-multipanel-blue-ktrend.png)

## What it is good at

Clean, publication-style line and scatter plots on rectangular Cartesian axes - the kind used as illustrative graphics in reports and articles.
Measured error over the synthetic corpus is **0.03% to 0.29% of full scale**, and **under 0.3% at the peaks**, which are measured separately and for good reason;
see [ACCURACY.md](ACCURACY.md) for the numbers and how they were obtained.

It handles, and is tested on:

- linear and logarithmic axes, including `10^n` superscript decade labels
- abbreviated tick labels (`42k`, `1.5M`, `3bn`), percentages, currencies, thousands separators and decimal commas
- matplotlib-style `1e6` axis multiplier annotations, surfaced for confirmation rather than applied silently
- multiple series separated by colour, solid and dashed lines, markers, and light and dark themes
- strongly antialiased markers, where one series' fade into the paper passes through another series' colour
- colour-coded legends, read with the same OCR and used as the series names
- charts with no y-axis line, non-white backgrounds, faint or dotted gridlines, and JPEG compression
- text printed *inside* the plot area in the same colour as the series it labels
- densely spiked series, where a per-column centroid would shave a third off every peak

## What it is not for

Heavily occluded curves, hand-drawn charts, photos of screens, perspective correction, pie/polar/3D charts, stacked areas and heatmaps.
Choosing a suitable image is the user's job. If the tool cannot read a plot confidently it says so rather than guessing.

## Running it

Node 24 and npm 11.

```sh
npm install
npm run dev         # http://localhost:5173
npm run build       # static bundle in dist/
npm test            # engine unit tests and the measured-accuracy suite
npm run android:apk # debug APK in android/app/build/outputs/apk/debug/
```

`dist/index.html` is a single self-contained page: the script and stylesheet are inlined into it, so it runs from any static host
*and* by opening it straight from the filesystem. Over `file://` the browser refuses to start a web worker, so OCR is skipped and the
tool says so; you type the four marker values in and everything else - detection, tracing, the panels, the table, export - works exactly the same.

## On a phone

`android/` is a minimal Kotlin app that hosts the same bundle in a WebView, so a plot cropped with the S Pen's Smart Select can be
shared straight to it and come back as a CSV or a workbook. It serves the page over an asset-loader https origin rather than `file://`, which means
the module build loads and OCR does run there. [ANDROID.md](ANDROID.md) covers building, sideloading, and the Smart Select route.

Other scripts:

```sh
npm run corpus -- narrow-peaks  # re-render named corpus cases with headless Chrome
npm run corpus                  # re-render all of them, which moves every measured number
npm run report                  # regenerate ACCURACY.md from a live run
npm run accuracy                # print the per-case accuracy table
```

## Using it

1. **Load** a PNG or JPEG: drop it on the page, pick it with the file button, or paste from the clipboard.
2. **Crop** to a single plot. Include the axes and their tick labels; leave out titles, legends outside the frame, and neighbouring panels.
3. **Extract**. The tool finds the plot frame, the ticks, the series, and reads the tick labels.
4. **Check the calibration.** Four markers - `X1` and `X2` along the bottom, `Y1` and `Y2` up the side - are always shown and always editable.
   Drag a marker on the image, or type its pixel position and its value.
   Zoom the image with the scroll wheel, a pinch or the `+` button, which lands on the nearest tick; while a marker is dragged a magnifier
   opens on the pixels beneath it. Nothing ever snaps to a tick: a marker goes exactly where you put it.
   The live mapping statement under them ("x: 0 to 12, linear") is what will be used; if it looks wrong, it is wrong.
   **Recalculate** re-runs everything, though everything already re-runs as you drag or type.
5. **Read the panels.** The original with the calibration markers on it, the extracted numbers re-plotted as a chart, the two overlaid,
   and the numbers themselves in a table you can scroll and copy from.
   Zoom and pan any of them; they share a zoom unless you turn that off. Untick a series to drop it from the re-plot, the overlay, the table and the export at once.
6. **Export.** A CSV with the separator and header row you want, or a real `.xlsx` workbook.

Anything the tool is unsure about appears as a warning in the panel and again in the export header: an ambiguous linear/log axis,
a tick label discarded as a misread, a multiplier annotation it wants confirmed, a plot frame it could not identify.

### Export formats

- **CSV**, with the separator of your choice - comma, tab, semicolon or pipe - and an optional header. The header toggle governs both the
  column names and the comment block above them, so "no header" really means numbers only.
- **Excel**, as a real `.xlsx` workbook rather than a CSV with the extension changed. It is written by
  [`src/engine/xlsx.ts`](src/engine/xlsx.ts), about two hundred lines with no dependency: an xlsx is a zip of a few small XML parts, and
  zip entries may be stored rather than deflated, so the whole format costs a CRC table and a couple of headers. The numbers are written
  as numbers, so a chart drawn from them works straight away, and the calibration provenance goes on a second sheet rather than as prose
  above the table.

Either way, a series you have unticked is not in the file.

### Calibration is the whole ballgame

A wrong calibration is a silently wrong answer, so the design gives it no room to hide:

- The mapping is **always two visible, editable markers per axis**. Whatever fitting happens underneath, what ships to the file is a mapping you had the chance to check.
- Markers are pre-filled by a **least-squares fit over every readable tick**, not by trusting two of them.
  Real charts round their printed tick values (`0, 4k, 9k, 13k, 18k, 22k` for evenly spaced pixels); a two-point fit inherits the rounding error of exactly those two labels.
- **Linear versus log is decided, not assumed.** Two labelled ticks fit both models, so with fewer than three the tool says so and defaults to linear with the toggle made obvious.
  With three or more it compares residuals under both models and picks the fit.
- A label that disagrees wildly with the rest is **discarded as a misread and reported**, not averaged in.
- Uncertainty comes from the drawn line's own thickness and the axis scale. A 3 px line over a 600 px axis spanning 0-100 is ±0.25 no matter how good the algorithm is; that number is shown in the UI and written into the export header.
  Thickness is measured perpendicular to the path - ink area over path length - not as the vertical extent of a column, which on a spiky series is several times the line's real width.

### The panels

Checking an extraction means comparing it against the picture it came from, and the way people do that is to paste the numbers into a
spreadsheet and draw a chart. That check is built in:

1. **The original**, with the detected frame, the detected ticks and the four calibration markers drawn over it - and nothing else.
   The extraction is deliberately *not* drawn here. This is the one clean view of the source, and it is what everything below is compared
   against; our own points drawn over the chart's own markers destroy the thing being compared to.
2. **The extracted data, re-plotted** - not a picture of the trace over the image, but a chart drawn from the exported numbers, so what you
   are looking at is what the file contains. Drag to pan, pinch or scroll to zoom, or press **Zoom to a box** and drag a rectangle to zoom
   into a region. Hover or tap for a readout, and click a name in the legend to hide a series.
3. **The overlay** - the extracted series drawn back over the original image. The two are aligned **through the calibration**, by mapping
   each value back to a pixel, never by stretching the image to fit. That is the point: it is the round trip that is being tested, so a
   wrong calibration shows up as a visible mismatch rather than being hidden by the fit. The image opacity and the point size are
   adjustable, and a magnifier tool redraws the trace at its own scale for a close look.
4. **The numbers**, as a scrollable table you can select and copy from - the same table the export writes, so what is on screen and what
   lands in the file cannot disagree.

The overlay drawn this way is what found the peak clipping described below, so it earns its place.

All three plot panels are drawn on **light paper whatever the system colour scheme is**. The series colours belong to the chart, chosen by
whoever drew it against white paper; on a near-black panel a dark blue or a saturated red cannot be read at all, and the middle panel exists
to be compared against the source by eye. The app chrome around them still follows the system setting.

The chart panel is [Apache ECharts](https://echarts.apache.org/), tree-shaken to the pieces used. It was chosen on three constraints, in
this order: it **bundles**, with no runtime network on desktop or on the phone; its **touch** handling is first class rather than mouse
events with touch bolted on; and **region-select zoom** is built in. The reasoning, and what the alternatives cost, is recorded at the top of
[`src/ui/chart.ts`](src/ui/chart.ts). The engine keeps no dependency at all - the library lives in the UI layer, and the purity test still
passes.

### How each series is drawn

Every series is drawn to match what it came from, and every part of that is yours to change:

- A **scatter** source draws as unconnected markers and a **curve** source draws as a line - and both show their markers by default,
  because the points are what was actually extracted and hiding them behind a smooth line is how a bad extraction looks fine.
- **Marker shape, marker size, line on or off, line width and colour** are settable per series, under "How it is read and drawn".

### Series names from the chart

Where a chart's legend is colour-coded, the labels are read with the same OCR that reads the tick labels and used as the series names.
The label for the orange series is the text drawn in orange, wherever on the page it sits - inside the plot frame or outside it - which is
what makes a colour-coded legend tractable. Legend entries that wrap over two rows are joined, and a name is only adopted where the
entries line up into a column or a row: that alignment is what tells a legend entry from a chart title drawn in one of the same colours.

**Naming is cosmetic and stays that way.** Nothing about it touches a coordinate, a calibration or an exported number; a bad read costs a
name and falls back to `series_1`. Every name is editable, the toggle "Take names from legible labels on the chart" turns the whole thing
off, and whatever name is showing is what goes into the file.

### Output sampling

**A marker series returns one point per drawn marker, at the position it was drawn.** No resampling, no shared grid, no automatic count:
the markers are the answer, and the count is whatever was found. Those points keep their own x column in the file, because a marker's x is
a measured position and not a slot on a grid.

**A curve series is different**, because there are no separate markers to find. The drawn line is traced and then sampled at evenly spaced
x - evenly in log x on a log axis, which is what evenly spaced means on the axis as drawn - and every curve series shares one grid, so the
file is one table with one x column. A series that stops short leaves the cell blank rather than having a value extrapolated into it.

For a curve the **number of points is proposed, not demanded**. A drawn line chart is a polyline and its vertices are the real data points,
so the tool counts the kinks in the trace and offers the count their spacing implies. Where no regular spacing can be read the proposal is
one point per pixel column, which is uniform in x too and neither invents nor discards anything. Both the count and the mode are yours to
overrule.

It is an estimate and it says so. A line drawn wider than the spacing of its own data points hides some of its own vertices: on the
retail-sales chart it proposes 235 points against a true 331. Across the real screenshots it lands within about a factor of two.

A chart may hold both kinds at once, and then the file carries both: the curves under the shared x column, each marker series on its own
pair of columns, and a header line naming the mode of every series. The Output panel explains, in sentences, which series is which, where
the count came from, and what each of the other settings would give instead.

### Peaks

A per-column intensity centroid is the right value only while the column holds one flat stroke. At a sharp apex the same column holds
the rising edge, the tip and the falling edge, and the centroid lands halfway down the spike - which is how a spiky series comes back
with its peaks shaved off. The drawn line has a roughly uniform thickness and the plotted value sits at the *centre* of the stroke, so at
a turning point the value is half a stroke in from the outermost ink. Flat columns keep their centroid untouched, and the two regimes are
blended rather than switched, so there is no seam.

Because a plot has few peaks and many columns, a headline RMS hides this almost perfectly. Peak error is therefore measured and reported
separately; see [ACCURACY.md](ACCURACY.md).

### Markers versus curve

- **Marker mode** returns the alpha-weighted centre of mass of each detected marker blob - not the middle of its bounding box, which would
  quantise away the sub-pixel position the antialiased edge carries. Those are real samples and are the high-fidelity result, so they keep
  the x positions they were drawn at rather than being moved onto a grid.
- **Curve mode** traces the drawn path and resamples it onto the shared uniform grid. The CSV header says plainly that the rows are a
  resampling of a drawn curve, not the original data points.

The mode is chosen from the shape of the ink - a marker is a compact filled blob, a dash is an elongated sliver - and is **overridable per
series**, in the series list, after extraction. Both readings are computed during the analysis, so switching costs a rebuild rather than a
re-run. A chart carrying a scatter and a line at once is handled by setting each of them separately.

## The engine

The extraction engine lives in [`src/engine/`](src/engine) and is **pure TypeScript with no DOM dependency**.
It operates on plain RGBA buffers, so the same code runs in the browser, under `node --test`/vitest, and inside the Android wrapper.
The UI is a thin layer over it.

```ts
import { analyse, buildSeries, toCsv, toXlsx } from './src/engine/index.ts';

// `image` is { width, height, data: Uint8ClampedArray } in RGBA order.
const analysis = await analyse(image, { ocr });      // ocr is optional
// `modes` overrides the automatic curve/marker choice, per series.
const series = buildSeries(analysis, { resample: { kind: 'uniform', count: 100 } });
const csv = toCsv(analysis, series, { source: 'chart.png', delimiter: '\t' });
```

### Public API

| Function | What it does |
| --- | --- |
| `analyse(image, options)` | Runs the whole pipeline: frame, ticks, labels, calibration, segmentation, tracing. Returns everything in pixel space. Expensive; call once. |
| `buildSeries(analysis, options)` | Applies a calibration to the traced series and resamples. Cheap; call on every marker edit. |
| `detectFrame(image)` | Plot rectangle, axis spines, background colour, dark-theme flag. |
| `detectTicks(image, frame, side)` | Tick positions, geometrically, with a label-blob fallback for charts that draw no tick marks. |
| `readTickLabels(image, frame, scan, ocr)` | Reads the labels next to the ticks through an injected `OcrProvider`. |
| `parseLabel(text)` | Parses one tick label: suffixes, units, separators, scientific and `10^n` forms. |
| `calibrateAxis(side, ticks, pxLo, pxHi, override)` | Least-squares calibration with linear/log selection and misread rejection. |
| `pixelToValue(cal, px)` / `valueToPixel(cal, value)` | The mapping itself. |
| `findSeriesCandidates(image, frame)` | Candidate series colours over the plot interior. |
| `buildMask` / `findComponents` / `selectDataComponents` | Per-series coverage mask, its connected components, and the data-versus-text decision. |
| `traceCurve(mask)` / `traceMarkers(components)` | Sub-pixel path tracing, apex-aware, and marker centres of mass. Both are computed for every series, so the mode can be switched without re-analysing. |
| `suggestPointCount(analysis, modes?)` | Proposes an export point count from the vertex spacing in the trace. Curves only: a marker series has no count to propose. |
| `readLegendLabels(image, frame, colours, ocr)` | Series names read off a colour-coded legend, matched by colour. Cosmetic; never feeds a number. |
| `findBlendArtefacts(candidates, masks, bg)` | Candidate colours that are another series' antialiased halo rather than a series. |
| `toCsv` / `toXlsx` | Delimited text with the chosen separator, or a real `.xlsx` workbook, both with the calibration, uncertainty and warnings in the header. |
| `estimateUncertainty(cal, thickness, strokeWidth)` | Uncertainty in data units from the line's thickness. |

`OcrProvider` is an interface so the engine stays DOM-free:

```ts
interface OcrProvider {
  recognise(image: ImageBuffer, hint?: { charset?: string }): Promise<{ text: string; confidence?: number }>;
}
```

The browser implementation is [`src/ui/ocr.ts`](src/ui/ocr.ts) (tesseract.js with the worker, WASM core and language data served from the bundle);
the Node one used by the tests is [`test/helpers/node-ocr.ts`](test/helpers/node-ocr.ts).
Pass `null` and the tool still works fully by placing the four markers by hand.

## Layout

```
src/engine/     the extraction engine, no DOM and no dependencies
src/ui/         canvas stage, the result panels, the chart, browser OCR, image IO
tools/          corpus generator, accuracy report, diagnostics
test/           unit tests and the measured-accuracy suite
corpus/         synthetic plots, ground-truth CSVs and case metadata
examples/real/  the real screenshots used as the acceptance corpus
android/        the Kotlin WebView shell; see ANDROID.md
vendor/         the tesseract language data, the one tracked binary
public/         generated in full by `npm run assets` from vendor/ and node_modules
```
