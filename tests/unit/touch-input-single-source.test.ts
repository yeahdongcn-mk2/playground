import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Static guard for the single-source release-click sequence.
 *
 * `scripts/lib/touch-input.mjs` owns the touch pointer ids and the
 * `releaseTouchClick` sequence (release-click pointer id, `pointerType:
 * 'mouse'`, `detail: 1`, `buttons: 0`). The e2e entry
 * `tests/e2e/touch-input.ts` and the minesweeper screenshot entry must consume
 * that implementation instead of rebuilding it. These checks read the source
 * so a copy can never be reintroduced just because the runtime parity tests
 * still happen to agree.
 */

const SHARED = new URL('../../scripts/lib/touch-input.mjs', import.meta.url);
const E2E = new URL('../e2e/touch-input.ts', import.meta.url);
const SCREENSHOT_ENTRY = new URL(
  '../../scripts/capture-minesweeper-screenshots.mjs',
  import.meta.url,
);

function read(url: URL): string {
  return readFileSync(url, 'utf8');
}

/**
 * Drop block and line comments so explanatory text cannot trip the duplicate
 * guards. Only a `//` at line start or after whitespace counts as a comment, so
 * URLs inside string literals stay intact.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** The duplicated release-click literal checks shared by both entry tests. */
function expectNoReleaseClickRebuild(source: string, label: string): void {
  expect(source, label).not.toMatch(/new\s+PointerEvent\b/);
  expect(source, label).not.toMatch(/pointerType:\s*['"]mouse['"]/);
  expect(source, label).not.toMatch(/\bdetail:\s*1\b/);
}

describe('touch injector single source', () => {
  it('defines the pointer ids only in the shared module', () => {
    const shared = read(SHARED);
    expect(shared).toContain('export const TOUCH_POINTER_ID = 2;');
    expect(shared).toContain('export const RELEASE_CLICK_POINTER_ID = 1;');

    const e2e = stripComments(read(E2E));
    expect(e2e).not.toMatch(/\b(?:const|let|var)\s+TOUCH_POINTER_ID\b/);
    expect(e2e).not.toMatch(/\b(?:const|let|var)\s+RELEASE_CLICK_POINTER_ID\b/);
    // Both ids must arrive through the shared module import that feeds the
    // re-export below, not through a second local definition.
    expect(e2e).toMatch(
      /import\s*\{[\s\S]*?\bTOUCH_POINTER_ID\b[\s\S]*?\}\s*from\s*'\.\.\/\.\.\/scripts\/lib\/touch-input\.mjs'/,
    );
    expect(e2e).toMatch(
      /import\s*\{[\s\S]*?\bRELEASE_CLICK_POINTER_ID\b[\s\S]*?\}\s*from\s*'\.\.\/\.\.\/scripts\/lib\/touch-input\.mjs'/,
    );
  });

  it('keeps the release-click sequence in the shared helper', () => {
    const shared = read(SHARED);
    const start = shared.indexOf('export async function releaseTouchClick');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = shared.slice(start, shared.indexOf('\n}', start));
    // Assert the fixed fields inside the helper body rather than their
    // formatting, so a harmless reformat does not fail while dropping one of
    // the fields still does.
    expect(body).toMatch(/'click'/);
    expect(body).toMatch(/\bRELEASE_CLICK_POINTER_ID\b/);
    expect(body).toMatch(/\bdetail:\s*1\b/);
    expect(body).toMatch(/\bbuttons:\s*0\b/);
    expect(body).toMatch(/pointerType:\s*'mouse'/);

    const e2e = stripComments(read(E2E));
    expectNoReleaseClickRebuild(e2e, 'tests/e2e/touch-input.ts');
    expect(e2e).not.toMatch(/\bfunction\s+dispatchTouchPointerEvent\b/);
    // The adapter dispatches its release click through the shared helper only;
    // a raw `'click'` here would hide a copy behind the dispatch defaults.
    expect(e2e).not.toMatch(/'click'/);
    expect(e2e.match(/releaseTouchClick\(/g)).toHaveLength(1);
  });

  it('routes both injection entries through the shared module', () => {
    const e2e = stripComments(read(E2E));
    expect(e2e).toContain("from '../../scripts/lib/touch-input.mjs'");

    const screenshot = stripComments(read(SCREENSHOT_ENTRY));
    expect(screenshot).toContain("from './lib/touch-input.mjs'");
    expect(screenshot).toMatch(/\btouchLongPress\b/);
    expectNoReleaseClickRebuild(screenshot, 'scripts/capture-minesweeper-screenshots.mjs');
  });
});
