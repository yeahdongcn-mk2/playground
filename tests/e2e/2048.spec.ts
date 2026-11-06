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
  readCanvasPixelCount,
  readState,
  readStatus,
  startGame,
} from './2048-helpers';
import { COLORS, TILE_STYLES } from '../../src/games/2048/palette';

const rgb = (fill: number): string =>
  `${(fill >> 16) & 0xff},${(fill >> 8) & 0xff},${fill & 0xff}`;
const tileFill = (value: number): string => {
  const style = TILE_STYLES[value];
  if (!style) {
    throw new Error(`No tile style for ${value}`);
  }
  return rgb(style.fill);
};

/** Ready board with empty cells and all four low tile colors. */
const COLOR_BOARD = [
  [2, 2, 4, 4],
  [8, 8, 16, 16],
  [null, null, null, null],
  [null, null, null, null],
] as const;

const TILE_COLORS = [2, 4, 8, 16].map(tileFill);
const MERGED_TILE_COLORS = [8, 16, 32].map(tileFill);

test.describe('2048 gameplay', () => {
  test('hub card opens the game and the back link returns to the hub', async ({ page }) => {
    await page.goto('/');
    const card = page.getByTestId('game-card-2048');
    await expect(card).toBeVisible();
    await expect(card).toContainText('2048');
    await expect(card).toContainText('R 开始 / 重新开始');
    await expect(card.locator('svg.game-2048-card-art')).toBeVisible();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
    await expect(page.getByTestId('game-card-tetris')).toBeVisible();

    await card.click();
    await expect(page).toHaveURL(/#\/games\/2048$/);
    await expect(page.getByTestId('2048-game')).toBeVisible();
    await expect(page.locator('[data-testid="2048-board"] canvas')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('合并出 2048');
    await expect(page.getByTestId('status')).toHaveText('准备开始');
    // The normal entry must not install the debug seam.
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
    await open2048(page, { board: COLOR_BOARD, renderer: 'canvas' });
    await expect(page.getByTestId('status')).toHaveText('准备开始');

    const area = await readCanvasPixelCount(page);
    const share = (counts: Record<string, number>, color: string): number =>
      (counts[color] ?? 0) / area;
    const ready = await readCanvasColorCounts(page);
    // scene.draw() paints the frame, board, empty cells and tile fills. If
    // draw() is removed the Phaser canvas only keeps its flat clear color,
    // so every share below drops to zero.
    for (const color of TILE_COLORS) {
      expect(share(ready, color), `canvas should draw tile color ${color}`).toBeGreaterThan(
        0.01,
      );
    }
    expect(share(ready, rgb(COLORS.empty)), 'canvas should draw empty cells').toBeGreaterThan(0.05);
    expect(share(ready, rgb(COLORS.board)), 'canvas should draw the board background').toBeGreaterThan(
      0.03,
    );

    const signature = (counts: Record<string, number>): string =>
      TILE_COLORS.map((color) => String(counts[color] ?? 0)).join('|');
    const before = signature(ready);

    // A merge changes the engine state and must also repaint the canvas.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('score')).toHaveText('60');
    await expect
      .poll(async () => signature(await readCanvasColorCounts(page)))
      .not.toBe(before);
    const after = await readCanvasColorCounts(page);
    // The merged 8/16/32 tiles must be on the canvas, so a repaint that just
    // clears the frame cannot satisfy the check above.
    for (const color of MERGED_TILE_COLORS) {
      expect(share(after, color), `canvas should draw merged tile ${color}`).toBeGreaterThan(
        0.005,
      );
    }
    expect(share(after, rgb(COLORS.empty)), 'canvas should still draw empty cells').toBeGreaterThan(
      0.05,
    );
  });

  test('R starts the game from READY instead of being a no-op', async ({ page }) => {
    await open2048(page, { board: MERGE_BOARD });
    await expect(page.getByTestId('status')).toHaveText('准备开始');
    await expect(page.getByTestId('overlay')).toBeVisible();

    await page.keyboard.press('KeyR');

    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('score')).toHaveText('0');
    const state = await readState(page);
    expect(state.status).toBe('playing');
    // Both start and restart keep the fixed debug board, so the live region is
    // what distinguishes them: startRun announces "游戏开始" while a restart
    // would announce "游戏重新开始".
    await expect(page.getByTestId('announcer')).toHaveText('游戏开始');
    expect(state.board).toEqual(MERGE_BOARD.map((row) => [...row]));
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
    // deleting controller.abort() would leave the signal-bound listeners.
    await destroyDebugGame(page);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect.poll(() => listenerCount(page, 'window', 'keydown')).toBe(baselineKeydown);
    await expect
      .poll(() => listenerCount(page, 'document', 'visibilitychange'))
      .toBe(baselineVisibility);
    await expect.poll(() => listenerCount(page, 'stage', 'pointerdown')).toBe(0);
    await expect.poll(() => listenerCount(page, 'stage', 'pointerup')).toBe(0);
    expect(await pendingLongTimerCount(page)).toBe(0);

    // The route remains usable and a second normal mount/teardown stays clean.
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-2048')).toBeVisible();
    await open2048(page, { board: MERGE_BOARD });
    await trackProbeTarget(page, 'stage', '[data-testid="2048-stage"]');
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-2048')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect.poll(() => listenerCount(page, 'window', 'keydown')).toBe(baselineKeydown);
    await expect
      .poll(() => listenerCount(page, 'document', 'visibilitychange'))
      .toBe(baselineVisibility);
    await expect.poll(() => listenerCount(page, 'stage', 'pointerdown')).toBe(0);
    await expect.poll(() => listenerCount(page, 'stage', 'pointerup')).toBe(0);
    expect(await pendingLongTimerCount(page)).toBe(0);
  });
});
