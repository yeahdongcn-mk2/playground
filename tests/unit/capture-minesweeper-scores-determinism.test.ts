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
 * equal the manifest entry. These tests pin the WebKit-only wiring
 * and the failure paths so a dropped seam, a leaked screenshot option, a
 * swallowed error or a write-before-match cannot silently restore the drifting
 * capture.
 */
describe('minesweeper scores screenshot determinism guard (Issue #341)', () => {
  it('settles the header and repaints the win overlay only on the WebKit scores path', () => {
    expect(SCRIPT).toContain(
      "import { settleSharedHeaderCompositing } from './lib/webkit-compositing-settle.mjs';",
    );
    expect(SCRIPT).toContain('const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;');

    const stripped = stripComments(SCRIPT);
    const webkit = functionBody(stripped, 'captureWebkitMobile');
    const openAt = webkit.indexOf('await openWin(page);');
    const scrollAt = webkit.indexOf('await settleWebkitReadyPaint(page);');
    const overlayAt = webkit.indexOf(
      'await repaintWebkitReadyOverlay(page);',
    );
    const headerAt = webkit.indexOf(
      'await settleSharedHeaderCompositing(page);',
    );
    const bytesAt = webkit.indexOf(
      'bytes = await captureStableBytes(page, { fullPage: true });',
    );
    const captureAt = webkit.indexOf(
      'await capture(page, name, { capturedBytes: bytes });',
    );
    expect(openAt).toBeGreaterThan(-1);
    // openWin ends in settle(); the seams must run after that and before the
    // screenshot, otherwise they would pin the raster of an unsettled page.
    expect(scrollAt).toBeGreaterThan(openAt);
    expect(overlayAt).toBeGreaterThan(scrollAt);
    // The overlay repaint runs before the header seam: the header seam must be
    // the last compositing change, otherwise it is discarded by the overlay
    // repaint.
    expect(headerAt).toBeGreaterThan(overlayAt);
    expect(bytesAt).toBeGreaterThan(headerAt);
    expect(captureAt).toBeGreaterThan(bytesAt);

    // The seams live in the function the WebKit branch alone calls.
    expect(stripped).toMatch(
      /if \(IS_WEBKIT\) \{\s*await captureWebkitMobile\(browser\);\s*\}/,
    );
    expect(
      [...stripped.matchAll(/await captureWebkitMobile\(browser\);/g)],
    ).toHaveLength(1);
    // One call of each seam and one stable capture in the whole script; the
    // Chromium desktop / mobile and the Before / clear paths never run them.
    expect([
      ...stripped.matchAll(/settleWebkitReadyPaint\(page\)/g),
    ]).toHaveLength(1);
    expect([
      ...stripped.matchAll(/settleSharedHeaderCompositing\(page\)/g),
    ]).toHaveLength(1);
    expect([
      ...stripped.matchAll(/repaintWebkitReadyOverlay\(page\)/g),
    ]).toHaveLength(1);
    expect([...stripped.matchAll(/stable: true/g)]).toHaveLength(0);
    expect([
      ...stripped.matchAll(/captureStableBytes\(page, \{ fullPage: true \}\)/g),
    ]).toHaveLength(1);
    for (const name of ['captureDesktop', 'captureMobile']) {
      const body = functionBody(stripped, name);
      expect(body).not.toContain('settleWebkitReadyPaint');
      expect(body).not.toContain('settleSharedHeaderCompositing');
      expect(body).not.toContain('repaintWebkitReadyOverlay');
      expect(body).not.toContain('captureStableBytes');
    }
  });

  it('rebuilds the win overlay backdrop instead of trusting the stable frame', () => {
    // The committed regression (Issue #341 rework): under host load the win
    // overlay's blurred backdrop kept a 1-LSB board-band / card raster. That
    // wrong raster persisted across consecutive frames, so the stable-frame
    // gate alone could not catch it; hiding and restoring the overlay is what
    // forces WebKit to re-snapshot the settled board.
    const webkit = functionBody(stripComments(SCRIPT), 'captureWebkitMobile');
    const scrollAt = webkit.indexOf('await settleWebkitReadyPaint(page);');
    const overlayAt = webkit.indexOf(
      'await repaintWebkitReadyOverlay(page);',
    );
    const bytesAt = webkit.indexOf(
      'bytes = await captureStableBytes(page, { fullPage: true });',
    );
    expect(scrollAt).toBeGreaterThan(-1);
    expect(overlayAt).toBeGreaterThan(scrollAt);
    expect(bytesAt).toBeGreaterThan(overlayAt);
    // A rejected seam must abort the capture instead of writing the PNG.
    expect(webkit).not.toContain('.catch');
    expect(webkit).toMatch(
      /await repaintWebkitReadyOverlay\(page\);\s*(?:\/\/[^\n]*\n\s*)*await settleSharedHeaderCompositing\(page\);\s*let bytes;\s*try \{\s*bytes = await captureStableBytes\(/,
    );
    // The seams are imported from the shared capture runtime, together with the
    // helpers that already implement the scroll round-trip and the hide /
    // restore two-frame sequence.
    expect(SCRIPT).toMatch(
      /repaintWebkitReadyOverlay,\n\s+settleWebkitReadyPaint,/,
    );
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
    // Two capture calls: the first-sample environment check and the final
    // write. The warm-up page never becomes evidence.
    expect([...webkit.matchAll(/await capture\(/g)]).toHaveLength(2);
    expect(webkit).toContain('checkOnly: true');
    expect(webkit).toContain('capturedBytes: bytes');
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

    // captureWebkitMobile must not swallow the missing-header error: the
    // failure has to abort the capture instead of writing an unsettled PNG.
    const webkit = functionBody(stripComments(SCRIPT), 'captureWebkitMobile');
    expect(webkit).toContain('await settleSharedHeaderCompositing(page);');
    expect(webkit).not.toContain('.catch');
    // The header seam flows straight into the screenshot with no try/catch
    // between them, so a rejected repaint aborts the write instead of being
    // ignored.
    expect(webkit).toMatch(
      /await settleSharedHeaderCompositing\(page\);\s*let bytes;\s*try \{\s*bytes = await captureStableBytes\(/,
    );
  });

  it('resamples a fresh page until it reproduces the recorded bytes', () => {
    // Issue #341 rework: the seams reduce but cannot prove the canonical raster
    // path. Under load a fresh page can still land on a byte-stable 1-LSB
    // variant, so the capture compares the sampled bytes to the manifest entry
    // and retries with a fresh context. It never writes a mismatch: the write
    // path only sees the bytes that matched.
    const stripped = stripComments(SCRIPT);
    const webkit = functionBody(stripped, 'captureWebkitMobile');
    expect(webkit).toContain(
      'const expectedSha256 = ALLOW_NEW_BYTES ? null : expectedCaptureSha256(name);',
    );
    expect(webkit).toContain(
      'const attempts = expectedSha256 === null ? 1 : WEBKIT_CAPTURE_ATTEMPTS;',
    );
    expect(webkit).toMatch(
      /for \(let attempt = 1; attempt <= attempts; attempt \+= 1\)/,
    );
    // A fresh context per attempt resets the per-page raster state; the warm-up
    // page and seams run inside the attempt loop, so createPhoneContext must be
    // inside the loop, not hoisted above it.
    const loopAt = webkit.indexOf(
      'for (let attempt = 1; attempt <= attempts; attempt += 1)',
    );
    const contextAt = webkit.indexOf(
      'const context = await createPhoneContext(browser, ENGINE, {',
    );
    expect(loopAt).toBeGreaterThan(-1);
    expect(contextAt).toBeGreaterThan(loopAt);
    expect([
      ...webkit.matchAll(/await createPhoneContext\(browser, ENGINE, \{/g),
    ]).toHaveLength(1);
    expect(webkit).toMatch(
      /\} finally \{\s*try \{\s*await context\.close\(\);\s*\} catch \(error\) \{/,
    );
    // The first sample checks the manifested environment before it spends the
    // resample budget on bytes that a host / wrong-image run can never match.
    expect(webkit).toMatch(
      /if \(attempt === 1\) \{[\s\S]*?await capture\(page, name, \{ checkOnly: true \}\);/,
    );
    // A page that cannot even reach two identical frames consumes a sample
    // instead of aborting the run; the last attempt rethrows the real error.
    expect(webkit).toMatch(
      /catch \(error\) \{[\s\S]*?if \(attempt === attempts\) throw error;[\s\S]*?continue;/,
    );
    // A trimmed checkout has no recorded sha to compare; it is logged rather
    // than silently downgraded.
    expect(webkit).toMatch(/console\.warn\(\s*`No manifest sha256 is recorded/);
    expect(webkit).toContain(
      "const actualSha256 = createHash('sha256').update(bytes).digest('hex');",
    );
    expect(webkit).toMatch(
      /if \(expectedSha256 === null \|\| actualSha256 === expectedSha256\) \{\s*await capture\(page, name, \{ capturedBytes: bytes \}\);\s*return;/,
    );
    expect(webkit).toContain('observed.push(actualSha256);');
    // A sample that never reached two identical frames is still reported as an
    // observed variant when the budget is exhausted.
    expect(webkit).toContain("observed.push('unstable');");
    expect(webkit).toContain('console.warn(');
    // Exhausting the budget fails before writing, with the observed variants.
    expect(webkit).toMatch(
      /throw new Error\(\s*`The WebKit scores capture did not reproduce[\s\S]*Nothing was written/,
    );
    // An intentional leaderboard UI change is an explicit escape hatch, not an
    // implicit fallback.
    expect(SCRIPT).toContain(
      "const ALLOW_NEW_BYTES = ARGS.includes('--allow-new-bytes');",
    );
    expect(SCRIPT).toMatch(
      /expectedCaptureSha256,[\s\S]{0,80}launchCaptureBrowser,/,
    );
    expect(stripped).toContain('const WEBKIT_CAPTURE_ATTEMPTS = 20;');
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
