import type { CDPSession, Locator, Page } from '@playwright/test';
import type {
  Cell,
  MinesweeperSnapshot,
} from '../../src/games/minesweeper/engine';
import { expect } from './fixtures';

export interface OpenMinesweeperOptions {
  /** Fixed mine layout, e.g. `[{ row: 0, col: 0 }, ...]`. */
  readonly mines?: readonly Cell[];
  /** Raw `mines=...` value, used to exercise malformed parser input. */
  readonly rawMines?: string;
  /** Seed for the deterministic debug PRNG. */
  readonly seed?: number;
}

/** A mine wall on row 4 plus one mine in the corner. */
export const LOSS_MINES: readonly Cell[] = [
  { row: 0, col: 0 },
  ...Array.from({ length: 9 }, (_, col) => ({ row: 4, col })),
];

/**
 * The first click below the mine wall. It reveals part of the board without
 * ending the game, so a later click on (0, 0) can lose deterministically.
 */
export const LOSS_SAFE_CLICK = { row: 7, col: 4 } as const;

/** Clicking this mine after {@link LOSS_SAFE_CLICK} loses the game. */
export const LOSS_MINE_CLICK = { row: 0, col: 0 } as const;

/** A block of mines in the top-left corner; revealing (8, 8) wins at once. */
export const WIN_MINES: readonly Cell[] = [
  ...Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, col) => ({ row, col })),
  ).flat(),
  { row: 0, col: 3 },
];

/** A blank corner whose flood fill reveals every safe cell. */
export const WIN_CLICK = { row: 8, col: 8 } as const;

export function cellLocator(page: Page, row: number, col: number): Locator {
  return page.getByTestId(`cell-${row}-${col}`);
}

async function cellCenter(
  page: Page,
  row: number,
  col: number,
): Promise<{ x: number; y: number }> {
  const box = await cellLocator(page, row, col).boundingBox();
  if (!box) {
    throw new Error(`cell-${row}-${col} has no bounding box`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real touch tap, so Chromium emits the same pointer/click pair a finger does. */
export async function tapCell(page: Page, row: number, col: number): Promise<void> {
  const point = await cellCenter(page, row, col);
  await page.touchscreen.tap(point.x, point.y);
}

/** Dispatch a synthetic touch PointerEvent on a cell. CDP cannot express every
 * multi-pointer sequence (for example two ids at once, or a click that arrives
 * after a long hold), so the suppression tests inject the exact events. */
export async function dispatchTouchPointer(
  page: Page,
  row: number,
  col: number,
  type: 'pointerdown' | 'pointerup' | 'click',
  pointerId: number,
  detail = 1,
): Promise<void> {
  await cellLocator(page, row, col).evaluate(
    (cell, init: { type: string; pointerId: number; detail: number }) => {
      cell.dispatchEvent(
        new PointerEvent(init.type, {
          bubbles: true,
          cancelable: true,
          pointerId: init.pointerId,
          pointerType: 'touch',
          detail: init.detail,
        }),
      );
    },
    { type, pointerId, detail },
  );
}

export interface CellPress {
  readonly client: CDPSession;
  readonly point: { readonly x: number; readonly y: number };
}

/** Begin a real touch press on a cell and keep it down until released. */
export async function startCellPress(
  page: Page,
  row: number,
  col: number,
): Promise<CellPress> {
  const client = await page.context().newCDPSession(page);
  const point = await cellCenter(page, row, col);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point],
  });
  return { client, point };
}

export async function moveCellPress(
  press: CellPress,
  dx: number,
  dy: number,
): Promise<void> {
  await press.client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: press.point.x + dx, y: press.point.y + dy }],
  });
}

/** Release a press and detach the CDP session. */
export async function endCellPress(press: CellPress): Promise<void> {
  try {
    await press.client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await press.client.detach();
  }
}

/** Cancel a press (browser scroll or gesture takeover) and detach the session. */
export async function cancelCellPress(press: CellPress): Promise<void> {
  try {
    await press.client.send('Input.dispatchTouchEvent', {
      type: 'touchCancel',
      touchPoints: [],
    });
  } finally {
    await press.client.detach();
  }
}

export async function longPressCell(
  page: Page,
  row: number,
  col: number,
  holdMs = 650,
): Promise<void> {
  const press = await startCellPress(page, row, col);
  try {
    await page.waitForTimeout(holdMs);
    await endCellPress(press);
  } catch (error) {
    await press.client.detach().catch(() => undefined);
    throw error;
  }
}

/** Assert the document does not scroll horizontally. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
}

/** Assert an element is fully inside the current phone viewport. */
export async function expectInsideViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} should have a bounding box`).not.toBeNull();
  expect(viewport, 'viewport size should be available').not.toBeNull();
  if (!box || !viewport) {
    return;
  }
  expect(box.x, `${label} should start inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} should start inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} should end inside the viewport`).toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
  expect(box.y + box.height, `${label} should end inside the viewport`).toBeLessThanOrEqual(
    viewport.height + 0.5,
  );
}

export async function openMinesweeper(
  page: Page,
  options: OpenMinesweeperOptions = {},
): Promise<void> {
  const params = new URLSearchParams({ debug: '1' });
  if (options.mines) {
    params.set(
      'mines',
      options.mines.map((mine) => `${mine.row},${mine.col}`).join(';'),
    );
  }
  if (options.rawMines !== undefined) {
    params.set('mines', options.rawMines);
  }
  if (options.seed !== undefined) {
    params.set('seed', String(options.seed));
  }

  // Mark the current debug API so the wait below cannot accept the previous
  // mount's DOM after a hash-only goto (which does not reload the document).
  await page.evaluate(() => {
    const api = (window as unknown as { __playground?: { stale?: boolean } })
      .__playground;
    if (api) {
      api.stale = true;
    }
  });
  await page.goto(`/#/games/minesweeper?${params.toString()}`);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as unknown as { __playground?: { stale?: boolean } })
          .__playground;
        return api !== undefined && api.stale !== true;
      }),
    )
    .toBe(true);
  await expect(page.getByTestId('minesweeper-game')).toBeVisible();
  await expect(page.getByTestId('minesweeper-board')).toBeVisible();
  await expect(page.locator('[data-cell]')).toHaveCount(81);
  await expect(page.getByTestId('status')).toHaveText('待开始');
}

export function readState(page: Page): Promise<MinesweeperSnapshot> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => MinesweeperSnapshot };
      }
    ).__playground;
    if (!api) {
      throw new Error('Playwright minesweeper debug API is not available');
    }
    return api.getState();
  });
}

export async function readStatus(
  page: Page,
): Promise<MinesweeperSnapshot['status'] | 'missing'> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => MinesweeperSnapshot };
      }
    ).__playground;
    return api?.getState().status ?? 'missing';
  });
}

/** Assert a restarted board has no revealed cells or leftover cell glyphs. */
export async function expectCleanBoard(page: Page): Promise<void> {
  await expect(page.locator('[data-revealed="true"]')).toHaveCount(0);
  await expect(page.locator('[data-number]')).toHaveCount(0);
  await expect(page.locator('[data-mine="true"]')).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator('[data-cell]').evaluateAll((cells) =>
        cells
          .map((cell) => (cell.textContent ?? '').trim())
          .filter((text) => text.length > 0),
      ),
    )
    .toEqual([]);
}

/** Assert the normal entry or a destroyed mount left no debug seam behind. */
export async function expectNoDebugSeam(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as unknown as { __playground?: unknown }).__playground,
    ),
  ).toBeUndefined();
}

/** Call the debug-only destroy seam without changing the route. */
export async function destroyDebugGame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; destroy?: () => void };
      }
    ).__playground;
    if (api?.gameId !== 'minesweeper' || !api.destroy) {
      throw new Error('Minesweeper debug destroy seam is not available');
    }
    api.destroy();
  });
}

interface IntervalProbeApi {
  count(): number;
}

interface IntervalProbeWindow {
  __intervalProbe?: IntervalProbeApi;
}

/**
 * Track active `setInterval` ids. The shared listener probe only tracks long
 * `setTimeout` timers, so it cannot observe the view's 250 ms clock interval.
 */
export async function installIntervalProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const active = new Set<number>();
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ): number => {
      const id = nativeSetInterval(handler, timeout, ...args);
      active.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number): void => {
      if (typeof id === 'number') {
        active.delete(id);
      }
      nativeClearInterval(id);
    }) as typeof window.clearInterval;
    Object.assign(window, {
      __intervalProbe: {
        count: () => active.size,
      },
    });
  });
}

/** Number of intervals that are currently registered. */
export async function activeIntervalCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as unknown as IntervalProbeWindow).__intervalProbe;
    if (!api) {
      throw new Error('Interval probe is not installed');
    }
    return api.count();
  });
}

interface AbortProbeApi {
  count(): number;
}

interface AbortProbeWindow {
  __abortProbe?: AbortProbeApi;
}

/**
 * Track active `abort` listeners added to `AbortSignal` instances. The view
 * registers one on the mount signal and must remove it on destroy; the shared
 * listener probe cannot identify a transient signal by selector.
 *
 * Install this after `installListenerProbe`: it layers on the current
 * `addEventListener`, and the listener probe's own signal-bound cleanup would
 * otherwise be counted. Duplicate registrations of one listener on one signal
 * are counted once, and already-aborted signals are skipped because their
 * listeners can never fire.
 */
export async function installAbortProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const trackers = new WeakMap<
      AbortSignal,
      Map<EventListenerOrEventListenerObject, EventListener>
    >();
    let active = 0;
    const isAbortListener = (target: EventTarget, type: string): boolean =>
      target instanceof AbortSignal && type === 'abort';

    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener && isAbortListener(this, type)) {
        const signal = this as AbortSignal;
        if (!signal.aborted) {
          let signalTrackers = trackers.get(signal);
          if (!signalTrackers) {
            signalTrackers = new Map();
            trackers.set(signal, signalTrackers);
          }
          if (!signalTrackers.has(listener)) {
            const signalMap = signalTrackers;
            const tracker = (): void => {
              if (signalMap.delete(listener)) {
                active -= 1;
              }
            };
            signalMap.set(listener, tracker);
            active += 1;
            nativeAdd.call(signal, 'abort', tracker, { once: true });
          }
        }
      }
      nativeAdd.call(this, type, listener, options);
    } as typeof EventTarget.prototype.addEventListener;

    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (listener && isAbortListener(this, type)) {
        const signalTrackers = trackers.get(this as AbortSignal);
        const tracker = signalTrackers?.get(listener);
        if (signalTrackers && tracker) {
          signalTrackers.delete(listener);
          nativeRemove.call(this, 'abort', tracker);
          active -= 1;
        }
      }
      nativeRemove.call(this, type, listener, options);
    } as typeof EventTarget.prototype.removeEventListener;

    Object.assign(window, { __abortProbe: { count: () => active } });
  });
}

/** Number of active `abort` listeners on all observed AbortSignals. */
export async function abortListenerCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as unknown as AbortProbeWindow).__abortProbe;
    if (!api) {
      throw new Error('Abort probe is not installed');
    }
    return api.count();
  });
}
