import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXED_STEP_MS } from '../../src/games/breakout/engine';
import { advanceFixedSteps } from '../../src/games/breakout/fixed-steps';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-breakout-screenshots.mjs'),
  'utf8',
);
const VIEW = readFileSync(join(ROOT, 'src', 'games', 'breakout', 'view.ts'), 'utf8');
const SCENE = readFileSync(join(ROOT, 'src', 'games', 'breakout', 'scene.ts'), 'utf8');

/**
 * Guard for the committed playing PNGs. The engine test proves 120 fixed steps
 * with seed 7 reach a deterministic state; these tests runtime-test the
 * extracted fixed-step loop and statically pin the capture script, the scene
 * wiring (final draw, sleep and marker order) and the focus / visibility wake
 * guards. A dropped parameter, a hard-coded step boundary, a missing final draw
 * or a removed wake guard cannot silently restore wall-clock captures while the
 * engine test stays green.
 */
describe('breakout screenshot determinism guard', () => {
  it('pins the debug seed and fixed step count on every playing scene', () => {
    expect(SCRIPT).toContain('const PLAYING_SEED = 7;');
    expect(SCRIPT).toContain('const PLAYING_STEPS = 120;');
    expect(SCRIPT).toContain(
      'openBreakout(page, { seed: PLAYING_SEED, steps: PLAYING_STEPS })',
    );
    // Desktop, mobile and WebKit each capture one playing state.
    expect([...SCRIPT.matchAll(/await openPlaying\(/g)]).toHaveLength(3);
  });

  it('waits for the fixed-step marker instead of a wall-clock delay', () => {
    expect(SCRIPT).not.toContain('waitForTimeout(800)');
    expect(SCRIPT).toContain("getAttribute('data-debug-steps') === String(steps)");
  });

  it('implements a debug-only URL seam that requests the fixed steps', () => {
    expect(VIEW).toContain("readDebugInt(debugParams().get('steps'), 0, 100_000)");
    // The seam is resolved through the existing debug gate, so a production
    // route without `?debug=1` never pauses or steps the game.
    expect(VIEW).toMatch(
      /function debugStepCount\(\): number \| undefined \{\s*if \(!debugEnabled\(\)\) \{\s*return undefined;/,
    );
    expect(VIEW).toContain('gameRoot.dataset.debugSteps = String(steps);');
  });

  it('stores and consumes the requested step count instead of a hard-coded loop', () => {
    // Index-based checks tolerate comments / line wrapping while still failing
    // when the stored step count, its one-shot clearing or the helper call to
    // `advanceFixedSteps(steps, ...)` is removed or replaced with a constant.
    const requestAt = SCENE.indexOf('requestFixedSteps(steps: number): void {');
    const storeAt = SCENE.indexOf(
      'this.fixedSteps = Math.max(0, Math.floor(steps));',
      requestAt,
    );
    expect(requestAt).toBeGreaterThan(-1);
    expect(storeAt).toBeGreaterThan(requestAt);

    const stepsAt = SCENE.indexOf('const steps = this.fixedSteps;', storeAt);
    const clearAt = SCENE.indexOf('this.fixedSteps = null;', stepsAt);
    const advanceAt = SCENE.indexOf('advanceFixedSteps(steps,', clearAt);
    expect(stepsAt).toBeGreaterThan(storeAt);
    expect(clearAt).toBeGreaterThan(stepsAt);
    expect(advanceAt).toBeGreaterThan(clearAt);

    // The final state is drawn, then the loop sleeps, then the capture marker
    // fires; deleting the draw would let the screenshot keep a stale frame.
    const drawAt = SCENE.indexOf('this.draw(this.engine.state);', advanceAt);
    const sleepAt = SCENE.indexOf('this.game.loop.sleep();', advanceAt);
    const markerAt = SCENE.indexOf('this.callbacks.onFixedSteps?.(steps);', advanceAt);
    expect(drawAt).toBeGreaterThan(advanceAt);
    expect(sleepAt).toBeGreaterThan(drawAt);
    expect(markerAt).toBeGreaterThan(sleepAt);
  });

  it('advances exactly the pinned 120 fixed steps with the engine delta', () => {
    const deltas: number[] = [];
    advanceFixedSteps(120, (delta) => deltas.push(delta));
    // A hard-coded shorter boundary (for example `index < 60`) fails here.
    expect(deltas).toHaveLength(120);
    expect(new Set(deltas)).toEqual(new Set([FIXED_STEP_MS]));
  });

  it('honours other requested counts, including zero', () => {
    const calls: number[] = [];
    advanceFixedSteps(0, (delta) => calls.push(delta));
    expect(calls).toHaveLength(0);
    advanceFixedSteps(7, (delta) => calls.push(delta));
    expect(calls).toHaveLength(7);
  });

  it('keeps focus and visibility from waking the loop after fixed steps', () => {
    // A pre-set flag would disable normal-play focus / visibility wake for the
    // whole mount, so the initializer must stay false.
    expect(VIEW).toContain('let debugStepsPaused = false;');
    // Both wake paths must stay gated by `debugStepsPaused`; deleting either
    // guard lets a real browser focus / visibility event resume wall-clock
    // frames after the deterministic screenshot state was captured.
    expect(VIEW).toMatch(
      /if \(!document\.hidden && !debugStepsPaused\) \{\s*runtime\?\.game\.loop\.wake\(\);\s*\}/,
    );
    expect(VIEW).toMatch(
      /else if \(windowFocused && !debugStepsPaused\) \{\s*activeRuntime\.game\.loop\.wake\(\);\s*\}/,
    );
    // The pause flag is raised before the scene is asked to advance.
    expect(VIEW).toMatch(
      /debugStepsPaused = true;\s*activeScene\?\.requestFixedSteps\(fixedStepCount\);/,
    );
  });
});
