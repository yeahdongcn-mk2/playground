import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import {
  cellLocator,
  difficultyButton,
  expectActiveDifficulty,
  expectInsideViewport,
  expectNoHorizontalOverflow,
  openMinesweeper,
} from './minesweeper-helpers';

/** Assert a control meets the 44px touch-target contract on both axes. */
async function expectMinTouchTarget(locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a bounding box`).not.toBeNull();
  expect(box?.height ?? 0, `${label} should be at least 44px tall`).toBeGreaterThanOrEqual(
    44,
  );
  expect(box?.width ?? 0, `${label} should be at least 44px wide`).toBeGreaterThanOrEqual(
    44,
  );
}

/** Submit the custom form with touch events, including the submit button. */
async function submitCustomByTouch(
  page: Page,
  rows: number,
  cols: number,
  mines: number,
): Promise<void> {
  const fields = [
    ['custom-rows', rows],
    ['custom-cols', cols],
    ['custom-mines', mines],
  ] as const;
  for (const [testId, value] of fields) {
    const input = page.getByTestId(testId);
    await input.tap();
    await input.fill(String(value));
  }
  await page.getByTestId('custom-difficulty-submit').tap();
}

/**
 * Narrow viewports that still have to explain the large-board degradation.
 * 320 is the supported minimum and 360 is the common short screen; both stay
 * inside the 560px warning breakpoint.
 */
const LARGE_BOARD_VIEWPORTS = [
  { width: 320, height: 640, label: '320x640' },
  { width: 360, height: 640, label: '360x640' },
] as const;

/** Assert the large-board warning state, including readable copy when shown. */
async function expectLargeBoardWarning(
  page: Page,
  visible: boolean,
): Promise<void> {
  const warning = page.getByTestId('board-size-warning');
  if (!visible) {
    await expect(warning).toBeHidden();
    return;
  }
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute('role', 'status');
  await expect(warning).toContainText('≥36px');
  await expect(warning).toContainText('横屏');
  await expect(warning).toContainText('更小的棋盘');
  // It must be readable, not just present: scroll it into view and check it
  // fits the viewport without causing horizontal overflow.
  await warning.scrollIntoViewIfNeeded();
  await expectInsideViewport(page, warning, 'large-board warning');
}

/**
 * Shared touch-form cases for the Chromium `mobile` project and the WebKit
 * `mobile-webkit` project. Presets, the custom form, validation and the
 * large-board warning are tapped through the touchscreen on both engines.
 */
export function defineMinesweeperDifficultyMobileCases(): void {
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

      await submitCustomByTouch(page, 12, 12, 20);
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
      await submitCustomByTouch(page, 8, 8, 64);
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

    test('the minimum 320px viewport keeps the selector, error and 16×30 expert board usable', async ({
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

      // The 44px touch-target contract applies to the presets and the custom
      // submit button; a screenshot is not an assertion.
      for (const id of ['beginner', 'intermediate', 'expert'] as const) {
        await expectMinTouchTarget(difficultyButton(page, id), `${id} preset`);
      }
      await expectMinTouchTarget(
        page.getByTestId('custom-difficulty-submit'),
        'custom submit',
      );

      await difficultyButton(page, 'intermediate').tap();
      await expect(page.locator('[data-cell]')).toHaveCount(256);
      await expect(page.getByTestId('board-summary')).toHaveText('16 × 16 · 40 雷');
      await expectNoHorizontalOverflow(page);

      // The 16×30 expert board has the most columns, so its cells are the
      // narrowest; assert the page still does not overflow at the minimum
      // supported 320px width.
      await difficultyButton(page, 'expert').tap();
      await expect(page.locator('[data-cell]')).toHaveCount(480);
      await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');
      await expectActiveDifficulty(page, 'expert');
      await expectNoHorizontalOverflow(page);

      await submitCustomByTouch(page, 99, 9, 10);
      const error = page.getByTestId('difficulty-error');
      await expect(error).toHaveText('行数必须是 5 到 30 之间的整数。');
      await expect(error).toBeVisible();
      await expectInsideViewport(page, error, 'difficulty error at 320px');
      await expect(page.locator('[data-cell]')).toHaveCount(480);
      await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');
      await expectNoHorizontalOverflow(page);

      // The far-corner expert cell must stay tappable at 320px.
      await cellLocator(page, 15, 29).tap();
      await expect(page.getByTestId('status')).toHaveText('进行中');
    });

    for (const viewport of LARGE_BOARD_VIEWPORTS) {
      test(`large boards explain the scaled cells on ${viewport.label} and 9×9 hides the hint`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openMinesweeper(page);
        const game = page.getByTestId('minesweeper-game');

        // The initial 9×9 board keeps its exact layout and the warning hidden.
        await expect(page.locator('[data-cell]')).toHaveCount(81);
        await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
        await expect(game).toHaveAttribute('data-large-board', 'false');
        await expectLargeBoardWarning(page, false);
        await expectNoHorizontalOverflow(page);

        // Built-in 16×30 expert: 480 cells, visible hint, no horizontal scroll
        // and the far corner still taps into the playing state.
        await difficultyButton(page, 'expert').tap();
        await expect(page.locator('[data-cell]')).toHaveCount(480);
        await expect(page.getByTestId('board-summary')).toHaveText('16 × 30 · 99 雷');
        await expectActiveDifficulty(page, 'expert');
        await expect(game).toHaveAttribute('data-large-board', 'true');
        await expectLargeBoardWarning(page, true);
        await expectNoHorizontalOverflow(page);

        await cellLocator(page, 15, 29).tap();
        await expect(page.getByTestId('status')).toHaveText('进行中');

        // A custom board with more than nine columns takes the same scaled path
        // and keeps its own cells tappable.
        await submitCustomByTouch(page, 10, 12, 15);
        await expect(page.locator('[data-cell]')).toHaveCount(120);
        await expect(page.getByTestId('board-summary')).toHaveText('10 × 12 · 15 雷');
        await expectActiveDifficulty(page, null);
        await expect(game).toHaveAttribute('data-large-board', 'true');
        await expectLargeBoardWarning(page, true);
        await expectNoHorizontalOverflow(page);

        await cellLocator(page, 9, 11).tap();
        await expect(page.getByTestId('status')).toHaveText('进行中');

        // Back to 9×9: the state clears and the hint disappears again without
        // changing the board size or introducing horizontal scroll.
        await difficultyButton(page, 'beginner').tap();
        await expect(page.locator('[data-cell]')).toHaveCount(81);
        await expect(page.getByTestId('board-summary')).toHaveText('9 × 9 · 10 雷');
        await expectActiveDifficulty(page, 'beginner');
        await expect(game).toHaveAttribute('data-large-board', 'false');
        await expectLargeBoardWarning(page, false);
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}
