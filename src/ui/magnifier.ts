/**
 * The magnifier inset.
 *
 * Aligning a calibration marker is the one thing in this tool that decides
 * whether the answer is right, and it is done by eye against a tick mark a
 * couple of pixels wide - under a fingertip, on a phone. So while a marker is
 * being dragged, a window opens showing the pixels underneath it, blown up,
 * with the marker's own guide line drawn across it.
 *
 * Two rules make it useful rather than decorative:
 *
 * - It is never under the pointer. It takes whichever corner is furthest from
 *   the finger, so the thing being aimed at stays visible.
 * - The guide lines inside it are drawn at their **screen** width, not scaled
 *   with the pixels. Magnifying a 1.5 px dashed line eight times would produce
 *   a 12 px bar covering the very detail the magnifier exists to show.
 */

export interface MagnifierGuide {
  axis: 'x' | 'y';
  /** Position in image coordinates. */
  px: number;
  colour: string;
}

export interface MagnifierOptions {
  bitmap: ImageBitmap;
  /** Where the user is pointing, in CSS pixels within the canvas. */
  at: { x: number; y: number };
  /** Image coordinates under that point. */
  image: { x: number; y: number };
  canvasWidth: number;
  canvasHeight: number;
  /** Magnification relative to the image's own pixels. */
  zoom?: number;
  size?: number;
  guides?: MagnifierGuide[];
  /** Caption under the crosshair, usually the pixel position being set. */
  label?: string;
  /**
   * Draw whatever else belongs inside the window, given a mapping from image
   * coordinates into it. The overlay panel uses this to redraw the extracted
   * trace at the magnifier's own scale: magnifying the canvas instead would
   * blow up a trace already drawn at the panel's zoom, which is blurry exactly
   * where the comparison has to be sharp.
   */
  content?(ctx: CanvasRenderingContext2D, toBox: (x: number, y: number) => { x: number; y: number }): void;
}

/** Draw the inset. The context must be in CSS-pixel coordinates. */
export function drawMagnifier(ctx: CanvasRenderingContext2D, options: MagnifierOptions): void {
  const size = options.size ?? Math.round(Math.min(148, Math.max(96, options.canvasWidth * 0.3)));
  const zoom = options.zoom ?? 7;
  const margin = 10;
  const box = placeAway(options.at, options.canvasWidth, options.canvasHeight, size, margin);
  const half = size / (2 * zoom);

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, box.x, box.y, size, size, 10);
  ctx.clip();

  // The plate behind it, so the edge of the image does not show through as a
  // hole when the marker is parked against it.
  ctx.fillStyle = 'rgba(16,20,28,0.92)';
  ctx.fillRect(box.x, box.y, size, size);

  // Nearest-neighbour: at this magnification the user is reading individual
  // pixels of a tick mark, and interpolation would smear away the answer.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    options.bitmap,
    options.image.x - half,
    options.image.y - half,
    half * 2,
    half * 2,
    box.x,
    box.y,
    size,
    size,
  );

  const toBox = (imageX: number, imageY: number) => ({
    x: box.x + (imageX - (options.image.x - half)) * zoom,
    y: box.y + (imageY - (options.image.y - half)) * zoom,
  });

  options.content?.(ctx, toBox);

  // Crosshair at the exact point, hairline and open in the middle so it never
  // hides the pixel it marks. Drawn twice, dark under light: most plots are
  // white inside and a white crosshair on white is no crosshair at all. It goes
  // under the guide lines, so the marker being dragged shows in its own colour
  // rather than under a white reticle sitting exactly on top of it.
  const centre = { x: box.x + size / 2, y: box.y + size / 2 };
  const cross = () => {
    ctx.beginPath();
    ctx.moveTo(centre.x - size / 2, centre.y);
    ctx.lineTo(centre.x - 5, centre.y);
    ctx.moveTo(centre.x + 5, centre.y);
    ctx.lineTo(centre.x + size / 2, centre.y);
    ctx.moveTo(centre.x, centre.y - size / 2);
    ctx.lineTo(centre.x, centre.y - 5);
    ctx.moveTo(centre.x, centre.y + 5);
    ctx.lineTo(centre.x, centre.y + size / 2);
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(16,20,28,0.55)';
  ctx.lineWidth = 2.5;
  cross();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1;
  cross();

  for (const guide of options.guides ?? []) {
    const s = toBox(guide.axis === 'x' ? guide.px : 0, guide.axis === 'y' ? guide.px : 0);
    ctx.strokeStyle = guide.colour;
    // Constant screen width, whatever the magnification.
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    if (guide.axis === 'x') {
      ctx.moveTo(s.x, box.y);
      ctx.lineTo(s.x, box.y + size);
    } else {
      ctx.moveTo(box.x, s.y);
      ctx.lineTo(box.x + size, s.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (options.label) {
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const width = ctx.measureText(options.label).width + 12;
    ctx.fillStyle = 'rgba(16,20,28,0.85)';
    ctx.fillRect(box.x + (size - width) / 2, box.y + size - 20, width, 17);
    ctx.fillStyle = '#fff';
    ctx.fillText(options.label, box.x + size / 2, box.y + size - 5);
  }
  ctx.restore();

  // The frame, dark outside and light inside, so the window has an edge over a
  // white plot as well as over dark ink.
  ctx.save();
  ctx.strokeStyle = 'rgba(16,20,28,0.75)';
  ctx.lineWidth = 4;
  roundRect(ctx, box.x, box.y, size, size, 10);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, box.x, box.y, size, size, 10);
  ctx.stroke();
  ctx.restore();
}

/** The corner furthest from the pointer, so the inset never sits under it. */
function placeAway(
  at: { x: number; y: number },
  width: number,
  height: number,
  size: number,
  margin: number,
): { x: number; y: number } {
  const left = margin;
  const right = Math.max(margin, width - size - margin);
  const top = margin;
  const bottom = Math.max(margin, height - size - margin);
  let best = { x: left, y: top };
  let bestD = -1;
  for (const x of [left, right]) {
    for (const y of [top, bottom]) {
      const d = Math.hypot(at.x - (x + size / 2), at.y - (y + size / 2));
      if (d > bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
