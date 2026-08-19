# Measured accuracy

Every number here is produced by running the engine over a committed image and comparing it against ground truth.
Regenerate with `npm run report`; the same measurements are asserted by `npm test`.

## Synthetic corpus

Fifteen plots rendered from analytic functions with Chart.js in headless Chrome, so ground truth is exact.
Error is RMS over 200 points resampled uniformly across the axis, as a percentage of the axis full-scale range,
compared against the same function the chart was drawn from. Log axes are compared in log space.
"Axis error" is how far the derived calibration itself lands from the true axis range.
"Cover" is the fraction of the x range the extracted series spans.

| Case | Series | Mode | Scales | RMS error (% full scale) | Cover | Axis error x / y |
| --- | --- | --- | --- | --- | --- | --- |
| `linear-single-solid` | 1/1 | curve | linear/linear | 0.031% | 100% | 0.017% / 0.054% |
| `linear-single-nogrid` | 1/1 | curve | linear/linear | 0.193% | 99% | 0.079% / 0.054% |
| `linear-thin-line` | 1/1 | curve | linear/linear | 0.044% | 99% | 0.017% / 0.054% |
| `linear-thick-line` | 1/1 | curve | linear/linear | 0.035% | 100% | 0.017% / 0.054% |
| `linear-dashed` | 1/1 | curve | linear/linear | 0.055% | 100% | 0.017% / 0.054% |
| `linear-multi` | 3/3 | curve | linear/linear | 0.033%, 0.044%, 0.037% | 100%, 100%, 100% | 0.017% / 0.057% |
| `dark-theme` | 2/2 | curve | linear/linear | 0.032%, 0.035% | 100%, 100% | 0.017% / 0.057% |
| `log-y` | 1/1 | curve | linear/log | 0.043% | 100% | 0.046% / 0.040% |
| `log-y-multi` | 2/2 | curve | linear/log | 0.047%, 0.048% | 100%, 100% | 0.046% / 0.043% |
| `scatter-markers` | 1/1 | marker | linear/linear | 0.031% | 99% | 0.017% / 0.054% |
| `jpeg-compressed` | 1/1 | curve | linear/linear | 0.037% | 100% | 0.021% / 0.061% |
| `offset-annotation` | 1/1 | curve | linear/linear | 0.032% | 100% | 0.083% / 0.056% |
| `retina-2x` | 1/1 | curve | linear/linear | 0.195% | 99% | 0.096% / 0.135% |
| `log-log` | 1/1 | curve | log/log | 0.071% | 94% | 0.060% / 0.035% |
| `narrow-small` | 1/1 | curve | linear/linear | 0.062% | 99% | 0.138% / 0.102% |

Worst case across the whole synthetic corpus: **0.195% of full scale**, against a target of "well under 1%".

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
| reported uncertainty | - | +/-0.0302 in x, +/-471 in y |

### `01-panel2.png` - Multipanel, panel 2 (cropped)

What it demands: flat data line lying on top of the x axis; rounded `0, 4k, 9k, 13k, 18k, 22k` labels.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 2019.5 to 2024.2 | 2019.35 to 2024.24 |
| y range | 0 to 22400 | -161 to 22079 |
| axis scales | linear/linear | linear/linear |
| series found | 1 | 1 |
| mode | curve | curve |
| reported uncertainty | - | +/-0.0455 in x, +/-379 in y |

### `01-panel3.png` - Multipanel, panel 3 (cropped)

What it demands: as panel 1, larger values.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 2019.5 to 2024.2 | 2019.34 to 2024.23 |
| y range | 0 to 88000 | 168 to 87333 |
| axis scales | linear/linear | linear/linear |
| series found | 1 | 1 |
| mode | curve | curve |
| reported uncertainty | - | +/-0.0296 in x, +/-958 in y |

### `02-microprocessor-log-scatter.png` - 42 Years of Microprocessor Trend Data

What it demands: 10^n superscript log axis, five marker-only series, dotted grid, legend outside the frame.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 1970 to 2020 | 1970 to 2020 |
| y range | 1 to 10000000 | 0.200447 to 2.963e+07 |
| axis scales | linear/log | linear/log |
| series found | 5 | 5 |
| mode | marker | marker |
| reported uncertainty | - | +/-0.436 in x, x or / 1.273 in y (log axis) |

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
| reported uncertainty | - | +/-0.403 in x, +/-0.506 in y |

### `04-hits-per-visit-redgreen.png` - Hits average per visit

What it demands: non-round two-decimal tick labels, cream background, rotated axis title, dense grid.

| Check | Printed on the chart | Extracted |
| --- | --- | --- |
| x range | 0 to 23 | -0.066 to 23.024 |
| y range | 0 to 0.94 | -0.00282 to 0.94879 |
| axis scales | linear/linear | linear/linear |
| series found | 2 | 2 |
| mode | curve | curve |
| reported uncertainty | - | +/-0.0767 in x, +/-0.0036 in y |

Warnings raised in the UI and written into the CSV header:

- *warn*: 1 x-axis tick label was discarded as a misread before fitting. Check the x anchors.
- *warn*: 2 y-axis tick labels were discarded as a misread before fitting. Check the y anchors.

