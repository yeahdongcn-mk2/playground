import {
  expect,
  expectNoAnimationFrames,
  installListenerProbe,
  installRafProbe,
  listenerCount,
  pendingLongTimerCount,
  rafCount,
  rafPending,
  resetRafCount,
  test,
  trackProbeTarget,
} from './fixtures';
import {
  BALL_UNDER_FIRST_BRICK,
  destroyDebugGame,
  expectNoHorizontalOverflow,
  forceMiss,
  openBreakout,
  readCanvasColorCounts,
  readCanvasPixelCount,
  readState,
  readStatus,
  restorePageVisibility,
  setPageHidden,
  startGame,
} from './breakout-helpers';
import { BREAKOUT_COLORS, BRICK_COLORS } from '../../src/games/breakout/palette';

const rgb = (fill: number): string =>
  `${(fill >> 16) & 0xff},${(fill >> 8) & 0xff},${fill & 0xff}`;

test.describe('breakout gameplay', () => {
  test('hub card opens the game, starts, and the back link returns to the hub', async ({
    page,
  }) => {
    await page.goto('/');
    const card = page.getByTestId('game-card-breakout');
    await expect(card).toBeVisible();
    await expect(card).toContainText('打砖块');
    await expect(card).toContainText('← / → 或 A / D 移动挡板');
    await expect(card.locator('svg.breakout-card-art')).toBeVisible();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
    await expect(page.getByTestId('game-card-tetris')).toBeVisible();
    await expect(page.getByTestId('game-card-2048')).toBeVisible();

    await card.click();
    await expect(page).toHaveURL(/#\/games\/breakout$/);
    await expect(page.getByTestId('breakout-game')).toBeVisible();
    await expect(page.locator('[data-testid="breakout-board"] canvas')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('击碎整面砖墙');
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('lives')).toHaveText('3');
    await expect(page.getByTestId('level')).toHaveText('1');
    // The normal entry must not install the debug seam.
    expect(
      await page.evaluate(
        () => (window as unknown as { __playground?: unknown }).__playground,
      ),
    ).toBeUndefined();

    await startGame(page);
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('进行中');

    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('game-card-breakout')).toBeVisible();
    await expect(page.locator('[data-testid="breakout-board"] canvas')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test('arrow keys and A/D move the paddle', async ({ page }) => {
    await openBreakout(page);
    const initial = await readState(page);
    expect(initial.status).toBe('ready');
    expect(initial.paddle.x).toBeCloseTo(initial.width / 2, 6);

    await page.keyboard.down('ArrowRight');
    await expect
      .poll(async () => (await readState(page)).paddle.x)
      .toBeGreaterThan(initial.paddle.x + 20);
    await page.keyboard.up('ArrowRight');
    const afterRight = (await readState(page)).paddle.x;

    await page.keyboard.down('KeyA');
    await expect
      .poll(async () => (await readState(page)).paddle.x)
      .toBeLessThan(afterRight - 20);
    await page.keyboard.up('KeyA');
    const afterLeft = (await readState(page)).paddle.x;

    await page.keyboard.down('KeyD');
    await expect
      .poll(async () => (await readState(page)).paddle.x)
      .toBeGreaterThan(afterLeft + 10);
    await page.keyboard.up('KeyD');

    // The attached ball keeps sitting on the paddle while waiting for a serve.
    const settled = await readState(page);
    expect(settled.ball.attached).toBe(true);
    expect(settled.ball.x).toBeCloseTo(settled.paddle.x, 6);
    await expect(page.getByTestId('overlay-title')).toHaveText('击碎整面砖墙');
    await expectNoHorizontalOverflow(page);
  });

  test('a brick hit scores before the level is cleared', async ({ page }) => {
    await openBreakout(page, {
      bricks: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
      ],
      ball: BALL_UNDER_FIRST_BRICK,
    });

    await expect(page.getByTestId('score')).toHaveText('10');
    // Pause the loop before the remaining assertions. A hit ball falls off the
    // court after a few seconds, so a slow CI could otherwise reach the
    // ready/game-over overlay while these assertions are still running.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const paused = await readState(page);
    await page.waitForTimeout(100);
    const still = await readState(page);
    expect(still.ball.x).toBe(paused.ball.x);
    expect(still.ball.y).toBe(paused.ball.y);
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('bricks-left')).toHaveText('1');
    await expect(page.getByTestId('overlay')).toBeHidden();

    const state = await readState(page);
    expect(state.status).toBe('running');
    expect(state.score).toBe(10);
    expect(state.bricks).toHaveLength(1);
  });

  test('Space starts and continues, R and the side button restart', async ({ page }) => {
    await openBreakout(page);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('进行中');

    await page.getByTestId('restart-button').click();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('score')).toHaveText('0');

    await page.keyboard.press('KeyR');
    await expect(page.getByTestId('status')).toHaveText('进行中');

    // After a level clear the primary button owns focus; Space must activate it
    // natively instead of being swallowed by the game's key handler.
    await openBreakout(page, {
      bricks: [{ row: 0, col: 0 }],
      ball: BALL_UNDER_FIRST_BRICK,
    });
    await expect(page.getByTestId('overlay-title')).toHaveText('第 1 关清空');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('level')).toHaveText('2');
  });

  test('losing window focus pauses the ball and focus resumes it', async ({ page }) => {
    await openBreakout(page);
    await startGame(page);
    await page.waitForTimeout(100);

    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(100);
    const paused = await readState(page);
    await page.waitForTimeout(400);
    const still = await readState(page);
    expect(still.ball.x).toBe(paused.ball.x);
    expect(still.ball.y).toBe(paused.ball.y);

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect
      .poll(async () => {
        const state = await readState(page);
        return state.ball.x !== paused.ball.x || state.ball.y !== paused.ball.y;
      })
      .toBe(true);
  });

  test('hiding the page pauses the ball and showing the page resumes it', async ({
    page,
  }) => {
    await openBreakout(page);
    await startGame(page);
    await page.waitForTimeout(100);

    await setPageHidden(page, true);
    try {
      await page.waitForTimeout(100);
      const paused = await readState(page);
      expect(paused.status).toBe('running');
      expect(paused.ball.attached).toBe(false);
      await page.waitForTimeout(400);
      const still = await readState(page);
      expect(still.ball.x).toBe(paused.ball.x);
      expect(still.ball.y).toBe(paused.ball.y);

      // A real browser blur may have cleared windowFocused while hidden. Restore
      // it now, while still hidden, so showing the page exercises the visibility
      // wake path instead of the focus path.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await setPageHidden(page, false);
      await expect
        .poll(async () => {
          const state = await readState(page);
          return state.ball.x !== paused.ball.x || state.ball.y !== paused.ball.y;
        })
        .toBe(true);

      // While the window is blurred, showing the page must not wake the loop;
      // only a matching focus event resumes it.
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.waitForTimeout(100);
      const blurred = await readState(page);
      await page.waitForTimeout(100);
      const blurredStill = await readState(page);
      expect(blurredStill.ball.x).toBe(blurred.ball.x);
      expect(blurredStill.ball.y).toBe(blurred.ball.y);

      await setPageHidden(page, true);
      await setPageHidden(page, false);
      await page.waitForTimeout(200);
      const gated = await readState(page);
      expect(gated.ball.x).toBe(blurred.ball.x);
      expect(gated.ball.y).toBe(blurred.ball.y);

      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(async () => {
          const state = await readState(page);
          return state.ball.x !== blurred.ball.x || state.ball.y !== blurred.ball.y;
        })
        .toBe(true);
    } finally {
      await restorePageVisibility(page);
    }
  });

  test('hitting a brick scores and clearing the level advances faster', async ({ page }) => {
    await openBreakout(page, {
      bricks: [{ row: 0, col: 0 }],
      ball: BALL_UNDER_FIRST_BRICK,
    });

    await expect(page.getByTestId('score')).toHaveText('10');
    await expect(page.getByTestId('status')).toHaveText('已过关');
    await expect(page.getByTestId('overlay-title')).toHaveText('第 1 关清空');
    await expect(page.getByTestId('bricks-left')).toHaveText('0');
    await expect(page.getByTestId('level')).toHaveText('1');

    const cleared = await readState(page);
    expect(cleared.status).toBe('levelclear');
    expect(cleared.bricks).toHaveLength(0);
    expect(cleared.ballSpeed).toBe(320);

    await page.getByTestId('overlay').getByRole('button', { name: '进入第 2 关' }).click();
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('level')).toHaveText('2');
    await expect(page.getByTestId('score')).toHaveText('10');
    await expect(page.getByTestId('lives')).toHaveText('3');

    const next = await readState(page);
    expect(next.status).toBe('running');
    expect(next.level).toBe(2);
    expect(next.ballSpeed).toBeGreaterThan(cleared.ballSpeed);
    expect(next.bricks).toHaveLength(50);
    await expectNoHorizontalOverflow(page);
  });

  test('missed balls lose lives, three misses end the game, and restart resets', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openBreakout(page, { seed: 7, speed: 640 });
    await expect(page.getByTestId('lives')).toHaveText('3');

    for (let remaining = 3; remaining >= 1; remaining -= 1) {
      await forceMiss(page);
      await expect(page.getByTestId('lives')).toHaveText(String(remaining - 1));
      if (remaining > 1) {
        await expect.poll(() => readStatus(page)).toBe('ready');
        await expect(page.getByTestId('overlay-title')).toHaveText('漏球了');
        await expect(page.getByTestId('overlay')).toBeVisible();
        await expect(page.getByTestId('overlay-body')).toContainText(
          `还剩 ${remaining - 1} 条命`,
        );
      }
    }

    await expect.poll(() => readStatus(page)).toBe('gameover');
    await expect(page.getByTestId('status')).toHaveText('已结束');
    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText('生命用完了');
    await expect(page.getByTestId('overlay-score')).toContainText('到达第 1 关');
    await expect(page.getByTestId('lives')).toHaveText('0');

    await page.getByTestId('overlay').getByRole('button', { name: '再来一局' }).click();
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('进行中');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('lives')).toHaveText('3');
    await expect(page.getByTestId('level')).toHaveText('1');

    const restarted = await readState(page);
    expect(restarted.status).toBe('running');
    expect(restarted.score).toBe(0);
    expect(restarted.lives).toBe(3);
    expect(restarted.level).toBe(1);
    expect(restarted.bricks).toHaveLength(40);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('breakout rendering and teardown', () => {
  test('draws the court, colour-tiered bricks, paddle and ball on the canvas', async ({
    page,
  }) => {
    await openBreakout(page, { renderer: 'canvas', level: 4 });
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('level')).toHaveText('4');

    const area = await readCanvasPixelCount(page);
    const counts = await readCanvasColorCounts(page);
    const share = (color: number): number => (counts[rgb(color)] ?? 0) / area;

    expect(share(BREAKOUT_COLORS.court), 'canvas should draw the court').toBeGreaterThan(
      0.05,
    );
    for (const color of BRICK_COLORS) {
      expect(
        share(color),
        `canvas should draw bricks in tier colour ${rgb(color)}`,
      ).toBeGreaterThan(0.01);
    }
    expect(share(BREAKOUT_COLORS.paddle), 'canvas should draw the paddle').toBeGreaterThan(
      0.001,
    );
    expect(share(BREAKOUT_COLORS.ball), 'canvas should draw the ball').toBeGreaterThan(
      0.0001,
    );
  });

  test('destroying the game releases keyboard, pointer and visibility listeners, the ready timer and the frame loop', async ({
    page,
  }) => {
    await installListenerProbe(page);
    await installRafProbe(page);
    await page.goto('/');
    const baselineKeydown = await listenerCount(page, 'window', 'keydown');
    const baselineKeyup = await listenerCount(page, 'window', 'keyup');
    const baselineBlur = await listenerCount(page, 'window', 'blur');
    const baselineFocus = await listenerCount(page, 'window', 'focus');
    const baselineVisibility = await listenerCount(page, 'document', 'visibilitychange');
    expect(await pendingLongTimerCount(page)).toBe(0);

    const expectReleasedMount = async (): Promise<void> => {
      await expect.poll(() => listenerCount(page, 'window', 'keydown')).toBe(
        baselineKeydown,
      );
      await expect.poll(() => listenerCount(page, 'window', 'keyup')).toBe(baselineKeyup);
      await expect.poll(() => listenerCount(page, 'window', 'blur')).toBe(baselineBlur);
      await expect.poll(() => listenerCount(page, 'window', 'focus')).toBe(baselineFocus);
      await expect
        .poll(() => listenerCount(page, 'document', 'visibilitychange'))
        .toBe(baselineVisibility);
      await expect.poll(() => listenerCount(page, 'board', 'pointerdown')).toBe(0);
      await expect.poll(() => listenerCount(page, 'board', 'pointermove')).toBe(0);
      await expect.poll(() => listenerCount(page, 'board', 'pointerup')).toBe(0);
      await expect.poll(() => listenerCount(page, 'board', 'pointercancel')).toBe(0);
      await expect.poll(() => listenerCount(page, 'board', 'lostpointercapture')).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { __playground?: unknown }).__playground,
        ),
        'the debug seam should be removed with the mount',
      ).toBeUndefined();
      expect(await pendingLongTimerCount(page)).toBe(0);
    };

    await openBreakout(page);
    await trackProbeTarget(page, 'board', '[data-testid="breakout-board"]');
    // The adapter also schedules a one-shot resize frame through RAF. Reset the
    // counter and require a sustained sequence: only Phaser's live loop can
    // deliver several frames, so the post-destroy check is not vacuous.
    await resetRafCount(page);
    await expect
      .poll(() => rafCount(page), {
        message: 'the mounted Phaser loop should keep delivering frames',
      })
      .toBeGreaterThan(2);
    expect(
      await rafPending(page),
      'a running loop keeps the next frame scheduled',
    ).toBeGreaterThan(0);
    expect(await listenerCount(page, 'window', 'keydown')).toBeGreaterThan(
      baselineKeydown,
    );
    expect(await listenerCount(page, 'window', 'keyup')).toBeGreaterThan(baselineKeyup);
    expect(await listenerCount(page, 'window', 'blur')).toBeGreaterThan(baselineBlur);
    expect(await listenerCount(page, 'window', 'focus')).toBeGreaterThan(baselineFocus);
    expect(await listenerCount(page, 'document', 'visibilitychange')).toBeGreaterThan(
      baselineVisibility,
    );
    expect(await listenerCount(page, 'board', 'pointerdown')).toBe(1);
    expect(await listenerCount(page, 'board', 'pointermove')).toBe(1);
    expect(await listenerCount(page, 'board', 'pointerup')).toBe(1);
    expect(await listenerCount(page, 'board', 'pointercancel')).toBe(1);
    expect(await listenerCount(page, 'board', 'lostpointercapture')).toBe(1);
    // The 12 s ready timeout has to be cleared once the scene is ready.
    expect(await pendingLongTimerCount(page)).toBe(0);

    // Destroy the mount directly, without the route change aborting the mount
    // signal first. This makes the cleanup in GameHandle.destroy observable.
    await destroyDebugGame(page);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expectReleasedMount();

    // Destroying the canvas and listeners is not enough: the Phaser loop must
    // stop scheduling and delivering frames too.
    await expectNoAnimationFrames(page);

    // The route remains usable and a second normal mount/teardown stays clean.
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-breakout')).toBeVisible();
    await openBreakout(page);
    await trackProbeTarget(page, 'board', '[data-testid="breakout-board"]');
    // Sleep the loop before the route unmount so the shared adapter has to wake
    // it for the deferred Game.destroy() teardown; without that wake the canvas
    // would stay in the DOM and no teardown frame would run.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.getByRole('link', { name: /返回大厅/ }).click();
    await expect(page.getByTestId('game-card-breakout')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expectReleasedMount();
    await expectNoAnimationFrames(page);
  });
});
