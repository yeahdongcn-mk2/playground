import { canvasBox, expect, openBlankGame, readPosition, test } from './fixtures';
import {
  collectFrameworkTapDiagnostics,
  formatFrameworkTapDiagnostics,
  installFrameworkTapProbe,
  isFrameworkTapSettled,
  readFrameworkTapPageSnapshot,
  readFrameworkTapProbe,
  type FrameworkTapTarget,
} from './framework-diagnostics';

/** The product-level position tolerance already used by this case. */
const TAP_TOLERANCE = 8;
/** The poll budget this case already uses; diagnostics must not widen it. */
const TAP_TIMEOUT_MS = 3_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shared framework mobile case for the Chromium `mobile` project and the
 * WebKit `mobile-webkit` project. Keeping the assertions here means the touch
 * interaction is verified once and executed by both engines instead of being
 * copied into a second spec.
 *
 * The tap poll is wrapped so a failure reports whether the tap reached the
 * canvas, whether the readout moved and whether the frame loop advanced
 * instead of only `Timeout 3000ms exceeded` (issue #117).
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
        await expect
          .poll(async () => isFrameworkTapSettled(await readPosition(page), target), {
            timeout: TAP_TIMEOUT_MS,
            message: `readout should reach canvas point (${target.localX}, ${target.localY}) ±${TAP_TOLERANCE}`,
          })
          .toBe(true);
      } catch (error) {
        // A closed/crashed page makes collection throw too; keep the original
        // assertion error and say that diagnostics could not be collected.
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
}
