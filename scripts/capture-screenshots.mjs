import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const PORT = 4174;
const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = 'docs/screenshots';
const shouldStartServer = !process.env.BASE_URL;

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
  await page.screenshot({ path: `${OUTPUT_DIR}/after-hub-desktop.png` });

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
  await page.screenshot({ path: `${OUTPUT_DIR}/after-blank-desktop.png` });

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
  await page.screenshot({ path: `${OUTPUT_DIR}/after-hub-mobile.png` });

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
  await page.screenshot({ path: `${OUTPUT_DIR}/after-blank-mobile.png` });

  await context.close();
}

try {
  await mkdir(OUTPUT_DIR, { recursive: true });

  if (shouldStartServer) {
    server = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { stdio: 'inherit' },
    );
    await waitForServer(BASE_URL);
  }

  const browser = await chromium.launch();
  try {
    await captureDesktop(browser);
    await captureMobile(browser);
  } finally {
    await browser.close();
  }

  console.log(`Screenshots written to ${OUTPUT_DIR}/`);
} finally {
  if (server) {
    server.kill('SIGTERM');
  }
}
