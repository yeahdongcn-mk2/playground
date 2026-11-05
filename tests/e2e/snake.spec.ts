import { expect, test } from './fixtures';
import {
  HIGH_SCORE_KEY,
  openSnake,
  readState,
  readStatus,
  startGame,
  trackPageErrors,
} from './snake-helpers';

test.describe('snake gameplay', () => {
  test('starts, eats the deterministic fruit, grows and persists the best score', async ({
    page,
  }) => {
    await openSnake(page, { food: '11,10' });
    await startGame(page);

    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });
    await expect(page.getByTestId('length')).toHaveText('4');
    await expect(page.getByTestId('best')).toHaveText('10');
    await expect(page.getByTestId('speed')).toHaveText('1.04×');

    await page.keyboard.press('KeyP');
    await expect.poll(() => readStatus(page)).toBe('paused');

    const state = await readState(page);
    expect(state.score).toBe(10);
    expect(state.stepMs).toBe(144);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), HIGH_SCORE_KEY),
    ).toBe('10');

    await page.reload();
    await expect(page.locator('[data-testid="snake-board"] canvas')).toBeVisible();
    await expect(page.getByTestId('best')).toHaveText('10');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect.poll(() => readStatus(page)).toBe('ready');
  });

  test('side panel pause, continue and restart buttons work', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect.poll(() => readStatus(page)).toBe('paused');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect.poll(() => readStatus(page)).toBe('running');

    await page.getByRole('button', { name: '重开', exact: true }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('length')).toHaveText('3');
  });

  test('Space pauses with an overlay, freezes the run and resumes', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);
    const scoreBefore = (await readState(page)).score;

    await page.keyboard.press('Space');
    await expect.poll(() => readStatus(page)).toBe('paused');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('已暂停');

    const headBefore = (await readState(page)).snake[0];
    await page.waitForTimeout(400);
    const frozen = await readState(page);
    expect(frozen.status).toBe('paused');
    expect(frozen.score).toBe(scoreBefore);
    expect(frozen.snake[0]).toEqual(headBefore);

    // A second Space press resumes; pressing it again pauses.
    await page.keyboard.press('Space');
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await page.keyboard.press('Space');
    await expect.poll(() => readStatus(page)).toBe('paused');

    await page.getByRole('button', { name: '继续游戏' }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('overlay')).toBeHidden();
  });

  test('P and Escape also toggle pause', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.keyboard.press('KeyP');
    await expect.poll(() => readStatus(page)).toBe('paused');
    await page.keyboard.press('KeyP');
    await expect.poll(() => readStatus(page)).toBe('running');

    await page.keyboard.press('Escape');
    await expect.poll(() => readStatus(page)).toBe('paused');
    await page.keyboard.press('Escape');
    await expect.poll(() => readStatus(page)).toBe('running');
  });

  test('dies against the wall and starts a fresh round from the overlay', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);
    await page.keyboard.press('ArrowUp');

    await expect.poll(() => readStatus(page), { timeout: 8000 }).toBe('gameover');
    await expect(page.getByTestId('overlay-title')).toHaveText('撞上了');
    await expect(page.getByTestId('overlay-score')).toContainText('本局 0 分');
    await expect(page.getByTestId('score')).toHaveText('0');

    await page.getByTestId('overlay').getByRole('button', { name: '再来一局' }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('length')).toHaveText('3');
    await expect(page.getByTestId('overlay')).toBeHidden();
  });

  test('Space and Enter restart after game over', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => readStatus(page), { timeout: 8000 }).toBe('gameover');

    await page.keyboard.press('Space');
    await expect.poll(() => readStatus(page)).toBe('running');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => readStatus(page), { timeout: 8000 }).toBe('gameover');
    await page.keyboard.press('Enter');
    await expect.poll(() => readStatus(page)).toBe('running');
  });

  test('shows the new-record overlay when a run beats the stored best', async ({ page }) => {
    await openSnake(page, { food: '11,10' });
    await startGame(page);
    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });
    await expect(page.getByTestId('best')).toHaveText('10');

    await page.keyboard.press('ArrowUp');
    await expect.poll(() => readStatus(page), { timeout: 8000 }).toBe('gameover');
    await expect(page.getByTestId('overlay-title')).toHaveText('新纪录！');
    await expect(page.getByTestId('overlay-body')).toContainText('刷新了你的最高分');
  });

  test('does not overwrite a higher stored best score', async ({ page }) => {
    await openSnake(page, { best: 100, food: '11,10' });
    await expect(page.getByTestId('best')).toHaveText('100');

    await startGame(page);
    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => readStatus(page), { timeout: 8000 }).toBe('gameover');

    await expect(page.getByTestId('best')).toHaveText('100');
    await expect(page.getByTestId('overlay-title')).toHaveText('撞上了');
    expect(await page.evaluate((key) => localStorage.getItem(key), HIGH_SCORE_KEY)).toBe('100');
  });

  test('replaces a lower stored best with the new score', async ({ page }) => {
    await openSnake(page, { best: 5, food: '11,10' });
    await expect(page.getByTestId('best')).toHaveText('5');

    await startGame(page);
    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });
    await page.keyboard.press('KeyP');
    await expect.poll(() => readStatus(page)).toBe('paused');

    await expect(page.getByTestId('best')).toHaveText('10');
    expect(await page.evaluate((key) => localStorage.getItem(key), HIGH_SCORE_KEY)).toBe('10');
  });

  test('restarts immediately with R', async ({ page }) => {
    await openSnake(page, { food: '11,10' });
    await startGame(page);
    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });

    await page.keyboard.press('KeyR');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('length')).toHaveText('3');
  });
});

test.describe('additional input paths', () => {
  test('swiping on the board steers the snake', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    const board = await page.getByTestId('snake-board').boundingBox();
    expect(board).not.toBeNull();
    const centerX = (board?.x ?? 0) + (board?.width ?? 0) / 2;
    const centerY = (board?.y ?? 0) + (board?.height ?? 0) / 2;

    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX, centerY - 90, { steps: 6 });
    await page.mouse.up();

    await expect.poll(async () => (await readState(page)).direction).toBe('up');
  });

  test('WASD keys also steer the snake', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.keyboard.press('KeyW');
    await expect.poll(async () => (await readState(page)).snake[0]?.y).toBeLessThan(10);
    await page.keyboard.press('KeyD');
    await expect.poll(async () => (await readState(page)).direction).toBe('right');
  });

  test('auto-pauses when the page becomes hidden', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect.poll(() => readStatus(page)).toBe('paused');
    await expect(page.getByTestId('overlay-title')).toHaveText('已暂停');
  });

  test('auto-pauses when the window loses focus', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(() => readStatus(page)).toBe('paused');
    await expect(page.getByTestId('overlay-title')).toHaveText('已暂停');
  });

  test('the hero CTA opens the snake game', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('enter-snake').click();
    await expect(page).toHaveURL(/#\/games\/snake/);
    await expect(page.locator('[data-testid="snake-board"] canvas')).toBeVisible();
  });

  test('hub card opens the game and the back link returns to the hub', async ({ page }) => {
    await page.goto('/');
    const card = page.getByTestId('game-card-snake');
    await expect(card).toBeVisible();
    await card.click();

    await expect(page).toHaveURL(/#\/games\/snake/);
    await expect(page.locator('[data-testid="snake-board"] canvas')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('吃掉果实，别撞墙');

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
    await expect(page.locator('[data-testid="snake-board"] canvas')).toHaveCount(0);
  });

  test('Enter on the back link navigates instead of being captured by the game', async ({ page }) => {
    await openSnake(page);
    await page.getByRole('link', { name: /返回大厅/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/$/);
  });

  test('plays without console or page errors', async ({ page }) => {
    const errors = trackPageErrors(page);
    await openSnake(page, { food: '11,10' });
    await startGame(page);
    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });
    await page.keyboard.press('KeyP');
    await expect.poll(() => readStatus(page)).toBe('paused');
    await page.keyboard.press('KeyR');
    await expect.poll(() => readStatus(page)).toBe('running');
    expect(errors).toEqual([]);
  });
});
