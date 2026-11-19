import { describe, expect, it } from 'vitest';
import {
  elapsedUpdateMs,
  fadeTrail,
  MAX_TRAIL_DOTS,
  TRAIL_INTERVAL_MS,
  TRAIL_LIFE_MS,
} from '../../src/games/blank/trail';
import type { TrailDot } from '../../src/games/blank/trail';

function dot(): TrailDot {
  return { x: 10, y: 20, life: 1 };
}

/**
 * Guard for the blank trail fade used by the screenshot settle loop: a
 * 250–400 ms software-rendered frame used to advance the 1.15 s fade by ~17 ms
 * and the WebKit capture timed out with `trail=2` (Issue #341 t2 rework).
 * `capture-blank-determinism.test.ts` pins the scene wiring.
 */
describe('blank trail wall-clock timing guard', () => {
  it('pins the fade contract used by the screenshot settle wait', () => {
    expect(TRAIL_LIFE_MS).toBe(1_150);
    expect(TRAIL_INTERVAL_MS).toBe(38);
    expect(MAX_TRAIL_DOTS).toBe(26);
  });

  it('fades after 1.15 s of wall time and survives bad elapsed values', () => {
    const fast = [dot()];
    for (let frame = 0; frame < 68; frame += 1) fadeTrail(fast, 1_000 / 60);
    expect(fast).toHaveLength(1);
    for (let frame = 0; frame < 5; frame += 1) fadeTrail(fast, 1_000 / 60);
    expect(fast).toHaveLength(0);

    // A long stall clears every dot in one update; bad values never decay.
    const stalled = [dot(), dot(), dot()];
    fadeTrail(stalled, 60_000);
    expect(stalled).toHaveLength(0);
    const kept = [dot()];
    fadeTrail(kept, 0);
    fadeTrail(kept, -500);
    fadeTrail(kept, Number.NaN);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.life).toBe(1);
  });

  it('fades over the same wall time when frames are slow', () => {
    // Three 400 ms frames are the clamped-delta case: the old frame-counted
    // fade would still be at ~0.95 life, the wall-clock fade clears both dots.
    const dots = [dot(), dot()];
    fadeTrail(dots, 400);
    fadeTrail(dots, 400);
    expect(dots).toHaveLength(2);
    expect(dots[0]?.life).toBeCloseTo(1 - 800 / TRAIL_LIFE_MS, 6);
    fadeTrail(dots, 400);
    expect(dots).toHaveLength(0);

    // `time` is Phaser's requestAnimationFrame timestamp; a missing, repeated
    // or backwards timestamp means no time passed.
    const exact = [dot()];
    fadeTrail(exact, TRAIL_LIFE_MS);
    expect(exact).toHaveLength(0);
    expect(elapsedUpdateMs(1000, 0)).toBe(0);
    expect(elapsedUpdateMs(1400, 1000)).toBe(400);
    expect(elapsedUpdateMs(1000, 1000)).toBe(0);
    expect(elapsedUpdateMs(900, 1000)).toBe(0);
    expect(elapsedUpdateMs(Number.NaN, 1000)).toBe(0);
    expect(elapsedUpdateMs(1400, Number.NaN)).toBe(0);
    expect(elapsedUpdateMs(1400, -1)).toBe(0);
  });
});
