import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  lockedCellCount,
  openTetris,
  readState,
  readStatus,
  startGame,
  TETRIS_HEIGHT,
  TETRIS_WIDTH,
} from './tetris-helpers';

const EMPTY_ROW = '.'.repeat(TETRIS_WIDTH);

/** A bottom row with a two-cell gap so an O piece completes it. */
function boardWithBottomGap(): string[] {
  const gap = 2;
  const bottom = `${'I'.repeat(TETRIS_WIDTH - gap)}${'.'.repeat(gap)}`;
  return [...Array.from({ length: TETRIS_HEIGHT - 1 }, () => EMPTY_ROW), bottom];
}

test.describe('tetris gameplay', () => {
  test('hub card opens the game and the back link returns to the hub', async ({ page }) => {
    await page.goto('/');
    const card = page.getByTestId('game-card-tetris');
    await expect(card).toBeVisible();
    await expect(card).toContainText('俄罗斯方块');
    await card.click();

    await expect(page).toHaveURL(/#\/games\/tetris$/);
    await expect(page.getByTestId('tetris-game')).toBeVisible();
    await expect(page.locator('[data-testid="tetris-board"] canvas')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('堆出你的最高分');
    await expect(page.getByTestId('status')).toHaveText('待开始');

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('game-card-tetris')).toBeVisible();
    await expect(page.locator('[data-testid="tetris-board"] canvas')).toHaveCount(0);
  });

  test('keyboard moves and rotates the falling piece before it locks', async ({ page }) => {
    await openTetris(page, { piece: 'T' });
    await startGame(page);

    const spawned = await readState(page);
    expect(spawned.active?.type).toBe('T');
    expect(spawned.active?.rotation).toBe(0);
    const startX = spawned.active?.x ?? 0;

    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await readState(page)).active?.x).toBe(startX - 1);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await readState(page)).active?.x).toBe(startX + 1);

    await page.keyboard.press('ArrowUp');
    const rotated = await readState(page);
    expect(rotated.active?.rotation).toBe(1);

    await page.keyboard.press('Space');
    await expect.poll(async () => lockedCellCount(await readState(page))).toBe(4);
    await expect.poll(() => readStatus(page)).toBe('running');
  });

  test('clears a line with a hard drop and updates score and lines', async ({ page }) => {
    await openTetris(page, { piece: 'O', board: boardWithBottomGap() });
    await startGame(page);

    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('ArrowRight');
    }
    await expect.poll(async () => (await readState(page)).active?.x).toBe(8);

    await page.keyboard.press('Space');

    await expect(page.getByTestId('score')).toHaveText('100');
    await expect(page.getByTestId('lines')).toHaveText('1');
    await expect(page.getByTestId('level')).toHaveText('1');

    const state = await readState(page);
    expect(state.score).toBe(100);
    expect(state.lines).toBe(1);
    // Only the O piece's upper half survives once the completed row clears.
    expect(lockedCellCount(state)).toBe(2);
    expect(state.board[TETRIS_HEIGHT - 1]?.[8]).toBe('O');
    expect(state.board[TETRIS_HEIGHT - 1]?.[9]).toBe('O');
    await expect(page.getByTestId('overlay')).toBeHidden();
  });

  test('pause and continue freeze the run', async ({ page }) => {
    await openTetris(page, { piece: 'T' });
    await startGame(page);

    await page.keyboard.press('KeyP');
    await expect.poll(() => readStatus(page)).toBe('paused');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('已暂停');

    const frozen = await readState(page);
    await page.waitForTimeout(400);
    const still = await readState(page);
    expect(still.status).toBe('paused');
    expect(still.active?.x).toBe(frozen.active?.x);
    expect(still.active?.y).toBe(frozen.active?.y);

    await page.getByTestId('pause-button').click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('overlay')).toBeHidden();

    await page.getByTestId('pause-button').click();
    await expect.poll(() => readStatus(page)).toBe('paused');
    await page.getByTestId('overlay').getByRole('button', { name: '继续游戏' }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
  });

  test('stacks to the top, ends the run and restarts from the overlay', async ({ page }) => {
    await openTetris(page);
    await startGame(page);

    // Accelerated fall keeps this quick, while the last key is not Space so
    // the focused "play again" button cannot be activated by the same press.
    await page.keyboard.down('ArrowDown');
    await expect.poll(() => readStatus(page), { timeout: 30_000 }).toBe('gameover');
    await page.keyboard.up('ArrowDown');

    await expect(page.getByTestId('overlay-title')).toHaveText('堆到顶了');
    await expect(page.getByTestId('overlay-score')).toContainText('本局');
    await expect(page.getByTestId('status')).toHaveText('已结束');

    await page.getByTestId('overlay').getByRole('button', { name: '再来一局' }).click();
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('lines')).toHaveText('0');
    await expect(page.getByTestId('overlay')).toBeHidden();

    await page.keyboard.press('KeyR');
    await expect.poll(() => readStatus(page)).toBe('running');
    await expect(page.getByTestId('score')).toHaveText('0');

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-tetris')).toBeVisible();
    await expect(page.locator('[data-testid="tetris-board"] canvas')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});
