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
 * Falsifiable two-run guard for the 2048 READY WebKit capture path
 * (Issue #199 review).
 *
 * This spec runs the real built page on WebKit twice, in two separate browser
 * processes like the two container runs, applies the same READY seams as
 * `scripts/capture-2048-screenshots.mjs`, and fails unless each run observes
 * the overlay hide / restore seam, produces two byte-identical consecutive
 * screenshots and both runs agree on the sha256. It checks run-to-run
 * consistency of one commit's raster, not manifest fidelity:
 * `after-2048-ready-webkit.png` is intentionally outside the sha256 manifest
 * (Issue #374) because concurrent host load can settle it into byte-stable
 * 1-LSB variants. The manifest gates playing / gameover through
 * `verify:screenshots:sha256` and the nightly `verify:screenshots:repro`.
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

interface OverlayRepaintTrace {
  /** The overlay style attribute before each mutation: this records `display: none`. */
  styles: (string | null)[];
  /** The inline display value after the seam, which must be restored. */
  display: string;
}

interface ReadyRun {
  digest: string;
  repaint: OverlayRepaintTrace;
}

/**
 * Record the overlay style mutations the repaint seam makes.
 *
 * The two-run hash guard cannot fail when both runs produce the same wrong
 * raster, which is the shape of the load-dependent blocker. Observing the
 * overlay during the real capture proves the hide / restore seam actually ran
 * in each fresh browser process: removing it leaves this trace empty and fails
 * the run even before the two hashes are compared.
 */
async function observeOverlayRepaint(page: Page): Promise<void> {
  await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="overlay"]');
    if (!(overlay instanceof HTMLElement)) {
      throw new Error('the READY page must have an overlay element to repaint');
    }
    const trace: (string | null)[] = [];
    const target = window as typeof window & {
      __readyOverlayRepaint?: (string | null)[];
    };
    target.__readyOverlayRepaint = trace;
    new MutationObserver((records) => {
      for (const record of records) {
        trace.push(record.oldValue);
      }
    }).observe(overlay, {
      attributes: true,
      attributeFilter: ['style'],
      attributeOldValue: true,
    });
  });
}

async function readOverlayRepaintTrace(page: Page): Promise<OverlayRepaintTrace> {
  return page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="overlay"]');
    const target = window as typeof window & {
      __readyOverlayRepaint?: (string | null)[];
    };
    return {
      styles: target.__readyOverlayRepaint ?? [],
      display: overlay instanceof HTMLElement ? overlay.style.display : 'missing',
    };
  });
}

/** Capture one READY run through the production stability loop. */
async function captureStableReady(page: Page): Promise<ReadyRun> {
  await settleWebkitReadyPaint(page);
  await observeOverlayRepaint(page);
  await repaintWebkitReadyOverlay(page);
  const repaint = await readOverlayRepaintTrace(page);
  const bytes = await captureStableBytes(page);
  return { digest: createHash('sha256').update(bytes).digest('hex'), repaint };
}

async function captureRun(baseURL: string): Promise<ReadyRun> {
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
    const run = await captureStableReady(page);
    expect(pageErrors, 'the READY page must not throw').toEqual([]);
    return run;
  } finally {
    await browser.close();
  }
}

test('2048 READY WebKit capture hides and restores the overlay, then is byte-identical on two runs', async () => {
  test.slow();

  const baseURL = test.info().project.use.baseURL;
  if (baseURL === undefined) {
    throw new Error('the mobile-webkit project must define a baseURL');
  }

  const first = await captureRun(baseURL);
  const second = await captureRun(baseURL);

  for (const [label, run] of [
    ['first', first],
    ['second', second],
  ] as const) {
    expect(
      run.repaint.styles.some((style) => style?.includes('display: none')),
      `the ${label} run must hide the overlay for the repaint seam`,
    ).toBe(true);
    expect(
      run.repaint.display,
      `the ${label} run must restore the overlay before the capture`,
    ).toBe('');
  }

  expect(second.digest, 'both runs must produce the same READY bytes').toBe(first.digest);
});
