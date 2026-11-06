import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import type { Game2048Snapshot } from '../../src/games/2048/engine';

export interface Open2048Options {
  /** Dev-only starting board, row-major from top to bottom; null is empty. */
  board?: readonly (readonly (number | null)[])[];
  /** Force Phaser's canvas renderer so canvas pixels can be read reliably. */
  renderer?: 'canvas';
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
  if (options.renderer) {
    params.set('renderer', options.renderer);
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

/**
 * Exact RGB histogram of the Phaser canvas, keyed as `r,g,b`. Callers pass
 * `renderer: 'canvas'` to open2048 so the renderer is deterministic; WebGL
 * canvases do not expose a 2D context to read.
 */
export async function readCanvasColorCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="2048-board"] canvas',
    );
    if (!canvas) {
      throw new Error('2048 canvas is missing');
    }
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('2048 canvas is not a 2D canvas');
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const counts: Record<string, number> = {};
    for (let index = 0; index < data.length; index += 4) {
      const key = `${data[index]},${data[index + 1]},${data[index + 2]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
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
    if (api?.gameId !== '2048' || !api.destroy) {
      throw new Error('2048 debug destroy seam is not available');
    }
    api.destroy();
  });
}

/** Number of pixels in the Phaser canvas backing store. */
export async function readCanvasPixelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="2048-board"] canvas',
    );
    if (!canvas) {
      throw new Error('2048 canvas is missing');
    }
    return canvas.width * canvas.height;
  });
}
