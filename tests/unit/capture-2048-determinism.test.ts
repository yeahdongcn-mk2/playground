import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(
  join(ROOT, 'scripts', 'capture-2048-screenshots.mjs'),
  'utf8',
);

function count(pattern: RegExp): number {
  return [...SOURCE.matchAll(pattern)].length;
}

function indexOfOrFail(needle: string): number {
  const index = SOURCE.indexOf(needle);
  expect(index, `missing: ${needle}`).toBeGreaterThan(-1);
  return index;
}

/**
 * Static guard for the committed playing / gameover / ready WebKit PNGs. The
 * engine test proves seed 135 is deterministic for the pinned boards; this test
 * proves the capture script actually passes that seed and keeps every such
 * scene on the same board and direction, so a dropped parameter cannot silently
 * restore random captures while the engine test stays green. It also pins the
 * WebKit READY paint seam to the ready scene only.
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

  it('repaints the WebKit header only between ready open and ready capture', () => {
    expect(SOURCE).toContain('settleCapturePaint,\n  settleWebkitReadyPaint,');
    expect(count(/settleWebkitReadyPaint\(/g)).toBe(1);

    const readyOpen = indexOfOrFail('await open2048(ready, COLOR_BOARD)');
    const seam = indexOfOrFail('await settleWebkitReadyPaint(ready)');
    const readyCapture = indexOfOrFail(
      "await capture(ready, 'after-2048-ready-webkit.png', false)",
    );
    expect(seam).toBeGreaterThan(readyOpen);
    expect(readyCapture).toBeGreaterThan(seam);
  });

  it('keeps every scene on the shared settle contract', () => {
    expect(SOURCE).toContain('await settleCapturePaint(page)');
    expect(SOURCE).toContain('settleCapturePaint,\n  settleWebkitReadyPaint,');
  });
});
