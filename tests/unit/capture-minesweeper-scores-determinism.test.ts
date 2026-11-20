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
 * in a band outside the shared header under concurrent host load; the review of
 * PR #363 then observed that the warm-up page and the stable-frame gate alone
 * still let a 1-LSB board-band / primary-button variant through, because that
 * wrong raster persists across frames. The fix runs a scroll round-trip
 * (`settleWebkitReadyPaint`), repaints the win overlay's blurred backdrop
 * (hide / restore), settles the shared header, captures two consecutive
 * byte-identical full-page frames and resamples a fresh page until those bytes
 * equal the manifest entry. Issue #376 t0 replaced the hand-written attempt
 * loop with the shared `captureManifestedScreenshot` helper. These tests pin
 * the helper wiring, the WebKit-only seams and the per-sample context /
 * warm-up / preflight / write contract so a dropped option, a leaked screenshot
 * option, a swallowed error or a write-before-match cannot silently restore the
 * drifting capture. Budget exhaustion, unstable samples and the first-sample
 * environment preflight are pinned by
 * `tests/unit/capture-manifest-resample.test.ts`.
 */
describe('minesweeper scores screenshot determinism guard (Issue #341 / #376)', () => {
  it('delegates the WebKit resample to captureManifestedScreenshot', () => {
    const stripped = stripComments(SCRIPT);
    const webkit = functionBody(stripped, 'captureWebkitMobile');

    expect(SCRIPT).toContain('captureManifestedScreenshot,');
    expect(SCRIPT).toContain('MANIFEST_CAPTURE_ATTEMPTS,');
    expect(webkit).toContain('await captureManifestedScreenshot({');
    expect(webkit).toContain('name,');
    expect(webkit).toContain('engine: ENGINE,');
    expect(webkit).toContain(
      'openPage: () => openWebkitScoresSample(browser),',
    );
    expect(webkit).toContain('closePage: (page) => page.context().close(),');
    expect(webkit).toContain(
      'checkEnvironment: (page) => capture(page, name, { checkOnly: true }),',
    );
    expect(webkit).toContain('prepare: prepareWebkitScoresPage,');
    expect(webkit).toContain(
      'captureBytes: (page) => captureStableBytes(page, { fullPage: true }),',
    );
    expect(webkit).toContain(
      'write: (page, bytes) => capture(page, name, { capturedBytes: bytes }),',
    );
    expect(webkit).toContain('attempts: MANIFEST_CAPTURE_ATTEMPTS,');
    expect(webkit).toContain('allowNewBytes: ALLOW_NEW_BYTES,');
    // The CLI flag itself stays wired; forwarding a hard-coded false would pass
    // the option pin above but silently disable the intentional-change exit.
    expect(SCRIPT).toContain(
      "const ALLOW_NEW_BYTES = ARGS.includes('--allow-new-bytes');",
    );

    // Exactly one resampler call, and no second hand-written implementation:
    // no attempt loop, hash comparison or direct manifest lookup in the script.
    expect([...stripped.matchAll(/captureManifestedScreenshot\(/g)]).toHaveLength(
      1,
    );
    expect(webkit).not.toMatch(/for \(let attempt/);
    expect(stripped).not.toContain('WEBKIT_CAPTURE_ATTEMPTS');
    // The acceptance criterion is that the scores script contains no second
    // hash comparison or direct manifest lookup, wherever they might be added.
    expect(stripped).not.toContain('createHash');
    expect(stripped).not.toContain('expectedCaptureSha256');
    expect(webkit).not.toContain('page.screenshot');
  });

  it('opens a fresh phone context with a throwaway warm-up page per sample', () => {
    const stripped = stripComments(SCRIPT);
    const open = functionBody(stripped, 'openWebkitScoresSample');
    const contextAt = open.indexOf(
      'const context = await createPhoneContext(browser, ENGINE, {',
    );
    const warmUpAt = open.indexOf('const warmUp = await context.newPage();');
    const warmOpenAt = open.indexOf('await openWin(warmUp);');
    const closeAt = open.indexOf('await warmUp.close();');
    const pageAt = open.indexOf('return await context.newPage();');
    expect(contextAt).toBeGreaterThan(-1);
    expect(warmUpAt).toBeGreaterThan(contextAt);
    expect(warmOpenAt).toBeGreaterThan(warmUpAt);
    // The throwaway page must close before the sampled page is created; a
    // leftover page would keep the first-page raster path alive.
    expect(closeAt).toBeGreaterThan(warmOpenAt);
    expect(pageAt).toBeGreaterThan(closeAt);
    // A new context per attempt resets the per-context compositor state, so the
    // context is created inside the openPage callback, not hoisted above it.
    expect([
      ...stripped.matchAll(/await createPhoneContext\(browser, ENGINE, \{/g),
    ]).toHaveLength(1);
    // One definition and one helper-call site: the context is opened per
    // sample, never once for the whole run.
    expect([
      ...stripped.matchAll(/openWebkitScoresSample\(browser\)/g),
    ]).toHaveLength(2);
    // The throwaway page is closed even when its navigation fails.
    expect(open).toMatch(
      /try \{\s*await seedScores\(warmUp\);\s*await openWin\(warmUp\);\s*\} finally \{\s*await warmUp\.close\(\);\s*\}/,
    );
    // A failure before the page is handed to the helper must close the fresh
    // context instead of leaking it.
    expect(open).toMatch(
      /catch \(error\) \{[\s\S]*?await context\.close\(\);[\s\S]*?throw error;/,
    );
  });

  it('runs the seams in the settled order inside prepare', () => {
    const stripped = stripComments(SCRIPT);
    const prepare = functionBody(stripped, 'prepareWebkitScoresPage');
    const seedAt = prepare.indexOf('await seedScores(page);');
    const openAt = prepare.indexOf('await openWin(page);');
    const scrollAt = prepare.indexOf('await settleWebkitReadyPaint(page);');
    const overlayAt = prepare.indexOf(
      'await repaintWebkitReadyOverlay(page);',
    );
    const headerAt = prepare.indexOf(
      'await settleSharedHeaderCompositing(page);',
    );
    expect(seedAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(seedAt);
    // openWin ends in settle(); the seams must run after that and before the
    // screenshot, otherwise they would pin the raster of an unsettled page.
    expect(scrollAt).toBeGreaterThan(openAt);
    expect(overlayAt).toBeGreaterThan(scrollAt);
    // The overlay repaint runs before the header seam: the header seam must be
    // the last compositing change, otherwise it is discarded by the overlay
    // repaint.
    expect(headerAt).toBeGreaterThan(overlayAt);
    expect(prepare).toMatch(
      /await settleSharedHeaderCompositing\(page\);\s*\}$/,
    );
    // A rejected seam must abort the capture instead of writing the PNG.
    expect(prepare).not.toContain('.catch');

    // The seams live in the callback the WebKit branch alone hands to the
    // helper; one call of each in the whole script.
    expect(stripped).toMatch(
      /if \(IS_WEBKIT\) \{\s*await captureWebkitMobile\(browser\);\s*\}/,
    );
    expect(
      [...stripped.matchAll(/await captureWebkitMobile\(browser\);/g)],
    ).toHaveLength(1);
    expect(
      [...stripped.matchAll(/settleWebkitReadyPaint\(page\)/g)],
    ).toHaveLength(1);
    expect(
      [...stripped.matchAll(/settleSharedHeaderCompositing\(page\)/g)],
    ).toHaveLength(1);
    expect(
      [...stripped.matchAll(/repaintWebkitReadyOverlay\(page\)/g)],
    ).toHaveLength(1);
    expect([...stripped.matchAll(/stable: true/g)]).toHaveLength(0);
    for (const name of ['captureDesktop', 'captureMobile']) {
      const body = functionBody(stripped, name);
      expect(body).not.toContain('settleWebkitReadyPaint');
      expect(body).not.toContain('settleSharedHeaderCompositing');
      expect(body).not.toContain('repaintWebkitReadyOverlay');
      expect(body).not.toContain('captureStableBytes');
      expect(body).not.toContain('checkOnly');
    }
    // The seams and the helper are imported from the shared capture runtime.
    expect(SCRIPT).toMatch(
      /repaintWebkitReadyOverlay,\n\s+settleWebkitReadyPaint,/,
    );
  });

  it('forwards captured bytes while keeping the default single shot', () => {
    const stripped = stripComments(SCRIPT);
    expect(stripped).toContain(
      'async function capture(page, name, options = {}) {',
    );
    const helper = functionBody(stripped, 'capture');
    // A dropped options spread would silently ignore the validated bytes and
    // take a third screenshot that may be a different raster.
    expect(helper).toContain('engine: ENGINE');
    expect(helper).toContain('fullPage: true');
    expect(helper).toContain('...options');

    // The Before / clear-records / Chromium behavior must keep its single-shot
    // path and its existing navigation guards.
    expect(SCRIPT).toContain("const BEFORE = ARGS.includes('--before');");
    expect(SCRIPT).toContain("const CLEAR = ARGS.includes('--clear');");
    expect(SCRIPT).toContain(
      "throw new Error('The --webkit mode captures After screenshots only.');",
    );
    expect(functionBody(stripped, 'captureDesktop')).toContain(
      'await capture(\n    page,',
    );
    expect(functionBody(stripped, 'captureMobile')).toContain(
      'await capture(\n    page,',
    );
    // captureDesktop / captureMobile call the helper with only page and name;
    // the third argument (options) belongs to the WebKit capture alone.
    expect(functionBody(stripped, 'captureDesktop')).not.toMatch(
      /,\s*\{\s*(?:stable|capturedBytes)/,
    );
    expect(functionBody(stripped, 'captureMobile')).not.toMatch(
      /,\s*\{\s*(?:stable|capturedBytes)/,
    );
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

    // The prepare callback must not swallow the missing-header error: the
    // failure has to abort the sample instead of returning matched-looking
    // bytes from an unsettled page.
    const prepare = functionBody(
      stripComments(SCRIPT),
      'prepareWebkitScoresPage',
    );
    expect(prepare).toContain('await settleSharedHeaderCompositing(page);');
    expect(prepare).not.toContain('.catch');
    // The header seam is the last preparation step; captureBytes runs only
    // after prepare resolves (the helper contract pinned by the resampler tests).
    expect(prepare).toMatch(
      /await settleSharedHeaderCompositing\(page\);\s*\}$/,
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

  it('records the load-dependent repro and the resampling acceptance run', () => {
    // The documented repro and the fixed-container acceptance run.
    expect(SCREENSHOTS_README).toContain('Issue #341 t3');
    expect(SCREENSHOTS_README).toContain(DRIFTED_SHA256);
    expect(SCREENSHOTS_README).toContain('3416');
    expect(SCREENSHOTS_README).toContain('rows 2853–2944');
    expect(SCREENSHOTS_README).toContain('4 跑分别用了 1 / 2 / 1 / 2 次采样');
    expect(SCREENSHOTS_README).toContain(
      '宿主 12×`yes` 并发负载（load average 1.84 → 16.84）',
    );
    // The review-fix head was accepted again under load; run 1 had to walk
    // through every known 1-LSB variant before reproducing the manifest bytes.
    expect(SCREENSHOTS_README).toContain(
      '评审收尾后再次按同一命令复跑 4 跑',
    );
    expect(SCREENSHOTS_README).toContain('9 / 1 / 5 / 1 次采样');
    expect(SCREENSHOTS_README).toContain(SCORES_SHA256);
    // The rework's review evidence and mechanism.
    expect(SCREENSHOTS_README).toContain(
      'a8187dcf4fb7d6772e6fbbac3cd6ba7975ea93f854e34f332fb76223f5494fd2',
    );
    expect(SCREENSHOTS_README).toContain('20 次');
    expect(SCREENSHOTS_README).toContain(
      '6 跑分别用了 1 / 2 / 1 / 3 / 2 / 2 次采样',
    );
    expect(SCREENSHOTS_README).toContain('capturedBytes');
    expect(SCREENSHOTS_README).toContain('captureManifestedScreenshot');
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
    // The #363 header seam did change the bytes (44768a97… -> 012a7bf0…) and
    // updated the provenance then. This rework reproduces the already-recorded
    // 012a7bf0… bytes, so the manifest sha256 and provenance stay 012a7bf0… /
    // 2cc6f87…: resampling is not a licence to rewrite the evidence.
    expect(capture?.provenance.captureCommit).toBe(SCORES_CAPTURE_COMMIT);
  });
});
