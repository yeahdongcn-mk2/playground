import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, openSnake, trackPageErrors } from './helpers';

test.describe('arcade hub', () => {
  test('shows one playable game and two roadmap cards', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/');

    await expect(page).toHaveTitle(/Playground Arcade/);
    await expect(page.getByRole('heading', { level: 1, name: /小游戏/ })).toBeVisible();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
    await expect(page.locator('.game-card--playable')).toHaveCount(1);
    await expect(page.locator('.game-card--soon')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: '技术底座' })).toBeVisible();
    await expect(page.getByText('Phaser 4').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    expect(errors).toEqual([]);
  });

  test('scrolls to the tech stack instead of rebuilding the hub', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: '看看技术底座' }).click();

    await expect(page).toHaveURL(/#stack$/);
    await expect(page.getByRole('heading', { name: '技术底座' })).toBeInViewport();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
  });

  test('opens Snake, mounts the canvas and returns to the hub', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/');
    await page.getByTestId('game-card-snake').click();

    await expect(page).toHaveURL(/#\/games\/snake$/);
    await expect(page.getByTestId('snake-canvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__playground?.gameId)).toBe('snake');

    const canvas = await page.getByTestId('snake-canvas').boundingBox();
    expect(canvas).not.toBeNull();
    expect(canvas?.width ?? 0).toBeGreaterThan(300);
    expect(Math.abs((canvas?.width ?? 0) - (canvas?.height ?? 0))).toBeLessThan(3);

    await page.getByRole('link', { name: /全部游戏/ }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    expect(await page.evaluate(() => window.__playground)).toBeUndefined();

    expect(errors).toEqual([]);
  });

  test('remembers the sound preference after a reload', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('sound-toggle');

    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveClass(/is-muted/);

    await page.reload();
    await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(
      await page.evaluate(() => localStorage.getItem('playground:v1:settings.sound')),
    ).toBe('off');
  });

  test('a direct game URL mounts the game without visiting the hub', async ({ page }) => {
    await page.goto('/#/games/snake');
    await expect(page.getByTestId('snake-canvas')).toBeVisible();
    await expect(page.getByTestId('score')).toHaveText('0');
  });

  test('an unknown game shows a recoverable error and returns to the hub', async ({ page }) => {
    await page.goto('/#/games/does-not-exist');
    await expect(page.getByRole('heading', { name: /没有找到这个游戏/ })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);

    await page.getByRole('link', { name: '返回游戏库' }).click();
    await expect(page.getByTestId('game-card-snake')).toBeVisible();
  });
});

test.describe('snake high score display', () => {
  test('shows a stored best score before the first round', async ({ page }) => {
    await openSnake(page, { best: 120 });
    await expect(page.getByTestId('best')).toHaveText('120');
    await expect(page.getByTestId('score')).toHaveText('0');
  });
});
