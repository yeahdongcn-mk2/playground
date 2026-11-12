import { mkdir } from 'node:fs/promises';
import {
  WEBKIT_ENGINE,
  captureScreenshot,
  closeCaptureBrowser,
  createDesktopContext,
  createMobileContext,
  createPhoneContext,
  engineLabel,
  launchCaptureBrowser,
  parseCaptureEngine,
  startPreviewServer,
  stopPreviewServer,
} from './lib/capture-runtime.mjs';
import { waitForBlankSettled } from './lib/blank-settle.mjs';
import { assertPortAvailable, parsePreviewPort } from './lib/preview-port.mjs';
import { waitForPreviewServer } from './lib/preview-server.mjs';

/**
 * Shared hub / blank-canvas evidence capture.
 *
 * The preview port is 4174 by default; on a shared host set `PREVIEW_PORT` to a
 * free port instead of editing this file. When that port is already taken, the
 * script fails with an explicit bind error instead of quietly talking to the
 * other server. A preview that exits right after the pre-spawn port probe
 * reports its exit code and stderr instead of being mistaken for the ready
 * server.
 *
 * Setting `BASE_URL` skips the local preview entirely: no port probe, no spawn.
 * The WebKit mode (`--webkit`) reuses the same startup path and port.
 *
 * The blank scenes poll the HUD readout after the pointer input instead of
 * sleeping for 700 ms: a frame is captured only once the orb has snapped to
 * the click target and the trail array is empty for several consecutive
 * samples. With `reducedMotion: reduce` the target ring does not pulse and the
 * orb scale is fixed, so that settled frame is reproducible byte-for-byte.
 */

const HOST = '127.0.0.1';
const PORT = parsePreviewPort(process.env.PREVIEW_PORT, 4174);
const ORIGIN = `http://${HOST}:${PORT}`;
const BASE_URL = process.env.BASE_URL ?? ORIGIN;
const OUTPUT_DIR = 'docs/screenshots';
const ARGS = process.argv.slice(2);
const ENGINE = parseCaptureEngine(ARGS);
const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;

let server = null;

/**
 * Click or tap a canvas fraction, then wait until the orb has snapped to that
 * target and its trail has completely faded before the caller screenshots.
 */
async function tapBlankCanvas(page, box, xRatio, yRatio, { touch = false } = {}) {
  const target = { x: box.width * xRatio, y: box.height * yRatio };
  if (touch) {
    await page.touchscreen.tap(box.x + target.x, box.y + target.y);
  } else {
    await page.mouse.click(box.x + target.x, box.y + target.y);
  }
  await waitForBlankSettled(page, target);
}

async function captureDesktop(browser) {
  const context = await createDesktopContext(browser, {
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await captureScreenshot(page, 'after-hub-desktop.png', {
    engine: ENGINE,
    fullPage: true,
    animations: 'allow',
  });

  await page.goto(`${BASE_URL}/#/games/blank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="blank-game"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="blank-stage"]')?.dataset.state === 'ready',
    undefined,
    { timeout: 20_000 },
  );
  const canvas = page.locator('canvas[data-testid="game-canvas"]');
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas has no bounding box');
  }
  await tapBlankCanvas(page, box, 0.66, 0.4);
  await captureScreenshot(page, 'after-blank-desktop.png', {
    engine: ENGINE,
    animations: 'allow',
  });

  await context.close();
}

async function captureMobile(browser) {
  const context = await createMobileContext(browser, {
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await captureScreenshot(page, 'after-hub-mobile.png', {
    engine: ENGINE,
    fullPage: true,
    animations: 'allow',
  });

  await page.goto(`${BASE_URL}/#/games/blank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="blank-game"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="blank-stage"]')?.dataset.state === 'ready',
    undefined,
    { timeout: 20_000 },
  );
  const canvas = page.locator('canvas[data-testid="game-canvas"]');
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas has no bounding box');
  }
  await tapBlankCanvas(page, box, 0.36, 0.62, { touch: true });
  await captureScreenshot(page, 'after-blank-mobile.png', {
    engine: ENGINE,
    animations: 'allow',
  });

  await context.close();
}

/** Capture the stable hub and blank-canvas phone frames on WebKit. */
async function captureWebkitMobile(browser) {
  const context = await createPhoneContext(browser, ENGINE);
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await captureScreenshot(page, 'after-hub-webkit.png', {
    engine: ENGINE,
    animations: 'allow',
  });

  await page.goto(`${BASE_URL}/#/games/blank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="blank-game"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="blank-stage"]')?.dataset.state === 'ready',
    undefined,
    { timeout: 20_000 },
  );
  const canvas = page.locator('canvas[data-testid="game-canvas"]');
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas has no bounding box');
  }
  await tapBlankCanvas(page, box, 0.36, 0.62, { touch: true });
  await captureScreenshot(page, 'after-blank-webkit.png', {
    engine: ENGINE,
    animations: 'allow',
  });

  await context.close();
}

try {
  if (!process.env.BASE_URL) {
    // Fail with the real cause when the port is taken; otherwise the readiness
    // probe would connect to the other server and an unrelated locator timeout
    // would be reported much later.
    await assertPortAvailable(PORT, HOST);

    // Test seam: point this at a stand-in that exits non-zero so the unit test
    // can exercise the post-probe startup failure without a second server.
    server = startPreviewServer({
      host: HOST,
      port: PORT,
      entry: process.env.PREVIEW_ENTRY || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForPreviewServer(server, { origin: ORIGIN, port: PORT });
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await launchCaptureBrowser(ENGINE);
  try {
    if (IS_WEBKIT) {
      await captureWebkitMobile(browser);
    } else {
      await captureDesktop(browser);
      await captureMobile(browser);
    }
  } finally {
    await closeCaptureBrowser(browser);
  }

  console.log(`Screenshots written to ${OUTPUT_DIR}/ on ${engineLabel(ENGINE)}`);
} finally {
  stopPreviewServer(server);
  server = null;
}
