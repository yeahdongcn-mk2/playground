/**
 * Shared court projection for the breakout canvas and pointer input.
 *
 * The engine works in a fixed logical court (480x720 by default). The scene
 * scales that court into the responsive canvas while keeping its aspect ratio,
 * and the view maps pointer positions back with exactly the same arithmetic.
 */

export interface CourtMetrics {
  /** Canvas pixels per logical court unit. */
  readonly scale: number;
  /** Left edge of the drawn court inside the canvas. */
  readonly offsetX: number;
  /** Top edge of the drawn court inside the canvas. */
  readonly offsetY: number;
  /** Drawn court width in canvas pixels. */
  readonly width: number;
  /** Drawn court height in canvas pixels. */
  readonly height: number;
}

/** Fit a logical court into a canvas, centred with letterboxing if needed. */
export function courtMetrics(
  viewWidth: number,
  viewHeight: number,
  courtWidth: number,
  courtHeight: number,
): CourtMetrics {
  const safeWidth = Math.max(1, viewWidth);
  const safeHeight = Math.max(1, viewHeight);
  const scale = Math.max(
    Number.EPSILON,
    Math.min(safeWidth / courtWidth, safeHeight / courtHeight),
  );
  const width = courtWidth * scale;
  const height = courtHeight * scale;
  return {
    scale,
    offsetX: (safeWidth - width) / 2,
    offsetY: (safeHeight - height) / 2,
    width,
    height,
  };
}

/** Map a pointer's client X to a logical court X, clamped to the court. */
export function courtXFromClientX(
  clientX: number,
  rect: Pick<DOMRect, 'left' | 'width' | 'height'>,
  courtWidth: number,
  courtHeight: number,
): number {
  const metrics = courtMetrics(rect.width, rect.height, courtWidth, courtHeight);
  const x = (clientX - rect.left - metrics.offsetX) / metrics.scale;
  return Math.min(courtWidth, Math.max(0, x));
}
