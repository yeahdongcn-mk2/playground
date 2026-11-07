import {
  activeIntervalCount,
  abortListenerCount,
  cellLocator,
  destroyDebugGame,
  difficultyButton,
  expectActiveDifficulty,
  expectCleanBoard,
  expectClockRunning,
  expectNoDebugSeam,
  installAbortProbe,
  installIntervalProbe,
  LOSS_MINES,
  mineSignature,
  openMinesweeper,
  readState,
  submitCustomDifficulty,
} from './minesweeper-helpers';
import {
  expect,
  installListenerProbe,
  listenerCount,
  test,
  trackProbeTarget,
} from './fixtures';

test.describe('minesweeper difficulty selector', () => {
  test('three presets rebuild the board, HUD and summary and clear the old game', async ({
    page,
  }) => {
    await installIntervalProbe(page);
    await openMinesweeper(page);

    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    // The sidebar restart must stay fully usable on the 1440×1000 desktop
    // viewport: the difficulty card lives below it, not above it.
    await expect(page.getByTestId('restart-button')).toBeInViewport({ ratio: 1 });
    await expectActiveDifficulty(page, 'beginner');

    // Dirty the beginner board and start its clock, so the rebuild must clear
    // the revealed cells / flags / overlay and stop the old interval.
    await cellLocator(page, 8, 8).click();
    await expectClockRunning(page);
    expect(await activeIntervalCount(page)).toBe(1);
    expect(
      await page.locator('[data-revealed="true"]').count(),
    ).toBeGreaterThan(0);

    await difficultyButton(page, 'intermediate').click();
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('remaining-mines')).toHaveText('40');
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    await expect(page.getByTestId('minesweeper-board')).toHaveAttribute(
      'aria-label',
      '16 × 16 扫雷棋盘',
    );
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expectActiveDifficulty(page, 'intermediate');
    await expectCleanBoard(page);
    expect(await activeIntervalCount(page)).toBe(0);
    expect(await readState(page).then((state) => [state.rows, state.cols, state.mineCount])).toEqual(
      [16, 16, 40],
    );

    await difficultyButton(page, 'expert').click();
    await expect(page.locator('[data-cell]')).toHaveCount(480);
    await expect(page.getByTestId('remaining-mines')).toHaveText('99');
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');
    await expect(page.getByTestId('minesweeper-board')).toHaveAttribute(
      'aria-label',
      '16 × 30 扫雷棋盘',
    );
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expectActiveDifficulty(page, 'expert');
    await expectCleanBoard(page);
    expect(await activeIntervalCount(page)).toBe(0);
    expect(await readState(page).then((state) => [state.rows, state.cols, state.mineCount])).toEqual(
      [16, 30, 99],
    );

    await difficultyButton(page, 'beginner').click();
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
    await expectActiveDifficulty(page, 'beginner');
    await expectCleanBoard(page);
    expect(await activeIntervalCount(page)).toBe(0);
  });

  test('custom boards apply, sync an equal preset and survive a restart', async ({
    page,
  }) => {
    await openMinesweeper(page);

    await submitCustomDifficulty(page, 12, 12, 20);
    await expect(page.locator('[data-cell]')).toHaveCount(144);
    await expect(page.getByTestId('remaining-mines')).toHaveText('20');
    await expect(page.getByTestId('board-summary')).toHaveText('12 × 12 · 20 雷');
    await expect(page.getByTestId('minesweeper-board')).toHaveAttribute(
      'aria-label',
      '12 × 12 扫雷棋盘',
    );
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expectActiveDifficulty(page, null);
    await expect(page.getByTestId('custom-rows')).toHaveValue('12');
    await expect(page.getByTestId('custom-cols')).toHaveValue('12');
    await expect(page.getByTestId('custom-mines')).toHaveValue('20');

    // Restart keeps the custom board instead of falling back to a preset.
    await cellLocator(page, 11, 11).click();
    await expectClockRunning(page);
    await page.getByTestId('restart-button').click();
    await expect(page.locator('[data-cell]')).toHaveCount(144);
    await expect(page.getByTestId('board-summary')).toHaveText('12 × 12 · 20 雷');
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expectActiveDifficulty(page, null);
    await expectCleanBoard(page);

    // A custom board equal to a preset lights that preset up; another custom
    // board does not.
    await submitCustomDifficulty(page, 16, 16, 40);
    await expectActiveDifficulty(page, 'intermediate');
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');

    await submitCustomDifficulty(page, 16, 30, 99);
    await expectActiveDifficulty(page, 'expert');
    await expect(page.locator('[data-cell]')).toHaveCount(480);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');

    await submitCustomDifficulty(page, 10, 12, 15);
    await expectActiveDifficulty(page, null);
    await expect(page.locator('[data-cell]')).toHaveCount(120);
    await expect(page.getByTestId('board-summary')).toHaveText('10 × 12 · 15 雷');
  });

  test('an invalid custom board only shows a readable error and leaves the game running', async ({
    page,
  }) => {
    await installIntervalProbe(page);
    await openMinesweeper(page);
    await difficultyButton(page, 'intermediate').click();
    await expect(page.locator('[data-cell]')).toHaveCount(256);

    await cellLocator(page, 15, 15).click();
    await expectClockRunning(page);
    const firstState = await readState(page);
    const hiddenCell = firstState.board
      .flat()
      .find((cell) => !cell.revealed && !cell.flagged);
    if (!hiddenCell) {
      throw new Error('expected a hidden cell to flag before the invalid submit');
    }
    await cellLocator(page, hiddenCell.row, hiddenCell.col).click({ button: 'right' });
    await expect(page.getByTestId('remaining-mines')).toHaveText('39');
    const before = await readState(page);
    expect(before.flaggedCount).toBe(1);
    const beforeSignature = mineSignature(before);
    const beforeRevealed = before.board.flat().filter((cell) => cell.revealed).length;
    expect(await activeIntervalCount(page)).toBe(1);

    const error = page.getByTestId('difficulty-error');
    await expect(error).toBeHidden();

    // Mines must stay smaller than the cell count.
    await submitCustomDifficulty(page, 8, 8, 64);
    await expect(error).toBeVisible();
    await expect(error).toHaveText('雷数必须小于格子总数（64）。');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    await expect(page.getByTestId('remaining-mines')).toHaveText('39');
    await expect(page.getByTestId('flag-count')).toHaveText('1');
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('timer')).not.toHaveText('0:00');
    await expectActiveDifficulty(page, 'intermediate');
    expect(await activeIntervalCount(page)).toBe(1);

    const afterMineError = await readState(page);
    expect(afterMineError.status).toBe('playing');
    expect(afterMineError.flaggedCount).toBe(1);
    expect([afterMineError.rows, afterMineError.cols, afterMineError.mineCount]).toEqual([
      16, 16, 40,
    ]);
    expect(mineSignature(afterMineError)).toBe(beforeSignature);
    expect(
      afterMineError.board.flat().filter((cell) => cell.revealed).length,
    ).toBe(beforeRevealed);

    // Out-of-bounds dimensions are reported against the field that failed.
    await submitCustomDifficulty(page, 99, 9, 10);
    await expect(error).toHaveText('行数必须是 5 到 30 之间的整数。');
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await activeIntervalCount(page)).toBe(1);

    // A 5×5 board leaves 16 mines at most once the 3×3 safe zone is reserved.
    await submitCustomDifficulty(page, 5, 5, 17);
    await expect(error).toHaveText(
      '雷数过多：首点安全区占 9 格，最多只能放 16 颗雷。',
    );
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await activeIntervalCount(page)).toBe(1);

    // Blank and non-integer values are rejected instead of clamped.
    await submitCustomDifficulty(page, '', 9, 10);
    await expect(error).toHaveText('行数不能为空。');
    await submitCustomDifficulty(page, '9.5', 9, 10);
    await expect(error).toHaveText('行数必须是整数。');
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');

    // A later valid custom board clears the alert and rebuilds normally.
    await submitCustomDifficulty(page, 9, 9, 10);
    await expect(error).toBeHidden();
    await expectActiveDifficulty(page, 'beginner');
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.getByTestId('flag-count')).toHaveText('0');
    await expectCleanBoard(page);
    expect(await activeIntervalCount(page)).toBe(0);

    // Restart is a fresh game action: it clears a stale alert and restores the
    // form values to the active config instead of keeping the rejected input.
    await submitCustomDifficulty(page, 8, 8, 64);
    await expect(error).toBeVisible();
    await page.getByTestId('restart-button').click();
    await expect(error).toBeHidden();
    await expect(page.getByTestId('custom-rows')).toHaveValue('9');
    await expect(page.getByTestId('custom-cols')).toHaveValue('9');
    await expect(page.getByTestId('custom-mines')).toHaveValue('10');
    await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
  });

  test('Enter submits the custom form from a number input', async ({ page }) => {
    await installIntervalProbe(page);
    await openMinesweeper(page);

    await page.getByTestId('custom-rows').fill('12');
    await page.getByTestId('custom-cols').fill('12');
    await page.getByTestId('custom-mines').fill('20');
    await page.getByTestId('custom-rows').press('Enter');
    await expect(page.locator('[data-cell]')).toHaveCount(144);
    await expect(page.getByTestId('board-summary')).toHaveText('12 × 12 · 20 雷');
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    expect(await activeIntervalCount(page)).toBe(0);

    // Enter also owns the invalid path: only the alert changes.
    await page.getByTestId('custom-rows').fill('8');
    await page.getByTestId('custom-cols').fill('8');
    await page.getByTestId('custom-mines').fill('64');
    await page.getByTestId('custom-mines').press('Enter');
    await expect(page.getByTestId('difficulty-error')).toBeVisible();
    await expect(page.getByTestId('difficulty-error')).toHaveText(
      '雷数必须小于格子总数（64）。',
    );
    await expect(page.locator('[data-cell]')).toHaveCount(144);
    await expect(page.getByTestId('board-summary')).toHaveText('12 × 12 · 20 雷');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    expect(await activeIntervalCount(page)).toBe(0);
  });

  test('repeated preset switches keep the clock, board and selector listeners bounded', async ({
    page,
  }) => {
    await installListenerProbe(page);
    await installAbortProbe(page);
    await installIntervalProbe(page);
    await page.goto('/');
    const baselineAbort = await abortListenerCount(page);

    await openMinesweeper(page);
    await trackProbeTarget(page, 'board', '[data-testid="minesweeper-board"]');
    await trackProbeTarget(page, 'customForm', '[data-testid="custom-difficulty-form"]');
    expect(await listenerCount(page, 'board', 'click')).toBe(1);
    expect(await listenerCount(page, 'board', 'contextmenu')).toBe(1);
    expect(await listenerCount(page, 'customForm', 'submit')).toBe(1);
    expect(await abortListenerCount(page)).toBe(baselineAbort + 1);

    await cellLocator(page, 8, 8).click();
    await expectClockRunning(page);
    expect(await activeIntervalCount(page)).toBe(1);

    const switches = [
      { id: 'intermediate', cells: 256, reveal: { row: 15, col: 15 } },
      { id: 'expert', cells: 480, reveal: { row: 15, col: 29 } },
      { id: 'beginner', cells: 81, reveal: { row: 8, col: 8 } },
      { id: 'intermediate', cells: 256, reveal: { row: 15, col: 15 } },
    ] as const;

    for (const next of switches) {
      await difficultyButton(page, next.id).click();
      await expect(page.locator('[data-cell]')).toHaveCount(next.cells);
      await expect(page.getByTestId('status')).toHaveText('待开始');
      await expect(page.getByTestId('timer')).toHaveText('0:00');
      await expectActiveDifficulty(page, next.id);
      // The rebuild stops the previous clock and reuses the same stable
      // listener targets instead of adding one per switch.
      expect(await activeIntervalCount(page)).toBe(0);
      expect(await listenerCount(page, 'board', 'click')).toBe(1);
      expect(await listenerCount(page, 'board', 'contextmenu')).toBe(1);
      expect(await listenerCount(page, 'customForm', 'submit')).toBe(1);
      expect(await abortListenerCount(page)).toBe(baselineAbort + 1);

      // Start the new clock so the next switch also has to stop a live one.
      await cellLocator(page, next.reveal.row, next.reveal.col).click();
      await expectClockRunning(page);
      expect(await activeIntervalCount(page)).toBe(1);
    }

    await destroyDebugGame(page);
    await expect.poll(() => activeIntervalCount(page)).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'click')).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'contextmenu')).toBe(0);
    await expect.poll(() => listenerCount(page, 'customForm', 'submit')).toBe(0);
    await expect.poll(() => abortListenerCount(page)).toBe(baselineAbort);
    await expectNoDebugSeam(page);
  });

  test('rebuilding from a finished game moves focus out of the hidden overlay', async ({
    page,
  }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    // Pre-fill a board that equals the intermediate preset. Filling moves focus
    // into the sidebar, but losing the game hands it back to the overlay, so
    // the submit below really starts with focus inside the overlay.
    await page.getByTestId('custom-rows').fill('16');
    await page.getByTestId('custom-cols').fill('16');
    await page.getByTestId('custom-mines').fill('40');
    await cellLocator(page, 7, 4).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await cellLocator(page, 0, 0).click();
    await expect(page.getByTestId('status')).toHaveText('踩雷结束');
    await expect(page.getByTestId('overlay-primary')).toBeFocused();

    // Submit the form without clicking it. A click would move focus out of the
    // overlay before `applyConfig()` runs, so the rescue branch would never be
    // exercised; `requestSubmit()` keeps focus on the overlay button while
    // firing the same submit listener a real submission uses.
    await page.getByTestId('custom-difficulty-form').evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
    });
    await expect(page.getByTestId('overlay')).toBeHidden();
    // The overlay button is hidden now, so focus must land on the active preset.
    await expect(difficultyButton(page, 'intermediate')).toBeFocused();
    await expectActiveDifficulty(page, 'intermediate');
    await expect(page.locator('[data-cell]')).toHaveCount(256);
  });

  test('a custom board submitted from the overlay focuses the custom submit', async ({
    page,
  }) => {
    // 12×12 with 20 fixed mines is a valid custom board without a matching
    // preset, so the rescue branch must fall back to the custom submit button.
    const mines = [
      { row: 0, col: 0 },
      ...Array.from({ length: 12 }, (_, col) => ({ row: 4, col })),
      ...Array.from({ length: 7 }, (_, col) => ({ row: 5, col })),
    ];
    await openMinesweeper(page, {
      rows: 12,
      cols: 12,
      mineCount: 20,
      mines,
    });
    await cellLocator(page, 7, 4).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await cellLocator(page, 0, 0).click();
    await expect(page.getByTestId('status')).toHaveText('踩雷结束');
    await expect(page.getByTestId('overlay-primary')).toBeFocused();

    // The form already holds the active custom board, so submitting it while
    // the overlay owns focus rebuilds the same board and moves focus to the
    // visible custom submit button instead of the hidden overlay button.
    await page.getByTestId('custom-difficulty-form').evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
    });
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('custom-difficulty-submit')).toBeFocused();
    await expectActiveDifficulty(page, null);
    await expect(page.locator('[data-cell]')).toHaveCount(144);
  });

  test('a debug board marks its matching preset as pressed on load', async ({ page }) => {
    await openMinesweeper(page, { rows: 16, cols: 30, mineCount: 99 });
    await expectActiveDifficulty(page, 'expert');
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');
    await expect(page.locator('[data-cell]')).toHaveCount(480);
  });

  test('the hub card advertises presets and custom boards', async ({ page }) => {
    await page.goto('/');
    const card = page.getByTestId('game-card-minesweeper');
    await expect(card).toBeVisible();
    await expect(card).toContainText('初级');
    await expect(card).toContainText('自定义');
    await expect(card).toContainText('行、列与雷数');
  });
});
