import {
  abortListenerCount,
  cellLocator,
  activeIntervalCount,
  destroyDebugGame,
  expectCleanBoard,
  expectNoDebugSeam,
  installAbortProbe,
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
import type { MinesweeperSnapshot } from '../../src/games/minesweeper/engine';
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
    await expectNoDebugSeam(page);

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
    // Players see the flag glyph, not the data-* implementation detail.
    await expect(mineCell).toHaveText('⚑');
    await expect(page.getByTestId('remaining-mines')).toHaveText('9');
    await expect(page.getByTestId('flag-count')).toHaveText('1');
    expect((await readState(page)).status).toBe('ready');

    // A flagged cell cannot be revealed by a left click.
    await mineCell.click();
    await expect(mineCell).toHaveAttribute('data-state', 'flagged');
    await expect(mineCell).toHaveText('⚑');
    expect((await readState(page)).status).toBe('ready');

    await mineCell.click({ button: 'right' });
    await expect(mineCell).toHaveAttribute('data-state', 'hidden');
    await expect(mineCell).toHaveText('');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('flag-count')).toHaveText('0');

    const safeCell = cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);
    await safeCell.click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(safeCell).toHaveAttribute('data-revealed', 'true');
    // A blank revealed cell stays visually empty.
    await expect(safeCell).toHaveText('');
    await expect(page.getByTestId('overlay')).toBeHidden();

    // Right-click must suppress the browser menu. Dispatch the event on an
    // already revealed cell so the handler's flag toggle is a no-op. Without
    // event.preventDefault() in the view this assertion fails.
    const contextMenuPrevented = await safeCell.evaluate((cell) => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      cell.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(contextMenuPrevented).toBe(true);
    expect((await readState(page)).flaggedCount).toBe(0);

    // The clock only starts on the first reveal; the HUD must show it moving.
    await expect
      .poll(async () => (await readState(page)).elapsedMs)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => page.getByTestId('timer').textContent(), { timeout: 4_000 })
      .not.toBe('0:00');
    const timerText = (await page.getByTestId('timer').textContent()) ?? '';
    expect(timerText).toMatch(/^\d+:\d{2}$/);
    await page.waitForTimeout(1_200);
    const laterTimerText = (await page.getByTestId('timer').textContent()) ?? '';
    expect(laterTimerText).toMatch(/^\d+:\d{2}$/);
    expect(laterTimerText).not.toBe(timerText);

    const state = await readState(page);
    expect(state.status).toBe('playing');
    expect(state.board[LOSS_SAFE_CLICK.row]?.[LOSS_SAFE_CLICK.col]?.revealed).toBe(true);
    expect(state.remainingMines).toBe(10);

    // A revealed number cell must render the engine's adjacent-mine count as
    // text; (5, 0) touches (4, 0) and (4, 1) in LOSS_MINES.
    const numbered = cellLocator(page, 5, 0);
    const numberedAdjacent = (await readState(page)).board[5]?.[0]?.adjacentMines;
    expect(numberedAdjacent).toBe(2);
    await expect(numbered).toHaveAttribute('data-state', 'revealed');
    await expect(numbered).toHaveText(String(numberedAdjacent));
  });

  test('Enter activates a focused cell through the keyboard click path', async ({ page }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    const safe = cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);

    // Keyboard activation dispatches a click with detail 0. This is a plain
    // regression guard that the keyboard path still reveals a focused cell.
    await safe.focus();
    await expect(safe).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(safe).toHaveAttribute('data-revealed', 'true');
    await expect(page.getByTestId('status')).toHaveText('进行中');
  });

  test('malformed debug mine layouts fall back to the seeded random board', async ({ page }) => {
    // Every entry must be rejected wholesale: too few cells, duplicate cells,
    // an empty coordinate token (Number('') must not become row 0), an
    // out-of-bounds cell and a trailing field.
    const malformedLayouts = [
      '0,0;0,1;0,2;0,3;0,4;0,5;0,6;0,7;0,8',
      '0,0;0,0;0,1;0,2;0,3;0,4;0,5;0,6;0,7;0,8',
      ',0;0,1;0,2;0,3;0,4;0,5;0,6;0,7;0,8;1,0',
      '0,0;0,1;0,2;0,3;0,4;0,5;0,6;0,7;0,8;9,0',
      '0,0;0,1;0,2;0,3;0,4;0,5;0,6;0,7;0,8;0,0,1',
    ];
    const mineSignature = (state: MinesweeperSnapshot): string =>
      state.board
        .flat()
        .filter((cell) => cell.mine)
        .map((cell) => `${cell.row},${cell.col}`)
        .join(';');

    const signatures: string[] = [];
    for (const layout of malformedLayouts) {
      await openMinesweeper(page, { rawMines: layout });
      // The first reveal is always safe, so it plants the fallback layout.
      await cellLocator(page, 8, 8).click();
      await expect(page.getByTestId('status')).toHaveText('进行中');
      const state = await readState(page);
      expect(state.status).toBe('playing');
      expect(state.board.flat().filter((cell) => cell.mine)).toHaveLength(10);
      signatures.push(mineSignature(state));
    }

    // No layout parameter must use the same debug seed and land on the same
    // board as every rejected layout. Uncaught page errors also fail this test
    // through the shared fixture; a thrown mount surfaces as an assertion
    // timeout because the app renders its route error instead.
    await openMinesweeper(page);
    await cellLocator(page, 8, 8).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    const fallbackSignature = mineSignature(await readState(page));
    expect(signatures).toEqual(malformedLayouts.map(() => fallbackSignature));
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
    // The finished overlay takes focus so keyboard users can restart at once.
    await expect(page.getByTestId('overlay-primary')).toBeFocused();

    const lost = await readState(page);
    expect(lost.status).toBe('lost');
    expect(lost.explodedCell).toEqual(LOSS_MINE_CLICK);
    // The clock interval stops as soon as the game is lost.
    expect(await activeIntervalCount(page)).toBe(0);
    const exploded = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect(exploded).toHaveAttribute('data-state', 'exploded');
    await expect(exploded).toHaveAttribute('data-mine', 'true');
    await expect(exploded).toHaveText('✹');
    // A correctly flagged mine keeps its flag; the other mines are exposed.
    await expect(correctFlag).toHaveAttribute('data-state', 'flagged');
    expect(await correctFlag.getAttribute('data-mine')).toBeNull();
    await expect(correctFlag).toHaveText('⚑');
    await expect(page.locator('[data-state="mine"]')).toHaveCount(8);
    await expect(page.locator('[data-state="mine"]')).toHaveText(
      Array.from({ length: 8 }, () => '✹'),
    );
    await expect(page.locator('[data-mine="true"]')).toHaveCount(9);

    // Both the engine clock and the visible HUD stay frozen after the loss.
    const frozenTimer = (await page.getByTestId('timer').textContent()) ?? '';
    expect(frozenTimer).toMatch(/^\d+:\d{2}$/);
    await page.waitForTimeout(700);
    expect((await readState(page)).elapsedMs).toBe(lost.elapsedMs);
    expect((await page.getByTestId('timer').textContent()) ?? '').toBe(frozenTimer);

    await page.getByTestId('overlay-primary').click();
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.locator('[data-state="hidden"]')).toHaveCount(81);
    await expect(page.getByTestId('restart-button')).toBeFocused();
    await expectCleanBoard(page);
  });

  test('revealing every safe cell wins the game', async ({ page }) => {
    await openMinesweeper(page, { mines: WIN_MINES });
    await cellLocator(page, WIN_CLICK.row, WIN_CLICK.col).click();

    await expect(page.getByTestId('status')).toHaveText('胜利');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('扫雷成功');
    await expect(page.getByTestId('overlay-primary')).toHaveText('再来一局');
    await expect(page.getByTestId('overlay-primary')).toBeFocused();

    const state = await readState(page);
    expect(state.status).toBe('won');
    const safeCells = state.board.flat().filter((cell) => !cell.mine);
    expect(safeCells).toHaveLength(71);
    expect(safeCells.every((cell) => cell.revealed)).toBe(true);
    await expect(page.locator('[data-revealed="true"]')).toHaveCount(71);
    // A win does not need to expose the mines.
    await expect(page.locator('[data-mine="true"]')).toHaveCount(0);

    // Every revealed number renders the engine's adjacent count as text.
    const numbered = safeCells.find((cell) => cell.adjacentMines > 0);
    expect(numbered).toBeDefined();
    if (numbered) {
      await expect(cellLocator(page, numbered.row, numbered.col)).toHaveText(
        String(numbered.adjacentMines),
      );
    }

    await page.getByTestId('overlay-primary').click();
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.locator('[data-state="hidden"]')).toHaveCount(81);
    await expect(page.getByTestId('restart-button')).toBeFocused();
    await expectCleanBoard(page);
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
    // The compact touch restart is hidden on desktop, so focus stays on the
    // sidebar button that the player used.
    await expect(page.getByTestId('mobile-restart-button')).toBeHidden();
    await expect(page.getByTestId('restart-button')).toBeFocused();
    await expectCleanBoard(page);
  });

  test('destroy and leaving the route release board listeners and the clock interval', async ({
    page,
  }) => {
    await installListenerProbe(page);
    await installIntervalProbe(page);
    await installAbortProbe(page);
    await page.goto('/');
    const baselineKeydown = await listenerCount(page, 'window', 'keydown');
    const baselineAbort = await abortListenerCount(page);

    await openMinesweeper(page, { mines: LOSS_MINES });
    await trackProbeTarget(page, 'board', '[data-testid="minesweeper-board"]');
    expect(await listenerCount(page, 'board', 'click')).toBe(1);
    expect(await listenerCount(page, 'board', 'contextmenu')).toBe(1);
    expect(await activeIntervalCount(page)).toBe(0);
    // The view bridges the mount signal onto its own listener AbortController.
    expect(await abortListenerCount(page)).toBe(baselineAbort + 1);

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
    // The mount-signal bridge is removed explicitly, and the debug seam is gone.
    await expect.poll(() => abortListenerCount(page)).toBe(baselineAbort);
    await expectNoDebugSeam(page);

    // The route stays usable and a second normal mount/teardown is clean too.
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-minesweeper')).toBeVisible();
    await openMinesweeper(page, { mines: LOSS_MINES });
    await trackProbeTarget(page, 'board', '[data-testid="minesweeper-board"]');
    expect(await abortListenerCount(page)).toBe(baselineAbort + 1);
    await cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await activeIntervalCount(page)).toBe(1);

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-minesweeper')).toBeVisible();
    await expect.poll(() => activeIntervalCount(page)).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'click')).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'contextmenu')).toBe(0);
    await expect.poll(() => abortListenerCount(page)).toBe(baselineAbort);
    expect(await listenerCount(page, 'window', 'keydown')).toBe(baselineKeydown);
    await expectNoDebugSeam(page);
  });
});
