import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { webkit } from '@playwright/test';
import {
  captureStableBytes,
  phoneContextOptions,
  repaintWebkitReadyOverlay,
  settleWebkitReadyPaint,
} from '../../scripts/lib/capture-runtime.mjs';
import { expect, test } from './fixtures';

/**
 * Falsifiable two-run guard for the fixed-container 2048 READY evidence
 * (Issue #199 review).
 *
 * The committed PNG and the nightly repro both compare bytes, but neither can
 * fail a normal PR when the capture runtime stops producing a stable raster.
 * This spec runs the real built page on WebKit twice, in two separate browser
 * processes like the two container runs, applies the same READY seams as
 * `scripts/capture-2048-screenshots.mjs`, and fails unless each run produces
 * two byte-identical consecutive screenshots and both runs agree on the
 * sha256. Manifest fidelity is a separate concern: `verify:screenshots:sha256`
 * and the nightly `verify:screenshots:repro` workflow compare every fixed-
 * container target, on every manifest target and under concurrent host load.
 */

/** Deliberate copy of the capture script's COLOR_BOARD for the committed READY evidence. */
const READY_BOARD = '2,4,8,16/32,64,128,256/512,1024,2048,./.,.,.,.';
const READY_URL = `/#/games/2048?debug=1&board=${READY_BOARD}&seed=135`;

async function openReady(page: Page): Promise<void> {
  await page.goto(READY_URL, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-testid="2048-board"] canvas')).toBeVisible();
  await expect(page.getByTestId('overlay-title')).toHaveText('合并出 2048');
  await expect(page.getByTestId('status')).toHaveText('准备开始');
}

/** Capture one READY run through the production stability loop. */
async function captureStableReady(page: Page): Promise<string> {
  await settleWebkitReadyPaint(page);
  await repaintWebkitReadyOverlay(page);
  const bytes = await captureStableBytes(page);
  return createHash('sha256').update(bytes).digest('hex');
}

async function captureRun(baseURL: string): Promise<string> {
  const browser = await webkit.launch();
  try {
    // This context is created outside the built-in fixtures, so it must carry
    // its own baseURL (and its own page-error check) explicitly.
    const context = await browser.newContext({
      ...phoneContextOptions('webkit'),
      baseURL,
    });
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await openReady(page);
    const digest = await captureStableReady(page);
    expect(pageErrors, 'the READY page must not throw').toEqual([]);
    return digest;
  } finally {
    await browser.close();
  }
}

test('2048 READY WebKit capture is byte-identical on two fresh runs', async () => {
  test.slow();

  const baseURL = test.info().project.use.baseURL;
  if (baseURL === undefined) {
    throw new Error('the mobile-webkit project must define a baseURL');
  }

  const first = await captureRun(baseURL);
  const second = await captureRun(baseURL);

  expect(second, 'both runs must produce the same READY bytes').toBe(first);
});
