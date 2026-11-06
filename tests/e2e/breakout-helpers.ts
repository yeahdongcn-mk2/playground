import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import {
  DEFAULT_BREAKOUT_CONFIG,
  type BreakoutSnapshot,
} from '../../src/games/breakout/engine';

export interface BreakoutBrickSpec {
  readonly row: number;
  readonly col: number;
}

export interface OpenBreakoutOptions {
  /** Fixed starting bricks in the engine's logical grid. */
  readonly bricks?: readonly BreakoutBrickSpec[];
  /** Fixed starting ball in logical court units. */
  readonly ball?: { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number };
  readonly level?: number;
  readonly seed?: number;
  /** Ball speed in logical units per second (max 680). */
  readonly speed?: number;
  /** Force Phaser's canvas renderer so canvas pixels can be read reliably. */
  readonly renderer?: 'canvas';
}

const BRICK_WIDTH =
  (DEFAULT_BREAKOUT_CONFIG.width -
    2 * DEFAULT_BREAKOUT_CONFIG.brickSideMargin -
    (DEFAULT_BREAKOUT_CONFIG.brickColumns - 1) * DEFAULT_BREAKOUT_CONFIG.brickGap) /
  DEFAULT_BREAKOUT_CONFIG.brickColumns;

/** A ball already aimed at the bottom edge of brick (row 0, col 0). */
export const BALL_UNDER_FIRST_BRICK = {
  x: DEFAULT_BREAKOUT_CONFIG.brickSideMargin + BRICK_WIDTH / 2,
  y:
    DEFAULT_BREAKOUT_CONFIG.brickTop +
    DEFAULT_BREAKOUT_CONFIG.brickHeight +
    DEFAULT_BREAKOUT_CONFIG.ballRadius -
    1,
  vx: 0,
  vy: -200,
} as const;

function ballParam(ball: OpenBreakoutOptions['ball']): string {
  return [ball?.x, ball?.y, ball?.vx, ball?.vy].join(',');
}

export async function openBreakout(
  page: Page,
  options: OpenBreakoutOptions = {},
): Promise<void> {
  const params = new URLSearchParams({ debug: '1' });
  if (options.bricks) {
    params.set(
      'bricks',
      options.bricks.map((brick) => `${brick.row},${brick.col}`).join(';'),
    );
  }
  if (options.ball) {
    params.set('ball', ballParam(options.ball));
  }
  if (options.level !== undefined) {
    params.set('level', String(options.level));
  }
  if (options.seed !== undefined) {
    params.set('seed', String(options.seed));
  }
  if (options.speed !== undefined) {
    params.set('speed', String(options.speed));
  }
  if (options.renderer) {
    params.set('renderer', options.renderer);
  }

  await page.goto(`/#/games/breakout?${params.toString()}`);
  await expect(page.getByTestId('breakout-game')).toBeVisible();
  await expect(page.locator('[data-testid="breakout-board"] canvas')).toBeVisible();
  await expect(page.getByTestId('breakout-game')).not.toHaveAttribute(
    'data-status',
    'loading',
  );
  await expect.poll(() => readStatus(page)).not.toBe('missing');
}

export function readState(page: Page): Promise<BreakoutSnapshot> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => BreakoutSnapshot };
      }
    ).__playground;
    if (!api) {
      throw new Error('Playwright breakout debug API is not available');
    }
    return api.getState();
  });
}

export async function readStatus(
  page: Page,
): Promise<BreakoutSnapshot['status'] | 'missing'> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => BreakoutSnapshot };
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
 * Play until the current ball falls past the bottom without being saved.
 *
 * The loop runs inside the page so it can follow the ball every ~30 ms and
 * move the paddle to the opposite half. It starts a serve when the engine is
 * waiting for one, and returns once one life was lost. Deterministic seeds plus
 * the paddle-away strategy keep the test independent of the serve direction.
 */
export async function forceMiss(page: Page): Promise<void> {
  const outcome = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        __playground?: { gameId: string; getState: () => BreakoutSnapshot };
      }
    ).__playground;
    if (!api) {
      throw new Error('Playwright breakout debug API is not available');
    }
    const board = document.querySelector<HTMLElement>('[data-testid="breakout-board"]');
    const overlay = document.querySelector<HTMLElement>('[data-testid="overlay"]');
    if (!board) {
      throw new Error('Breakout board is missing');
    }

    const startLives = api.getState().lives;
    if (startLives <= 0) {
      return 'already-over';
    }

    const deadline = performance.now() + 25_000;
    while (performance.now() < deadline) {
      const state = api.getState();
      if (state.lives < startLives) {
        return 'lost';
      }
      if (state.status === 'gameover' || state.status === 'levelclear') {
        return state.status;
      }
      if (state.status === 'ready' && overlay && !overlay.hidden) {
        overlay
          .querySelector<HTMLButtonElement>('button[data-action="primary"]')
          ?.click();
      }
      if (state.status === 'running') {
        const rect = board.getBoundingClientRect();
        const clientX =
          state.ball.x < state.width / 2 ? rect.right - 2 : rect.left + 2;
        const clientY = rect.top + rect.height * 0.8;
        const init = {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX,
          clientY,
        };
        board.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
        board.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
    return 'timeout';
  });

  expect(outcome, 'the ball should be missed').toBe('lost');
}

/**
 * Exact RGB histogram of the Phaser canvas, keyed as `r,g,b`. Callers pass
 * `renderer: 'canvas'` so the renderer is deterministic; WebGL canvases do not
 * expose a 2D context to read.
 */
export async function readCanvasColorCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="breakout-board"] canvas',
    );
    if (!canvas) {
      throw new Error('Breakout canvas is missing');
    }
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Breakout canvas is not a 2D canvas');
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

/** Number of pixels in the Phaser canvas backing store. */
export async function readCanvasPixelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="breakout-board"] canvas',
    );
    if (!canvas) {
      throw new Error('Breakout canvas is missing');
    }
    return canvas.width * canvas.height;
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
    if (api?.gameId !== 'breakout' || !api.destroy) {
      throw new Error('Breakout debug destroy seam is not available');
    }
    api.destroy();
  });
}

interface PageVisibilityProbeWindow {
  __pageHidden?: boolean;
}

/**
 * Override `document.hidden` and dispatch `visibilitychange`. Only `hidden` is
 * stubbed because the breakout view reads that property; `visibilityState` is
 * left untouched so this cannot silently test the wrong signal.
 */
export async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hidden) => {
    const probe = window as unknown as PageVisibilityProbeWindow;
    if (probe.__pageHidden === undefined) {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () =>
          Boolean((window as unknown as PageVisibilityProbeWindow).__pageHidden),
      });
    }
    probe.__pageHidden = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Restore the real `document.hidden` getter after {@link setPageHidden}. */
export async function restorePageVisibility(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    delete (window as unknown as PageVisibilityProbeWindow).__pageHidden;
  });
}
