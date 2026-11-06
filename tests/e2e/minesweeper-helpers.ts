import type { Locator, Page } from '@playwright/test';
import type {
  Cell,
  MinesweeperSnapshot,
} from '../../src/games/minesweeper/engine';
import { expect } from './fixtures';

export interface OpenMinesweeperOptions {
  /** Fixed mine layout, e.g. `[{ row: 0, col: 0 }, ...]`. */
  readonly mines?: readonly Cell[];
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
  if (options.seed !== undefined) {
    params.set('seed', String(options.seed));
  }

  await page.goto(`/#/games/minesweeper?${params.toString()}`);
  await expect(page.getByTestId('minesweeper-game')).toBeVisible();
  await expect(page.getByTestId('minesweeper-board')).toBeVisible();
  await expect(page.locator('[data-cell]')).toHaveCount(81);
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
