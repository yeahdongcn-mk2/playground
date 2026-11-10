import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  lockedCellCount,
  openTetris,
  readState,
  readStatus,
} from './tetris-helpers';

/**
 * Shared tetris phone cases for the Chromium `mobile` project and the WebKit
 * `mobile-webkit` project. Touch buttons, keyboard / touch mixed input and the
 * game-over restart path run against the same assertions on both engines; the
 * two project entries only wire this module in, so they cannot drift.
 */
export function defineTetrisMobileCases(): void {
  test.describe('tetris on a phone viewport', () => {
    test('touch buttons start, move, rotate, pause and drop the piece', async ({ page }) => {
      await openTetris(page, { piece: 'T' });
      await expectNoHorizontalOverflow(page);

      const controls = page.getByTestId('touch-controls');
      await expect(controls).toBeVisible();
      await controls.scrollIntoViewIfNeeded();

      const board = await page.getByTestId('tetris-board').boundingBox();
      const pad = await controls.boundingBox();
      expect(board).not.toBeNull();
      expect(pad).not.toBeNull();
      expect(pad?.y ?? 0).toBeGreaterThanOrEqual((board?.y ?? 0) + (board?.height ?? 0));

      const startX = (await readState(page)).active?.x ?? 0;

      // The first tap starts the round and still moves the piece.
      await controls.locator('[data-action="left"]').click();
      await expect.poll(() => readStatus(page)).toBe('running');
      await expect.poll(async () => (await readState(page)).active?.x).toBe(startX - 1);

      await controls.locator('[data-action="right"]').click();
      await controls.locator('[data-action="right"]').click();
      await expect.poll(async () => (await readState(page)).active?.x).toBe(startX + 1);

      await controls.locator('[data-action="rotate"]').click();
      const rotated = await readState(page);
      expect(rotated.active?.rotation).toBe(1);

      await controls.locator('[data-action="pause"]').click();
      await expect.poll(() => readStatus(page)).toBe('paused');
      await expect(page.getByTestId('overlay-title')).toHaveText('已暂停');
      await controls.locator('[data-action="pause"]').click();
      await expect.poll(() => readStatus(page)).toBe('running');

      await controls.locator('[data-action="hardDrop"]').click();
      await expect.poll(async () => lockedCellCount(await readState(page))).toBe(4);
      await expect.poll(() => readStatus(page)).toBe('running');
      await expectNoHorizontalOverflow(page);
    });

    test('stacks to the top, shows the game-over overlay and restarts', async ({ page }) => {
      await openTetris(page);
      const hardDrop = page.getByTestId('touch-controls').locator('[data-action="hardDrop"]');

      for (let index = 0; index < 60; index += 1) {
        if ((await readStatus(page)) === 'gameover') {
          break;
        }
        await hardDrop.click();
      }
      await expect.poll(() => readStatus(page), { timeout: 15_000 }).toBe('gameover');
      await expect(page.getByTestId('overlay-title')).toHaveText('堆到顶了');

      await page.getByTestId('overlay').getByRole('button', { name: '再来一局' }).click();
      await expect.poll(() => readStatus(page)).toBe('running');
      await expect(page.getByTestId('score')).toHaveText('0');
      await expectNoHorizontalOverflow(page);
    });
  });
}
