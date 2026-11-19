/**
 * Trail timing for the blank canvas.
 *
 * Phaser clamps `delta` to the previous (~16 ms) value for frames slower than
 * its minimum-fps window; a software-rendered WebKit frame under host load
 * takes 250–400 ms, so a delta-driven 1.15 s fade took tens of seconds and the
 * screenshot settle loop timed out (Issue #341 rework). Use real elapsed time.
 */

/** One live trail dot left behind by the moving orb. */
export interface TrailDot {
  readonly x: number;
  readonly y: number;
  life: number;
}

/** Wall-clock lifetime of one trail dot (the 1.15 s fade), in milliseconds. */
export const TRAIL_LIFE_MS = 1_150;

/** Minimum wall-clock spacing between two trail dots while the orb moves. */
export const TRAIL_INTERVAL_MS = 38;

/** The scene keeps at most this many trail dots. */
export const MAX_TRAIL_DOTS = 26;

/**
 * Real elapsed time for one scene update: Phaser passes the requestAnimationFrame
 * timestamp as `time`, so it stays wall-clock based even when `delta` is
 * clamped. A missing, repeated or backwards timestamp means no time passed.
 */
export function elapsedUpdateMs(time: number, previousTime: number): number {
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(previousTime) ||
    previousTime <= 0 ||
    time <= previousTime
  ) {
    return 0;
  }
  return time - previousTime;
}

/**
 * Decay every dot by the real elapsed time and drop the ones whose 1.15 s life
 * has run out. A long stall clears the trail in one update.
 */
export function fadeTrail(dots: TrailDot[], elapsedMs: number): void {
  const decay =
    (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0) / TRAIL_LIFE_MS;
  if (decay === 0) {
    return;
  }
  for (const dot of dots) {
    dot.life -= decay;
  }
  for (let index = dots.length - 1; index >= 0; index -= 1) {
    if ((dots[index]?.life ?? 0) <= 0) {
      dots.splice(index, 1);
    }
  }
}
