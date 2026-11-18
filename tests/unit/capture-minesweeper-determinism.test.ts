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

function indexOfOrFail(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index, `missing: ${needle}`).toBeGreaterThan(-1);
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
 * writing. This test pins that seam to the ready scene and keeps playing /
 * lost / won on their existing path so a refactor cannot silently restore the
 * non-deterministic capture.
 */
describe('minesweeper WebKit READY determinism guard', () => {
  it('warms the first-page paint path before the committed ready page', () => {
    const warmUpOpen = indexOfOrFail(
      SCRIPT,
      'const warmUp = await context.newPage()',
    );
    const warmUpLoad = indexOfOrFail(SCRIPT, 'await openTouchGame(warmUp, WIN_MINES)');
    const warmUpClose = indexOfOrFail(SCRIPT, 'await warmUp.close()');
    const readyOpen = SCRIPT.indexOf('const ready = await context.newPage()', warmUpClose);
    expect(readyOpen, 'missing: the ready page after the warm-up page').toBeGreaterThan(-1);

    expect(warmUpLoad).toBeGreaterThan(warmUpOpen);
    expect(warmUpClose).toBeGreaterThan(warmUpLoad);
    expect(readyOpen).toBeGreaterThan(warmUpClose);

    // The throwaway page must be closed even when opening the game throws:
    // dropping the try/finally would leak the page (and can shift the committed
    // ready page onto a different paint path). This structural assertion fails
    // if `finally` is removed or the close is moved outside the block.
    expect(SCRIPT).toMatch(
      /const warmUp = await context\.newPage\(\);\s*try \{\s*await openTouchGame\(warmUp, WIN_MINES\);\s*\} finally \{\s*await warmUp\.close\(\);\s*\}/,
    );
  });

  it('requires two identical whole-image frames for the ready capture', () => {
    const optionsStart = indexOfOrFail(
      SCRIPT,
      'const readyCaptureOptions =',
    );
    const readyCapture = indexOfOrFail(
      SCRIPT,
      "await capture(ready, touchMobileName(prefix, 'ready'), false, readyCaptureOptions)",
    );
    const readyOptions = SCRIPT.slice(optionsStart, readyCapture);
    expect(readyOptions).toContain(
      "IS_WEBKIT && prefix === 'after'",
    );
    expect(readyOptions).toContain('stableFrames: READY_CAPTURE_STABLE_FRAMES,');
    expect(readyOptions).toContain(
      'stableIntervalMs: READY_CAPTURE_STABLE_INTERVAL_MS,',
    );
    expect(readyOptions).toContain(
      'stableAttempts: READY_CAPTURE_STABLE_ATTEMPTS,',
    );
    expect(readyOptions).toContain(': {};');
    expect(READY_CAPTURE_STABLE_FRAMES).toBe(2);
    expect(READY_CAPTURE_STABLE_INTERVAL_MS).toBe(250);
    expect(READY_CAPTURE_STABLE_ATTEMPTS).toBe(5);
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

  it('forwards the ready options through capture() to captureScreenshot()', () => {
    // `capture()` is the only bridge from the ready scene's stability options
    // to `captureScreenshot`. Dropping its `options` parameter or the
    // `...options` spread silently disables the two-frame check while every
    // capture run still succeeds, so pin both ends of that wiring.
    expect(SCRIPT).toMatch(
      /async function capture\(\s*page,\s*name,\s*fullPage,\s*options = \{\}\s*\)\s*\{/,
    );
    expect(SCRIPT).toMatch(
      /await captureScreenshot\(\s*page,\s*name,\s*\{\s*\.\.\.options,\s*engine: ENGINE,\s*fullPage\s*\}\s*\);/,
    );
  });

  it('repaints the WebKit header only between ready open and ready capture', () => {
    expect(SCRIPT).toContain(
      "settleWebkitReadyPaint,\n  startPreviewServer,",
    );
    expect(count(/settleWebkitReadyPaint\(/g)).toBe(1);

    const readyOpen = indexOfOrFail(SCRIPT, 'await openTouchGame(ready, WIN_MINES)');
    const seam = indexOfOrFail(SCRIPT, 'await settleWebkitReadyPaint(ready)');
    const readyCapture = indexOfOrFail(
      SCRIPT,
      "await capture(ready, touchMobileName(prefix, 'ready'), false, readyCaptureOptions)",
    );
    expect(seam).toBeGreaterThan(readyOpen);
    expect(readyCapture).toBeGreaterThan(seam);

    // Walk the script's actual WebKit-after guard blocks: the seam must be
    // inside one of them, not merely after the warm-up guard. Matching each
    // guard to its closing brace is what makes deleting the seam's own guard
    // falsifiable.
    const warmUpOpen = indexOfOrFail(
      SCRIPT,
      'const warmUp = await context.newPage()',
    );
    const warmUpGuard = enclosingAfterGuard(
      SCRIPT,
      warmUpOpen,
      'the warm-up page',
    );
    const seamGuard = enclosingAfterGuard(SCRIPT, seam, 'the ready seam');
    expect(warmUpGuard).not.toBe(seamGuard);

    const warmUpGuardEnd = closingBrace(
      SCRIPT,
      warmUpGuard + AFTER_GUARD_OPEN_BRACE_OFFSET,
    );
    const seamGuardEnd = closingBrace(
      SCRIPT,
      seamGuard + AFTER_GUARD_OPEN_BRACE_OFFSET,
    );
    const readyPageOpen = SCRIPT.indexOf(
      'const ready = await context.newPage()',
      warmUpGuardEnd,
    );
    expect(
      readyPageOpen,
      'missing: the committed ready page after the warm-up guard',
    ).toBeGreaterThan(-1);

    expect(warmUpOpen).toBeGreaterThan(warmUpGuard);
    expect(warmUpOpen).toBeLessThan(warmUpGuardEnd);
    expect(readyPageOpen).toBeGreaterThan(warmUpGuardEnd);
    expect(seam).toBeGreaterThan(seamGuard);
    expect(seam).toBeLessThan(seamGuardEnd);
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
    }
    expect(manifestSection).toContain('清单覆盖（14 张');
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
    expect(historical).toContain('连续 3 跑（含全新容器首跑）');
    expect(historical).toContain('整幅连续两帧');
  });
});
