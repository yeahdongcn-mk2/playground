/**
 * Waitable freeze seam for the WebKit breakout terminal captures (Issue #328).
 *
 * The previous capture polled `requestAnimationFrame` until the game had
 * reached a terminal step, then slept the loop from that watcher. Under host
 * load the watcher could run after the screenshot, so a pre-freeze composite
 * could be committed; a stable double-frame check cannot distinguish that from
 * a finished frame. The debug build now exposes an explicit
 * `window.__playground.freeze()` that sleeps Phaser and publishes
 * `data-debug-frozen="1"` only after the loop confirms it stopped. This module
 * requests that freeze from the capture page and waits for the marker, so the
 * overlay backdrop / shared header seams always run against a frozen canvas.
 *
 * The freeze is gated by `?debug=1&freeze=1` in the view, so calling it on a
 * normal page throws instead of silently pausing a player's game.
 */

/** Stable debug marker the view publishes once the Phaser loop is asleep. */
export const BREAKOUT_FROZEN_ATTRIBUTE = 'data-debug-frozen';

/** Game root that carries {@link BREAKOUT_FROZEN_ATTRIBUTE}. */
export const BREAKOUT_GAME_SELECTOR = '[data-testid="breakout-game"]';

/** How long the capture waits for the explicit freeze marker. */
export const BREAKOUT_FREEZE_TIMEOUT_MS = 10_000;

/**
 * In-page half of {@link freezeBreakoutLoop}.
 *
 * This runs inside `page.evaluate`, so it only uses browser globals and its
 * serialisable options. The debug API is installed by the game view; a missing
 * root / API returns a structured failure instead of throwing an opaque
 * browser-side error.
 */
export function requestBreakoutFreeze({ selector }) {
  const root = document.querySelector(selector);
  if (!(root instanceof HTMLElement)) {
    return { found: false, frozen: false };
  }
  const api = window.__playground;
  if (!api || api.gameId !== 'breakout' || typeof api.freeze !== 'function') {
    return { found: true, frozen: false };
  }
  return { found: true, frozen: api.freeze() === true };
}

/**
 * Freeze the breakout Phaser loop and wait for its explicit marker.
 *
 * The capture must call this after the terminal overlay title is visible and
 * before the overlay backdrop / shared header seams, so those seams rebuild the
 * compositor from a canvas that can no longer redraw. A missing game root, a
 * missing debug API or a freeze that does not confirm the loop stopped fails
 * the capture loudly; the stable double-frame check is a backstop, not a
 * substitute for the freeze.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   selector?: string,
 *   attribute?: string,
 *   timeout?: number,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function freezeBreakoutLoop(
  page,
  {
    selector = BREAKOUT_GAME_SELECTOR,
    attribute = BREAKOUT_FROZEN_ATTRIBUTE,
    timeout = BREAKOUT_FREEZE_TIMEOUT_MS,
  } = {},
) {
  const result = await page.evaluate(requestBreakoutFreeze, { selector });
  if (!result?.found) {
    throw new Error(
      `Breakout game root "${selector}" was not found, so the WebKit ` +
        'terminal capture could not freeze the Phaser loop before the screenshot',
    );
  }
  if (!result.frozen) {
    throw new Error(
      'The breakout debug API did not expose freeze() or did not confirm that ' +
        'the Phaser loop stopped; the WebKit terminal capture was not frozen',
    );
  }
  try {
    await page.waitForFunction(
      ({ selector: rootSelector, attribute: marker }) =>
        document.querySelector(rootSelector)?.getAttribute(marker) === '1',
      { selector, attribute },
      { timeout },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Breakout did not publish ${attribute}="1" within ${timeout} ms after ` +
        `the debug freeze, so the WebKit terminal capture was not frozen: ${detail}`,
    );
  }
}
