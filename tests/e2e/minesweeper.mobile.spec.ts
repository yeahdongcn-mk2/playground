import { expect, test } from './fixtures';
import {
  cancelCellPress,
  cellLocator,
  endCellPress,
  expectCleanBoard,
  expectInsideViewport,
  expectNoHorizontalOverflow,
  LOSS_MINE_CLICK,
  LOSS_MINES,
  LOSS_SAFE_CLICK,
  longPressCell,
  moveCellPress,
  openMinesweeper,
  readState,
  readStatus,
  startCellPress,
  tapCell,
  WIN_CLICK,
  WIN_MINES,
} from './minesweeper-helpers';

test.describe('minesweeper on a phone viewport', () => {
  test('opens with the board, HUD and restart / back entries inside the viewport', async ({
    page,
  }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    await expectNoHorizontalOverflow(page);

    await expect(page.getByTestId('minesweeper-board')).toBeVisible();
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.getByTestId('overlay')).toBeHidden();
    expect((await readState(page)).status).toBe('ready');

    await expect(page.getByTestId('touch-hint')).toBeVisible();
    await expect(page.getByTestId('touch-hint')).toContainText('长按');
    expect(
      await page
        .getByTestId('minesweeper-board')
        .evaluate((board) => getComputedStyle(board).userSelect),
    ).toBe('none');
    await expectInsideViewport(
      page,
      page.getByRole('link', { name: /返回大厅/ }),
      'back link',
    );
    await expectInsideViewport(page, page.getByTestId('remaining-mines'), 'remaining mines');
    await expectInsideViewport(page, page.getByTestId('timer'), 'timer');
    await expectInsideViewport(
      page,
      page.getByTestId('mobile-restart-button'),
      'restart button',
    );

    // The 9x9 grid keeps every cell a usable touch target on a 412 px viewport.
    const cellBox = await cellLocator(page, 0, 0).boundingBox();
    expect(cellBox, 'cell should have a bounding box').not.toBeNull();
    expect(cellBox?.width ?? 0).toBeGreaterThanOrEqual(36);
    expect(cellBox?.height ?? 0).toBeGreaterThanOrEqual(36);
    expect(cellBox?.width ?? 0).toBeCloseTo(cellBox?.height ?? 0, 1);
  });

  test('a tap reveals and a long press toggles a flag exactly once', async ({ page }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });

    await tapCell(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(
      cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col),
    ).toHaveAttribute('data-revealed', 'true');

    const mine = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect(mine).toHaveAttribute('data-state', 'flagged');
    await expect(mine).toHaveText('⚑');
    await expect(page.getByTestId('remaining-mines')).toHaveText('9');
    await expect(page.getByTestId('flag-count')).toHaveText('1');
    // A long press must not toggle twice through the synthetic contextmenu.
    expect((await readState(page)).flaggedCount).toBe(1);

    // The restart entry next to the board works from a dirty board.
    const mobileRestart = page.getByTestId('mobile-restart-button');
    const restartBox = await mobileRestart.boundingBox();
    expect(restartBox).not.toBeNull();
    await page.touchscreen.tap(
      (restartBox?.x ?? 0) + (restartBox?.width ?? 0) / 2,
      (restartBox?.y ?? 0) + (restartBox?.height ?? 0) / 2,
    );
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expectCleanBoard(page);

    // Holding a flagged cell clears the flag; the first hold sets it again.
    await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect(mine).toHaveAttribute('data-state', 'flagged');
    await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect(mine).toHaveAttribute('data-state', 'hidden');
    await expect(mine).toHaveText('');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('flag-count')).toHaveText('0');
    expect((await readState(page)).flaggedCount).toBe(0);
    await expectNoHorizontalOverflow(page);
  });

  test('moving, scrolling or cancelling a press never toggles a flag', async ({ page }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    const mine = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);

    // Movement beyond the tolerance cancels the pending long press and click.
    const moved = await startCellPress(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await page.waitForTimeout(120);
    await moveCellPress(moved, 40, 0);
    await page.waitForTimeout(600);
    await endCellPress(moved);
    await expect(mine).toHaveAttribute('data-state', 'hidden');
    expect(await readStatus(page)).toBe('ready');

    // pointercancel cancels as well.
    const cancelled = await startCellPress(
      page,
      LOSS_MINE_CLICK.row,
      LOSS_MINE_CLICK.col,
    );
    await page.waitForTimeout(120);
    await cancelCellPress(cancelled);
    await page.waitForTimeout(600);
    await expect(mine).toHaveAttribute('data-state', 'hidden');
    expect(await readStatus(page)).toBe('ready');

    // pointerleave (the finger leaves the board) also cancels. A real finger
    // would already trip the move tolerance above, so this synthetic event
    // covers the dedicated handler without claiming a physical path.
    const leftBoard = await startCellPress(
      page,
      LOSS_MINE_CLICK.row,
      LOSS_MINE_CLICK.col,
    );
    await page.waitForTimeout(120);
    await page.getByTestId('minesweeper-board').dispatchEvent('pointerleave');
    await page.waitForTimeout(600);
    await endCellPress(leftBoard);
    await expect(mine).toHaveAttribute('data-state', 'hidden');
    expect(await readStatus(page)).toBe('ready');

    // Scrolling the page cancels the pending press.
    const scrolled = await startCellPress(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.scrollBy(0, 160));
    await page.waitForTimeout(600);
    await endCellPress(scrolled);
    await expect(mine).toHaveAttribute('data-state', 'hidden');
    expect(await readStatus(page)).toBe('ready');

    // Positive control: cancellation did not break the timer itself.
    await page.evaluate(() => window.scrollTo(0, 0));
    await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect(mine).toHaveAttribute('data-state', 'flagged');
    expect((await readState(page)).flaggedCount).toBe(1);
    await expectNoHorizontalOverflow(page);
  });

  test('a touch contextmenu is always prevented and never toggles twice', async ({
    page,
  }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    const mine = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);

    // Without an active hold, a touch contextmenu is prevented and ignored.
    const preventedWithoutHold = await mine.evaluate((cell) => {
      const event = new PointerEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
      });
      cell.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(preventedWithoutHold).toBe(true);
    expect((await readState(page)).flaggedCount).toBe(0);

    // If the native menu wins the race against the 500 ms timer, it owns the
    // flag and disarms the timer so the hold still toggles exactly once.
    const press = await startCellPress(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await page.waitForTimeout(120);
    const preventedDuringHold = await mine.evaluate((cell) => {
      const event = new PointerEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
      });
      cell.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(preventedDuringHold).toBe(true);
    await page.waitForTimeout(600);
    await endCellPress(press);

    await expect(mine).toHaveAttribute('data-state', 'flagged');
    expect((await readState(page)).flaggedCount).toBe(1);
  });

  test('tapping a mine ends the game, explains the loss and restarts from the overlay', async ({
    page,
  }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    await tapCell(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);
    await expect(page.getByTestId('status')).toHaveText('进行中');

    await tapCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect(page.getByTestId('status')).toHaveText('踩雷结束');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('踩到地雷');
    await expectInsideViewport(
      page,
      page.getByTestId('overlay-primary'),
      'overlay restart button',
    );
    await expectNoHorizontalOverflow(page);

    const restart = page.getByTestId('overlay-primary');
    const box = await restart.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expectCleanBoard(page);
    await expectNoHorizontalOverflow(page);
  });

  test('tapping the last safe cell wins the game', async ({ page }) => {
    await openMinesweeper(page, { mines: WIN_MINES });
    await tapCell(page, WIN_CLICK.row, WIN_CLICK.col);

    await expect(page.getByTestId('status')).toHaveText('胜利');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('扫雷成功');
    await expectInsideViewport(
      page,
      page.getByTestId('overlay-primary'),
      'overlay restart button',
    );
    expect((await readState(page)).status).toBe('won');
    await expect(page.locator('[data-revealed="true"]')).toHaveCount(71);
    await expectNoHorizontalOverflow(page);
  });
});
