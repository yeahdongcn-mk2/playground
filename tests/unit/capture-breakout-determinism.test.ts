import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-breakout-screenshots.mjs'),
  'utf8',
);
const VIEW = readFileSync(join(ROOT, 'src', 'games', 'breakout', 'view.ts'), 'utf8');
const SCENE = readFileSync(join(ROOT, 'src', 'games', 'breakout', 'scene.ts'), 'utf8');

/**
 * Static guard for the committed playing PNGs. The engine test proves 120 fixed
 * steps with seed 7 reach a deterministic state; this test proves the capture
 * script actually pins that seed and step count and waits for the seam, and
 * that the seam still advances fixed steps before pausing the loop. A dropped
 * parameter cannot silently restore wall-clock captures while the engine test
 * stays green.
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
    expect(VIEW).toContain('activeScene?.requestFixedSteps(fixedStepCount);');
    expect(VIEW).toContain('gameRoot.dataset.debugSteps = String(steps);');
  });

  it('advances exactly the requested fixed steps and pauses the loop', () => {
    expect(SCENE).toContain('requestFixedSteps(steps: number): void');
    expect(SCENE).toContain('this.advance(FIXED_STEP_MS);');
    expect(SCENE).toContain('this.game.loop.sleep();');
    expect(SCENE).toContain('this.callbacks.onFixedSteps?.(steps);');
  });
});
