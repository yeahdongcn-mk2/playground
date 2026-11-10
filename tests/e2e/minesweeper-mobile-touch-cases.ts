import { expect, test } from './fixtures';
import {
  cancelCellPress,
  cellLocator,
  destroyDebugGame,
  dispatchTouchPointer,
  endCellPress,
  expectCleanBoard,
  expectInsideViewport,
  expectNoDebugSeam,
  expectNoHorizontalOverflow,
  LOSS_MINE_CLICK,
  LOSS_MINES,
  LOSS_SAFE_CLICK,
  longPressCell,
  moveCellPress,
  openMinesweeper,
  readState,
  readStatus,
  setDebugConfig,
  startCellPress,
  tapCell,
  WIN_CLICK,
  WIN_MINES,
} from './minesweeper-helpers';

/**
 * Shared touch-gesture cases for the Chromium `mobile` project and the WebKit
 * `mobile-webkit` project. Taps, long presses, the two-pointer suppression,
 * cancellation, restart focus and the win / loss paths run against the same
 * assertions on both engines; only the helper that injects the held touch
 * differs, so the two platform entries cannot drift apart.
 */
export function defineMinesweeperMobileTouchCases(): void {
  test.describe('minesweeper touch gestures on a phone viewport', () => {
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
      // After a restart the focus must land on a visible control. On a phone the
      // compact button next to the board is the preferred target.
      await expect(mobileRestart).toBeFocused();
      await expectInsideViewport(page, mobileRestart, 'restart button');
  
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
  
    test('a long hold that clears a flag still swallows the release click', async ({ page }) => {
      await openMinesweeper(page, { mines: LOSS_MINES });
      const mine = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
  
      // The finger stays down 1100 ms after the 500 ms long-press timer. A fixed
      // suppression window would expire before this release click, revealing the
      // cell; the gesture-level flag must keep swallowing it.
      await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col, 1_600);
      // Let the release click land so a regression would reveal the cell.
      await page.waitForTimeout(150);
      await expect(mine).toHaveAttribute('data-state', 'flagged');
      await expect.poll(async () => (await readState(page)).flaggedCount).toBe(1);
      await expect.poll(() => readStatus(page)).toBe('ready');
  
      // A second long hold clears the flag; its release click arrives even later
      // and must still be swallowed instead of revealing the cell.
      await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col, 1_600);
      // Let the second release click land; it must not reveal the cell either.
      await page.waitForTimeout(150);
      await expect(mine).toHaveAttribute('data-state', 'hidden');
      await expect(mine).toHaveText('');
      await expect.poll(async () => (await readState(page)).flaggedCount).toBe(0);
      await expect.poll(() => readStatus(page)).toBe('ready');
    });
  
    test('a second pointer cannot clear the first pointer click suppression', async ({
      page,
    }) => {
      await openMinesweeper(page, { mines: LOSS_MINES });
      const mine = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
  
      // Start from a flag so the first pointer's stale release click would reveal
      // the mine instead of being a no-op on an already flagged cell.
      await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
      await expect(mine).toHaveAttribute('data-state', 'flagged');
  
      // First finger starts a second long hold and clears the flag at 500 ms;
      // its synthetic click is injected manually because CDP multi-touch does not
      // generate one, and it must stay suppressed while the finger is down.
      await dispatchTouchPointer(
        page,
        LOSS_MINE_CLICK.row,
        LOSS_MINE_CLICK.col,
        'pointerdown',
        11,
      );
      await page.waitForTimeout(650);
      await expect(mine).toHaveAttribute('data-state', 'hidden');
  
      // A second finger starts and ends its own gesture elsewhere on the board.
      await dispatchTouchPointer(
        page,
        LOSS_SAFE_CLICK.row,
        LOSS_SAFE_CLICK.col,
        'pointerdown',
        12,
      );
      await dispatchTouchPointer(
        page,
        LOSS_SAFE_CLICK.row,
        LOSS_SAFE_CLICK.col,
        'pointerup',
        12,
      );
      // The first finger lifts (pointerup) before its click, and the suppression
      // must survive the other pointer until that click is consumed.
      await dispatchTouchPointer(
        page,
        LOSS_MINE_CLICK.row,
        LOSS_MINE_CLICK.col,
        'pointerup',
        11,
      );
      await dispatchTouchPointer(
        page,
        LOSS_MINE_CLICK.row,
        LOSS_MINE_CLICK.col,
        'click',
        11,
      );
  
      await expect(mine).toHaveAttribute('data-state', 'hidden');
      await expect.poll(() => readStatus(page)).toBe('ready');
      expect((await readState(page)).flaggedCount).toBe(0);
    });
  
    test('restarting while a finger holds a cell cancels the pending long press', async ({
      page,
    }) => {
      await openMinesweeper(page, { mines: LOSS_MINES });
      const mine = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
  
      // Activate restart inside the same pointerdown turn. Waiting for a separate
      // Playwright call could let the 500 ms timer fire first under CI load, and
      // the restarted board would hide that failure.
      await page.evaluate(() => {
        const board = document.querySelector('[data-testid="minesweeper-board"]');
        const restart = document.querySelector<HTMLButtonElement>(
          '[data-testid="mobile-restart-button"]',
        );
        board?.addEventListener('pointerdown', () => restart?.click(), { once: true });
      });
  
      const held = await startCellPress(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
      await expect(page.getByTestId('status')).toHaveText('待开始');
  
      // Wait past the original hold deadline. Without cancelling the gesture the
      // stale timer would flag the fresh board when it fires.
      await page.waitForTimeout(600);
      await endCellPress(held);
      // The release click after the cancellation must not reveal a cell either.
      await expect(mine).toHaveAttribute('data-state', 'hidden');
      await expect(page.getByTestId('flag-count')).toHaveText('0');
      await expectCleanBoard(page);
      expect(await readStatus(page)).toBe('ready');
    });
  
    test('rebuilding while a finger holds a cell keeps the long press cancelled and swallows its release click', async ({
      page,
    }) => {
      await openMinesweeper(page, { mines: LOSS_MINES });
      const held = await startCellPress(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
      await page.waitForTimeout(120);
  
      // Rebuild the board to 16x16 while the first gesture is still pending.
      await setDebugConfig(page, {
        rows: 16,
        cols: 16,
        mines: 40,
        firstClickSafe: true,
      });
      await expect(page.locator('[data-cell]')).toHaveCount(256);
      await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
      await expect(page.getByTestId('status')).toHaveText('待开始');
  
      // The old 500 ms timer is gone, so holding past the threshold must not
      // flag the rebuilt board.
      await page.waitForTimeout(600);
      await endCellPress(held);
      // The release click belongs to the cancelled gesture and still targets the
      // rebuilt board; it must be swallowed instead of revealing a cell.
      await page.waitForTimeout(150);
      await expect(page.getByTestId('status')).toHaveText('待开始');
      await expect(page.getByTestId('flag-count')).toHaveText('0');
      await expect(page.getByTestId('remaining-mines')).toHaveText('40');
      await expectCleanBoard(page);
      expect(await readStatus(page)).toBe('ready');
      expect((await readState(page)).flaggedCount).toBe(0);
  
      // The debug seam is still a debug-only test seam and is removed on destroy.
      await destroyDebugGame(page);
      await expectNoDebugSeam(page);
    });
  
    test('destroying the mount while a finger holds a cell cancels the pending long press', async ({
      page,
    }) => {
      await openMinesweeper(page, { mines: LOSS_MINES });
      const mine = cellLocator(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
  
      const held = await startCellPress(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
      try {
        await destroyDebugGame(page);
  
        // Without cancelling the gesture the 500 ms timer would still run after
        // destroy and toggle a flag through sync() on the detached view.
        await page.waitForTimeout(600);
      } finally {
        await endCellPress(held);
      }
      await expect(mine).toHaveAttribute('data-state', 'hidden');
      await expect(page.getByTestId('flag-count')).toHaveText('0');
      await expect(page.getByTestId('minesweeper-game')).toHaveAttribute(
        'data-status',
        'ready',
      );
      await expectNoDebugSeam(page);
    });
  
    test('restarting from the sidebar focuses the visible compact restart on a phone', async ({
      page,
    }) => {
      await openMinesweeper(page, { mines: LOSS_MINES });
      await tapCell(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);
      await expect(page.getByTestId('status')).toHaveText('进行中');
  
      const sidebarRestart = page.getByTestId('restart-button');
      // The sidebar restart stays visible in the stacked phone layout but can be
      // below the fold. Restarting from it must not leave focus off-screen.
      await sidebarRestart.scrollIntoViewIfNeeded();
      await sidebarRestart.click();
      await expect(page.getByTestId('status')).toHaveText('待开始');
      const compactRestart = page.getByTestId('mobile-restart-button');
      await expect(compactRestart).toBeFocused();
      await expectInsideViewport(page, compactRestart, 'compact restart after restart');
      await expect(sidebarRestart).not.toBeFocused();
    });
  
    test('cancelled presses never toggle a flag and do not swallow the next tap', async ({ page }) => {
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
  
      // Cancelled gestures must not leave state that swallows the next tap.
      await tapCell(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);
      await expect(
        cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col),
      ).toHaveAttribute('data-revealed', 'true');
      await expect.poll(() => readStatus(page)).toBe('playing');
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
}
