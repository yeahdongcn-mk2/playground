import { expect, test } from './fixtures';
import {
  cellLocator,
  difficultyButton,
  expectActiveDifficulty,
  expectInsideViewport,
  expectNoHorizontalOverflow,
  openMinesweeper,
  submitCustomDifficulty,
} from './minesweeper-helpers';

test.describe('minesweeper difficulty selector on a phone viewport', () => {
  test('presets and custom boards are operable by touch without horizontal overflow', async ({
    page,
  }) => {
    await openMinesweeper(page);
    await expectNoHorizontalOverflow(page);
    await expectActiveDifficulty(page, 'beginner');

    // `tap` goes through the touchscreen path and auto-scrolls the sidebar
    // controls into view, which is how a phone user reaches them.
    await difficultyButton(page, 'intermediate').tap();
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    await expect(page.getByTestId('remaining-mines')).toHaveText('40');
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expectActiveDifficulty(page, 'intermediate');
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(
      page,
      page.getByTestId('difficulty-presets'),
      'preset buttons',
    );

    await difficultyButton(page, 'expert').tap();
    await expect(page.locator('[data-cell]')).toHaveCount(480);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');
    await expect(page.getByTestId('remaining-mines')).toHaveText('99');
    await expectActiveDifficulty(page, 'expert');
    await expectNoHorizontalOverflow(page);

    await submitCustomDifficulty(page, 12, 12, 20);
    await expect(page.locator('[data-cell]')).toHaveCount(144);
    await expect(page.getByTestId('board-summary')).toHaveText('12 × 12 · 20 雷');
    await expect(page.getByTestId('remaining-mines')).toHaveText('20');
    await expectActiveDifficulty(page, null);
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(
      page,
      page.getByTestId('custom-difficulty-form'),
      'custom form',
    );

    // A rejected custom board stays a visible alert and does not rebuild.
    await submitCustomDifficulty(page, 8, 8, 64);
    const error = page.getByTestId('difficulty-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveText('雷数必须小于格子总数（64）。');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.locator('[data-cell]')).toHaveCount(144);
    await expect(page.getByTestId('board-summary')).toHaveText('12 × 12 · 20 雷');
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(page, error, 'difficulty error');
  });

  test('the minimum 320px viewport keeps the selector and its error readable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openMinesweeper(page);
    await expectNoHorizontalOverflow(page);

    await page.getByTestId('custom-difficulty-form').scrollIntoViewIfNeeded();
    await expectInsideViewport(
      page,
      page.getByTestId('custom-difficulty-form'),
      'custom form at 320px',
    );
    await expectInsideViewport(
      page,
      page.getByTestId('difficulty-presets'),
      'preset buttons at 320px',
    );

    await difficultyButton(page, 'intermediate').tap();
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    await expectNoHorizontalOverflow(page);

    await submitCustomDifficulty(page, 99, 9, 10);
    const error = page.getByTestId('difficulty-error');
    await expect(error).toHaveText('行数必须是 5 到 30 之间的整数。');
    await expect(error).toBeVisible();
    await expectInsideViewport(page, error, 'difficulty error at 320px');
    await expect(page.locator('[data-cell]')).toHaveCount(256);
    await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
    await expectNoHorizontalOverflow(page);

    await cellLocator(page, 15, 15).tap();
    await expect(page.getByTestId('status')).toHaveText('进行中');
  });
});
