import {
  blurListenerCount,
  canvasBox,
  expect,
  installBlurListenerProbe,
  openBlankGame,
  readPosition,
  test,
  visibilityListenerCount,
} from './fixtures';

test.describe('hub and routing', () => {
  test('renders the shared-shell landing page with a working game card', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Playground Arcade/);
    await expect(page.getByRole('heading', { name: /一块画布/ })).toBeVisible();
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
    await expect(page.getByTestId('enter-blank')).toBeVisible();
    await expect(page.getByRole('heading', { name: '共享框架做了什么' })).toBeVisible();
    await expect(page.locator('main')).toHaveCount(1);

    await page.getByTestId('enter-blank').click();
    await expect(page).toHaveURL(/#\/games\/blank$/);
    await expect(page.getByTestId('blank-game')).toBeVisible();
    await expect(page.getByTestId('blank-stage')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
  });

  test('scrolls to framework features without leaving the hub', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '看看框架能力' }).click();

    await expect(page.getByRole('heading', { name: '共享框架做了什么' })).toBeInViewport();
    await expect(page).not.toHaveURL(/#features/);
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
  });

  test('can go back to the hub and re-enter the game', async ({ page }) => {
    await openBlankGame(page);
    await page.getByRole('link', { name: /返回大厅/ }).first().click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('game-card-blank')).toBeVisible();

    await page.getByTestId('game-card-blank').click();
    await expect(page.getByTestId('blank-stage')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await expect(page.locator('canvas[data-testid="game-canvas"]')).toHaveCount(1);
  });

  test('shows the last-played time after returning to the hub and keeps it across reloads', async ({
    page,
  }) => {
    // Freeze the clock so the relative label cannot drift out of its
    // one-minute window even when the suite is slow.
    const now = new Date('2026-01-01T12:00:00Z');
    await page.clock.setFixedTime(now);

    await page.goto('/');
    const blankLastPlayed = page.getByTestId('game-card-last-played-blank');
    const snakeLastPlayed = page.getByTestId('game-card-last-played-snake');
    await expect(blankLastPlayed).toContainText('还没玩过');
    await expect(snakeLastPlayed).toContainText('还没玩过');

    // Open blank from its hub card; mounting it must record the visit in the
    // shared storage before the hub can show a relative time.
    await page.getByTestId('game-card-blank').click();
    await expect(page).toHaveURL(/#\/games\/blank$/);
    await expect(page.getByTestId('blank-stage')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });

    await page.getByRole('link', { name: /返回大厅/ }).first().click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(blankLastPlayed).toContainText('刚刚');
    await expect(snakeLastPlayed).toContainText('还没玩过');

    // The timestamp lives in localStorage, so a full reload keeps showing it.
    expect(
      await page.evaluate(() => localStorage.getItem('playground:v1:blank.lastPlayed')),
    ).toBe(String(now.getTime()));
    await page.reload();
    await expect(page.getByTestId('game-card-last-played-blank')).toContainText('刚刚');
    await expect(page.getByTestId('game-card-last-played-snake')).toContainText('还没玩过');
  });

  test('shows a recoverable error for an unknown game', async ({ page }) => {
    await page.goto('/#/games/does-not-exist');

    await expect(page.getByRole('heading', { name: '没有找到这个游戏' })).toBeVisible();
    await expect(page.getByRole('link', { name: '返回大厅' })).toBeVisible();
    await expect(page.getByRole('link', { name: '#/games/blank' })).toBeVisible();

    await page.getByRole('link', { name: '返回大厅' }).click();
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
  });

  test('shows a recoverable error for an unknown path', async ({ page }) => {
    await page.goto('/#/nope');

    await expect(page.getByRole('heading', { name: '没有找到这个页面' })).toBeVisible();
    await page.getByRole('link', { name: '返回大厅' }).click();
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
  });

  test('persists the sound preference across reloads', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('sound-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveAttribute('aria-label', '开启音效');

    await page.reload();
    await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('sound-toggle').click();
    await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('blank canvas game', () => {
  test('moves with arrow keys and WASD', async ({ page }) => {
    await openBlankGame(page);
    const start = await readPosition(page);

    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(450);
    await page.keyboard.up('ArrowRight');
    await expect
      .poll(async () => (await readPosition(page)).x, { timeout: 2_000 })
      .toBeGreaterThan(start.x + 60);
    await expect(page.getByTestId('input-mode')).toHaveText('键盘');

    const afterRight = await readPosition(page);
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(350);
    await page.keyboard.up('KeyS');
    await expect
      .poll(async () => (await readPosition(page)).y, { timeout: 2_000 })
      .toBeGreaterThan(afterRight.y + 40);
  });

  test('ignores modifier-key shortcuts', async ({ page }) => {
    await openBlankGame(page);
    const before = await readPosition(page);

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);

    expect(await readPosition(page)).toEqual(before);
    await expect(page.getByTestId('input-mode')).toHaveText('待机');
  });

  test('moves toward a pointer click', async ({ page }) => {
    await openBlankGame(page);
    const box = await canvasBox(page);
    const targetX = box.x + box.width * 0.3;
    const targetY = box.y + box.height * 0.72;

    await page.mouse.click(targetX, targetY);

    await expect
      .poll(
        async () => {
          const position = await readPosition(page);
          return (
            Math.abs(position.x - (targetX - box.x)) <= 6 &&
            Math.abs(position.y - (targetY - box.y)) <= 6
          );
        },
        { timeout: 3_000 },
      )
      .toBe(true);
    await expect(page.getByTestId('input-mode')).toHaveText('指针 / 触屏');
  });

  test('follows a mouse drag', async ({ page }) => {
    await openBlankGame(page);
    const box = await canvasBox(page);
    const targetX = box.x + box.width * 0.7;
    const targetY = box.y + box.height * 0.7;

    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(
        async () => {
          const position = await readPosition(page);
          return (
            Math.abs(position.x - (targetX - box.x)) <= 6 &&
            Math.abs(position.y - (targetY - box.y)) <= 6
          );
        },
        { timeout: 3_000 },
      )
      .toBe(true);
    await expect(page.getByTestId('input-mode')).toHaveText('指针 / 触屏');
  });

  test('reset centres the cursor and keyboard keeps working afterwards', async ({ page }) => {
    await openBlankGame(page);
    const box = await canvasBox(page);

    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.2);
    await expect
      .poll(async () => (await readPosition(page)).x, { timeout: 3_000 })
      .toBeGreaterThan(box.width * 0.7);

    const reset = page.getByTestId('reset');
    await reset.click();
    await expect(page.getByTestId('game-status')).toHaveText('位置已重置');
    await expect
      .poll(async () => {
        const position = await readPosition(page);
        return (
          Math.abs(position.x - box.width / 2) <= 2 &&
          Math.abs(position.y - box.height / 2) <= 2
        );
      })
      .toBe(true);

    // The reset button keeps focus; arrow keys must still reach the canvas.
    const centred = await readPosition(page);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowLeft');
    await expect
      .poll(async () => (await readPosition(page)).x, { timeout: 2_000 })
      .toBeLessThan(centred.x - 40);
  });

  test('resizes the engine when only its container changes', async ({ page }) => {
    await openBlankGame(page);
    await page.getByTestId('blank-stage').evaluate((element) => {
      element.style.width = '520px';
      element.style.justifySelf = 'start';
    });

    await expect
      .poll(
        async () => page.evaluate(() => (document.querySelector('canvas') as HTMLCanvasElement).width),
        { timeout: 3_000 },
      )
      .toBeLessThanOrEqual(520);
    await expect
      .poll(
        async () => page.evaluate(() => (document.querySelector('canvas') as HTMLCanvasElement).width),
        { timeout: 3_000 },
      )
      .toBeGreaterThan(480);

    const info = await page.evaluate(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height };
    });
    expect(info.width).toBeGreaterThan(480);
    expect(info.width).toBeLessThanOrEqual(520);
    expect(info.height).toBeGreaterThan(500);
    await expect
      .poll(() => page.getByTestId('viewport').textContent())
      .toBe(`${info.width} × ${info.height}`);
  });

  test('cleans up window listeners after leaving the game', async ({ page }) => {
    await installBlurListenerProbe(page);
    await page.goto('/');
    const baselineBlur = await blurListenerCount(page);
    const baselineVisibility = await visibilityListenerCount(page);

    await openBlankGame(page);
    expect(await blurListenerCount(page)).toBe(baselineBlur + 1);
    expect(await visibilityListenerCount(page)).toBeGreaterThan(baselineVisibility);
    await page.getByRole('link', { name: /返回大厅/ }).first().click();
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect.poll(() => blurListenerCount(page)).toBe(baselineBlur);
    await expect.poll(() => visibilityListenerCount(page)).toBe(baselineVisibility);

    await openBlankGame(page);
    await page.getByRole('link', { name: /返回大厅/ }).first().click();
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
    await expect.poll(() => blurListenerCount(page)).toBe(baselineBlur);
    await expect.poll(() => visibilityListenerCount(page)).toBe(baselineVisibility);
  });

  test('tears down the game when leaving while the page is hidden', async ({ page }) => {
    await installBlurListenerProbe(page);
    await page.goto('/');
    const baselineBlur = await blurListenerCount(page);
    const baselineVisibility = await visibilityListenerCount(page);

    await openBlankGame(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('game-status')).toHaveText('已暂停 · 页面不可见');

    await page.getByRole('link', { name: /返回大厅/ }).first().click();
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect.poll(() => blurListenerCount(page)).toBe(baselineBlur);
    await expect.poll(() => visibilityListenerCount(page)).toBe(baselineVisibility);
  });

  test('aborts a late mount when the route changes during loading', async ({ page }) => {
    await page.route('**/assets/view-*.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    const viewRequest = page.waitForRequest('**/assets/view-*.js');

    await page.goto('/#/games/blank');
    await viewRequest;
    await page.evaluate(() => {
      location.hash = '#/';
    });

    await expect(page.getByTestId('game-card-blank')).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.getByTestId('blank-game')).toHaveCount(0);
  });

  test('adapts the canvas to its container and stays inside the viewport', async ({ page }) => {
    await openBlankGame(page);
    await page.setViewportSize({ width: 800, height: 900 });
    await expect
      .poll(async () => (await canvasBox(page)).width, { timeout: 3_000 })
      .toBeGreaterThan(700);

    const box = await canvasBox(page);
    const stage = await page.getByTestId('blank-stage').boundingBox();
    if (!stage) {
      throw new Error('Stage has no bounding box');
    }
    expect(Math.abs(box.width - (stage.width - 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - (stage.height - 2))).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );

    const position = await readPosition(page);
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.x).toBeLessThanOrEqual(Math.round(box.width));
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeLessThanOrEqual(Math.round(box.height));
  });
});
