import { expect, test } from '@playwright/test';
import {
  HIGH_SCORE_KEY,
  expectNoHorizontalOverflow,
  openSnake,
  readState,
  readStatus,
  startGame,
} from './helpers';

test.describe('snake gameplay', () => {
  test('starts, eats the deterministic fruit, grows and persists the best score', async ({
    page,
  }) => {
    await openSnake(page, { food: '11,10' });
    await startGame(page);

    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });
    await page.keyboard.press('KeyP');
    await expect.poll(() => readStatus(page)).toBe('paused');

    await expect(page.getByTestId('length')).toHaveText('4');
    await expect(page.getByTestId('best')).toHaveText('10');
    await expect(page.getByTestId('speed')).toHaveText('1.04×');

    const state = await readState(page);
    expect(state.score).toBe(10);
    expect(state.stepMs).toBe(144);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), HIGH_SCORE_KEY),
    ).toBe('10');

    await page.reload();
    await expect(page.getByTestId('snake-canvas')).toBeVisible();
    await expect(page.getByTestId('best')).toHaveText('10');
    await expect(page.getByTestId('score')).toHaveText('0');
  });

  test('side panel pause and restart buttons work', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.getByRole('button', { name: '暂停' }).click();
    await expect.poll(() => readStatus(page)).toBe('paused');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect.poll(() => readStatus(page)).toBe('running');

    await page.getByRole('button', { name: '重开' }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('score')).toHaveText('0');
  });

  test('Space pauses, shows the overlay and resumes from the button', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.keyboard.press('Space');
    await expect.poll(() => readStatus(page)).toBe('paused');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('暂停中');

    const headBefore = (await readState(page)).snake[0];
    await page.waitForTimeout(400);
    expect((await readState(page)).snake[0]).toEqual(headBefore);

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

    await page.getByRole('button', { name: '再来一局' }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('length')).toHaveText('3');
    await expect(page.getByTestId('overlay')).toBeHidden();
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

  test('records a new best score after a short run', async ({ page }) => {
    await openSnake(page, { food: '11,10' });
    await startGame(page);
    await expect(page.getByTestId('score')).toHaveText('10', { timeout: 4000 });

    await page.keyboard.press('ArrowUp');
    await expect.poll(() => readStatus(page), { timeout: 8000 }).toBe('gameover');
    await expect(page.getByTestId('overlay-title')).toHaveText('新纪录！');

    const best = Number(await page.getByTestId('best').textContent());
    expect(best).toBeGreaterThanOrEqual(10);
    expect(await page.evaluate((key) => localStorage.getItem(key), HIGH_SCORE_KEY)).toBe(
      String(best),
    );

    await page.reload();
    await expect(page.getByTestId('best')).toHaveText(String(best));
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

  test('auto-pauses when the page becomes hidden', async ({ page }) => {
    await openSnake(page, { food: '0,0' });
    await startGame(page);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect.poll(() => readStatus(page)).toBe('paused');
    await expect(page.getByTestId('overlay-title')).toHaveText('暂停中');
  });
});

test.describe('snake on a phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('shows the D-pad under the board and can start the game', async ({ page }) => {
    await openSnake(page, { food: '11,10' });
    await expectNoHorizontalOverflow(page);

    const dpad = page.getByTestId('dpad');
    await expect(dpad).toBeVisible();
    await dpad.scrollIntoViewIfNeeded();

    const board = await page.getByTestId('snake-board').boundingBox();
    const pad = await dpad.boundingBox();
    expect(board).not.toBeNull();
    expect(pad).not.toBeNull();
    expect(pad?.y ?? 0).toBeGreaterThan(board?.y ?? 0);

    await dpad.locator('[data-direction="up"]').click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect.poll(async () => (await readState(page)).direction).toBe('up');
    await expect(page.getByTestId('overlay')).toBeHidden();

    await dpad.locator('.dpad-button--center').click();
    await expect.poll(() => readStatus(page)).toBe('paused');
    await dpad.locator('.dpad-button--center').click();
    await expect.poll(() => readStatus(page)).toBe('running');
  });
});
