import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import {
  expectFirstScreenContract,
  expectNoHorizontalOverflow,
  LOSS_MINES,
  openMinesweeper,
  readState,
} from './minesweeper-helpers';
import { defineMinesweeperMobileTouchCases } from './minesweeper-mobile-touch-cases';

/**
 * Every supported phone size that the first-screen contract covers. The
 * 320px minimum uses the documented 34px geometric fallback; widths from
 * 340px up keep 36px touch targets. 360x640 and 375x667 cover the short/narrow
 * edge added for Issue #60; 400x700 exercises the pre-existing <=700px query;
 * all entries require the compact restart entry to stay inside the first
 * screen. 412x839 is the Pixel 7 default viewport from playwright.config.ts.
 */
const FIRST_SCREEN_VIEWPORTS = [
  { width: 320, height: 640, minimumCellSize: 34, label: '320x640' },
  { width: 340, height: 700, minimumCellSize: 36, label: '340x700' },
  { width: 349, height: 700, minimumCellSize: 36, label: '349x700' },
  { width: 360, height: 640, minimumCellSize: 36, label: '360x640' },
  { width: 360, height: 740, minimumCellSize: 36, label: '360x740' },
  { width: 375, height: 667, minimumCellSize: 36, label: '375x667' },
  { width: 400, height: 700, minimumCellSize: 36, label: '400x700' },
  { width: 412, height: 839, minimumCellSize: 36, label: '412x839' },
] as const;

/**
 * The 340x667 min-width / max-height corner must actually match the short
 * screen query. Its first-screen geometry also passes without that query, so
 * assert the tightened computed styles; the boundary test below also checks
 * the max-width edge, the one-pixel-outside corners and both unchanged
 * neighborhoods, so a regression to `min-width: 341px`, `max-width: 399px`
 * or `max-height: 666px` cannot slip through.
 */
async function expectShortScreenTightening(page: Page): Promise<void> {
  const heading = page.locator('.minesweeper-game .game-heading');
  await expect(heading).toHaveCSS('row-gap', '6px');
  await expect(heading).toHaveCSS('padding-bottom', '4px');
  await expect(page.getByTestId('touch-hint')).toHaveCSS('margin-top', '2px');
  await expect(page.locator('.minesweeper-touch-actions')).toHaveCSS(
    'margin-top',
    '2px',
  );
}

/** The <=400x<=700 query must survive untouched above 667px and below 340px. */
async function expectShortScreenSpacingUnchanged(page: Page): Promise<void> {
  const heading = page.locator('.minesweeper-game .game-heading');
  await expect(heading).toHaveCSS('row-gap', '8px');
  await expect(heading).toHaveCSS('padding-bottom', '10px');
  await expect(page.getByTestId('touch-hint')).toHaveCSS('margin-top', '4px');
  await expect(page.locator('.minesweeper-touch-actions')).toHaveCSS(
    'margin-top',
    '6px',
  );
}

/** Above 400px neither narrow query applies, so the <=560px base spacing returns. */
async function expectBaseSpacing(page: Page): Promise<void> {
  const heading = page.locator('.minesweeper-game .game-heading');
  await expect(heading).toHaveCSS('row-gap', '12px');
  await expect(heading).toHaveCSS('padding-bottom', '22px');
  await expect(page.getByTestId('touch-hint')).toHaveCSS('margin-top', '10px');
  await expect(page.locator('.minesweeper-touch-actions')).toHaveCSS(
    'margin-top',
    '12px',
  );
}

test.describe('minesweeper on a phone viewport', () => {
  test('opens with the board, HUD and restart / back entries inside the viewport', async ({
    page,
  }) => {
    await openMinesweeper(page, { mines: LOSS_MINES });
    await expectFirstScreenContract(page, 36, { restartEntry: true });

    await expect(page.getByTestId('minesweeper-board')).toBeVisible();
    await expect(page.locator('[data-cell]')).toHaveCount(81);
    await expect(page.getByTestId('status')).toHaveText('待开始');
    await expect(page.getByTestId('remaining-mines')).toHaveText('10');
    await expect(page.getByTestId('timer')).toHaveText('0:00');
    await expect(page.getByTestId('overlay')).toBeHidden();
    expect((await readState(page)).status).toBe('ready');

    await expect(page.getByTestId('touch-hint')).toBeVisible();
    await expect(page.getByTestId('touch-hint')).toContainText('长按');
    expect(
      await page
        .getByTestId('minesweeper-board')
        .evaluate((board) => getComputedStyle(board).userSelect),
    ).toBe('none');
  });

  test('renders the longest custom best-time label without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(() => {
      localStorage.setItem(
        'playground:v1:minesweeper.scores',
        JSON.stringify({
          version: 1,
          records: { 'custom:30x30x100:unsafe': 125_000 },
        }),
      );
    });
    await openMinesweeper(page, { mines: LOSS_MINES });

    const row = page.locator('[data-score-bucket="custom:30x30x100:unsafe"]');
    await expect(row).toContainText('自定义 30×30 / 100 雷（首点不安全）');
    await expect(row).toContainText('2:05');
    await expectNoHorizontalOverflow(page);

    // The longest label must wrap inside the card instead of widening the
    // 320px document; the panel itself has to stay inside the viewport.
    const card = await page.getByTestId('scores-panel').boundingBox();
    expect(card, 'score panel should have a bounding box').not.toBeNull();
    if (card) {
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(320.5);
    }
  });

  for (const viewport of FIRST_SCREEN_VIEWPORTS) {
    test(`keeps the first-screen mobile contract on a ${viewport.label} viewport`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openMinesweeper(page, { mines: LOSS_MINES });

      // Every supported phone size must keep the compact restart entry fully
      // inside the first screen, not just the board, HUD and back link.
      await expectFirstScreenContract(page, viewport.minimumCellSize, {
        restartEntry: true,
      });
    });
  }

  test('matches the short-screen query only between 340 and 400px wide and at most 667px high', async ({
    page,
  }) => {
    // 340x667 is the min-width / max-height corner of the query. The geometry
    // alone would pass without the query, so also pin the tightened styles.
    await page.setViewportSize({ width: 340, height: 667 });
    await openMinesweeper(page, { mines: LOSS_MINES });
    await expectFirstScreenContract(page, 36, { restartEntry: true });
    await expectShortScreenTightening(page);

    // 339px is one pixel below the min-width edge: only the older <=700px
    // query applies, so no extra tightening.
    await page.setViewportSize({ width: 339, height: 667 });
    await expectShortScreenSpacingUnchanged(page);

    // 668px is one pixel above the new max-height edge (the older <=700px
    // query still applies): only the base short-narrow compression remains.
    await page.setViewportSize({ width: 340, height: 668 });
    await expectShortScreenSpacingUnchanged(page);

    // 320px is below the min-width boundary (and its 34px fallback): the base
    // short-narrow spacing must survive untouched.
    await page.setViewportSize({ width: 320, height: 640 });
    await expectShortScreenSpacingUnchanged(page);

    // 400px is the max-width corner; the new query still applies there.
    await page.setViewportSize({ width: 400, height: 667 });
    await expectShortScreenTightening(page);

    // 401px is one pixel above the max-width edge: both narrow queries stop
    // applying, so the base (>400px) spacing returns.
    await page.setViewportSize({ width: 401, height: 667 });
    await expectBaseSpacing(page);
  });
});

// The touch gestures are shared with the `mobile-webkit` entry; the 8-viewport
// matrix and the short-screen query boundary stay Chromium-only.
defineMinesweeperMobileTouchCases();
