import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_CAPTURE_ATTEMPTS,
  captureManifestedScreenshot,
  captureStableBytes,
} from '../../scripts/lib/capture-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(
  join(ROOT, 'scripts', 'capture-2048-screenshots.mjs'),
  'utf8',
);

/**
 * The script with line and block comments removed. A commented-out seam call
 * must not satisfy the static guards below.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const CODE = stripComments(SOURCE);

function count(pattern: RegExp): number {
  return [...CODE.matchAll(pattern)].length;
}

/** The source of one top-level `async function name(...)` declaration. */
function functionCode(name: string): string {
  const marker = `async function ${name}(`;
  const start = CODE.indexOf(marker);
  expect(start, `missing: ${marker}`).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n}\n', start);
  expect(end, `unterminated: ${marker}`).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

/**
 * Assert each needle appears exactly once, in the given order, inside a
 * function body. Anchoring on the function body keeps a same-named call from
 * another scene (for example the Chromium desktop READY capture) from
 * satisfying the guard.
 */
function expectInOrder(fn: string, needles: readonly string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const occurrences = fn.split(needle).length - 1;
    expect(occurrences, `expected exactly one occurrence of: ${needle}`).toBe(1);
    const index = fn.indexOf(needle);
    expect(index, `missing in function: ${needle}`).toBeGreaterThan(cursor);
    cursor = index;
  }
}

/**
 * The ready contract after Issue #374: one throwaway READY page before any
 * evidence sample, then a fresh-page resample of the READY scene; every sampled
 * page re-runs the original scroll + overlay seams and keeps the two-frame
 * stable gate before its bytes are compared with the manifest. The ready scene
 * must not fall back to a single-page `{ stable: true }` capture and must not
 * grow a shared-header-only seam, which would resample the overlay into another
 * 1-LSB variant.
 */
function assertReadyPath(fn: string): void {
  expectInOrder(fn, [
    'const warmUp = await context.newPage();',
    'await open2048(warmUp, COLOR_BOARD);',
    'await warmUp.close();',
    "name: 'after-2048-ready-webkit.png'",
    'await open2048(ready, COLOR_BOARD)',
    'await settleWebkitReadyPaint(ready)',
    'await repaintWebkitReadyOverlay(ready)',
    'captureBytes: captureReadyBytes,',
  ]);
  // The ready state goes through the fresh-page resampler, not a single
  // `{ stable: true }` capture, and the sample body runs both seams in order.
  expect(fn).toMatch(
    /await warmUp\.close\(\);\s*\}\s*[\s\S]*?await sampleWebkitState\(context, \{\s*name: 'after-2048-ready-webkit\.png',\s*prepare: async \(ready\) => \{\s*await open2048\(ready, COLOR_BOARD\);\s*await settleWebkitReadyPaint\(ready\);\s*await repaintWebkitReadyOverlay\(ready\);\s*\},\s*captureBytes: captureReadyBytes,/,
  );
  // The warm-up is closed on the throwing path too; a missing finally would
  // leak the throwaway page into the browser's first-page raster path.
  expect(fn).toMatch(
    /const warmUp = await context\.newPage\(\);\s*try \{\s*await open2048\(warmUp, COLOR_BOARD\);\s*\}\s*finally \{\s*await warmUp\.close\(\);\s*\}/,
  );
  expect(fn).not.toContain(
    "await capture(ready, 'after-2048-ready-webkit.png', false, { stable: true })",
  );
  expect(fn).not.toContain('stable: true');
  expect(fn).not.toContain('settleSharedHeaderCompositing(ready)');
  expect(fn).not.toContain('settleBackdropLayersCompositing(ready)');
}

/**
 * Static guard for the committed playing / gameover / ready WebKit PNGs. The
 * engine test proves seed 135 is deterministic for the pinned boards; this test
 * proves the capture script actually passes that seed and keeps every such
 * scene on the same board and direction, so a dropped parameter cannot silently
 * restore random captures while the engine test stays green. It also pins the
 * WebKit READY paint seam to the ready scene only and the shared-backdrop seams
 * to the playing / gameover scenes (Issue #341).
 */
describe('2048 screenshot determinism guard', () => {
  it('pins the debug seed in the URL of every 2048 scene', () => {
    expect(SOURCE).toContain("const DEBUG_SEED = '135';");
    expect(SOURCE).toContain('seed=${DEBUG_SEED}');
    expect(SOURCE).toContain('page.goto(gameUrl(board)');
  });

  it('keeps all three playing scenes on the merge board with a left move', () => {
    expect(SOURCE).toContain(
      "const MERGE_BOARD = '2,2,4,4/8,8,16,16/.,.,.,./.,.,.,.'",
    );
    expect(count(/open2048\(playing, MERGE_BOARD\)/g)).toBe(3);
    expect(count(/getByTestId\('score'\)\.filter\(\{ hasText: '60' \}\)/g)).toBe(3);
  });

  it('keeps all three gameover scenes on the stuck board and its final score', () => {
    expect(SOURCE).toContain(
      "const STUCK_BOARD = '2,2,16,8/8,4,2,16/4,8,16,2/16,2,4,8'",
    );
    expect(count(/open2048\(over, STUCK_BOARD\)/g)).toBe(3);
    expect(count(/hasText: '本局 4 分 · 最大方块 16'/g)).toBe(3);
  });

  it('uses the same left move for every playing and gameover scene', () => {
    // Three Chromium/WebKit playing captures plus three gameover captures.
    expect(count(/keyboard\.press\('ArrowLeft'\)/g)).toBe(6);
  });

  it('keeps the ready scene on the warm-up + fresh-page resample path', () => {
    expect(SOURCE).toContain('settleCapturePaint,\n  settleWebkitReadyPaint,');
    expect(SOURCE).toContain('captureStableBytes,');
    expect(count(/settleWebkitReadyPaint\(/g)).toBe(1);
    expect(count(/repaintWebkitReadyOverlay\(/g)).toBe(1);
    // The two-frame gate moved into the READY resample helper; no 2048 scene
    // writes a single-page `{ stable: true }` capture anymore.
    expect(count(/stable: true/g)).toBe(0);
    expect(count(/captureStableBytes\(/g)).toBe(1);

    const gate = functionCode('captureReadyBytes');
    expect(gate).toContain(
      'return captureStableBytes(page, { fullPage: false });',
    );

    const webkit = functionCode('captureWebkitMobile');
    assertReadyPath(webkit);
    expect(count(/open2048\(warmUp, COLOR_BOARD\)/g)).toBe(1);
    expect(count(/await sampleWebkitState\(context, \{/g)).toBe(3);
  });

  it('fails the ready guard when a seam, the warm-up or the frame gate is removed', () => {
    const webkit = functionCode('captureWebkitMobile');
    for (const seam of [
      'await settleWebkitReadyPaint(ready);',
      'await repaintWebkitReadyOverlay(ready);',
    ]) {
      const commented = stripComments(webkit.replace(seam, `// ${seam}`));
      expect(() => assertReadyPath(commented)).toThrow();
    }
    const withoutWarmUp = stripComments(
      webkit.replace(
        /const warmUp = await context\.newPage\(\);[\s\S]*?await warmUp\.close\(\);\s*\}\s*/,
        '',
      ),
    );
    expect(() => assertReadyPath(withoutWarmUp)).toThrow();
    const withoutGate = stripComments(
      webkit.replace('captureBytes: captureReadyBytes,', ''),
    );
    expect(() => assertReadyPath(withoutGate)).toThrow();
    const rerouted = stripComments(
      webkit.replace(
        /await sampleWebkitState\(context, \{[\s\S]*?name: 'after-2048-ready-webkit\.png'[\s\S]*?captureBytes: captureReadyBytes,\s*\}\);/,
        "await capture(ready, 'after-2048-ready-webkit.png', false, { stable: true });",
      ),
    );
    expect(() => assertReadyPath(rerouted)).toThrow();
  });

  it('keeps every scene on the shared settle contract', () => {
    expect(SOURCE).toContain('await settleCapturePaint(page)');
    expect(SOURCE).toContain('settleCapturePaint,\n  settleWebkitReadyPaint,');
  });

  it('samples the ready / playing / gameover states from fresh pages until the manifest sha256', () => {
    expect(CODE).toContain('captureManifestedScreenshot,');
    expect(CODE).toContain(
      "const ALLOW_NEW_BYTES = ARGS.includes('--allow-new-bytes');",
    );
    // Three resampled states, one capture each, all through the same helper.
    expect(count(/await sampleWebkitState\(context, \{/g)).toBe(3);

    const helper = functionCode('sampleWebkitState');
    expect(helper).toContain('await captureManifestedScreenshot({');
    expect(helper).toContain('openPage: () => context.newPage()');
    expect(helper).toContain(
      'checkEnvironment: (page) => capture(page, name, false, { checkOnly: true })',
    );
    expect(helper).toMatch(
      /write: \(page, bytes\) =>\s*capture\(page, name, false, \{ capturedBytes: bytes \}\),/,
    );
    expect(helper).toContain('allowNewBytes: ALLOW_NEW_BYTES,');
    // The helper must rely on `captureManifestedScreenshot`'s manifest lookup
    // and MANIFEST_CAPTURE_ATTEMPTS default; pinning a single attempt or a null
    // expected sha here would silently disable the resample contract.
    expect(helper).not.toContain('attempts:');
    expect(helper).not.toContain('expectedSha256:');

    const webkit = functionCode('captureWebkitMobile');
    expectInOrder(webkit, [
      "name: 'after-2048-ready-webkit.png'",
      "name: 'after-2048-playing-webkit.png'",
      "name: 'after-2048-gameover-webkit.png'",
    ]);
  });

  it('settles the playing header and rebuilds the gameover backdrops', () => {
    expect(CODE).toContain('settleSharedHeaderCompositing,');
    expect(CODE).toContain('settleBackdropLayersCompositing,');
    // Playing has no overlay, so it rebuilds only the shared header. Gameover
    // rebuilds the header and its own translucent backdrop together; a
    // separate header-only call would resample the overlay into another
    // variant, so it must stay at exactly one backdrop-pair call.
    expect([...CODE.matchAll(/await settleSharedHeaderCompositing\(/g)]).toHaveLength(1);
    expect([...CODE.matchAll(/await settleBackdropLayersCompositing\(/g)]).toHaveLength(1);

    const webkit = functionCode('captureWebkitMobile');
    expectInOrder(webkit, [
      "name: 'after-2048-playing-webkit.png'",
      'await open2048(playing, MERGE_BOARD)',
      'await settle(playing)',
      'await settleSharedHeaderCompositing(playing)',
      "name: 'after-2048-gameover-webkit.png'",
      'await open2048(over, STUCK_BOARD)',
      'await settle(over)',
      'await settleBackdropLayersCompositing(over)',
    ]);
    // The gameover pair already rebuilds both layers; one extra header-only
    // seam before it would be a redundant, contract-confusing sample.
    expect(webkit).not.toContain('settleSharedHeaderCompositing(over)');
    expect(webkit).not.toContain('repaintWebkitReadyOverlay(over)');
    expect(webkit).not.toContain('repaintWebkitReadyOverlay(playing)');
  });
});

/**
 * Runtime contract for the READY resample the capture script now uses: the
 * settled two-frame bytes are hashed and compared with the manifest, a
 * byte-stable but drifted raster is discarded on a fresh page, and a run that
 * never reproduces the recorded sha256 fails before any write.
 */
describe('2048 ready manifest resampling', () => {
  const READY = 'after-2048-ready-webkit.png';
  const CANONICAL = Buffer.from('canonical 2048 READY bytes');
  const EXPECTED = createHash('sha256').update(CANONICAL).digest('hex');

  /** A page double whose screenshots are the supplied bytes. */
  function stablePage(bytes: Buffer): Page {
    return {
      screenshot: vi.fn(async () => bytes),
      close: vi.fn(async () => {}),
    } as unknown as Page;
  }

  /** The same settled two-frame gate `captureReadyBytes` applies. */
  function captureReadyFrames(page: Page): Promise<Buffer> {
    return captureStableBytes(page, { fullPage: false, settle: async () => {} });
  }

  it('discards byte-stable drifted samples and writes only the manifest bytes', async () => {
    const pages: Page[] = [];
    const write = vi.fn(async () => {});
    let sample = 0;

    await captureManifestedScreenshot({
      name: READY,
      engine: 'webkit',
      openPage: async () => {
        sample += 1;
        const bytes = sample < 3 ? Buffer.from(`drifted READY ${sample}`) : CANONICAL;
        const page = stablePage(bytes);
        pages.push(page);
        return page;
      },
      prepare: async () => {},
      captureBytes: captureReadyFrames,
      write,
      expectedSha256: EXPECTED,
      log: { warn: () => {} },
    });

    expect(pages).toHaveLength(3);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(pages[2], CANONICAL);
  });

  it('fails after the sample budget without writing when no sample matches', async () => {
    const pages: Page[] = [];
    const write = vi.fn(async () => {});

    await expect(
      captureManifestedScreenshot({
        name: READY,
        engine: 'webkit',
        openPage: async () => {
          const page = stablePage(Buffer.from('stable but drifted READY raster'));
          pages.push(page);
          return page;
        },
        prepare: async () => {},
        captureBytes: captureReadyFrames,
        write,
        expectedSha256: '0'.repeat(64),
        log: { warn: () => {} },
      }),
    ).rejects.toThrow(/Nothing was written/);

    expect(write).not.toHaveBeenCalled();
    expect(pages).toHaveLength(MANIFEST_CAPTURE_ATTEMPTS);
  });
});
