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
  return source.slice(open, bracedBlock(source, open).close + 1);
}

/** The body of the brace block that starts at `open`, and its closing brace. */
function bracedBlock(source: string, open: number): { body: string; close: number } {
  if (source[open] !== '{') {
    throw new Error(`expected a brace at ${open}`);
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, index), close: index };
    }
  }
  throw new Error('unterminated brace block');
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

  it('freezes the WebKit terminal loop through a waitable explicit marker', () => {
    // Issue #328: even after the header / backdrop seams, a live court lets
    // WebKit pick between 1-LSB card and button rasters across loaded runs.
    // The explicit debug freeze must run after the overlay title and before the
    // seams; a capture-side waitForFunction sees the marker, not a rAF guess.
    const stripped = stripComments(SCRIPT);
    expect(stripped).toContain(
      "import { freezeBreakoutLoop } from './lib/breakout-freeze.mjs';",
    );
    for (const name of ['openLevelClear', 'openGameOver']) {
      expect(functionBody(stripped, name)).toContain(
        "...(IS_WEBKIT ? { freeze: '1' } : {})",
      );
      expect(functionBody(stripped, name)).toContain(
        'await freezeBreakoutLoop(page);',
      );
    }
    // READY / playing and both Chromium paths never request the freeze; the two
    // terminal WebKit URLs are the only sites with `freeze: '1'`.
    for (const name of ['openReady', 'openPlaying', 'captureDesktop', 'captureMobile']) {
      const body = functionBody(stripped, name);
      expect(body).not.toContain('freeze:');
      expect(body).not.toContain('freezeBreakoutLoop');
    }
    expect([...stripped.matchAll(/freeze: '1'/g)]).toHaveLength(2);
    expect([
      ...stripped.matchAll(/await freezeBreakoutLoop\(page\);/g),
    ]).toHaveLength(2);

    const view = stripComments(VIEW);
    // The obsolete rAF watcher must not come back: it could run after the
    // screenshot under load, which is exactly the late-freeze variant.
    expect(view).not.toContain('freezeRequested');
    expect(view).not.toContain('sleepOnTerminal');
    expect(view).not.toContain('requestAnimationFrame(sleepOnTerminal)');
    // The freeze is debug-only and URL-gated; a missing gate must throw rather
    // than silently pausing a normal player's loop.
    expect(view).toMatch(
      /const freezeLoopEnabled =\s*debugEnabled\(\) && debugParams\(\)\.get\('freeze'\) === '1';/,
    );
    expect(view).toMatch(
      /if \(!freezeLoopEnabled\) \{\s*throw new Error\(\s*'Breakout freeze requested without \?debug=1&freeze=1',\s*\);\s*\}/,
    );

    // The debug method raises the existing pause guard before sleeping, then
    // publishes the marker only after Phaser reports the loop stopped. A marker
    // written before the sleep, or a missing running check, would let the
    // capture wait on a loop that can still redraw.
    const freezeAt = view.indexOf('const freezeLoop = (): boolean => {');
    expect(freezeAt).toBeGreaterThan(-1);
    const freezeBody = bracedBlock(view, view.indexOf('{', freezeAt)).body;
    const gateAt = freezeBody.indexOf('if (!freezeLoopEnabled) {');
    const pauseAt = freezeBody.indexOf('debugStepsPaused = true;');
    const sleepAt = freezeBody.indexOf('activeRuntime.game.loop.sleep();');
    const runningCheckAt = freezeBody.indexOf(
      'if (activeRuntime.game.loop.running) {',
    );
    const markerAt = freezeBody.indexOf(
      "gameRoot.dataset.debugFrozen = '1';",
    );
    const returnAt = freezeBody.indexOf('return true;', markerAt);
    expect(gateAt).toBeGreaterThan(-1);
    expect(pauseAt).toBeGreaterThan(gateAt);
    expect(sleepAt).toBeGreaterThan(pauseAt);
    expect(runningCheckAt).toBeGreaterThan(sleepAt);
    expect(markerAt).toBeGreaterThan(runningCheckAt);
    expect(returnAt).toBeGreaterThan(markerAt);
    // Exactly one marker writer, and the only activeRuntime sleep sites are the
    // explicit freeze and the existing visibility pause: a second early freeze
    // sleep would make the capture proceed before the terminal state is frozen.
    expect([...view.matchAll(/gameRoot\.dataset\.debugFrozen = '1';/g)]).toHaveLength(1);
    expect([...view.matchAll(/activeRuntime\.game\.loop\.sleep\(\);/g)]).toHaveLength(2);
    // Freeze is exposed through the existing debug API only (which is itself
    // installed under `debugEnabled()`), not on the normal game handle.
    expect(view).toMatch(/freeze: freezeLoop,/);
    expect(view).toMatch(/if \(debugEnabled\(\)\) \{\s*debugWindow\(\)\.__playground = \{/);
    // No terminal-step auto-freeze may creep back in: the capture owns the
    // moment, and a handleStep freeze would race the title wait.
    expect(view).not.toContain('result.levelCleared || result.gameOver');
  });

  it('repaints the WebKit overlay backdrop for ready and the settled terminal states', () => {
    // The READY overlay appears before Phaser paints the court, so a WebKit
    // screenshot can keep the empty backdrop. openReady must wait for that
    // overlay (title and status) and only then run the gated backdrop seam;
    // deleting the call, the guard or either wait restores the blank-court
    // drift while every other assertion above stays green.
    const openReady = functionBody(SCRIPT, 'openReady');
    const readyTitleAt = openReady.indexOf(
      "filter({ hasText: '击碎整面砖墙' })",
    );
    const readyStatusAt = openReady.indexOf("filter({ hasText: '待开始' })");
    const readyGateAt = openReady.indexOf('if (IS_WEBKIT) {');
    const readyBackdropAt = openReady.indexOf(
      'await settleReadyBackdrop(page);',
    );
    expect(
      readyTitleAt,
      'openReady must wait for its overlay title',
    ).toBeGreaterThan(-1);
    expect(readyStatusAt, 'openReady must wait for its READY status').toBeGreaterThan(
      readyTitleAt,
    );
    expect(readyGateAt, 'openReady must gate the backdrop seam on WebKit').toBeGreaterThan(
      readyStatusAt,
    );
    expect(readyBackdropAt).toBeGreaterThan(readyGateAt);
    expect(readyBackdropAt).toBeLessThan(
      bracedBlock(openReady, openReady.indexOf('{', readyGateAt)).close,
    );

    // The seam must disable and restore the same backdrop-filter between two
    // committed frames; dropping either toggle, the frame waits or the restore
    // would leave the browser on a stale or visibly unfiltered snapshot.
    const seam = functionBody(SCRIPT, 'settleReadyBackdrop');
    expect(seam).toContain("overlay.style.backdropFilter = 'none'");
    expect(seam).toContain("overlay.style.webkitBackdropFilter = 'none'");
    expect(seam).toContain("overlay.style.backdropFilter = ''");
    expect(seam).toContain("overlay.style.webkitBackdropFilter = ''");
    expect(seam.match(/await nextFrame\(\);/g)).toHaveLength(2);

    // Issue #328: the levelclear / gameover cards share the same blurred
    // backdrop. Each waits for its own title, freezes the canvas inside the
    // WebKit gate, settles, repaints the overlay backdrop, and only then
    // rebuilds the header snapshot: moving the freeze after the settle or the
    // backdrop before the settle must fail here.
    const stripped = stripComments(SCRIPT);
    for (const [name, anchor] of [
      ['openLevelClear', "filter({ hasText: '第 1 关清空' })"],
      ['openGameOver', "filter({ hasText: '生命用完了' })"],
    ] as const) {
      const body = functionBody(stripped, name);
      const titleAt = body.indexOf(anchor);
      const gateAt = body.indexOf('if (IS_WEBKIT) {', titleAt);
      const freezeAt = body.indexOf('await freezeBreakoutLoop(page);', titleAt);
      const settleAt = body.indexOf('await settle(page);', freezeAt);
      const backdropAt = body.indexOf(
        'await settleReadyBackdrop(page);',
        settleAt,
      );
      const headerAt = body.indexOf(
        'await settleSharedHeaderCompositing(page);',
        backdropAt,
      );
      const gateCloseAt = bracedBlock(body, body.indexOf('{', gateAt)).close;
      expect(titleAt, `${name} must wait for its overlay title`).toBeGreaterThan(
        -1,
      );
      expect(gateAt, `${name} must gate the terminal seams on WebKit`).toBeGreaterThan(
        titleAt,
      );
      expect(
        freezeAt,
        `${name} must freeze the loop after the title`,
      ).toBeGreaterThan(titleAt);
      expect(
        settleAt,
        `${name} must settle only after the explicit freeze`,
      ).toBeGreaterThan(freezeAt);
      expect(backdropAt, `${name} must repaint the overlay backdrop`).toBeGreaterThan(
        settleAt,
      );
      expect(headerAt, `${name} must settle the header last`).toBeGreaterThan(
        backdropAt,
      );
      expect(freezeAt).toBeGreaterThan(gateAt);
      expect(backdropAt).toBeLessThan(gateCloseAt);
      expect(headerAt).toBeLessThan(gateCloseAt);
    }
    expect([
      ...stripped.matchAll(/await settleReadyBackdrop\(page\);/g),
    ]).toHaveLength(3);
    expect(functionBody(stripped, 'openPlaying')).not.toContain(
      'settleReadyBackdrop',
    );
    for (const name of ['captureDesktop', 'captureMobile']) {
      expect(functionBody(stripped, name)).not.toContain('settleReadyBackdrop');
    }
  });

  it('settles the shared header and overlay on every WebKit settled state', () => {
    // Issue #328: the observed drift is entirely inside the shared site
    // header's blurred backdrop snapshot, so playing / levelclear / gameover
    // reuse the reusable #326 / #341 seam instead of carrying a second paint
    // recipe.
    expect(SCRIPT).toContain(
      "import { settleSharedHeaderCompositing } from './lib/webkit-compositing-settle.mjs';",
    );
    expect(SCRIPT).toContain('const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;');

    const stripped = stripComments(SCRIPT);
    const states = [
      {
        name: 'openPlaying',
        anchor: "getAttribute('data-debug-steps')",
        settleInsideGate: false,
      },
      {
        name: 'openLevelClear',
        anchor: "filter({ hasText: '第 1 关清空' })",
        settleInsideGate: true,
      },
      {
        name: 'openGameOver',
        anchor: "filter({ hasText: '生命用完了' })",
        settleInsideGate: true,
      },
    ];
    for (const { name, anchor, settleInsideGate } of states) {
      const body = functionBody(stripped, name);
      const anchorAt = body.indexOf(anchor);
      const settleAt = body.indexOf('await settle(page);', anchorAt);
      const seamAt = body.indexOf(
        'await settleSharedHeaderCompositing(page);',
        settleAt,
      );
      // The state must fully settle its own overlay / debug marker before the
      // header snapshot is rebuilt; terminal states keep the extra settle
      // inside the WebKit gate so Chromium timing is unchanged.
      expect(anchorAt, `${name} is missing its settled-state anchor`).toBeGreaterThan(-1);
      expect(settleAt, `${name} is missing its settle after ${anchor}`).toBeGreaterThan(
        anchorAt,
      );
      expect(
        seamAt,
        `${name} must settle the header after its own settle`,
      ).toBeGreaterThan(settleAt);
      // The seam must be gated by WebKit mode: removing the guard would change
      // the committed Chromium bytes as well. The gate also has to stay open
      // through the overlay backdrop seam in the terminal states.
      const gateAt = body.indexOf('if (IS_WEBKIT) {', anchorAt);
      const gateClose = bracedBlock(body, body.indexOf('{', gateAt)).close;
      expect(gateAt, `${name} must gate the seams on WebKit`).toBeGreaterThan(
        anchorAt,
      );
      if (settleInsideGate) {
        expect(
          settleAt,
          `${name} must keep the extra settle inside the WebKit gate`,
        ).toBeGreaterThan(gateAt);
      } else {
        expect(settleAt).toBeLessThan(gateAt);
      }
      expect(gateAt).toBeLessThan(seamAt);
      expect(gateClose, `${name} must close the WebKit gate`).toBeGreaterThan(
        seamAt,
      );
    }

    // READY keeps its own first-paint backdrop seam; the header seam must not
    // leak into it.
    expect(functionBody(stripped, 'openReady')).not.toContain(
      'settleSharedHeaderCompositing',
    );
    // Exactly one call per settled WebKit state (playing / levelclear / gameover).
    expect([
      ...stripped.matchAll(/await settleSharedHeaderCompositing\(page\);/g),
    ]).toHaveLength(3);

    // Chromium never calls the header seam directly; the WebKit gate in the
    // shared open* helpers is the only route to it.
    for (const name of ['captureDesktop', 'captureMobile']) {
      expect(functionBody(stripped, name)).not.toContain(
        'settleSharedHeaderCompositing',
      );
    }
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

  it('opts the WebKit playing / levelclear / gameover captures into the stable path', () => {
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
    for (const [variable, file] of [
      ['playing', 'after-breakout-playing-webkit.png'],
      ['cleared', 'after-breakout-levelclear-webkit.png'],
      ['over', 'after-breakout-gameover-webkit.png'],
    ]) {
      // Each settled state must pair its header seam with the stable frame
      // path; a dropped option would commit a single in-flight header raster.
      expect(webkit).toContain(
        `capture(${variable}, '${file}', false, {\n    stable: true,\n  });`,
      );
    }
    // Exactly three captures ask for stable bytes.
    expect([...stripped.matchAll(/stable: true/g)]).toHaveLength(3);

    // READY still uses the single-screenshot path.
    const readyAt = webkit.indexOf(
      "capture(ready, 'after-breakout-ready-webkit.png', false);",
    );
    expect(readyAt).toBeGreaterThan(-1);
    expect(webkit.slice(readyAt, webkit.indexOf('await ready.close()'))).not.toContain(
      'stable: true',
    );

    // Chromium desktop / mobile captures keep the single-frame path.
    for (const name of ['captureDesktop', 'captureMobile']) {
      expect(functionBody(stripped, name)).not.toContain('stable: true');
    }
  });
});
