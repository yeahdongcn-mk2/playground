import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { advanceFixedTicks } from '../../src/games/snake/fixed-ticks';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-snake-screenshots.mjs'),
  'utf8',
);
const VIEW = readFileSync(join(ROOT, 'src', 'games', 'snake', 'snake-view.ts'), 'utf8');
const SCENE = readFileSync(join(ROOT, 'src', 'games', 'snake', 'scene.ts'), 'utf8');
const SNAKE_CSS = readFileSync(join(ROOT, 'src', 'games', 'snake', 'snake.css'), 'utf8');
const APP_CSS = readFileSync(join(ROOT, 'src', 'styles', 'app.css'), 'utf8');
const E2E_MOBILE_CASES = readFileSync(
  join(ROOT, 'tests', 'e2e', 'snake-mobile-cases.ts'),
  'utf8',
);

/** The declarations of the first rule whose selector contains `selector`. */
function cssRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) {
    throw new Error(`missing CSS rule: ${selector}`);
  }
  const open = css.indexOf('{', start + selector.length);
  const close = open < 0 ? -1 : css.indexOf('}', open);
  if (open < 0 || close < 0) {
    throw new Error(`unterminated CSS rule: ${selector}`);
  }
  return css.slice(open + 1, close);
}

/** `#rrggbb` as the resolved `rgb(r, g, b)` value `getComputedStyle` reports. */
function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16),
  );
  return `rgb(${channels.join(', ')})`;
}

/**
 * Guard for the committed playing PNG. The engine test proves seed 7 plus three
 * fixed ticks reach a deterministic snake, next fruit and HUD state; these
 * tests runtime-test the extracted fixed-tick loop and statically pin the
 * capture script, the view wiring and the scene's final draw / sleep / marker
 * order. A dropped parameter cannot silently restore wall-clock captures while
 * the engine test stays green.
 */
describe('snake screenshot determinism guard', () => {
  it('pins the seed, fixed first fruit and tick count in the playing URL', () => {
    expect(SCRIPT).toContain('const PLAYING_SEED = 7;');
    expect(SCRIPT).toContain('const PLAYING_TICKS = 3;');
    expect(SCRIPT).toContain(
      '`${ORIGIN}/#/games/snake?debug=1&food=11,10&seed=${PLAYING_SEED}&ticks=${PLAYING_TICKS}`',
    );
  });

  it('pins the READY title color and disables its transition', () => {
    // Issue #318 t3: the reduced-motion rule sets `transition-duration` on every
    // element, so an inherited title color started a `color` transition at the
    // pre-CSS black start point and WebKit could leave it stuck there. Pinning
    // `--text` plus `transition: none` makes the first paint the final state.
    const rule = cssRule(SNAKE_CSS, '.snake-overlay-card h2');
    expect(rule).toContain('color: var(--text);');
    expect(rule).toMatch(/transition:\s*none;/);
  });

  it('waits for the READY title final color with no running transition', () => {
    const start = SCRIPT.indexOf('async function waitForSnakeReady(');
    const end = SCRIPT.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = SCRIPT.slice(start, end);

    // The wait must read the real computed color and active animations, not
    // just the status marker: a stuck color transition keeps painting black
    // while the state machine already reports `ready`.
    expect(body).toContain(
      "document.querySelector('[data-testid=\"overlay-title\"]')",
    );
    expect(body).toContain('getComputedStyle(title).color === expectedColor');
    expect(body).toContain('title.getAnimations().length === 0');
    expect(SCRIPT).toContain('const READY_TITLE_COLOR =');
    expect(body).toMatch(/READY_TITLE_COLOR,\s*\);/);

    // The guard must run before the committed WebKit capture, not after it.
    const waitAt = SCRIPT.indexOf('await waitForSnakeReady(mobileGame);');
    const captureAt = SCRIPT.indexOf(
      "await capture(mobileGame, 'after-snake-webkit.png', false, { stable: true });",
    );
    expect(waitAt).toBeGreaterThan(-1);
    expect(captureAt).toBeGreaterThan(waitAt);
  });

  it('warms the first-page paint path before the committed WebKit ready page', () => {
    // Issue #342 rework: a fresh browser's first page can rasterise the sticky
    // header and the READY card / blurred backdrop in a stable 1-2-LSB variant.
    // `{ stable: true }` cannot catch that because the wrong raster is itself
    // byte-identical across consecutive frames, so the committed page must not
    // be the browser's first page. A throwaway page loads the same READY scene
    // (including the overlay and its backdrop-filter) and closes before the
    // real page opens, the same seam as the minesweeper READY capture.
    expect(SCRIPT).toContain(
      "const SNAKE_READY_URL = `${ORIGIN}/#/games/snake?debug=1&food=11,10`;",
    );
    const helperStart = SCRIPT.indexOf('async function captureWebkitMobile(');
    const helperEnd = SCRIPT.indexOf('\n}\n', helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const body = SCRIPT.slice(helperStart, helperEnd);

    const warmUpOpen = body.indexOf('const warmUp = await mobile.newPage();');
    const warmUpLoad = body.indexOf(
      "await warmUp.goto(SNAKE_READY_URL, { waitUntil: 'networkidle' });",
    );
    const warmUpWait = body.indexOf('await waitForSnakeReady(warmUp);');
    const warmUpSettle = body.indexOf('await settleCapturePaint(warmUp);');
    const warmUpClose = body.indexOf('await warmUp.close();');
    const committedOpen = body.indexOf('const mobileGame = await mobile.newPage();');
    const committedLoad = body.indexOf(
      "await mobileGame.goto(SNAKE_READY_URL, { waitUntil: 'networkidle' });",
    );

    expect(warmUpOpen).toBeGreaterThan(-1);
    expect(warmUpLoad).toBeGreaterThan(warmUpOpen);
    expect(warmUpWait).toBeGreaterThan(warmUpLoad);
    expect(warmUpSettle).toBeGreaterThan(warmUpWait);
    expect(warmUpClose).toBeGreaterThan(warmUpSettle);
    expect(committedOpen).toBeGreaterThan(warmUpClose);
    expect(committedLoad).toBeGreaterThan(committedOpen);

    // The throwaway page must close even when loading, waiting or settling
    // throws: dropping the try/finally would leak the page if the warm-up fails.
    expect(body).toMatch(
      /const warmUp = await mobile\.newPage\(\);\s*try \{\s*await warmUp\.goto\([^;]+;\s*await waitForSnakeReady\(warmUp\);\s*(?:\/\/[^\n]*\n\s*)*await settleCapturePaint\(warmUp\);\s*\} finally \{\s*await warmUp\.close\(\);\s*\}/,
    );
  });

  it('runs the READY repaint seams in order before the stable WebKit capture', () => {
    // Issue #342 t0: the shared header and the READY card / blurred backdrop
    // need the same deterministic seams as 2048, but the snake frame is
    // framed by a D-pad scroll, so header repaint must happen first and the
    // overlay repaint after the framing scroll. A reordered or dropped call
    // must fail this static guard.
    expect(SCRIPT).toContain(
      'repaintWebkitReadyOverlay,\n  settleCapturePaint,\n  settleWebkitReadyPaint,',
    );
    expect(SCRIPT).toMatch(/\bsettleWebkitReadyPaint,\n\s*stopPreviewServer,/);

    const helperStart = SCRIPT.indexOf('async function captureWebkitMobile(');
    const helperEnd = SCRIPT.indexOf('\n}\n', helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const body = SCRIPT.slice(helperStart, helperEnd);

    const waitAt = body.indexOf('await waitForSnakeReady(mobileGame);');
    const headerAt = body.indexOf('await settleWebkitReadyPaint(mobileGame);');
    const scrollAt = body.indexOf(
      "await mobileGame.getByTestId('dpad').scrollIntoViewIfNeeded();",
    );
    const nudgeAt = body.indexOf('await mobileGame.evaluate(() => window.scrollBy(0, -16));');
    const overlayAt = body.indexOf('await repaintWebkitReadyOverlay(mobileGame);');
    const captureAt = body.indexOf(
      "await capture(mobileGame, 'after-snake-webkit.png', false, { stable: true });",
    );

    expect(waitAt).toBeGreaterThan(-1);
    expect(headerAt).toBeGreaterThan(waitAt);
    expect(scrollAt).toBeGreaterThan(headerAt);
    expect(nudgeAt).toBeGreaterThan(scrollAt);
    expect(overlayAt).toBeGreaterThan(nudgeAt);
    expect(captureAt).toBeGreaterThan(overlayAt);

    // The D-pad framing must not reset the page to the top; only the header
    // seam runs a scroll round-trip, and it does so before the framing scroll.
    expect(body).not.toContain('window.scrollTo(0, 0)');
    expect(body).not.toContain('scrollTo(0, 0)');

    // One seam call each: a second call elsewhere would make the pinned order
    // above ambiguous.
    const calls = (source: string, name: string): number =>
      source.match(new RegExp(`await ${name}\\(`, 'g'))?.length ?? 0;
    expect(calls(SCRIPT, 'settleWebkitReadyPaint')).toBe(1);
    expect(calls(SCRIPT, 'repaintWebkitReadyOverlay')).toBe(1);
  });

  it('passes capture options through and opts only the WebKit frame into stable bytes', () => {
    // The `stable: true` wiring only works if capture() forwards its fourth
    // argument to captureScreenshot; a helper that forgets it would silently
    // write a single in-flight frame.
    const helperStart = SCRIPT.indexOf('async function capture(');
    const helperEnd = SCRIPT.indexOf('\n}\n', helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = SCRIPT.slice(helperStart, helperEnd);
    expect(helper).toContain('async function capture(page, name, fullPage = true, options = {}) {');
    expect(helper).toContain(
      'await captureScreenshot(page, name, { engine: ENGINE, fullPage, ...options });',
    );

    expect(SCRIPT.match(/, \{ stable: true \}\);/g)).toHaveLength(1);
    expect(SCRIPT).toContain(
      "await capture(mobileGame, 'after-snake-webkit.png', false, { stable: true });",
    );
    // Chromium desktop / mobile and the other WebKit-neighbour captures keep
    // their existing single-screenshot path.
    expect(SCRIPT).not.toContain("after-snake-mobile.png', false, {");
    expect(SCRIPT).not.toContain("after-snake-ready.png', true, {");
  });

  it('keeps the expected READY title color in sync with the app.css token', () => {
    const token = APP_CSS.match(/--text:\s*(#[0-9a-fA-F]{6});/)?.[1] ?? '';
    expect(token).not.toBe('');
    const expectedColor = hexToRgb(token);
    expect(SCRIPT).toContain(
      `const READY_TITLE_COLOR = '${expectedColor}';`,
    );
    // The e2e assertion hardcodes the same resolved value; keep it in sync so a
    // token change cannot leave a green unit guard and a failing mobile test.
    expect(E2E_MOBILE_CASES).toContain(
      `expect(readyTitle.color).toBe('${expectedColor}');`,
    );
  });

  it('waits for the fixed-tick marker instead of a wall-clock delay', () => {
    expect(SCRIPT).not.toContain('waitForTimeout(120)');
    expect(SCRIPT).not.toContain('score >= 10');
    expect(SCRIPT).toContain(
      "?.getAttribute('data-debug-ticks') === String(ticks)",
    );
  });

  it('gates the seed and tick seams through the existing debug gate', () => {
    expect(VIEW).toMatch(
      /function debugSeedFromHash\(\): number \| undefined \{\s*if \(!debugEnabled\(\)\) \{\s*return undefined;\s*\}\s*return resolveDebugSeed\(debugParams\(\)\.get\('seed'\)\);/,
    );
    expect(VIEW).toMatch(
      /function debugTicksFromHash\(\): number \| undefined \{\s*if \(!debugEnabled\(\)\) \{\s*return undefined;\s*\}\s*return resolveDebugTicks\(debugParams\(\)\.get\('ticks'\)\);/,
    );
    expect(VIEW).toContain('const seed = debugSeedFromHash();');
    expect(VIEW).toContain('const fixedTickCount = debugTicksFromHash();');
    // The seeded RNG is still the engine's RNG; a removed seed would fall back
    // to the per-mount random seed and break the screenshot silently.
    expect(VIEW).toMatch(/createSeededRng\(\s*seed \?\?/);
  });

  it('requests the fixed ticks only after a run starts and marks completion', () => {
    expect(VIEW).toContain('let debugTicksPaused = false;');
    expect(VIEW).toMatch(
      /if \(fixedTickCount !== undefined\) \{\s*debugTicksPaused = true;\s*\/\/[^]*?runtime\?\.game\.loop\.wake\(\);\s*scene\?\.requestFixedTicks\(fixedTickCount\);/,
    );
    expect(VIEW).toContain('gameRoot.dataset.debugTicks = String(ticks);');
  });

  it('keeps focus and visibility from unfreezing the deterministic frame', () => {
    // Both wake / pause paths are skipped while the debug tick sequence owns
    // the run, so a stray browser event cannot change the captured state.
    expect(VIEW).toMatch(
      /const onVisibilityChange = \(\): void => \{\s*if \(debugTicksPaused\) \{\s*return;\s*\}/,
    );
    expect(VIEW).toMatch(
      /if \(!debugTicksPaused && engine\.currentStatus === 'running'\) \{/,
    );
  });

  it('stores and consumes the requested tick count instead of a hard-coded loop', () => {
    const requestAt = SCENE.indexOf('requestFixedTicks(ticks: number): void {');
    const storeAt = SCENE.indexOf(
      'this.fixedTicks = Math.max(0, Math.floor(ticks));',
      requestAt,
    );
    expect(requestAt).toBeGreaterThan(-1);
    expect(storeAt).toBeGreaterThan(requestAt);

    const ticksAt = SCENE.indexOf('const ticks = this.fixedTicks;', storeAt);
    const clearAt = SCENE.indexOf('this.fixedTicks = null;', ticksAt);
    const advanceAt = SCENE.indexOf('advanceFixedTicks(ticks,', clearAt);
    expect(ticksAt).toBeGreaterThan(storeAt);
    expect(clearAt).toBeGreaterThan(ticksAt);
    expect(advanceAt).toBeGreaterThan(clearAt);

    // The final state is drawn, then the run is frozen until the frame's
    // render finishes, then the capture marker fires; deleting the draw would
    // let the screenshot keep a stale frame. A slept WebGL canvas can capture
    // as black, so the seam must freeze the run instead of the loop.
    const drawAt = SCENE.indexOf('this.drawGame(this.engine.state, time);', advanceAt);
    const frozenAt = SCENE.indexOf('this.frozen = true;', drawAt);
    const renderAt = SCENE.indexOf('Phaser.Core.Events.POST_RENDER', frozenAt);
    const markerAt = SCENE.indexOf('this.callbacks.onFixedTicks?.(ticks);', renderAt);
    expect(drawAt).toBeGreaterThan(advanceAt);
    expect(frozenAt).toBeGreaterThan(drawAt);
    expect(renderAt).toBeGreaterThan(frozenAt);
    expect(markerAt).toBeGreaterThan(renderAt);
    expect(SCENE).not.toContain('this.game.loop.sleep()');
    expect(SCENE).toMatch(/if \(this\.frozen\) \{\s*return;\s*\}/);
    expect(SCENE).toMatch(
      /resetRunState\(\): void \{\s*this\.accumulator = 0;\s*this\.deathFlashUntil = 0;\s*this\.frozen = false;/,
    );
  });

  it('advances exactly the requested fixed ticks', () => {
    const calls: string[] = [];
    advanceFixedTicks(3, () => {
      calls.push('tick');
    });
    expect(calls).toHaveLength(3);

    advanceFixedTicks(0, () => {
      calls.push('unexpected');
    });
    expect(calls).toHaveLength(3);
  });

  it('stops early when a tick reports the run is over', () => {
    let calls = 0;
    advanceFixedTicks(10, () => {
      calls += 1;
      return calls < 2;
    });
    expect(calls).toBe(2);
  });
});
