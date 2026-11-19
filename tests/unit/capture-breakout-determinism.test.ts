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

  it('freezes the loop for the WebKit terminal captures only', () => {
    // Issue #328: even after the header / backdrop seams, a live court lets
    // WebKit pick between 1-LSB card and button rasters across loaded runs.
    // The debug freeze stops the loop once the terminal overlay is ready, so
    // the seam composite is built from a canvas that can no longer redraw.
    for (const name of ['openLevelClear', 'openGameOver']) {
      expect(functionBody(stripComments(SCRIPT), name)).toContain(
        "...(IS_WEBKIT ? { freeze: '1' } : {})",
      );
    }
    // READY / playing keep their existing paths, and Chromium never asks for
    // the freeze; the WebKit spread is the only gate.
    for (const name of ['openReady', 'openPlaying']) {
      expect(functionBody(stripComments(SCRIPT), name)).not.toContain(
        'freeze:',
      );
    }
    expect(functionBody(stripComments(SCRIPT), 'captureDesktop')).not.toContain(
      'freeze:',
    );

    // The view flag is debug-only and stops the loop only after a terminal
    // step; the watcher must sleep the loop and raise the existing pause guard
    // so a focus / visibility event cannot wake the frozen capture.
    expect(VIEW).toMatch(
      /const freezeOnTerminal =\s*debugEnabled\(\) && debugParams\(\)\.get\('freeze'\) === '1';/,
    );
    expect(VIEW).toMatch(
      /if \(freezeOnTerminal && \(result\.levelCleared \|\| result\.gameOver\)\) \{\s*freezeRequested = true;\s*\}/,
    );
    // The flag must have exactly one setter: a second early setter would sleep
    // the loop before the terminal step even with the watcher intact.
    const view = stripComments(VIEW);
    expect([...view.matchAll(/freezeRequested = true;/g)]).toHaveLength(1);
    // Pin the watcher structure rather than the mere presence of the two API
    // calls: deleting the initial schedule leaves no watcher at all, deleting
    // the recursion stops it after the first frame, and emptying or deleting
    // the `freezeRequested` guard sleeps the loop on the first mounted frame.
    // All of those mutations previously kept this test green.
    const watcherGateAt = view.indexOf('if (freezeOnTerminal) {');
    expect(watcherGateAt).toBeGreaterThan(-1);
    const watcherBlock = bracedBlock(view, view.indexOf('{', watcherGateAt));
    const watcher = watcherBlock.body;
    expect(
      watcher.match(/requestAnimationFrame\(sleepOnTerminal\);/g),
    ).toHaveLength(2);
    expect(watcher).toContain('const sleepOnTerminal = (): void => {');
    const arrowOpen = watcher.indexOf(
      '{',
      watcher.indexOf('const sleepOnTerminal = (): void =>'),
    );
    const arrowBlock = bracedBlock(watcher, arrowOpen);
    const arrow = arrowBlock.body;
    const guardAt = arrow.indexOf('if (freezeRequested) {');
    const pauseAt = arrow.indexOf('debugStepsPaused = true;');
    const sleepAt = arrow.indexOf('activeRuntime.game.loop.sleep();');
    const returnAt = arrow.indexOf('return;', sleepAt);
    const recursiveAt = arrow.indexOf(
      'requestAnimationFrame(sleepOnTerminal);',
      returnAt,
    );
    // The sleep must live inside the guard, after the flag is observed, and the
    // recursion must stay outside it so the watcher keeps polling until the
    // terminal step.
    expect(guardAt).toBeGreaterThan(-1);
    const guard = bracedBlock(arrow, arrow.indexOf('{', guardAt));
    expect(guard.body).toContain('debugStepsPaused = true;');
    expect(guard.body).toContain('activeRuntime.game.loop.sleep();');
    expect(guard.body).toContain('return;');
    expect(guard.body).not.toContain('requestAnimationFrame(sleepOnTerminal);');
    expect(pauseAt).toBeGreaterThan(guardAt);
    expect(sleepAt).toBeGreaterThan(pauseAt);
    expect(returnAt).toBeGreaterThan(sleepAt);
    expect(recursiveAt).toBeGreaterThan(guard.close);
    expect(arrow.indexOf('requestAnimationFrame(sleepOnTerminal);')).toBe(
      recursiveAt,
    );
    // The only other schedule is the initial one, and it must sit after the
    // arrow: deleting it previously left the recursive call behind and passed.
    expect(
      watcher.lastIndexOf('requestAnimationFrame(sleepOnTerminal);'),
    ).toBeGreaterThan(arrowBlock.close);
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
    // backdrop. Each waits for its own title, settles inside the WebKit gate,
    // repaints the overlay backdrop, and only then rebuilds the header snapshot:
    // moving the backdrop before the settle or outside the gate (both
    // previously kept this test green) must fail here.
    const stripped = stripComments(SCRIPT);
    for (const [name, anchor] of [
      ['openLevelClear', "filter({ hasText: '第 1 关清空' })"],
      ['openGameOver', "filter({ hasText: '生命用完了' })"],
    ] as const) {
      const body = functionBody(stripped, name);
      const titleAt = body.indexOf(anchor);
      const gateAt = body.indexOf('if (IS_WEBKIT) {', titleAt);
      const settleAt = body.indexOf('await settle(page);', gateAt);
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
      expect(settleAt, `${name} must settle after the title`).toBeGreaterThan(
        gateAt,
      );
      expect(backdropAt, `${name} must repaint the overlay backdrop`).toBeGreaterThan(
        settleAt,
      );
      expect(headerAt, `${name} must settle the header last`).toBeGreaterThan(
        backdropAt,
      );
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
