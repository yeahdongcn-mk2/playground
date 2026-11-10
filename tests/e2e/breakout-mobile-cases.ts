import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  openBreakout,
  readState,
} from './breakout-helpers';
import { endTouch, moveTouch, startTouch } from './touch-input';

/**
 * Shared breakout phone cases for the Chromium `mobile` project and the WebKit
 * `mobile-webkit` project. The paddle drag and no-horizontal-overflow checks
 * run on both engines; the two project entries only wire this module in, so
 * they cannot drift.
 */
export function defineBreakoutMobileCases(): void {
  test.describe('breakout on a phone viewport', () => {
    test('touch drags the paddle and the page does not overflow', async ({ page }) => {
      await openBreakout(page);
      await expectNoHorizontalOverflow(page);
      await expect(page.getByTestId('touch-hint')).toBeVisible();
      await expect(page.getByTestId('lives')).toHaveText('3');

      await page
        .getByTestId('overlay')
        .getByRole('button', { name: '开始游戏' })
        .click();
      await expect(page.getByTestId('overlay')).toBeHidden();
      await expect(page.getByTestId('status')).toHaveText('进行中');

      const board = page.getByTestId('breakout-board');
      const box = await board.boundingBox();
      expect(box).not.toBeNull();
      const x = box?.x ?? 0;
      const y = box?.y ?? 0;
      const width = box?.width ?? 0;
      const height = box?.height ?? 0;

      // Touch pointer events, not a mouse drag: the shared helper dispatches
      // the pointerdown / pointermove / pointerup sequence a finger produces on
      // both engines. The drag starts on the left and ends on the right, so the
      // paddle must follow to the right half of the court.
      const touchY = y + height * 0.82;
      const drag = await startTouch(page, { x: x + width * 0.15, y: touchY });
      await moveTouch(drag, { x: x + width * 0.5, y: touchY });
      await moveTouch(drag, { x: x + width * 0.88, y: touchY });
      await endTouch(drag);

      await expect
        .poll(async () => (await readState(page)).paddle.x)
        .toBeGreaterThan(320);
      await expectNoHorizontalOverflow(page);
    });
  });
}
