import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_SETTLE_FRAMES,
  CAPTURE_SETTLE_TIMEOUT_MS,
  READY_CAPTURE_STABLE_ATTEMPTS,
  READY_CAPTURE_STABLE_FRAMES,
  READY_CAPTURE_STABLE_INTERVAL_MS,
  settleCapturePaint,
  settleWebkitReadyPaint,
} from '../../scripts/lib/capture-runtime.mjs';
import { findHistoricalAfterEvidence } from '../../scripts/lib/screenshot-evidence.mjs';
import { settleSharedHeaderCompositing } from '../../scripts/lib/webkit-compositing-settle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-minesweeper-screenshots.mjs'),
  'utf8',
);
const RUNTIME = readFileSync(
  join(ROOT, 'scripts', 'lib', 'capture-runtime.mjs'),
  'utf8',
);
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const ROOT_README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const MANIFEST_PATH = join(
  ROOT,
  'docs',
  'screenshots',
  'capture-sha256-manifest.json',
);
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  captures: Array<{
    file: string;
    sha256: string;
    command: string;
    provenance: { captureCommit: string };
  }>;
};

const MINESWEEPER_WEBKIT = [
  'after-minesweeper-ready-webkit.png',
  'after-minesweeper-playing-webkit.png',
  'after-minesweeper-lost-webkit.png',
  'after-minesweeper-won-webkit.png',
] as const;
const MINESWEEPER_COMMAND =
  'npm run screenshots:container -- screenshots:minesweeper:webkit';

/** The WebKit-after guard that wraps each capture-only paint step. */
const AFTER_GUARD = "if (IS_WEBKIT && prefix === 'after') {";
const AFTER_GUARD_OPEN_BRACE_OFFSET = AFTER_GUARD.length - 1;

function count(pattern: RegExp): number {
  return [...SCRIPT.matchAll(pattern)].length;
}

/**
 * The script with line and block comments removed. A commented-out seam call
 * must not satisfy the static guards below.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const CODE = stripComments(SCRIPT);

function indexOfOrFail(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index, `missing: ${needle}`).toBeGreaterThan(-1);
  return index;
}

/** First index of `needle` at or after `from`. */
function indexAfter(haystack: string, needle: string, from: number): number {
  const index = haystack.indexOf(needle, from);
  expect(index, `missing after index ${from}: ${needle}`).toBeGreaterThan(-1);
  return index;
}

/**
 * The index of the `}` that closes the block opened at `openBrace`.
 *
 * The capture script's after-mode guards contain only `//` comments, so skip
 * those; a brace in a comment must not move the boundary this test pins.
 */
function closingBrace(source: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      if (newline === -1) {
        break;
      }
      index = newline;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(`unbalanced block starting at index ${openBrace}`);
}

/**
 * The index of the `if (IS_WEBKIT && prefix === 'after') {` guard whose block
 * contains `index`, or a test failure naming what was expected there.
 */
function enclosingAfterGuard(
  source: string,
  index: number,
  description: string,
): number {
  for (
    let guard = source.indexOf(AFTER_GUARD);
    guard !== -1;
    guard = source.indexOf(AFTER_GUARD, guard + AFTER_GUARD.length)
  ) {
    if (
      guard < index &&
      index < closingBrace(source, guard + AFTER_GUARD_OPEN_BRACE_OFFSET)
    ) {
      return guard;
    }
  }
  throw new Error(
    `missing: ${description} is not inside a WebKit-after guard`,
  );
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The body of the shared subsection, up to the next heading. */
function subsection(text: string, heading: string): string {
  const start = indexOfOrFail(text, heading);
  const nextLevel2 = text.indexOf('\n## ', start + heading.length);
  const nextLevel3 = text.indexOf('\n### ', start + heading.length);
  const candidates = [nextLevel2, nextLevel3].filter((index) => index >= 0);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

/**
 * Static guard for the minesweeper WebKit READY determinism seam (Issue #318).
 *
 * WebKit's first page in a fresh browser can rasterise the sticky header and
 * the board gradients in a subtly different 1-LSB variant. The ready capture
 * first loads a throwaway page, then repaints the header with a scroll
 * round-trip and requires two consecutive identical whole-image frames before
 * the bytes are considered. A wrong raster can still be byte-stable (the 105 px
 * board variant in Issue #341), so the ready page is sampled like playing /
 * lost / won and only the bytes that equal the manifest sha256 are written.
 * This test pins that resampling seam to the ready scene, pins the shared
 * header compositing seam (Issue #341) to playing / won, rebuilds the lost
 * header + overlay backdrop together, and pins the loss overlay repaint so a
 * refactor cannot silently restore the non-deterministic capture.
 */
describe('minesweeper WebKit READY determinism guard', () => {
  it('warms the first-page paint path before sampling a ready page', () => {
    const warmUpOpen = indexOfOrFail(
      SCRIPT,
      'const warmUp = await context.newPage()',
    );
    const warmUpLoad = indexOfOrFail(SCRIPT, 'await openTouchGame(warmUp, WIN_MINES)');
    const warmUpClose = indexOfOrFail(SCRIPT, 'await warmUp.close()');
    const readySample = SCRIPT.indexOf(
      "name: touchMobileName(prefix, 'ready')",
      warmUpClose,
    );
    expect(
      readySample,
      'missing: the ready sample after the warm-up page',
    ).toBeGreaterThan(-1);

    expect(warmUpLoad).toBeGreaterThan(warmUpOpen);
    expect(warmUpClose).toBeGreaterThan(warmUpLoad);
    expect(readySample).toBeGreaterThan(warmUpClose);

    // The throwaway page must be closed even when opening the game throws:
    // dropping the try/finally would leak the page (and can shift the sampled
    // ready page onto a different paint path). This structural assertion fails
    // if `finally` is removed or the close is moved outside the block.
    expect(SCRIPT).toMatch(
      /const warmUp = await context\.newPage\(\);\s*try \{\s*await openTouchGame\(warmUp, WIN_MINES\);\s*\} finally \{\s*await warmUp\.close\(\);\s*\}/,
    );
  });

  it('requires two identical whole-image frames for every sampled ready page', () => {
    const helperStart = indexOfOrFail(
      CODE,
      'function captureReadyFramesBytes(page, name)',
    );
    const helperEnd = CODE.indexOf('\n}\n', helperStart);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = CODE.slice(helperStart, helperEnd);
    expect(helper).toContain('captureStableFramesBytes(page, {');
    expect(helper).toContain('fullPage: false,');
    expect(helper).toContain("animations: 'disabled',");
    expect(helper).toContain('stableFrames: READY_CAPTURE_STABLE_FRAMES,');
    expect(helper).toContain(
      'stableIntervalMs: READY_CAPTURE_STABLE_INTERVAL_MS,',
    );
    expect(helper).toContain(
      'stableAttempts: READY_CAPTURE_STABLE_ATTEMPTS,',
    );

    // The ready sample must pass that helper as its captureBytes: deleting the
    // wiring would silently fall back to the resampler's single screenshot and
    // drop the READY capture's stability contract.
    const readySample = indexOfOrFail(
      CODE,
      "name: touchMobileName(prefix, 'ready')",
    );
    const captureBytes = indexAfter(CODE, 'captureBytes: (ready) =>', readySample);
    expect(
      indexAfter(CODE, 'captureReadyFramesBytes(ready,', captureBytes),
    ).toBeGreaterThan(captureBytes);

    expect(READY_CAPTURE_STABLE_FRAMES).toBe(2);
    expect(READY_CAPTURE_STABLE_INTERVAL_MS).toBe(250);
    expect(READY_CAPTURE_STABLE_ATTEMPTS).toBe(5);
    expect(RUNTIME).toContain(
      'export async function captureStableFramesBytes',
    );
    expect(RUNTIME).toContain(
      'export const READY_CAPTURE_STABLE_FRAMES = 2;',
    );
    expect(RUNTIME).toContain(
      'export const READY_CAPTURE_STABLE_INTERVAL_MS = 250;',
    );
    expect(RUNTIME).toContain(
      'export const READY_CAPTURE_STABLE_ATTEMPTS = 5;',
    );
  });

  it('forwards the sample options through capture() to captureScreenshot()', () => {
    // `capture()` is the only bridge from the ready sample's environment
    // preflight / captured bytes to `captureScreenshot`. Dropping its `options`
    // parameter or the `...options` spread would silently turn the guarded
    // write into a plain screenshot of a sampled page.
    expect(SCRIPT).toMatch(
      /async function capture\(\s*page,\s*name,\s*fullPage,\s*options = \{\}\s*\)\s*\{/,
    );
    expect(SCRIPT).toMatch(
      /await captureScreenshot\(\s*page,\s*name,\s*\{\s*\.\.\.options,\s*engine: ENGINE,\s*fullPage\s*\}\s*\);/,
    );
  });

  it('repaints the WebKit header before every sampled ready capture', () => {
    expect(SCRIPT).toContain(
      "settleWebkitReadyPaint,\n  startPreviewServer,",
    );
    expect(count(/settleWebkitReadyPaint\(/g)).toBe(1);

    const touch = indexOfOrFail(
      CODE,
      'async function captureTouchMobile(browser, prefix)',
    );
    const readySample = indexAfter(
      CODE,
      "name: touchMobileName(prefix, 'ready')",
      touch,
    );
    const readyOpen = indexAfter(
      CODE,
      'await openTouchGame(ready, WIN_MINES)',
      readySample,
    );
    const seam = indexAfter(
      CODE,
      'await settleWebkitReadyPaint(ready)',
      readyOpen,
    );
    const readyBytes = indexAfter(
      CODE,
      'captureBytes: (ready) =>',
      seam,
    );
    expect(seam).toBeGreaterThan(readyOpen);
    expect(readyBytes).toBeGreaterThan(seam);

    // The scroll round-trip must run inside the ready sample's prepare
    // callback, which itself belongs to a WebKit-after guard. Matching each
    // guard to its closing brace makes deleting that guard falsifiable.
    const seamGuard = enclosingAfterGuard(CODE, seam, 'the ready seam');
    expect(seam).toBeGreaterThan(seamGuard);
    expect(seam).toBeLessThan(
      closingBrace(CODE, seamGuard + AFTER_GUARD_OPEN_BRACE_OFFSET),
    );

    const warmUpOpen = indexOfOrFail(
      CODE,
      'const warmUp = await context.newPage()',
    );
    const warmUpGuard = enclosingAfterGuard(
      CODE,
      warmUpOpen,
      'the warm-up page',
    );
    expect(warmUpOpen).toBeGreaterThan(warmUpGuard);
    expect(readySample).toBeGreaterThan(warmUpOpen);
    expect(warmUpGuard).toBe(seamGuard);
  });

  it('repaints the loss overlay backdrop before rebuilding both backdrops', () => {
    // The loss overlay's translucent backdrop can cache a 1-LSB board variant.
    // The overlay is hidden / restored first, then the shared header and the
    // loss-card backdrop are rebuilt together; both sit after the loss overlay
    // has appeared and before the resampled capture.
    const afterTouch = indexOfOrFail(
      CODE,
      'async function captureWebkitAfterTouchStates(context, prefix)',
    );
    const lostOverlay = indexAfter(
      CODE,
      "await lost.getByTestId('overlay-title').filter({ hasText: '踩到地雷' }).waitFor()",
      afterTouch,
    );
    const lostRepaint = indexAfter(
      CODE,
      'await repaintWebkitReadyOverlay(lost)',
      afterTouch,
    );
    const lostLayers = indexAfter(
      CODE,
      'await settleBackdropLayersCompositing(lost)',
      afterTouch,
    );
    expect(lostRepaint).toBeGreaterThan(lostOverlay);
    expect(lostLayers).toBeGreaterThan(lostRepaint);
    // A separate header-only seam before the pair would resample the overlay
    // into another variant; the pair already rebuilds both layers.
    expect(CODE).not.toContain('settleSharedHeaderCompositing(lost)');
    // The lost scene is written by the resampled capture, so the state is
    // named in a sample call after the seams.
    expect(
      indexAfter(CODE, "name: touchMobileName(prefix, 'lost')", afterTouch),
    ).toBeGreaterThan(-1);
    // The pre-existing settle stays on the Chromium / before path.
    expect(CODE).toMatch(
      /await lost\.getByTestId\('overlay-title'\)\.filter\(\{ hasText: '踩到地雷' \}\)\.waitFor\(\);\s*await settle\(lost\);/,
    );
  });

  it('settles the shared header before the playing / won reveals', () => {
    expect(CODE).toContain('settleSharedHeaderCompositing,');
    expect(CODE).toContain('settleBackdropLayersCompositing,');
    // playing / won settle before their first reveal; lost rebuilds its header
    // and overlay backdrop together after the loss overlay repaint. The ready
    // path keeps its own seam.
    expect([...CODE.matchAll(/await settleSharedHeaderCompositing\(/g)]).toHaveLength(2);
    expect([...CODE.matchAll(/await settleBackdropLayersCompositing\(/g)]).toHaveLength(1);

    const afterTouch = indexOfOrFail(
      CODE,
      'async function captureWebkitAfterTouchStates(context, prefix)',
    );
    for (const state of ['playing', 'won'] as const) {
      const open = indexAfter(CODE, `await openTouchGame(${state},`, afterTouch);
      const seam = indexAfter(
        CODE,
        `await settleSharedHeaderCompositing(${state})`,
        afterTouch,
      );
      const reveal = indexAfter(CODE, `await touchTap(${state},`, afterTouch);
      // Settling after the live reveal can roll the playing clock to the next
      // second under load.
      expect(seam, `${state} seam must run before the first reveal`).toBeGreaterThan(open);
      expect(seam, `${state} seam must run before the first reveal`).toBeLessThan(reveal);
    }

    // The live HUD keeps its settle as the last paint step of the playing
    // setup, before the resampled capture reads the frame.
    expect(CODE).toMatch(
      /await playing\.getByTestId\('timer'\)\.filter\(\{ hasNotText: '0:00' \}\)\.waitFor\(\);\s*await settle\(playing\);/,
    );

    expect(CODE).toMatch(
      /await won\.getByTestId\('overlay-title'\)\.filter\(\{ hasText: '扫雷成功' \}\)\.waitFor\(\);\s*await settle\(won\);/,
    );

    const touch = indexOfOrFail(
      CODE,
      'async function captureTouchMobile(browser, prefix)',
    );
    // The READY path keeps its warm-up / scroll / whole-image stability seam;
    // adding the shared header seam there would change the committed bytes.
    const readySample = indexAfter(
      CODE,
      "name: touchMobileName(prefix, 'ready')",
      touch,
    );
    const readyCaptureBytes = indexAfter(
      CODE,
      'captureBytes: (ready) =>',
      readySample,
    );
    const readySampleBlock = CODE.slice(readySample, readyCaptureBytes);
    expect(readySampleBlock).toContain('await openTouchGame(ready, WIN_MINES)');
    expect(readySampleBlock).toContain('await settleWebkitReadyPaint(ready)');
    expect(readySampleBlock).not.toContain('settleSharedHeaderCompositing');

    // The WebKit-after branch samples ready / playing / lost / won before the
    // Chromium / before path and then closes the context, so a stray eighth
    // capture cannot write the shared evidence after the sampled states.
    const warmUpOpen = indexOfOrFail(
      CODE,
      'const warmUp = await context.newPage()',
    );
    const branch = CODE.lastIndexOf(
      "if (IS_WEBKIT && prefix === 'after') {",
      warmUpOpen,
    );
    expect(branch, 'missing: the WebKit-after guard around the warm-up page').toBeGreaterThan(-1);
    expect(warmUpOpen).toBeGreaterThan(branch);
    const afterStates = indexAfter(
      CODE,
      'await captureWebkitAfterTouchStates(context, prefix);',
      branch,
    );
    const chromiumPlaying = indexAfter(
      CODE,
      'const playing = await context.newPage();',
      touch,
    );
    expect(branch).toBeGreaterThan(touch);
    expect(afterStates).toBeGreaterThan(branch);
    expect(afterStates).toBeLessThan(chromiumPlaying);
    expect(CODE.slice(afterStates, chromiumPlaying)).toContain('await context.close();');
    expect(count(/await captureWebkitAfterTouchStates\(context, prefix\);/g)).toBe(1);
  });

  it('resamples the WebKit-after phone states and ready from fresh pages', () => {
    expect(CODE).toContain('captureManifestedScreenshot,');
    expect(CODE).toContain(
      "const ALLOW_NEW_BYTES = ARGS.includes('--allow-new-bytes');",
    );
    expect(count(/await sampleWebkitTouchState\(context, \{/g)).toBe(4);
    expect(CODE).toContain("name: touchMobileName(prefix, 'ready')");
    for (const state of ['playing', 'lost', 'won']) {
      expect(CODE).toContain(`name: touchMobileName(prefix, '${state}')`);
    }

    const helperStart = indexOfOrFail(
      CODE,
      'async function sampleWebkitTouchState(context, { name, prepare, captureBytes })',
    );
    const helperEnd = CODE.indexOf('\n}\n', helperStart);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = CODE.slice(helperStart, helperEnd);
    expect(helper).toContain('await captureManifestedScreenshot({');
    expect(helper).toContain('openPage: () => context.newPage()');
    expect(helper).toContain(
      'checkEnvironment: (page) => capture(page, name, false, { checkOnly: true })',
    );
    expect(helper).toContain('capturedBytes: bytes');
    expect(helper).toContain('allowNewBytes: ALLOW_NEW_BYTES,');
    // The two-frame gate only reaches the resampler when this call forwards
    // captureBytes; dropping the option silently falls back to a single
    // screenshot while every other assertion still passes.
    const manifestCall = helper.indexOf('await captureManifestedScreenshot({');
    expect(manifestCall).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf('captureBytes,', manifestCall)).toBeGreaterThan(manifestCall);
    expect(helper.indexOf('captureBytes,', manifestCall)).toBeLessThan(
      helper.indexOf('checkEnvironment:', manifestCall),
    );
  });

  it('fails instead of skipping when the shared header is missing', async () => {
    const missingHeader = {
      evaluate: async () => false,
    } as unknown as Page;
    await expect(settleSharedHeaderCompositing(missingHeader)).rejects.toThrow(
      'Shared header ".site-header" was not found',
    );
  });

  it('keeps the seam on the shared runtime contract', () => {
    expect(RUNTIME).toContain('export async function settleWebkitReadyPaint');
    expect(RUNTIME).toContain('await settleCapturePaint(page);');
    expect(RUNTIME).toContain('export const CAPTURE_SETTLE_FRAMES = 2;');
    expect(RUNTIME).toContain('export const CAPTURE_SETTLE_TIMEOUT_MS = 300;');
  });

  it('settles fonts, two animation frames and the 300 ms fallback', async () => {
    const { page, evaluate, waitForTimeout } = recordingPage();

    await settleCapturePaint(page);

    expect(CAPTURE_SETTLE_FRAMES).toBe(2);
    expect(CAPTURE_SETTLE_TIMEOUT_MS).toBe(300);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[1]?.[1]).toBe(2);
    expect(waitForTimeout).toHaveBeenCalledWith(300);
  });

  it('scrolls away, waits for the repaint, returns to the top and settles', async () => {
    const { page, calls, evaluate, waitForFunction } = recordingPage();

    await settleWebkitReadyPaint(page);

    expect(calls).toEqual([
      'evaluate:200',
      'waitForFunction',
      'evaluate:',
      'waitForFunction',
      'evaluate:',
      'evaluate:2',
      'waitForTimeout',
    ]);
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(waitForFunction).toHaveBeenCalledTimes(2);
  });

  it('accepts an explicit scroll offset for a different viewport', async () => {
    const { page, calls } = recordingPage();

    await settleWebkitReadyPaint(page, { offset: 320 });

    expect(calls[0]).toBe('evaluate:320');
  });

  it('executes each waitForFunction predicate against the guarded scroll state', async () => {
    const { page, waitForFunction } = recordingPage();

    await settleWebkitReadyPaint(page);

    const predicates = waitForFunction.mock.calls.map(
      ([predicate]) => predicate as () => boolean,
    );
    const awayPredicate = predicates[0];
    const backPredicate = predicates[1];
    expect(awayPredicate).toBeDefined();
    expect(backPredicate).toBeDefined();
    if (awayPredicate === undefined || backPredicate === undefined) {
      throw new Error('the seam did not call waitForFunction twice');
    }
    // `scrollY > 0` must reject the pre-scroll state (this would pass if a
    // refactor changed it to `>= 0`), and `scrollY === 0` must reject the
    // scrolled-away state before the return to the top.
    expect(runPredicate(awayPredicate, 0)).toBe(false);
    expect(runPredicate(awayPredicate, 200)).toBe(true);
    expect(runPredicate(backPredicate, 200)).toBe(false);
    expect(runPredicate(backPredicate, 0)).toBe(true);
  });
});

/** Run a recorded browser predicate with the given `window.scrollY`. */
function runPredicate(predicate: () => boolean, scrollY: number): boolean {
  return new Function('window', `return (${predicate.toString()})();`)({
    scrollY,
  }) as boolean;
}

/**
 * A Page double that records the seam's calls and executes the callbacks with
 * a fake `window`, `document` and synchronous `requestAnimationFrame`, so a
 * predicate that no longer guards the scroll state fails the tests.
 */
function recordingPage(): {
  page: Page;
  calls: string[];
  evaluate: ReturnType<typeof vi.fn>;
  waitForFunction: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const window = {
    scrollY: 0,
    scrollTo(_x: number, y: number) {
      window.scrollY = y;
    },
  };
  const document = { fonts: { ready: Promise.resolve() } };
  const requestAnimationFrame = (callback: (time: number) => void) =>
    callback(0);
  const run = (callback: unknown, arg?: unknown): unknown => {
    const source = (callback as { toString(): string }).toString();
    return new Function(
      'window',
      'document',
      'requestAnimationFrame',
      'arg',
      `return (${source})(arg);`,
    )(window, document, requestAnimationFrame, arg);
  };
  const evaluate = vi.fn(async (callback: unknown, arg?: unknown) => {
    calls.push(`evaluate:${arg === undefined ? '' : String(arg)}`);
    return run(callback, arg);
  });
  const waitForFunction = vi.fn(async (predicate: unknown) => {
    calls.push('waitForFunction');
    if (!run(predicate)) {
      throw new Error('waitForFunction predicate was false');
    }
  });
  const waitForTimeout = vi.fn(async () => {
    calls.push('waitForTimeout');
  });
  return {
    page: { evaluate, waitForFunction, waitForTimeout } as unknown as Page,
    calls,
    evaluate,
    waitForFunction,
    waitForTimeout,
  };
}

/**
 * Manifest and README contract for the four minesweeper WebKit phone states.
 *
 * The fixed-container two-run procedure only stays useful if the committed
 * PNGs, the manifest and the documentation keep describing the same bytes and
 * capture command; the historical-evidence guard must no longer skip them.
 */
describe('minesweeper WebKit manifest and README contract', () => {
  it('records each committed PNG with its sha256 and fixed-container command', () => {
    for (const file of MINESWEEPER_WEBKIT) {
      const capture = MANIFEST.captures.find((entry) => entry.file === file);
      expect(capture, file).toBeDefined();
      expect(capture?.command).toBe(MINESWEEPER_COMMAND);
      expect(capture?.sha256).toBe(
        sha256(join(ROOT, 'docs', 'screenshots', file)),
      );
      expect(capture?.provenance.captureCommit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('lists the four files in the manifest table with the same sha256 and command', () => {
    const manifestSection = subsection(
      SCREENSHOTS_README,
      '### 已提交证据 sha256 清单与校验（Issue #199）',
    );
    for (const file of MINESWEEPER_WEBKIT) {
      const capture = MANIFEST.captures.find((entry) => entry.file === file);
      const row = manifestSection
        .split('\n')
        .find((line) => line.startsWith('|') && line.includes(`\`${file}\``));
      expect(row, `missing manifest row for ${file}`).toBeDefined();
      expect(row).toContain(`\`${capture?.sha256}\``);
      expect(row).toContain(`\`${MINESWEEPER_COMMAND}\``);
      expect(row).toContain(`\`${capture?.provenance.captureCommit}\``);
    }
    expect(manifestSection).toContain('清单覆盖（15 张');
  });

  it('advertises the container command for the four webkit-phone rows', () => {
    const phoneSection = subsection(
      SCREENSHOTS_README,
      '## webkit-phone：t1–t3 稳定场景的 WebKit 手机端截图（Issue #100 / t4）',
    );
    for (const file of MINESWEEPER_WEBKIT) {
      const row = phoneSection
        .split('\n')
        .find((line) => line.startsWith('|') && line.includes(`\`${file}\``));
      expect(row, `missing webkit-phone row for ${file}`).toContain(
        `\`${MINESWEEPER_COMMAND}\``,
      );
    }
    const rootRow = ROOT_README.split('\n').find((line) =>
      line.startsWith('| `npm run screenshots:minesweeper:webkit` |'),
    );
    expect(rootRow).toBeDefined();
    expect(rootRow).toContain(MINESWEEPER_COMMAND);
    expect(rootRow).toContain('capture-sha256-manifest.json');
    expect(rootRow).toContain('写前护栏');
  });

  it('removes the four files from the historical-evidence guard', () => {
    for (const file of MINESWEEPER_WEBKIT) {
      expect(findHistoricalAfterEvidence(file), file).toBeNull();
    }
  });

  it('keeps them out of the historical drift list and documents the seam', () => {
    const historical = subsection(
      SCREENSHOTS_README,
      '### WebKit 历史证据（Issue #137 / #120）',
    );
    const driftBullets = historical
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('  - ') &&
          line.includes('after-minesweeper-') &&
          line.includes('webkit'),
      )
      .join('\n');
    for (const file of MINESWEEPER_WEBKIT) {
      expect(driftBullets).not.toContain(file);
      expect(historical).toContain(file);
    }
    expect(historical).toContain('滚动往返');
    expect(historical).toContain('sticky 页眉');
    expect(historical).toContain('一次性预热页');
    expect(historical).toContain('连续 3 跑');
    expect(historical).toContain('含全新容器');
    expect(historical).toContain('整幅连续两帧');
  });
});
