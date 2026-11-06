import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  MERGE_BOARD,
  NEAR_STUCK_BOARD,
  open2048,
  readState,
  readStatus,
  startGame,
} from './2048-helpers';

test.describe('2048 gameplay', () => {
  test('hub card opens the game and the back link returns to the hub', async ({ page }) => {
    await page.goto('/');
    const card = page.getByTestId('game-card-2048');
    await expect(card).toBeVisible();
    await expect(card).toContainText('2048');
    await expect(card.locator('svg.game-2048-card-art')).toBeVisible();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
    await expect(page.getByTestId('game-card-tetris')).toBeVisible();

    await card.click();
    await expect(page).toHaveURL(/#\/games\/2048$/);
    await expect(page.getByTestId('2048-game')).toBeVisible();
    await expect(page.locator('[data-testid="2048-board"] canvas')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('合并出 2048');
    await expect(page.getByTestId('status')).toHaveText('准备开始');
    // The normal entry must not install the read-only debug seam.
    expect(
      await page.evaluate(
        () => (window as unknown as { __playground?: unknown }).__playground,
      ),
    ).toBeUndefined();

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('game-card-2048')).toBeVisible();
    await expect(page.locator('[data-testid="2048-board"] canvas')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test('arrow keys and WASD slide, merge and score', async ({ page }) => {
    await open2048(page, { board: MERGE_BOARD });

    // The first direction key starts the run and applies the move at once.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('score')).toHaveText('8');
    await expect.poll(async () => (await readState(page)).board[0]?.[0]).toBe(4);
    expect((await readState(page)).board[1]?.[0]).toBe(4);
    expect(await page.getByTestId('max-tile').textContent()).toBe('4');

    await page.keyboard.press('KeyW');
    await expect(page.getByTestId('score')).toHaveText('16');
    await expect.poll(async () => (await readState(page)).board[0]?.[0]).toBe(8);
    await expect(page.getByTestId('best')).toHaveText('16');

    // R restarts a run in progress and keeps the best score.
    await page.keyboard.press('KeyR');
    await expect.poll(() => readStatus(page)).toBe('playing');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('best')).toHaveText('16');

    // The best score lives in namespaced storage and survives a reload.
    expect(
      await page.evaluate(() => localStorage.getItem('playground:v1:2048.best')),
    ).toBe('16');
    await page.reload();
    await expect(page.locator('[data-testid="2048-board"] canvas')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('合并出 2048');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('best')).toHaveText('16');
    await expectNoHorizontalOverflow(page);
  });

  test('ends when no move is possible and restarts three ways', async ({ page }) => {
    await open2048(page, { board: NEAR_STUCK_BOARD });
    await startGame(page);

    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => readStatus(page)).toBe('gameover');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('无路可走');
    await expect(page.getByTestId('overlay-score')).toContainText('本局 4 分');
    await expect(page.getByTestId('status')).toHaveText('已结束');

    // 1. The overlay's primary action.
    await page.getByTestId('overlay').getByRole('button', { name: '再来一局' }).click();
    await expect.poll(() => readStatus(page)).toBe('playing');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('overlay')).toBeHidden();
    expect((await readState(page)).board).toEqual(
      NEAR_STUCK_BOARD.map((row) => [...row]),
    );

    // 2. The side-panel restart button after another game over.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => readStatus(page)).toBe('gameover');
    await expect(page.getByTestId('restart-button')).toBeEnabled();
    await page.getByTestId('restart-button').click();
    await expect.poll(() => readStatus(page)).toBe('playing');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('overlay')).toBeHidden();

    // 3. R after the fixed board reaches game over again.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => readStatus(page)).toBe('gameover');
    await page.keyboard.press('KeyR');
    await expect.poll(() => readStatus(page)).toBe('playing');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});
