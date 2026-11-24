import type { Page } from '@playwright/test';
import type {
  ZhenShaDebugApiWithSettlement,
  ZhenShaDebugStateWithSettlement,
} from '../../src/games/zhen-sha/zhen-sha-view';
import { expect } from './fixtures';

export type { ZhenShaDebugApiWithSettlement, ZhenShaDebugStateWithSettlement };

/** Open Zhen Sha with the `?debug=1` seam and wait until the API is installed. */
export async function openDebugGame(page: Page): Promise<void> {
  await page.goto('/#/games/zhen-sha?debug=1');
  await expect(page.getByTestId('zhen-sha-game')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __playground?: ZhenShaDebugApiWithSettlement }).__playground?.gameId ?? null),
    )
    .toBe('zhen-sha');
}

/** Read the settlement-aware debug state, failing when the seam is missing. */
export async function readState(page: Page): Promise<ZhenShaDebugStateWithSettlement> {
  return page.evaluate(() => {
    const api = (window as unknown as { __playground?: ZhenShaDebugApiWithSettlement }).__playground;
    if (api?.gameId !== 'zhen-sha') {
      throw new Error('Playwright zhen-sha debug API is not available');
    }
    return api.getState();
  });
}

/** Fixed input sequence: three perfect parries at ticks 180 / 360 / 540, then
 * charge + strike inside the break. Every tap lands exactly on its impact tick,
 * so the snapshot depends only on the tick schedule, never on frame pacing. */
export async function playFixedWin(page: Page): Promise<ZhenShaDebugStateWithSettlement> {
  return page.evaluate(() => {
    const api = (window as unknown as { __playground?: ZhenShaDebugApiWithSettlement }).__playground;
    if (api?.gameId !== 'zhen-sha') {
      throw new Error('Playwright zhen-sha debug API is not available');
    }
    api.step(180);
    api.input('block');
    api.step(1);
    api.step(179);
    api.input('block');
    api.step(1);
    api.step(179);
    api.input('block');
    api.step(1);
    api.input('charge');
    api.step(1);
    api.input('strike');
    api.step(1);
    return api.getState();
  });
}
