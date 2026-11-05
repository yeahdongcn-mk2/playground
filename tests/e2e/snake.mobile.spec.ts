import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, openSnake, readState, readStatus } from './snake-helpers';

test.describe('snake on a phone viewport', () => {
  test('shows the D-pad under the board, starts and steers the game', async ({ page }) => {
    await openSnake(page, { food: '11,10' });
    await expectNoHorizontalOverflow(page);

    const dpad = page.getByTestId('dpad');
    await expect(dpad).toBeVisible();
    await dpad.scrollIntoViewIfNeeded();

    const board = await page.getByTestId('snake-board').boundingBox();
    const pad = await dpad.boundingBox();
    expect(board).not.toBeNull();
    expect(pad).not.toBeNull();
    expect(pad?.y ?? 0).toBeGreaterThanOrEqual((board?.y ?? 0) + (board?.height ?? 0));

    await dpad.locator('[data-direction="up"]').click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect.poll(async () => (await readState(page)).direction).toBe('up');
    await expect(page.getByTestId('overlay')).toBeHidden();

    await dpad.locator('.snake-key--center').click();
    await expect.poll(() => readStatus(page)).toBe('paused');
    await dpad.locator('.snake-key--center').click();
    await expect.poll(() => readStatus(page)).toBe('running');

    // A fresh run keeps the final steering check away from the wall.
    await page.keyboard.press('KeyR');
    await expect.poll(() => readStatus(page)).toBe('running');

    // Focus stays on the D-pad after a tap; arrow keys must still steer.
    await dpad.locator('[data-direction="up"]').click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await readState(page)).direction).toBe('right');
  });

  test('Space pauses after a D-pad direction tap', async ({ page }) => {
    await openSnake(page);
    const dpad = page.getByTestId('dpad');
    await dpad.scrollIntoViewIfNeeded();

    // A reversal is ignored while ready, so focus stays on the left button.
    await dpad.locator('[data-direction="left"]').click();
    await page.keyboard.press('Space');
    await expect.poll(() => readStatus(page)).toBe('running');

    await dpad.locator('[data-direction="up"]').click();
    await page.keyboard.press('Space');
    await expect.poll(() => readStatus(page)).toBe('paused');
  });

  test('can die and restart from the overlay on a phone', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    const dpad = page.getByTestId('dpad');
    await dpad.locator('[data-direction="up"]').click();
    await expect.poll(() => readStatus(page)).toBe('running');

    await expect.poll(() => readStatus(page), { timeout: 9000 }).toBe('gameover');
    await expect(page.getByTestId('overlay-title')).toHaveText('撞上了');

    await page.getByTestId('overlay').getByRole('button', { name: '再来一局' }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expectNoHorizontalOverflow(page);
  });
});
