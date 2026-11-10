import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, openMinesweeper } from './minesweeper-helpers';

/**
 * Minimal WebKit smoke test for the `mobile-webkit` project. It only proves
 * that the built app boots on WebKit, renders the default board without an
 * uncaught page error (asserted by `fixtures`) and does not overflow the
 * iPhone SE (3rd gen) viewport horizontally.
 */
test.describe('minesweeper on WebKit', () => {
  test('opens the default board without page errors or horizontal overflow', async ({
    page,
    browserName,
  }) => {
    expect(browserName).toBe('webkit');
    expect(page.viewportSize()).toEqual({ width: 375, height: 667 });

    await openMinesweeper(page);
    await expect(page.getByTestId('minesweeper-game')).toBeVisible();
    await expect(page.getByTestId('minesweeper-board')).toBeVisible();
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');

    await expectNoHorizontalOverflow(page);
  });
});
