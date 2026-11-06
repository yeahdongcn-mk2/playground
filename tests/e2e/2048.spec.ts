import {
  expect,
  installListenerProbe,
  listenerCount,
  pendingLongTimerCount,
  test,
  trackProbeTarget,
} from './fixtures';
import {
  destroyDebugGame,
  expectNoHorizontalOverflow,
  MERGE_BOARD,
  NEAR_STUCK_BOARD,
  open2048,
  readCanvasColorCounts,
  readState,
  readStatus,
  startGame,
} from './2048-helpers';

/** Ready board with empty cells and all four low tile colours. */
const COLOUR_BOARD = [
  [2, 2, 4, 4],
  [8, 8, 16, 16],
  [null, null, null, null],
  [null, null, null, null],
] as const;

const TILE_COLOURS = [
  '226,232,240', // 2
  '203,213,225', // 4
  '251,191,36', // 8
  '245,158,11', // 16
];

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

test.describe('2048 rendering and teardown', () => {
  test('draws the board and tiles on the Phaser canvas', async ({ page }) => {
    await open2048(page, { board: COLOUR_BOARD });
    await expect(page.getByTestId('status')).toHaveText('准备开始');

    const ready = await readCanvasColorCounts(page);
    // scene.draw() paints the frame, board, empty cells and tile fills. If
    // draw() is removed the Phaser canvas only keeps its flat clear colour,
    // so every count below drops to zero.
    for (const colour of TILE_COLOURS) {
      expect(ready[colour] ?? 0, `canvas should draw tile colour ${colour}`).toBeGreaterThan(
        2_000,
      );
    }
    expect(ready['17,29,48'] ?? 0, 'canvas should draw empty cells').toBeGreaterThan(10_000);
    expect(ready['10,19,34'] ?? 0, 'canvas should draw the board background').toBeGreaterThan(
      10_000,
    );

    const signature = (counts: Record<string, number>): string =>
      TILE_COLOURS.map((colour) => String(counts[colour] ?? 0)).join('|');
    const before = signature(ready);

    // A merge changes the engine state and must also repaint the canvas.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('score')).toHaveText('60');
    await expect
      .poll(async () => signature(await readCanvasColorCounts(page)))
      .not.toBe(before);
  });

  test('R starts the game from READY instead of being a no-op', async ({ page }) => {
    await open2048(page, { board: MERGE_BOARD });
    await expect(page.getByTestId('status')).toHaveText('准备开始');
    await expect(page.getByTestId('overlay')).toBeVisible();

    await page.keyboard.press('KeyR');

    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('score')).toHaveText('0');
    expect((await readState(page)).status).toBe('playing');
  });

  test('releases keyboard, visibility, pointer listeners and the ready timer', async ({
    page,
  }) => {
    await installListenerProbe(page);
    await page.goto('/');
    const baselineKeydown = await listenerCount(page, 'window', 'keydown');
    const baselineVisibility = await listenerCount(page, 'document', 'visibilitychange');
    expect(await pendingLongTimerCount(page)).toBe(0);

    await open2048(page, { board: MERGE_BOARD });
    await trackProbeTarget(page, 'stage', '[data-testid="2048-stage"]');
    expect(await listenerCount(page, 'window', 'keydown')).toBeGreaterThan(baselineKeydown);
    expect(await listenerCount(page, 'document', 'visibilitychange')).toBeGreaterThan(
      baselineVisibility,
    );
    expect(await listenerCount(page, 'stage', 'pointerdown')).toBe(1);
    expect(await listenerCount(page, 'stage', 'pointerup')).toBe(1);
    // The 12 s ready timeout has to be cleared once the scene is ready.
    expect(await pendingLongTimerCount(page)).toBe(0);

    // Destroy the mount directly, without the route change aborting the mount
    // signal first. This makes the cleanup in GameHandle.destroy observable:
    // deleting the explicit removeEventListener/abort calls leaks them.
    await destroyDebugGame(page);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect.poll(() => listenerCount(page, 'window', 'keydown')).toBe(baselineKeydown);
    await expect
      .poll(() => listenerCount(page, 'document', 'visibilitychange'))
      .toBe(baselineVisibility);
    await expect.poll(() => listenerCount(page, 'stage', 'pointerdown')).toBe(0);
    await expect.poll(() => listenerCount(page, 'stage', 'pointerup')).toBe(0);
    expect(await pendingLongTimerCount(page)).toBe(0);

    // The route remains usable and a second mount/teardown stays clean.
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-2048')).toBeVisible();
    await open2048(page, { board: MERGE_BOARD });
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-2048')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  });
});
