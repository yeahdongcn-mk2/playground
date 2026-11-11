import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLANK_STABLE_SAMPLES,
  BLANK_TARGET_TOLERANCE,
  isBlankAtTarget,
  nextBlankStableStreak,
} from '../../scripts/lib/blank-settle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-screenshots.mjs'),
  'utf8',
);
const VIEW = readFileSync(join(ROOT, 'src', 'games', 'blank', 'view.ts'), 'utf8');
const SCENE = readFileSync(
  join(ROOT, 'src', 'games', 'blank', 'scene.ts'),
  'utf8',
);

/**
 * Guard for the committed blank-canvas PNGs. The blank scene has no RNG, so
 * determinism only needs the orb to snap to the pointer target and the trail
 * to fade out before the screenshot. These tests runtime-test the settle
 * predicate and statically pin the capture script, the trail readout and the
 * scene state that feeds it. Dropping the trail wait or reinstating a
 * wall-clock delay fails here instead of silently restoring flaky captures.
 */
describe('blank canvas screenshot determinism guard', () => {
  it('waits for a settled readout instead of the old 700 ms delay', () => {
    expect(SCRIPT).not.toContain('waitForTimeout(700)');
    expect(SCRIPT).toContain('nextBlankStableStreak(streak, last, target)');
    expect(SCRIPT).toContain('[data-testid="readout"]');
    expect(SCRIPT).toContain('BLANK_SETTLE_TIMEOUT_MS');
    expect(SCRIPT).toContain('did not settle');
  });

  it('settles every blank scene (desktop, mobile, WebKit)', () => {
    expect([...SCRIPT.matchAll(/await tapBlankCanvas\(page, box/g)]).toHaveLength(3);
    expect(SCRIPT).toContain('await tapBlankCanvas(page, box, 0.66, 0.4);');
    expect(SCRIPT).toContain(
      'await tapBlankCanvas(page, box, 0.36, 0.62, { touch: true });',
    );
  });

  it('publishes the live trail count from the scene state', () => {
    expect(VIEW).toContain('readout.dataset.trail = String(state.trail);');
    expect(VIEW).toContain('data-x="0" data-y="0" data-trail="0"');
    expect(SCENE).toContain('trail: this.trail.length,');
  });

  it('accepts only a sample at the target and with no trail left', () => {
    const target = { x: 120, y: 80 };
    expect(isBlankAtTarget({ x: 120, y: 80, trail: 0 }, target)).toBe(true);
    expect(
      isBlankAtTarget(
        { x: 120 + BLANK_TARGET_TOLERANCE, y: 80 - BLANK_TARGET_TOLERANCE, trail: 0 },
        target,
      ),
    ).toBe(true);
    expect(
      isBlankAtTarget(
        { x: 120 + BLANK_TARGET_TOLERANCE + 0.5, y: 80, trail: 0 },
        target,
      ),
    ).toBe(false);
    expect(
      nextBlankStableStreak(2, { x: 120, y: 80, trail: 0 }, target),
    ).toBe(3);
    // A live trail dot resets even when the orb already sits on the target.
    expect(
      nextBlankStableStreak(2, { x: 120, y: 80, trail: 1 }, target),
    ).toBe(0);
  });

  it('resets the streak when the orb is still moving or misses the target', () => {
    const target = { x: 200, y: 150 };
    const onTarget = { x: 200, y: 150, trail: 0 };
    const moving = { x: 190, y: 150, trail: 0 };
    // A still centre reading from before the click must not count.
    const beforeClick = { x: 100, y: 100, trail: 0 };

    let streak = 0;
    streak = nextBlankStableStreak(streak, beforeClick, target);
    expect(streak).toBe(0);
    streak = nextBlankStableStreak(streak, moving, target);
    expect(streak).toBe(0);
    streak = nextBlankStableStreak(streak, onTarget, target);
    expect(streak).toBe(1);
    streak = nextBlankStableStreak(streak, moving, target);
    expect(streak).toBe(0);
  });

  it('caps the streak at the configured sample count', () => {
    const target = { x: 0, y: 0 };
    const sample = { x: 0, y: 0, trail: 0 };
    let streak = 0;
    for (let index = 0; index < BLANK_STABLE_SAMPLES + 3; index += 1) {
      streak = nextBlankStableStreak(streak, sample, target);
    }
    expect(streak).toBe(BLANK_STABLE_SAMPLES);
    expect(
      nextBlankStableStreak(0, sample, target, { required: 2 }),
    ).toBe(1);
    expect(
      nextBlankStableStreak(1, sample, target, { required: 2 }),
    ).toBe(2);
  });
});
