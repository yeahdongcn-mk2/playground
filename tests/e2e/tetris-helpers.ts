import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import type { TetrisSnapshot, TetrominoType } from '../../src/games/tetris/engine';

export const TETRIS_WIDTH = 10;
export const TETRIS_HEIGHT = 20;

export interface OpenTetrisOptions {
  /** Dev-only first piece, e.g. "T". */
  piece?: TetrominoType;
  /**
   * Dev-only starting stack, one string per row from top to bottom. "." is an
   * empty cell and a piece letter fills the cell, e.g. `IIIIIIII..` for a
   * bottom row with a two-cell gap.
   */
  board?: readonly string[];
}

export async function openTetris(page: Page, options: OpenTetrisOptions = {}): Promise<void> {
  const params = new URLSearchParams({ debug: '1' });
  if (options.piece) {
    params.set('piece', options.piece);
  }
  if (options.board) {
    params.set('board', options.board.join('/'));
  }

  await page.goto(`/#/games/tetris?${params.toString()}`);
  await expect(page.getByTestId('tetris-game')).toBeVisible();
  await expect(page.locator('[data-testid="tetris-board"] canvas')).toBeVisible();
  await expect(page.getByTestId('overlay-title')).toHaveText('堆出你的最高分');
  await expect.poll(() => readStatus(page)).toBe('ready');
}

export function readState(page: Page): Promise<TetrisSnapshot> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => TetrisSnapshot };
      }
    ).__playground;
    if (!api) {
      throw new Error('Playwright debug API is not available');
    }
    return api.getState();
  });
}

export async function readStatus(page: Page): Promise<TetrisSnapshot['status'] | 'missing'> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => TetrisSnapshot };
      }
    ).__playground;
    return api?.getState().status ?? 'missing';
  });
}

export async function startGame(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await expect.poll(() => readStatus(page)).toBe('running');
}

export function lockedCellCount(state: TetrisSnapshot): number {
  return state.board.flat().filter((cell) => cell !== null).length;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
}
