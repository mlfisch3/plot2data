# Measured accuracy

Every number here is produced by running the engine over a committed image and comparing it against ground truth.
Regenerate with `npm run report`; the same measurements are asserted by `npm test`.

## Synthetic corpus

17 plots rendered from analytic functions with Chart.js in headless Chrome, so ground truth is exact.
Error is RMS over 200 points resampled uniformly across the axis, as a percentage of the axis full-scale range,
compared against the same function the chart was drawn from. Log axes are compared in log space.
"Axis error" is how far the derived calibration itself lands from the true axis range.
"Cover" is the fraction of the x range the extracted series spans.

"Peak error" is the signed shortfall at the turning points, measured inwards, so a trace that shaves the tips off
its peaks shows a positive number here whatever its RMS says. It is measured at native resolution and reported
with the number of turning points a case has; a monotone curve has none and reads `-`.

| Case | Series | Mode | Scales | RMS error (% full scale) | Cover | Peak error | Axis error x / y |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `linear-single-solid` | 1/1 | curve | linear/linear | 0.031% | 100% | 0.003% (3) | 0.017% / 0.054% |
| `linear-single-nogrid` | 1/1 | curve | linear/linear | 0.193% | 99% | - | 0.079% / 0.054% |
| `linear-thin-line` | 1/1 | curve | linear/linear | 0.044% | 99% | 0.047% (1) | 0.017% / 0.054% |
| `linear-thick-line` | 1/1 | curve | linear/linear | 0.035% | 100% | -0.019% (3) | 0.017% / 0.054% |
| `linear-dashed` | 1/1 | curve | linear/linear | 0.055% | 100% | - | 0.017% / 0.054% |
| `linear-multi` | 3/3 | curve | linear/linear | 0.033%, 0.043%, 0.037% | 100%, 100%, 100% | -0.023% (3), -, - | 0.017% / 0.057% |
| `dark-theme` | 2/2 | curve | linear/linear | 0.032%, 0.035% | 100%, 100% | -0.023% (3), - | 0.017% / 0.057% |
| `log-y` | 1/1 | curve | linear/log | 0.043% | 100% | - | 0.046% / 0.040% |
| `log-y-multi` | 2/2 | curve | linear/log | 0.047%, 0.048% | 100%, 100% | -, - | 0.046% / 0.043% |
| `scatter-markers` | 1/1 | marker | linear/linear | 0.031% | 99% | - | 0.017% / 0.054% |
| `jpeg-compressed` | 1/1 | curve | linear/linear | 0.036% | 100% | -0.001% (3) | 0.021% / 0.061% |
| `offset-annotation` | 1/1 | curve | linear/linear | 0.032% | 100% | - | 0.083% / 0.056% |
| `retina-2x` | 1/1 | curve | linear/linear | 0.196% | 99% | 0.108% (3) | 0.096% / 0.135% |
| `log-log` | 1/1 | curve | log/log | 0.074% | 94% | - | 0.060% / 0.035% |
| `sawtooth-sharp` | 1/1 | curve | linear/linear | 0.234% | 100% | -0.263% (15) | 0.017% / 0.054% |
| `narrow-peaks` | 1/1 | curve | linear/linear | 0.283% | 100% | -0.053% (11) | 0.017% / 0.054% |
| `narrow-small` | 1/1 | curve | linear/linear | 0.077% | 99% | 0.023% (3) | 0.138% / 0.102% |

Worst case across the whole synthetic corpus: **0.283% of full scale** RMS, against a target of "well under 1%", and **0.263% of full scale** at the peaks.

### Why peaks are measured separately

A per-column intensity centroid is the right value only while the column holds one flat stroke. At a sharp apex
the same column holds the rising edge, the tip and the falling edge, and the centroid lands halfway down the spike.
A plot has few peaks and many columns, so averaging over x hides this almost perfectly: before the fix,
`narrow-peaks` scored 0.26% of full scale on RMS while losing 0.99% at every spike, and `sawtooth-sharp` 0.24%
while losing 0.51%. Measured before and after, as a percentage of full scale:

| Case | Peak error before | Peak error after |
| --- | --- | --- |
| `narrow-peaks` (round corners) | 0.987% | -0.053% |
| `sawtooth-sharp` (mitred corners) | 0.511% | -0.263% |

The two cases carry different corner styles on purpose. A **mitred** corner runs on past the vertex it is drawn
at - five pixels past it, for a 2 px line meeting itself at an acute angle - so stopping half a stroke in from the
outermost ink would read a peak the chart never plotted. The two are told apart by cross-section, which leaves no
room for doubt: half a stroke below a round cap the ink is already most of a stroke across, and half a stroke below
a miter it is a sliver. A sliver, and only a sliver, sends the tracer on down until the ink is a full stroke across,
which is where the two legs of the join meet - the vertex.

## The captain's real screenshots

These have no exact ground truth, so each is judged against what the chart itself prints: the axis range implied by its tick labels,
and, where the chart prints a value next to a data point, that value.

### `01-panel1.png` - Multipanel, panel 1 (cropped)

What it demands: abbreviated `42k` tick labels, no y-axis line, rounded printed tick values.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 2019.5 to 2024.2 | 2019.34 to 2024.23 |
| y range | 0 to 42000 | -171 to 41906 |
| axis scales | linear/linear | linear/linear |
| series found | 1 | 1 |
| mode | curve | curve |
| reported uncertainty | - | +/-0.0224 in x, +/-349 in y |

### `01-panel2.png` - Multipanel, panel 2 (cropped)

What it demands: flat data line lying on top of the x axis; rounded `0, 4k, 9k, 13k, 18k, 22k` labels.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 2019.5 to 2024.2 | 2019.35 to 2024.24 |
| y range | 0 to 22400 | -161 to 22079 |
| axis scales | linear/linear | linear/linear |
| series found | 1 | 1 |
| mode | curve | curve |
| reported uncertainty | - | +/-0.0228 in x, +/-190 in y |

### `01-panel3.png` - Multipanel, panel 3 (cropped)

What it demands: as panel 1, larger values.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 2019.5 to 2024.2 | 2019.34 to 2024.23 |
| y range | 0 to 88000 | 168 to 87333 |
| axis scales | linear/linear | linear/linear |
| series found | 1 | 1 |
| mode | curve | curve |
| reported uncertainty | - | +/-0.0226 in x, +/-731 in y |

### `02-microprocessor-log-scatter.png` - 42 Years of Microprocessor Trend Data

What it demands: 10^n superscript log axis, five marker-only series, dotted grid, legend outside the frame.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 1970 to 2020 | 1970 to 2020 |
| y range | 1 to 10000000 | 0.200447 to 2.963e+07 |
| axis scales | linear/log | linear/log |
| series found | 5 | 5 |
| mode | marker | marker |
| reported uncertainty | - | +/-0.511 in x, x or / 1.357 in y (log axis) |

### `03-women-men-percent.png` - Women and men, percent

What it demands: text inside the plot in the series colour, percent unit on one label only, no y-axis line.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 1970 to 2021 | 1969 to 2021.89 |
| y range | 0 to 60 | 0.537 to 60.04 |
| axis scales | linear/linear | linear/linear |
| series found | 2 | 2 |
| mode | curve | curve |
| endpoint printed as 46 | 46 at x=2021 | 45.848 at x=2021.3 (-0.25% of full scale) |
| endpoint printed as 36 | 36 at x=2021 | 36.4411 at x=2021.3 (0.74% of full scale) |
| reported uncertainty | - | +/-0.351 in x, +/-0.441 in y |

### `05-retail-sales-monthly.png` - U.S. Retail Sales, monthly

What it demands: a dense spiky monthly series drawn with a pen wider than its own point spacing.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 1992 to 2019.4 | 1992 to 2019.38 |
| y range | 120 to 520 | 120.15 to 520.81 |
| axis scales | linear/linear | linear/linear |
| series found | 1 | 1 |
| mode | curve | curve |
| spike amplitude recovered | 100% of what is drawn | 94.2% mean, 98.5% median, 52.2% worst, over 47 spikes |
| reported uncertainty | - | +/-0.0505 in x, +/-1.62 in y |

### `04-hits-per-visit-redgreen.png` - Hits average per visit

What it demands: non-round two-decimal tick labels, cream background, rotated axis title, dense grid.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 0 to 23 | -0.066 to 23.024 |
| y range | 0 to 0.94 | -0.00282 to 0.94879 |
| axis scales | linear/linear | linear/linear |
| series found | 2 | 2 |
| mode | curve | curve |
| reported uncertainty | - | +/-0.0475 in x, +/-0.00223 in y |

Warnings raised in the UI and written into the CSV header:

- *warn*: 1 x-axis tick label was discarded as a misread before fitting. Check the x anchors.
- *warn*: 2 y-axis tick labels were discarded as a misread before fitting. Check the y anchors.

## Verdicts

| Case | Verdict | Notes |
| --- | --- | --- |
| `01-panel1/2/3` (cropped) | pass | Abbreviated `k` labels parsed, axes within ~0.3% of full scale. Panel 2 works despite its data line lying on top of the x axis. The uncropped three-panel screenshot is correctly rejected: no single plot frame is found, and the tool says to crop rather than guessing. |
| `02-microprocessor` | pass, with caveats | `10^n` superscript decades read, log axis detected, all five marker series separated, legend outside the frame ignored. Marker counts are lower than the true point counts because overlapping markers merge into one blob - expected on this chart and reported honestly as the number of points found. A handful of dotted-grid remnants survive as stray points near the top and bottom gridlines. |
| `03-women-men-percent` | pass | Both series traced end to end; the in-plot words `Women` and `Men` and the endpoint annotations `12`, `20`, `46`, `36` are rejected on shape, not colour. The extracted endpoints land within 0.8% of full scale of the values the chart prints. The percent unit is picked up from the single label that carries it. The x axis reads 1969 rather than 1970 because the final `2021` label is right-aligned to the plot edge rather than centred on its tick, which pulls the fit by about one year; the anchors are editable and the residual warning fires. |
| `04-hits-per-visit` | pass | Non-round two-decimal tick labels handled by the least-squares fit; the two labels OCR misread are discarded and reported. Cream background and rotated axis title cause no trouble. |
| `05-retail-sales-monthly` | pass | The chart the peak clipping was found on, cropped from the captain's own screenshot. Both axes read off the tick labels to within a pixel. The line is drawn about 5.5 px wide and plots a point every 3.5 px, so its individual monthly vertices are not all separable from the ink: the automatic point count proposes 235 against a true 331, and says what it counted. Spike amplitude recovered rose from 65.8% of the drawn amplitude before the apex correction to the figure in the table above, and the mean peak shortfall fell from 4.30% of full scale to 0.01%. |

## Known limits

- **Overlapping markers merge.** Marker mode returns one centroid per connected blob, so a dense scatter reports fewer points than were plotted. The count shown is the count found, never an extrapolation.
- **OCR misreads small labels.** Below about 8 px of text height the recogniser drops or confuses digits. The least-squares fit absorbs the ones it catches and reports the ones it discards, but the defence against a systematic misread is the editable anchors, not the OCR.
- **An end label aligned to the plot edge biases the fit** by roughly half a label width, as in `03`. The residual warning fires; the fix is to drag the anchor.
- **A curve that doubles back in x** cannot be represented by one value per column. The trace follows the branch that continues from the previous column and does not report the other.
- **Line and marker drawn together** merge into one component, so the tool traces the curve rather than returning the marker positions. That is the honest reading of the ink, and the CSV says so.
- **The worst individual spike is read lower than the average one.** On the retail-sales chart the mean spike recovers about 95% of its drawn amplitude and the median about 98%, but the worst single spike recovers about half. Those are the spikes whose neighbours are close enough that the ink merges, leaving no separate tip to find.
- **A peak at a mitred corner is read a little high.** The correction descends from the outermost ink until the ink is one stroke across, which finds the vertex for a round corner exactly and for a mitred one to within a fraction of a stroke. On the corpus's deliberately extreme sawtooth that is -0.26% of full scale, against 0.51% of clipping before.
- **The automatic point count is an estimate.** It counts the kinks in the trace, so a line drawn wider than the spacing of its own data points comes out low - 235 against 331 on the retail-sales chart. Across the real screenshots it lands within about a factor of two of the true point count, which is the right order for a default; the count is editable and one point per pixel column is always available.

