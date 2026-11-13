import { expect, test } from './fixtures';

test.use({ viewport: { width: 320, height: 640 } });

/**
 * 320x640 is the documented minimum viewport. The stage may extend past the
 * fold, but the three gesture hints are the onboarding copy and must be read
 * without scrolling (issue #250 t2 review).
 */
test('shows the three gesture hints inside the 320x640 first screen', async ({ page }) => {
  await page.goto('/#/games/zhen-sha');

  const hints = page.getByTestId('gesture-hints');
  await expect(hints).toBeVisible();
  await expect(hints.locator('li')).toHaveCount(3);

  const hintsBox = await hints.boundingBox();
  expect(hintsBox).not.toBeNull();
  expect(hintsBox!.y).toBeGreaterThanOrEqual(0);
  expect(hintsBox!.y + hintsBox!.height).toBeLessThanOrEqual(640);

  // On phones the hints lead the stage so they are not pushed below the fold by
  // the tall play area.
  const stageBox = await page.getByTestId('zhen-sha-stage').boundingBox();
  expect(stageBox).not.toBeNull();
  expect(stageBox!.y).toBeGreaterThanOrEqual(hintsBox!.y + hintsBox!.height);
});
