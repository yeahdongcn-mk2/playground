import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
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

const PORT = 4174;
const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = 'docs/screenshots';
const shouldStartServer = !process.env.BASE_URL;
const ARGS = process.argv.slice(2);
const ENGINE = parseCaptureEngine(ARGS);
const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;

let server = null;

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The preview server is still booting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

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
  await mkdir(OUTPUT_DIR, { recursive: true });

  if (shouldStartServer) {
    server = startPreviewServer({ port: PORT, host: '127.0.0.1', stdio: 'inherit' });
    await waitForServer(BASE_URL);
  }

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
}
