import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import type { Game2048Snapshot } from '../../src/games/2048/engine';

export interface Open2048Options {
  /** Dev-only starting board, row-major from top to bottom; null is empty. */
  board?: readonly (readonly (number | null)[])[];
}

/** Fixed 2x2 block of equal tiles: moving left merges twice, scoring 8. */
export const MERGE_BOARD = [
  [2, 2, null, null],
  [2, 2, null, null],
  [null, null, null, null],
  [null, null, null, null],
] as const;

/**
 * Full board with a single merge pair. Moving left merges the pair, the only
 * spawned tile lands in the vacated top-right cell, and whichever 2/4 appears
 * leaves no equal neighbours: the run ends deterministically.
 */
export const NEAR_STUCK_BOARD = [
  [2, 2, 16, 8],
  [8, 4, 2, 16],
  [4, 8, 16, 2],
  [16, 2, 4, 8],
] as const;

function encodeBoard(board: readonly (readonly (number | null)[])[]): string {
  return board
    .map((row) => row.map((value) => (value === null ? '.' : String(value))).join(','))
    .join('/');
}

export async function open2048(page: Page, options: Open2048Options = {}): Promise<void> {
  const params = new URLSearchParams({ debug: '1' });
  if (options.board) {
    params.set('board', encodeBoard(options.board));
  }

  await page.goto(`/#/games/2048?${params.toString()}`);
  await expect(page.getByTestId('2048-game')).toBeVisible();
  await expect(page.locator('[data-testid="2048-board"] canvas')).toBeVisible();
  await expect(page.getByTestId('overlay-title')).toHaveText('合并出 2048');
  await expect.poll(() => readStatus(page)).toBe('playing');
}

export function readState(page: Page): Promise<Game2048Snapshot> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => Game2048Snapshot };
      }
    ).__playground;
    if (!api) {
      throw new Error('Playwright debug API is not available');
    }
    return api.getState();
  });
}

export async function readStatus(
  page: Page,
): Promise<Game2048Snapshot['status'] | 'missing'> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => Game2048Snapshot };
      }
    ).__playground;
    return api?.getState().status ?? 'missing';
  });
}

export async function startGame(page: Page): Promise<void> {
  await page.getByTestId('overlay').getByRole('button', { name: '开始游戏' }).click();
  await expect(page.getByTestId('overlay')).toBeHidden();
  await expect(page.getByTestId('status')).toHaveText('进行中');
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
}
