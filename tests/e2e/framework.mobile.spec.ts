import { canvasBox, expect, openBlankGame, readPosition, test } from './fixtures';

test.describe('mobile shell', () => {
  test('hub and blank canvas fit a phone viewport', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      (await page.evaluate(() => window.innerWidth)) + 1,
    );

    await openBlankGame(page);
    const box = await canvasBox(page);
    const stage = await page.getByTestId('blank-stage').boundingBox();
    if (!stage) {
      throw new Error('Stage has no bounding box');
    }
    expect(box.width).toBeGreaterThan(280);
    expect(box.width).toBeLessThanOrEqual(stage.width);
    expect(stage.height).toBeGreaterThanOrEqual(300);
    expect(stage.height).toBeLessThanOrEqual(560);

    const targetX = box.x + box.width * 0.25;
    const targetY = box.y + box.height * 0.7;
    await page.touchscreen.tap(targetX, targetY);

    await expect
      .poll(
        async () => {
          const position = await readPosition(page);
          return (
            Math.abs(position.x - (targetX - box.x)) <= 8 &&
            Math.abs(position.y - (targetY - box.y)) <= 8
          );
        },
        { timeout: 3_000 },
      )
      .toBe(true);
    await expect(page.getByTestId('input-mode')).toHaveText('指针 / 触屏');

    await page.getByTestId('reset').tap();
    await expect(page.getByTestId('game-status')).toHaveText('位置已重置');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      (await page.evaluate(() => window.innerWidth)) + 1,
    );
  });
});
