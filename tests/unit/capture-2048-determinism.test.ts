import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
 * The unchanged ready contract: the original scroll + overlay seams, then the
 * two-frame stable capture. The ready state must not enter the fresh-page
 * resampler or the shared-backdrop rebuild (Issue #341 t3 leaves it on the
 * pre-existing path; its remaining ready-scene drift belongs to Issue #374).
 */
function assertReadyPath(fn: string): void {
  expectInOrder(fn, [
    'await open2048(ready, COLOR_BOARD)',
    'await settleWebkitReadyPaint(ready)',
    'await repaintWebkitReadyOverlay(ready)',
    "await capture(ready, 'after-2048-ready-webkit.png', false, { stable: true })",
  ]);
  expect(fn).not.toMatch(
    /sampleWebkitState\(context, \{\s*name: 'after-2048-ready-webkit\.png'/,
  );
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

  it('keeps the ready scene on its original scroll + overlay stable path', () => {
    expect(SOURCE).toContain('settleCapturePaint,\n  settleWebkitReadyPaint,');
    expect(count(/settleWebkitReadyPaint\(/g)).toBe(1);
    expect(count(/repaintWebkitReadyOverlay\(/g)).toBe(1);
    // Only the ready scene takes two consecutive identical frames; playing /
    // gameover compare bytes through the manifest resampler instead.
    expect(count(/stable: true/g)).toBe(1);

    const webkit = functionCode('captureWebkitMobile');
    assertReadyPath(webkit);
  });

  it('fails the ready guard when a seam or the stable capture is removed', () => {
    const webkit = functionCode('captureWebkitMobile');
    for (const seam of [
      'await settleWebkitReadyPaint(ready);',
      'await repaintWebkitReadyOverlay(ready);',
    ]) {
      const commented = stripComments(webkit.replace(seam, `// ${seam}`));
      expect(() => assertReadyPath(commented)).toThrow();
    }
    const withoutStable = stripComments(
      webkit.replace("false, { stable: true }", 'false'),
    );
    expect(() => assertReadyPath(withoutStable)).toThrow();
    const rerouted = stripComments(
      webkit.replace(
        "await capture(ready, 'after-2048-ready-webkit.png', false, { stable: true })",
        "await sampleWebkitState(context, { name: 'after-2048-ready-webkit.png' })",
      ),
    );
    expect(() => assertReadyPath(rerouted)).toThrow();
  });

  it('keeps every scene on the shared settle contract', () => {
    expect(SOURCE).toContain('await settleCapturePaint(page)');
    expect(SOURCE).toContain('settleCapturePaint,\n  settleWebkitReadyPaint,');
  });

  it('samples the playing / gameover states from fresh pages until the manifest sha256', () => {
    expect(CODE).toContain('captureManifestedScreenshot,');
    expect(CODE).toContain(
      "const ALLOW_NEW_BYTES = ARGS.includes('--allow-new-bytes');",
    );
    // Two resampled states, one capture each, both through the same helper.
    expect(count(/await sampleWebkitState\(context, \{/g)).toBe(2);

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

    const webkit = functionCode('captureWebkitMobile');
    expectInOrder(webkit, [
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
