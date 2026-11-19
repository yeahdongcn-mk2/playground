import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { FIXED_STEP_MS } from '../../src/games/breakout/engine';
import { advanceFixedSteps } from '../../src/games/breakout/fixed-steps';
import {
  SHARED_HEADER_SELECTOR,
  SHARED_HEADER_SETTLE_FRAMES,
  settleSharedHeaderCompositing,
} from '../../scripts/lib/webkit-compositing-settle.mjs';
import type { SharedHeaderRepaintOptions } from '../../scripts/lib/webkit-compositing-settle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-breakout-screenshots.mjs'),
  'utf8',
);
const VIEW = readFileSync(join(ROOT, 'src', 'games', 'breakout', 'view.ts'), 'utf8');
const SCENE = readFileSync(join(ROOT, 'src', 'games', 'breakout', 'scene.ts'), 'utf8');

/** The body of one top-level function, found by matching braces. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) {
    throw new Error(`missing function: ${name}`);
  }
  // Skip the parameter list first: a default value such as `options = {}` holds
  // a brace that must not be mistaken for the function body.
  const paramsOpen = source.indexOf('(', start);
  let depth = 0;
  let paramsClose = -1;
  for (let index = paramsOpen; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        paramsClose = index;
        break;
      }
    }
  }
  if (paramsClose < 0) {
    throw new Error(`unterminated parameters: ${name}`);
  }
  const open = source.indexOf('{', paramsClose);
  depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

/** Drop comments so a commented-out call cannot satisfy the static pins. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

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

  it('repaints the WebKit READY backdrop without touching the other states', () => {
    // The READY overlay appears before Phaser paints the court, so a WebKit
    // screenshot can keep the empty backdrop. openReady must run the seam only
    // in WebKit mode; deleting the call or the guard restores the blank-court
    // drift while every other assertion above stays green.
    const openReady = functionBody(SCRIPT, 'openReady');
    expect(openReady).toMatch(/if \(IS_WEBKIT\) \{\s*await settleReadyBackdrop\(page\);/);

    // The seam must disable and restore the same backdrop-filter between two
    // committed frames; dropping either toggle, the frame waits or the restore
    // would leave the browser on a stale or visibly unfiltered snapshot.
    const seam = functionBody(SCRIPT, 'settleReadyBackdrop');
    expect(seam).toContain("overlay.style.backdropFilter = 'none'");
    expect(seam).toContain("overlay.style.webkitBackdropFilter = 'none'");
    expect(seam).toContain("overlay.style.backdropFilter = ''");
    expect(seam).toContain("overlay.style.webkitBackdropFilter = ''");
    expect(seam.match(/await nextFrame\(\);/g)).toHaveLength(2);

    // playing / levelclear / gameover keep their committed bytes, so the seam
    // must not leak into the state captures.
    for (const name of ['openPlaying', 'openLevelClear', 'openGameOver']) {
      expect(functionBody(SCRIPT, name)).not.toContain('settleReadyBackdrop');
    }
  });

  it('settles the shared header only on the WebKit playing path', () => {
    // Issue #328: the observed drift is entirely inside the shared site
    // header's blurred backdrop snapshot, so the playing capture reuses the
    // reusable #326 / #341 seam instead of carrying a second paint recipe.
    expect(SCRIPT).toContain(
      "import { settleSharedHeaderCompositing } from './lib/webkit-compositing-settle.mjs';",
    );
    expect(SCRIPT).toContain('const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;');

    const stripped = stripComments(SCRIPT);
    const openPlaying = functionBody(stripped, 'openPlaying');
    const markerAt = openPlaying.indexOf("getAttribute('data-debug-steps')");
    const settleAt = openPlaying.indexOf('await settle(page);');
    const seamAt = openPlaying.indexOf('await settleSharedHeaderCompositing(page);');
    expect(markerAt).toBeGreaterThan(-1);
    expect(seamAt).toBeGreaterThan(markerAt);
    expect(seamAt).toBeGreaterThan(settleAt);
    // The seam must be gated by WebKit mode: removing the guard would change
    // the committed Chromium playing bytes as well.
    expect(openPlaying).toMatch(
      /if \(IS_WEBKIT\) \{\s*await settleSharedHeaderCompositing\(page\);\s*\}/,
    );

    // No other state capture runs the header seam, and there is exactly one
    // call in the script: a leak into ready / levelclear / gameover would
    // rewrite their committed bytes.
    for (const name of ['openReady', 'openLevelClear', 'openGameOver']) {
      expect(functionBody(stripped, name)).not.toContain(
        'settleSharedHeaderCompositing',
      );
    }
    expect([
      ...stripped.matchAll(/await settleSharedHeaderCompositing\(page\);/g),
    ]).toHaveLength(1);
  });

  it('asks the shared header seam for the two committed repaint frames', async () => {
    // Four double-rAF waits in total: one SHARED_HEADER_SETTLE_FRAMES budget
    // after disabling the filter and one after restoring it. The in-page
    // toggle / frame sequence is runtime-tested in
    // webkit-compositing-settle.test.ts; this pins the budget the breakout
    // capture relies on and that it does not override the shared default.
    expect(SHARED_HEADER_SETTLE_FRAMES).toBe(2);
    const calls: SharedHeaderRepaintOptions[] = [];
    const page = {
      evaluate: async (_pageFunction: unknown, options: SharedHeaderRepaintOptions) => {
        calls.push(options);
        return true;
      },
    };
    await settleSharedHeaderCompositing(page as unknown as Page);
    expect(calls).toEqual([
      { selector: SHARED_HEADER_SELECTOR, frames: SHARED_HEADER_SETTLE_FRAMES },
    ]);

    const openPlaying = functionBody(stripComments(SCRIPT), 'openPlaying');
    expect(openPlaying).toContain('await settleSharedHeaderCompositing(page);');
    expect(openPlaying).not.toContain('frames:');
  });

  it('opts only the WebKit playing capture into the stable frame path', () => {
    // capture() must forward its options, otherwise `stable: true` is silently
    // dropped and the header seam writes a single in-flight frame.
    const stripped = stripComments(SCRIPT);
    expect(stripped).toContain(
      'async function capture(page, name, fullPage, options = {}) {',
    );
    const helper = functionBody(stripped, 'capture');
    expect(helper).toContain(
      'await captureScreenshot(page, name, { engine: ENGINE, fullPage, ...options });',
    );

    const webkit = functionBody(stripped, 'captureWebkitMobile');
    const captureAt = webkit.indexOf(
      "capture(playing, 'after-breakout-playing-webkit.png', false, {",
    );
    const stableAt = webkit.indexOf('stable: true');
    expect(captureAt).toBeGreaterThan(-1);
    expect(stableAt).toBeGreaterThan(captureAt);
    // Exactly one capture asks for stable bytes; the other three WebKit states
    // and the Chromium / before captures keep the single-screenshot path.
    expect([...stripped.matchAll(/stable: true/g)]).toHaveLength(1);
    for (const file of [
      'after-breakout-ready-webkit.png',
      'after-breakout-levelclear-webkit.png',
      'after-breakout-gameover-webkit.png',
    ]) {
      expect(webkit).not.toContain(`${file}', false, {`);
    }
  });
});
