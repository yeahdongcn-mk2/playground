import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard for the online room stylesheet.
 *
 * The stage cards set `display: flex`, which outranks the browser's
 * `[hidden] { display: none }` rule. jsdom force-applies `[hidden]`, so a
 * computed-style unit test cannot catch the regression; this Node-side test
 * pins the author rule while the real-browser check lives in the room e2e.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOM_VIEW_CSS = readFileSync(
  join(ROOT, 'src', 'games', 'minesweeper', 'online', 'client', 'room-view.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Whether an author rule hides `.online-room__card` elements with `hidden`. */
function hidesHiddenCards(css: string): boolean {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    ([, selector = '', declarations = '']) =>
      selector.includes('.online-room__card') &&
      selector.includes('[hidden]') &&
      /display\s*:\s*none/.test(declarations),
  );
}

describe('online room card visibility', () => {
  it('hides inactive cards with an author rule that beats the flex display', () => {
    expect(hidesHiddenCards(ROOM_VIEW_CSS)).toBe(true);
  });
});
