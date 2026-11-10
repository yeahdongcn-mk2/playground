import { mkdir } from 'node:fs/promises';
import {
  WEBKIT_ENGINE,
  captureScreenshot,
  closeCaptureBrowser,
  createPhoneContext,
  engineLabel,
  launchCaptureBrowser,
  parseCaptureEngine,
  startPreviewServer,
  stopPreviewServer,
} from './lib/capture-runtime.mjs';
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

async function captureDesktop(browser) {
  const context = await browser.newContext({
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
  await page.mouse.click(box.x + box.width * 0.66, box.y + box.height * 0.4);
  await page.waitForTimeout(700);
  await captureScreenshot(page, 'after-blank-desktop.png', {
    engine: ENGINE,
    animations: 'allow',
  });

  await context.close();
}

async function captureMobile(browser) {
  const context = await browser.newContext({
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
  await page.touchscreen.tap(box.x + box.width * 0.36, box.y + box.height * 0.62);
  await page.waitForTimeout(700);
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
  await page.touchscreen.tap(box.x + box.width * 0.36, box.y + box.height * 0.62);
  await page.waitForTimeout(700);
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
