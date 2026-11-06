import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  MERGE_BOARD,
  open2048,
  readState,
} from './2048-helpers';

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

    // Real touch input, not a mouse drag: Chromium turns this into the same
    // pointerdown/pointerup pair a finger produces. The swipe starts on the
    // overlay backdrop beside the card, so it also covers swipe-to-start.
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX + 54, y }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: endX, y }],
    });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('score')).toHaveText('8');
    await expect.poll(async () => (await readState(page)).board[0]?.[3]).toBe(4);
    await expectNoHorizontalOverflow(page);
  });
});
