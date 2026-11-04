import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const HOST = '127.0.0.1';
const PORT = 5174;
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForReady(page) {
  await page.waitForSelector('[data-testid="snake-canvas"]');
  await page.waitForFunction(() => window.__playground?.getState().status === 'ready');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function captureSnake(page, name) {
  const canvas = page.getByTestId('snake-canvas');
  await canvas.waitFor();
  await page.screenshot({
    path: `${OUTPUT}/${name}`,
    fullPage: true,
    animations: 'disabled',
  });
}

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', HOST, '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
);

let browser;
try {
  await waitForServer(ORIGIN);
  await mkdir(OUTPUT, { recursive: true });
  browser = await chromium.launch();

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const hub = await desktop.newPage();
  await hub.goto(ORIGIN, { waitUntil: 'networkidle' });
  await hub.evaluate(() => document.fonts.ready);
  await hub.waitForTimeout(300);
  await hub.screenshot({
    path: `${OUTPUT}/after-hub-desktop.png`,
    fullPage: true,
    animations: 'disabled',
  });

  const ready = await desktop.newPage();
  await ready.goto(`${ORIGIN}/?food=11,10#/games/snake`, { waitUntil: 'networkidle' });
  await waitForReady(ready);
  await captureSnake(ready, 'after-snake-ready.png');

  await ready.keyboard.press('Space');
  await ready.waitForFunction(() => window.__playground?.getState().score >= 10);
  await ready.waitForTimeout(80);
  await captureSnake(ready, 'after-snake-playing.png');

  const over = await desktop.newPage();
  await over.goto(`${ORIGIN}/?food=0,0#/games/snake`, { waitUntil: 'networkidle' });
  await waitForReady(over);
  await over.keyboard.press('Space');
  await over.keyboard.press('ArrowUp');
  await over.waitForFunction(() => window.__playground?.getState().status === 'gameover');
  await over.waitForTimeout(300);
  await captureSnake(over, 'after-snake-gameover.png');

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const mobileHub = await mobile.newPage();
  await mobileHub.goto(ORIGIN, { waitUntil: 'networkidle' });
  await mobileHub.evaluate(() => document.fonts.ready);
  await mobileHub.waitForTimeout(300);
  await mobileHub.screenshot({
    path: `${OUTPUT}/after-hub-mobile.png`,
    fullPage: false,
    animations: 'disabled',
  });

  const mobileGame = await mobile.newPage();
  await mobileGame.goto(`${ORIGIN}/?food=11,10#/games/snake`, { waitUntil: 'networkidle' });
  await waitForReady(mobileGame);
  await mobileGame.getByTestId('dpad').scrollIntoViewIfNeeded();
  await mobileGame.evaluate(() => window.scrollBy(0, -24));
  await mobileGame.waitForTimeout(300);
  await mobileGame.screenshot({
    path: `${OUTPUT}/after-snake-mobile.png`,
    fullPage: false,
    animations: 'disabled',
  });

  await desktop.close();
  await mobile.close();
  console.log('Screenshots written to docs/screenshots/');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
