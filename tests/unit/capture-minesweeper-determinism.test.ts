import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_SETTLE_FRAMES,
  CAPTURE_SETTLE_TIMEOUT_MS,
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

function count(pattern: RegExp): number {
  return [...SCRIPT.matchAll(pattern)].length;
}

function indexOfOrFail(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index, `missing: ${needle}`).toBeGreaterThan(-1);
  return index;
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
 * WebKit can rasterise the sticky site header in two subtly different ways on
 * the first paint. The ready capture repaints it with a scroll round-trip and
 * then waits for fonts and two animation frames; this test pins that seam to
 * the ready scene and keeps playing / lost / won on their existing path so a
 * refactor cannot silently restore the non-deterministic capture.
 */
describe('minesweeper WebKit READY determinism guard', () => {
  it('repaints the WebKit header only between ready open and ready capture', () => {
    expect(SCRIPT).toContain(
      "settleWebkitReadyPaint,\n  startPreviewServer,",
    );
    expect(count(/settleWebkitReadyPaint\(/g)).toBe(1);

    const readyOpen = indexOfOrFail(SCRIPT, 'await openTouchGame(ready, WIN_MINES)');
    const seam = indexOfOrFail(SCRIPT, 'await settleWebkitReadyPaint(ready)');
    const readyCapture = indexOfOrFail(
      SCRIPT,
      "await capture(ready, touchMobileName(prefix, 'ready'), false)",
    );
    expect(seam).toBeGreaterThan(readyOpen);
    expect(readyCapture).toBeGreaterThan(seam);
    expect(SCRIPT).toContain("if (IS_WEBKIT && prefix === 'after') {");
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
});

/** A Page double that records the seam's calls without running callbacks. */
function recordingPage(): {
  page: Page;
  calls: string[];
  evaluate: ReturnType<typeof vi.fn>;
  waitForFunction: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const evaluate = vi.fn(async (_callback: unknown, arg?: unknown) => {
    calls.push(`evaluate:${arg === undefined ? '' : String(arg)}`);
  });
  const waitForFunction = vi.fn(async () => {
    calls.push('waitForFunction');
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
    expect(manifestSection).toContain('清单覆盖（8 张');
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
    expect(historical).toContain('连续两跑 sha256 相同');
  });
});
