import {
  cellLocator,
  activeIntervalCount,
  destroyDebugGame,
  installIntervalProbe,
  LOSS_MINE_CLICK,
  LOSS_MINES,
  LOSS_SAFE_CLICK,
  openMinesweeper,
  readState,
  readStatus,
  WIN_CLICK,
  WIN_MINES,
} from './minesweeper-helpers';
import {
  expect,
  installListenerProbe,
  listenerCount,
  test,
  trackProbeTarget,
} from './fixtures';

test.describe('minesweeper gameplay', () => {
  test('hub card opens the game, shows the ready HUD, and the back link returns to the hub', async ({
    page,
  }) => {
    await page.goto('/');
    const card = page.getByTestId('game-card-minesweeper');
    await expect(card).toBeVisible();
    await expect(card).toContainText('扫雷');
    await expect(card).toContainText('左键翻开格子');
    await expect(card.locator('svg.minesweeper-card-art')).toBeVisible();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
    await expect(page.getByTestId('game-card-tetris')).toBeVisible();
    await expect(page.getByTestId('game-card-2048')).toBeVisible();
    await expect(page.getByTestId('game-card-breakout')).toBeVisible();

    await card.click();
    await expect(page).toHaveURL(/#\/games\/minesweeper$/);
    await expect(page.getByTestId('minesweeper-game')).toBeVisible();
    await expect(page.getByTestId('minesweeper-board')).toBeVisible();
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('overlay')).toBeHidden();
    // The normal entry must not install the debug seam.
    expect(
      await page.evaluate(
        () => (window as unknown as { __playground?: unknown }).__playground,
      ),
    ).toBeUndefined();

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('game-card-minesweeper')).toBeVisible();
    await expect(page.locator('[data-cell]')).toHaveCount(0);
  });

  test('left click reveals, right click toggles a flag and updates the remaining count', async ({
    page,
  }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    const mineCell = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);

    // Flags are allowed before the first reveal and do not start the clock.
    await mineCell.click({ button: 'right' });
    await expect(mineCell).toHaveAttribute('data-state', 'flagged');
    await expect(page.getByTestId('remaining-mines')).toHaveText('9');
    await expect(page.getByTestId('flag-count')).toHaveText('1');
    expect((await readState(page)).status).toBe('ready');

    // A flagged cell cannot be revealed by a left click.
    await mineCell.click();
    await expect(mineCell).toHaveAttribute('data-state', 'flagged');
    expect((await readState(page)).status).toBe('ready');

    await mineCell.click({ button: 'right' });
    await expect(mineCell).toHaveAttribute('data-state', 'hidden');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('flag-count')).toHaveText('0');

    const safeCell = cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);
    await safeCell.click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(safeCell).toHaveAttribute('data-revealed', 'true');
    await expect(page.getByTestId('overlay')).toBeHidden();

    // The clock only starts on the first reveal; the HUD must show it moving.
    await expect
      .poll(async () => (await readState(page)).elapsedMs)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => page.getByTestId('timer').textContent(), { timeout: 4_000 })
      .not.toBe('0:00');

    const state = await readState(page);
    expect(state.status).toBe('playing');
    expect(state.board[LOSS_SAFE_CLICK.row]?.[LOSS_SAFE_CLICK.col]?.revealed).toBe(true);
    expect(state.remainingMines).toBe(10);
  });

  test('hitting a mine ends the game, reveals every mine, freezes the clock and restarts', async ({
    page,
  }) => {
    await installIntervalProbe(page);
    await openMinesweeper(page, { mines: LOSS_MINES });
    const correctFlag = cellLocator(page, 4, 0);
    await correctFlag.click({ button: 'right' });
    expect(await activeIntervalCount(page)).toBe(0);

    await cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await activeIntervalCount(page)).toBe(1);

    await cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col).click();
    await expect(page.getByTestId('status')).toHaveText('踩雷结束');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('踩到地雷');
    await expect(page.getByTestId('overlay-body')).toContainText('用时');
    await expect(page.getByTestId('overlay-primary')).toHaveText('再来一局');

    const lost = await readState(page);
    expect(lost.status).toBe('lost');
    expect(lost.explodedCell).toEqual(LOSS_MINE_CLICK);
    // The clock interval stops as soon as the game is lost.
    expect(await activeIntervalCount(page)).toBe(0);
    const exploded = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect(exploded).toHaveAttribute('data-state', 'exploded');
    await expect(exploded).toHaveAttribute('data-mine', 'true');
    // A correctly flagged mine keeps its flag; the other mines are exposed.
    await expect(correctFlag).toHaveAttribute('data-state', 'flagged');
    expect(await correctFlag.getAttribute('data-mine')).toBeNull();
    await expect(page.locator('[data-state="mine"]')).toHaveCount(8);
    await expect(page.locator('[data-mine="true"]')).toHaveCount(9);

    // The engine clock is frozen after the loss.
    await page.waitForTimeout(700);
    expect((await readState(page)).elapsedMs).toBe(lost.elapsedMs);

    await page.getByTestId('overlay-primary').click();
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.locator('[data-state="hidden"]')).toHaveCount(81);
  });

  test('revealing every safe cell wins the game', async ({ page }) => {
    await openMinesweeper(page, { mines: WIN_MINES });
    await cellLocator(page, WIN_CLICK.row, WIN_CLICK.col).click();

    await expect(page.getByTestId('status')).toHaveText('胜利');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('扫雷成功');
    await expect(page.getByTestId('overlay-primary')).toHaveText('再来一局');

    const state = await readState(page);
    expect(state.status).toBe('won');
    const safeCells = state.board.flat().filter((cell) => !cell.mine);
    expect(safeCells).toHaveLength(71);
    expect(safeCells.every((cell) => cell.revealed)).toBe(true);
    await expect(page.locator('[data-revealed="true"]')).toHaveCount(71);
    // A win does not need to expose the mines.
    await expect(page.locator('[data-mine="true"]')).toHaveCount(0);

    await page.getByTestId('overlay-primary').click();
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.locator('[data-state="hidden"]')).toHaveCount(81);
  });

  test('the restart button resets a running game', async ({ page }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    await cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col).click();
    await cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col).click({
      button: 'right',
    });
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('remaining-mines')).toHaveText('9');

    await page.getByTestId('restart-button').click();
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('flag-count')).toHaveText('0');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.locator('[data-state="hidden"]')).toHaveCount(81);
  });

  test('destroy and leaving the route release board listeners and the clock interval', async ({
    page,
  }) => {
    await installListenerProbe(page);
    await installIntervalProbe(page);
    await page.goto('/');
    const baselineKeydown = await listenerCount(page, 'window', 'keydown');

    await openMinesweeper(page, { mines: LOSS_MINES });
    await trackProbeTarget(page, 'board', '[data-testid="minesweeper-board"]');
    expect(await listenerCount(page, 'board', 'click')).toBe(1);
    expect(await listenerCount(page, 'board', 'contextmenu')).toBe(1);
    expect(await activeIntervalCount(page)).toBe(0);

    await cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await readStatus(page)).toBe('playing');
    expect(await activeIntervalCount(page)).toBe(1);

    // Destroy the mount directly, without the route change aborting the mount
    // signal first, so cleanup inside GameHandle.destroy is observable.
    await destroyDebugGame(page);
    await expect.poll(() => activeIntervalCount(page)).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'click')).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'contextmenu')).toBe(0);
    expect(await listenerCount(page, 'window', 'keydown')).toBe(baselineKeydown);

    // The route stays usable and a second normal mount/teardown is clean too.
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-minesweeper')).toBeVisible();
    await openMinesweeper(page, { mines: LOSS_MINES });
    await trackProbeTarget(page, 'board', '[data-testid="minesweeper-board"]');
    await cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await activeIntervalCount(page)).toBe(1);

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-minesweeper')).toBeVisible();
    await expect.poll(() => activeIntervalCount(page)).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'click')).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'contextmenu')).toBe(0);
    expect(await listenerCount(page, 'window', 'keydown')).toBe(baselineKeydown);
  });
});
