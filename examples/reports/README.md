# Screenshots from the field

Evidence for the series mis-assignment on `examples/real/02-microprocessor-log-scatter.png`, kept because a picture of the
failure is what made it findable.

The captain's, before the fix:

- `07-result-full-app.png` - the whole app. The series list reads 27/26/**123**/40/55 points, the header says "27 points"
  and the output panel says "123 rows"; the uncertainty readout gives the orange series ±0.0213 in x against ±0.36 to ±0.51
  for every other series, because it was measuring a structure one pixel thick.
- `08-result-zoomed-orange-on-red.png` - zoomed into the red triangles. Orange extracted points sit on the red markers, and
  the top panel carries our own extraction rings over the source image - the "splotchy, snowflake" markers that cost real
  time to explain.

The same chart afterwards:

- `09-result-after-the-fix.png` - the orange series is where the orange triangles are, every series is named from the
  chart's own legend, and the header, the series list, the output panel and the table all agree.
- `10-result-zoomed-red-region.png` - the same red-triangle region as `08`. The top panel shows the source image and
  nothing else, and no orange point is anywhere near it.

See `ACCURACY.md` for the numbers and the diagnosis.
