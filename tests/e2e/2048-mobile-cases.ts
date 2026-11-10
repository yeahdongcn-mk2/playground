import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  MERGE_BOARD,
  open2048,
  readState,
} from './2048-helpers';
import { endTouch, moveTouch, startTouch } from './touch-input';

/**
 * Shared 2048 phone cases for the Chromium `mobile` project and the WebKit
 * `mobile-webkit` project. The swipe-to-start / merge / score assertion runs on
 * both engines; the two project entries only wire this module in, so they
 * cannot drift.
 */
export function define2048MobileCases(): void {
  test.describe('2048 on a phone viewport', () => {
    test('swipes from the ready overlay to start, merge and score', async ({ page }) => {
      await open2048(page, { board: MERGE_BOARD });
      await expectNoHorizontalOverflow(page);
      await expect(page.getByTestId('swipe-hint')).toBeVisible();

      const board = page.getByTestId('2048-board');
      const box = await board.boundingBox();
      expect(box).not.toBeNull();
      const startX = (box?.x ?? 0) + 12;
      const endX = startX + 108;
      const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

      // Touch pointer events, not a mouse drag: the shared helper dispatches
      // the pointerdown / pointermove / pointerup sequence a finger produces on
      // both engines. The swipe starts on the overlay backdrop beside the card,
      // so it also covers swipe-to-start; the overlay bubbles the events up to
      // the stage listener while it is still visible.
      const swipe = await startTouch(page, { x: startX, y });
      await moveTouch(swipe, { x: startX + 54, y });
      await moveTouch(swipe, { x: endX, y });
      await endTouch(swipe);

      await expect(page.getByTestId('overlay')).toBeHidden();
      await expect(page.getByTestId('status')).toHaveText('进行中');
      await expect(page.getByTestId('score')).toHaveText('8');
      await expect.poll(async () => (await readState(page)).board[0]?.[3]).toBe(4);
      await expectNoHorizontalOverflow(page);
    });
  });
}
