import type { Page } from '@playwright/test';
import { waitForBlankSettled } from '../../scripts/lib/blank-settle.mjs';
import { canvasBox, expect, openBlankGame, test } from './fixtures';
import {
  collectFrameworkTapDiagnostics,
  formatFrameworkTapDiagnostics,
  installFrameworkTapProbe,
  readFrameworkTapPageSnapshot,
  readFrameworkTapProbe,
  type FrameworkTapTarget,
} from './framework-diagnostics';

/** The product-level position tolerance already used by this case. */
const TAP_TOLERANCE = 8;

const ZHEN_SHA_CARD = '[data-testid="game-card-zhen-sha"]';
const ZHEN_SHA_CTA = '[data-testid="enter-zhen-sha"]';
/** The six entries that stay in the lobby grid next to the featured card. */
const GRID_GAME_IDS = ['snake', 'tetris', '2048', 'breakout', 'minesweeper', 'blank'] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Assert a locator's border box is completely inside the visible viewport. */
async function expectFullyOnFirstScreen(
  page: Page,
  selector: string,
  label: string,
): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport, 'viewport size should be available').not.toBeNull();
  if (viewport === null) {
    return;
  }
  const box = await page.locator(selector).boundingBox();
  expect(box, `${label} should render a box`).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.width, `${label} should have a non-zero width`).toBeGreaterThan(0);
  expect(box.height, `${label} should have a non-zero height`).toBeGreaterThan(0);
  expect(box.x, `${label} should start at or after the left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} should start at or after the top edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} should end inside the viewport width`).toBeLessThanOrEqual(
    viewport.width,
  );
  expect(box.y + box.height, `${label} should end inside the viewport height`).toBeLessThanOrEqual(
    viewport.height,
  );
}

/**
 * Shared framework mobile case for the Chromium `mobile` project and the
 * WebKit `mobile-webkit` project. Keeping the assertions here means the touch
 * interaction is verified once and executed by both engines instead of being
 * copied into a second spec.
 *
 * The tap result is awaited with the blank scene's deterministic settle loop:
 * the readout must stay on the tapped canvas point with no trail left for
 * several consecutive samples. A wall-clock poll can pass on one lucky frame
 * and fail on a cold CI start (issue #117), so it is not used here. The wait is
 * still wrapped with the tap diagnostics so a failure reports whether the tap
 * reached the canvas, whether the readout moved and whether the frame loop
 * advanced instead of only a timeout.
 */
export function defineFrameworkMobileCases(): void {
  test.describe('mobile shell', () => {
    test('hub and blank canvas fit a phone viewport', async ({ page }) => {
      await installFrameworkTapProbe(page);
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
      const target: FrameworkTapTarget = {
        viewportX: targetX,
        viewportY: targetY,
        localX: targetX - box.x,
        localY: targetY - box.y,
        tolerance: TAP_TOLERANCE,
      };

      const baseline = (await readFrameworkTapPageSnapshot(page)).readout;
      const probeBefore = await readFrameworkTapProbe(page);
      const startedAt = Date.now();
      let tapError: string | null = null;
      try {
        await page.touchscreen.tap(targetX, targetY);
      } catch (error) {
        tapError = errorMessage(error);
      }
      try {
        await waitForBlankSettled(
          page,
          { x: target.localX, y: target.localY },
          { tolerance: TAP_TOLERANCE },
        );
      } catch (error) {
        // A closed/crashed page makes collection throw too; keep the original
        // settle error (which names the last readout) and say that diagnostics
        // could not be collected.
        let diagnosticMessage: string;
        try {
          const diagnostics = await collectFrameworkTapDiagnostics(page, {
            target,
            canvas: box,
            baseline,
            probeBefore,
            elapsedMs: Date.now() - startedAt,
            tapError,
          });
          diagnosticMessage = formatFrameworkTapDiagnostics(diagnostics);
        } catch (collectionError) {
          diagnosticMessage = `诊断采集失败: ${errorMessage(collectionError)}`;
        }
        throw new Error(`${diagnosticMessage}\n\n原始断言错误: ${errorMessage(error)}`, {
          cause: error,
        });
      }

      // Falsifiable wiring check: the success path must prove the probe really
      // saw the tap. Without this, a probe that stopped counting would still
      // pass every test and only produce a wrong failure message later.
      const probeAfter = await readFrameworkTapProbe(page);
      const canvasHits =
        probeAfter.canvasPointerDown +
        probeAfter.canvasTouchStart -
        (probeBefore.canvasPointerDown + probeBefore.canvasTouchStart);
      expect(canvasHits, 'tap 探针应记录到 canvas 上的 pointerdown/touchstart').toBeGreaterThan(0);
      expect(probeAfter.lastPointerDown?.target ?? probeAfter.lastTouchStart?.target).toBe(
        'game-canvas',
      );

      await expect(page.getByTestId('input-mode')).toHaveText('指针 / 触屏');

      await page.getByTestId('reset').tap();
      await expect(page.getByTestId('game-status')).toHaveText('位置已重置');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        (await page.evaluate(() => window.innerWidth)) + 1,
      );
    });
  });

  // The narrowest supported phone width, exercised by both the Chromium
  // `mobile` project and the WebKit `mobile-webkit` project. The hub fixture is
  // the production hero from #430; this case pins the phone regression that the
  // desktop project's 320x640 case cannot see (touch device emulation).
  test.describe('zhen-sha lobby at 320x640', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test('keeps the featured card in the first screen with a reachable primary CTA and six entries', async ({
      page,
    }) => {
      await page.goto('/');
      expect(page.viewportSize()).toEqual({ width: 320, height: 640 });

      const card = page.getByTestId('game-card-zhen-sha');
      await expect(card).toHaveCount(1);
      await expect(card).toHaveClass(/game-card--feature/);
      await expect(card).toBeVisible();
      await expectFullyOnFirstScreen(page, ZHEN_SHA_CARD, 'the zhen-sha featured card');

      // At the <=860px breakpoint the featured visual is ordered above the
      // hero copy, so the CTA itself sits below the promoted card instead of
      // inside the first 640px. Issue #252 pins the card's bounding box to the
      // first screen and only requires the CTA to stay visible, linked and
      // unobstructed, so scroll it in and assert that reachability.
      const cta = page.locator(ZHEN_SHA_CTA);
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('href', '#/games/zhen-sha');
      await cta.scrollIntoViewIfNeeded();
      await expect(cta).toBeInViewport({ ratio: 1 });

      // The CTA must be the element hit at its own centre; a collapsed or
      // overlapped button still has a bounding box, so geometry alone is not
      // enough to prove it is reachable.
      const obstructed = await cta.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return top === null || !(top === element || element.contains(top));
      });
      expect(obstructed, 'the hero CTA must not be covered by another element').toBe(false);

      // Only zhen-sha is promoted: the hero carries exactly one primary button.
      const primaryButtons = page.locator('.hero .button--primary');
      await expect(primaryButtons).toHaveCount(1);
      expect(
        await primaryButtons.evaluate((element) => element.getAttribute('data-testid')),
      ).toBe('enter-zhen-sha');

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        'the lobby must not scroll horizontally at 320px',
      ).toBeLessThanOrEqual(overflow.clientWidth);

      for (const id of GRID_GAME_IDS) {
        const entry = page.getByTestId(`game-card-${id}`);
        await expect(entry, `grid entry ${id} should appear exactly once`).toHaveCount(1);
        await expect(entry, `grid entry ${id} should stay visible`).toBeVisible();
      }
    });
  });
}
