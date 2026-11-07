import {
  activeIntervalCount,
  abortListenerCount,
  cellLocator,
  destroyDebugGame,
  expectInsideViewport,
  expectNoDebugSeam,
  expectNoHorizontalOverflow,
  installAbortProbe,
  installIntervalProbe,
  mineSignature,
  openMinesweeper,
  readState,
  setDebugConfig,
} from './minesweeper-helpers';
import {
  expect,
  installListenerProbe,
  listenerCount,
  test,
  trackProbeTarget,
} from './fixtures';

/**
 * Forty mines for a 16x16 board: a full row, a partial row and another full
 * row. The lower full row is a barrier: the fixed reveal at (15, 15) floods
 * the region below it and reaches numbered border cells without revealing the
 * safe cells above, so the game keeps playing.
 */
const INTERMEDIATE_MINES = [
  ...Array.from({ length: 16 }, (_, col) => ({ row: 0, col })),
  ...Array.from({ length: 8 }, (_, col) => ({ row: 5, col })),
  ...Array.from({ length: 16 }, (_, col) => ({ row: 8, col })),
];

/** Bottom-right cell used for deterministic first reveals. */
const BOTTOM_RIGHT_16 = { row: 15, col: 15 } as const;
const BOTTOM_RIGHT_30 = { row: 15, col: 29 } as const;

test.describe('minesweeper board configuration', () => {
  test('renders 16x16/40, 16x30/99 and the default 9x9/10 board', async ({ page }) => {
    await openMinesweeper(page, { rows: 16, cols: 16, mineCount: 40 });
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('remaining-mines')).toHaveText('40');
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    await expect(page.getByTestId('minesweeper-board')).toHaveAttribute(
      'aria-label',
      '16 × 16 扫雷棋盘',
    );
    let state = await readState(page);
    expect([state.rows, state.cols, state.mineCount]).toEqual([16, 16, 40]);
    expect(
      await page.getByTestId('minesweeper-stage').evaluate((stage) => {
        const style = getComputedStyle(stage);
        return {
          rows: style.getPropertyValue('--rows').trim(),
          cols: style.getPropertyValue('--cols').trim(),
        };
      }),
    ).toEqual({ rows: '16', cols: '16' });

    await openMinesweeper(page, { rows: 16, cols: 30, mineCount: 99 });
    await expect(page.locator('[data-cell]')).toHaveCount(480);
    await expect(page.getByTestId('remaining-mines')).toHaveText('99');
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');
    state = await readState(page);
    expect([state.rows, state.cols, state.mineCount]).toEqual([16, 30, 99]);

    await openMinesweeper(page);
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
    await expect(page.getByTestId('minesweeper-board')).toHaveAttribute(
      'aria-label',
      '9 × 9 扫雷棋盘',
    );
    state = await readState(page);
    expect([state.rows, state.cols, state.mineCount]).toEqual([9, 9, 10]);
  });

  test('a fixed mine layout renders on a custom board and flood-reveals numbers', async ({
    page,
  }) => {
    await openMinesweeper(page, {
      rows: 16,
      cols: 16,
      mineCount: 40,
      mines: INTERMEDIATE_MINES,
    });
    await cellLocator(page, BOTTOM_RIGHT_16.row, BOTTOM_RIGHT_16.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');

    const state = await readState(page);
    expect(state.status).toBe('playing');
    expect(state.board[BOTTOM_RIGHT_16.row]?.[BOTTOM_RIGHT_16.col]?.mine).toBe(false);
    // The injected layout is kept exactly, in row-major order.
    expect(mineSignature(state)).toBe(
      INTERMEDIATE_MINES.map((mine) => `${mine.row},${mine.col}`).join(';'),
    );
    expect(state.board.flat().filter((cell) => cell.mine)).toHaveLength(40);

    // The bottom-right reveal floods through the blank area up to the mines.
    const revealedCount = state.board.flat().filter((cell) => cell.revealed).length;
    expect(revealedCount).toBeGreaterThan(1);
    await expect(page.locator('[data-revealed="true"]')).toHaveCount(revealedCount);

    // A revealed border cell renders the engine's adjacent-mine count.
    const numbered = state.board
      .flat()
      .find((cell) => cell.revealed && cell.adjacentMines > 0);
    expect(numbered).toBeDefined();
    if (numbered) {
      const button = cellLocator(page, numbered.row, numbered.col);
      await expect(button).toHaveAttribute('data-state', 'revealed');
      await expect(button).toHaveText(String(numbered.adjacentMines));
    }

    // Restart keeps the configured 16x16/40 board and the fixed layout.
    await page.getByTestId('restart-button').click();
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('remaining-mines')).toHaveText('40');
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    await expect(page.locator('[data-revealed="true"]')).toHaveCount(0);
    const restarted = await readState(page);
    expect([restarted.rows, restarted.cols, restarted.mineCount]).toEqual([16, 16, 40]);
    expect(restarted.status).toBe('ready');

    await cellLocator(page, BOTTOM_RIGHT_16.row, BOTTOM_RIGHT_16.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(mineSignature(await readState(page))).toBe(mineSignature(state));
  });

  test('safeFirst=0 keeps an injected mine under the first click', async ({ page }) => {
    const mines = [...INTERMEDIATE_MINES.slice(0, 39), BOTTOM_RIGHT_16];
    await openMinesweeper(page, {
      rows: 16,
      cols: 16,
      mineCount: 40,
      mines,
      safeFirst: false,
    });
    await cellLocator(page, BOTTOM_RIGHT_16.row, BOTTOM_RIGHT_16.col).click();
    await expect(page.getByTestId('status')).toHaveText('踩雷结束');
    await expect(page.getByTestId('overlay')).toBeVisible();

    const state = await readState(page);
    expect(state.status).toBe('lost');
    expect(state.explodedCell).toEqual(BOTTOM_RIGHT_16);
    expect(state.board[BOTTOM_RIGHT_16.row]?.[BOTTOM_RIGHT_16.col]?.mine).toBe(true);
    expect(state.board.flat().filter((cell) => cell.mine)).toHaveLength(40);
  });

  test('an invalid debug config falls back to the beginner board', async ({ page }) => {
    const invalidConfigs = [
      // Out of the playable bounds.
      { rows: 99, cols: 99, mineCount: 200 },
      // Mines must stay smaller than the cell count.
      { rows: 8, cols: 8, mineCount: 64 },
    ];
    for (const config of invalidConfigs) {
      await openMinesweeper(page, { ...config, expectedCells: 81 });
      await expect(page.locator('[data-cell]')).toHaveCount(81);
      await expect(page.getByTestId('remaining-mines')).toHaveText('10');
      await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
      const state = await readState(page);
      expect([state.rows, state.cols, state.mineCount]).toEqual([9, 9, 10]);
      expect(state.status).toBe('ready');
    }
  });

  test('setConfig rebuilds the board, stops the clock and keeps listeners bounded', async ({
    page,
  }) => {
    await installListenerProbe(page);
    await installAbortProbe(page);
    await installIntervalProbe(page);
    await page.goto('/');
    const baselineAbort = await abortListenerCount(page);

    await openMinesweeper(page);
    await trackProbeTarget(page, 'board', '[data-testid="minesweeper-board"]');
    expect(await listenerCount(page, 'board', 'click')).toBe(1);
    expect(await listenerCount(page, 'board', 'contextmenu')).toBe(1);
    expect(await abortListenerCount(page)).toBe(baselineAbort + 1);
    expect(await activeIntervalCount(page)).toBe(0);

    await cellLocator(page, 8, 8).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await activeIntervalCount(page)).toBe(1);

    // Rebuild to a bigger board while the old clock is running.
    await setDebugConfig(page, {
      rows: 16,
      cols: 16,
      mines: 40,
      firstClickSafe: true,
    });
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('remaining-mines')).toHaveText('40');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    const state = await readState(page);
    expect([state.rows, state.cols, state.mineCount]).toEqual([16, 16, 40]);
    expect(state.status).toBe('ready');
    expect(await activeIntervalCount(page)).toBe(0);
    // Reconstruction reuses the stable board element and listener signal.
    expect(await listenerCount(page, 'board', 'click')).toBe(1);
    expect(await listenerCount(page, 'board', 'contextmenu')).toBe(1);
    expect(await abortListenerCount(page)).toBe(baselineAbort + 1);

    // The rebuilt board plays normally and starts a fresh clock.
    await cellLocator(page, BOTTOM_RIGHT_16.row, BOTTOM_RIGHT_16.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    expect(await activeIntervalCount(page)).toBe(1);
    await expect
      .poll(async () => (await readState(page)).elapsedMs)
      .toBeGreaterThan(0);

    await destroyDebugGame(page);
    await expect.poll(() => activeIntervalCount(page)).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'click')).toBe(0);
    await expect.poll(() => listenerCount(page, 'board', 'contextmenu')).toBe(0);
    await expect.poll(() => abortListenerCount(page)).toBe(baselineAbort);
    await expectNoDebugSeam(page);
  });

  test('a 16x30 board fits desktop and phone viewports and stays playable', async ({
    page,
  }) => {
    await openMinesweeper(page, { rows: 16, cols: 30, mineCount: 99 });
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(
      page,
      page.getByTestId('minesweeper-stage'),
      'wide stage',
    );
    await expectInsideViewport(
      page,
      page.getByTestId('minesweeper-board'),
      'wide board',
    );
    const desktopCell = await cellLocator(
      page,
      BOTTOM_RIGHT_30.row,
      BOTTOM_RIGHT_30.col,
    ).boundingBox();
    expect(desktopCell?.width ?? 0).toBeGreaterThan(4);
    await cellLocator(page, BOTTOM_RIGHT_30.row, BOTTOM_RIGHT_30.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');

    await page.setViewportSize({ width: 412, height: 915 });
    // A different seed changes the hash so the router mounts a fresh board;
    // a repeated identical URL would keep the desktop mount alive.
    await openMinesweeper(page, { rows: 16, cols: 30, mineCount: 99, seed: 2 });
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(
      page,
      page.getByTestId('minesweeper-board'),
      'phone wide board',
    );
    const phoneCell = await cellLocator(
      page,
      BOTTOM_RIGHT_30.row,
      BOTTOM_RIGHT_30.col,
    ).boundingBox();
    expect(phoneCell?.width ?? 0).toBeGreaterThan(4);
    await cellLocator(page, BOTTOM_RIGHT_30.row, BOTTOM_RIGHT_30.col).click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
  });

  test('the normal entry ignores debug board parameters and exposes no API', async ({
    page,
  }) => {
    await page.goto('/#/games/minesweeper?rows=16&cols=16&mineCount=40');
    await expect(page.getByTestId('minesweeper-game')).toBeVisible();
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
    await expectNoDebugSeam(page);
  });
});
