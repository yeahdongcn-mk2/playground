import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  openBreakout,
  readState,
} from './breakout-helpers';

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

    // Real touch input, not a mouse drag: Chromium turns this into the same
    // pointer events a finger produces. The drag starts on the left and ends on
    // the right, so the paddle must follow to the right half of the court.
    const client = await page.context().newCDPSession(page);
    const touchY = y + height * 0.82;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: x + width * 0.15, y: touchY }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + width * 0.5, y: touchY }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + width * 0.88, y: touchY }],
    });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect
      .poll(async () => (await readState(page)).paddle.x)
      .toBeGreaterThan(320);
    await expectNoHorizontalOverflow(page);
  });
});
