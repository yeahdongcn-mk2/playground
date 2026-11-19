import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { captureStableBytes } from '../../scripts/lib/capture-runtime.mjs';
import {
  SHARED_HEADER_SELECTOR,
  SHARED_HEADER_SETTLE_FRAMES,
  settleSharedHeaderCompositing,
} from '../../scripts/lib/webkit-compositing-settle.mjs';
import type { SharedHeaderRepaintOptions } from '../../scripts/lib/webkit-compositing-settle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-minesweeper-scores-screenshots.mjs'),
  'utf8',
);
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const MANIFEST = JSON.parse(
  readFileSync(
    join(ROOT, 'docs', 'screenshots', 'capture-sha256-manifest.json'),
    'utf8',
  ),
) as {
  captures: Array<{
    file: string;
    sha256: string;
    command: string;
    provenance: { captureCommit: string };
  }>;
};

const SCORES_WEBKIT = 'after-minesweeper-scores-webkit.png';
const SCORES_SHA256 =
  '012a7bf09d4f8d8c3b8a38ff34f362def21a2dc2c3a076f5be027d3cdc89fb12';
const SCORES_CAPTURE_COMMIT = '2cc6f87d3bcc5fba0e7db5b02df7e5a73dce1f40';
const DRIFTED_SHA256 =
  'b7f08eac34dbf325f00bbbb195f9726b49b03a207acd9e17e6bf3249eb21c89d';

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
 * Guard for the committed `after-minesweeper-scores-webkit.png`. Issue #341
 * recorded that the full-page leaderboard capture could drift one 8-bit step
 * in a band outside the shared header under concurrent host load. The fix
 * settles the shared header and then requires two consecutive byte-identical
 * full-page frames before writing; these tests pin the WebKit-only wiring and
 * the failure path so a dropped seam, a leaked `stable` option or a swallowed
 * error cannot silently restore the drifting single-shot capture.
 */
describe('minesweeper scores screenshot determinism guard (Issue #341)', () => {
  it('settles the shared header only on the WebKit scores capture path', () => {
    expect(SCRIPT).toContain(
      "import { settleSharedHeaderCompositing } from './lib/webkit-compositing-settle.mjs';",
    );
    expect(SCRIPT).toContain('const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;');

    const stripped = stripComments(SCRIPT);
    const webkit = functionBody(stripped, 'captureWebkitMobile');
    const openAt = webkit.indexOf('await openWin(page);');
    const seamAt = webkit.indexOf(
      'await settleSharedHeaderCompositing(page);',
    );
    const captureAt = webkit.indexOf(
      'await capture(page, `after-${FILE_PREFIX}-webkit.png`, { stable: true });',
    );
    expect(openAt).toBeGreaterThan(-1);
    // openWin ends in settle(); the seam must run after that and before the
    // screenshot, otherwise it would pin the header of an unsettled page.
    expect(seamAt).toBeGreaterThan(openAt);
    expect(captureAt).toBeGreaterThan(seamAt);

    // The seam lives in the function the WebKit branch alone calls.
    expect(stripped).toMatch(
      /if \(IS_WEBKIT\) \{\s*await captureWebkitMobile\(browser\);\s*\}/,
    );
    expect(
      [...stripped.matchAll(/await captureWebkitMobile\(browser\);/g)],
    ).toHaveLength(1);
    // One seam call and one stable capture in the whole script; the Chromium
    // desktop / mobile and the Before / clear paths never run them.
    expect([
      ...stripped.matchAll(/settleSharedHeaderCompositing\(page\)/g),
    ]).toHaveLength(1);
    expect([...stripped.matchAll(/stable: true/g)]).toHaveLength(1);
    for (const name of ['captureDesktop', 'captureMobile']) {
      const body = functionBody(stripped, name);
      expect(body).not.toContain('settleSharedHeaderCompositing');
      expect(body).not.toContain('stable');
    }
  });

  it('preheats WebKit with a throwaway page before the captured page', () => {
    const webkit = functionBody(stripComments(SCRIPT), 'captureWebkitMobile');
    const warmUpAt = webkit.indexOf('const warmUp = await context.newPage();');
    const warmOpenAt = webkit.indexOf('await openWin(warmUp);');
    const closeAt = webkit.indexOf('await warmUp.close();');
    const pageAt = webkit.indexOf('const page = await context.newPage();');
    expect(warmUpAt).toBeGreaterThan(-1);
    expect(warmOpenAt).toBeGreaterThan(warmUpAt);
    // The throwaway page must close before the captured page is created; a
    // leftover page would keep the first-page raster path alive.
    expect(closeAt).toBeGreaterThan(warmOpenAt);
    expect(pageAt).toBeGreaterThan(closeAt);
    // The throwaway page is closed even when its navigation fails, so one
    // failed warm-up cannot leave the context in a half-loaded state.
    expect(webkit).toMatch(
      /try \{\s*await seedScores\(warmUp\);\s*await openWin\(warmUp\);\s*\} finally \{\s*await warmUp\.close\(\);\s*\}/,
    );
    // Exactly one screenshot is written: the warm-up page never becomes
    // evidence.
    expect([...webkit.matchAll(/await capture\(/g)]).toHaveLength(1);
  });

  it('forwards stable capture options while keeping the default single shot', () => {
    const stripped = stripComments(SCRIPT);
    expect(stripped).toContain(
      'async function capture(page, name, options = {}) {',
    );
    const helper = functionBody(stripped, 'capture');
    // A dropped options spread would silently ignore `stable: true` and write
    // the first in-flight frame.
    expect(helper).toContain('engine: ENGINE');
    expect(helper).toContain('fullPage: true');
    expect(helper).toContain('...options');

    // The Before / clear-records / Chromium behavior must keep its single-shot
    // path and its existing navigation guards.
    expect(SCRIPT).toContain('const BEFORE = ARGS.includes(\'--before\');');
    expect(SCRIPT).toContain('const CLEAR = ARGS.includes(\'--clear\');');
    expect(SCRIPT).toContain(
      "throw new Error('The --webkit mode captures After screenshots only.');",
    );
    expect(functionBody(stripped, 'captureDesktop')).toContain(
      "await capture(\n    page,",
    );
    expect(functionBody(stripped, 'captureMobile')).toContain(
      "await capture(\n    page,",
    );
    // captureDesktop / captureMobile call the helper with only page and name;
    // the third argument (options) belongs to the WebKit capture alone.
    expect(functionBody(stripped, 'captureDesktop')).not.toMatch(/,\s*\{\s*stable/);
    expect(functionBody(stripped, 'captureMobile')).not.toMatch(/,\s*\{\s*stable/);
  });

  it('fails when the shared header is missing instead of skipping the seam', async () => {
    const calls: SharedHeaderRepaintOptions[] = [];
    const missingHeader = {
      evaluate: async (
        _pageFunction: unknown,
        options: SharedHeaderRepaintOptions,
      ) => {
        calls.push(options);
        return false;
      },
    };
    await expect(
      settleSharedHeaderCompositing(missingHeader as unknown as Page),
    ).rejects.toThrow(
      `Shared header "${SHARED_HEADER_SELECTOR}" was not found`,
    );
    expect(calls).toEqual([
      { selector: SHARED_HEADER_SELECTOR, frames: SHARED_HEADER_SETTLE_FRAMES },
    ]);

    // captureWebkitMobile must not swallow the missing-header error: the
    // failure has to abort the capture instead of writing an unsettled PNG.
    const webkit = functionBody(stripComments(SCRIPT), 'captureWebkitMobile');
    expect(webkit).toContain('await settleSharedHeaderCompositing(page);');
    expect(webkit).not.toContain('.catch');
    // The seam call flows straight into the capture with no try/catch between
    // them, so a rejected repaint aborts the write instead of being ignored.
    expect(webkit).toMatch(
      /await settleSharedHeaderCompositing\(page\);\s*await capture\(/,
    );
  });

  it('writes only after two consecutive byte-identical full-page frames', async () => {
    const frames = [
      Buffer.from('first'),
      Buffer.from('second'),
      Buffer.from('second'),
    ];
    const screenshots: Array<{ fullPage?: boolean }> = [];
    const settlingPage = {
      screenshot: async (options: { fullPage?: boolean }) => {
        screenshots.push(options);
        return frames.shift();
      },
    };
    const stable = await captureStableBytes(settlingPage as unknown as Page, {
      fullPage: true,
      attempts: 3,
      settle: async () => {},
    });
    expect(stable.toString()).toBe('second');
    expect(screenshots).toHaveLength(3);
    expect(screenshots.every((options) => options.fullPage === true)).toBe(true);

    // A page that never repeats two consecutive frames must throw instead of
    // writing a transient raster.
    let frame = 0;
    const unstablePage = {
      screenshot: async () => {
        frame += 1;
        return Buffer.from(`frame-${frame}`);
      },
    };
    await expect(
      captureStableBytes(unstablePage as unknown as Page, {
        fullPage: true,
        attempts: 2,
        settle: async () => {},
      }),
    ).rejects.toThrow('did not stabilise');
  });

  it('records the load-dependent repro and the four-run container result', () => {
    // The documented repro and the fixed-container acceptance run.
    expect(SCREENSHOTS_README).toContain('Issue #341 t3');
    expect(SCREENSHOTS_README).toContain(DRIFTED_SHA256);
    expect(SCREENSHOTS_README).toContain('3416');
    expect(SCREENSHOTS_README).toContain('rows 2853–2944');
    expect(SCREENSHOTS_README).toContain('4 跑');
    expect(SCREENSHOTS_README).toContain(SCORES_SHA256);
    expect(SCREENSHOTS_README).toContain(
      'npm run screenshots:container -- screenshots:minesweeper:scores:webkit',
    );

    const capture = MANIFEST.captures.find(
      (entry) => entry.file === SCORES_WEBKIT,
    );
    expect(capture).toBeDefined();
    expect(capture?.sha256).toBe(SCORES_SHA256);
    expect(capture?.command).toBe(
      'npm run screenshots:container -- screenshots:minesweeper:scores:webkit',
    );
    // The seam does not change the settled rendering, so the committed bytes,
    // manifest entry and capture provenance stay put.
    expect(capture?.provenance.captureCommit).toBe(SCORES_CAPTURE_COMMIT);
  });
});
