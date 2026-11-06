import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

/**
 * Capture the Before / After evidence for the 2048 integration PR.
 *
 *   npm run screenshots:2048
 *   BASE_URL=http://127.0.0.1:4184 node scripts/capture-2048-screenshots.mjs --before
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The before mode must point BASE_URL at a main baseline preview;
 * main has no 2048 route, so no debug seam is needed there.
 */

const HOST = '127.0.0.1';
const PORT = 4183;
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const MODE = process.argv.includes('--before') ? 'before' : 'after';
const BASE_URL = process.env.BASE_URL ?? ORIGIN;
const COLOUR_BOARD = '2,4,8,16/32,64,128,256/512,1024,2048,./.,.,.,.';
const MERGE_BOARD = '2,2,4,4/8,8,16,16/.,.,.,./.,.,.,.';
const STUCK_BOARD = '2,2,16,8/8,4,2,16/4,8,16,2/16,2,4,8';

let server = null;

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
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function capture(page, name, fullPage) {
  await page.screenshot({
    path: `${OUTPUT}/${name}`,
    fullPage,
    animations: 'disabled',
  });
}

async function open2048(page, board) {
  await page.goto(`${BASE_URL}/#/games/2048?debug=1&board=${board}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-testid="2048-board"] canvas');
  await page.getByTestId('overlay-title').filter({ hasText: '合并出 2048' }).waitFor();
  await page.getByTestId('status').filter({ hasText: '准备开始' }).waitFor();
  await settle(page);
}

async function captureDesktop(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  if (MODE === 'before') {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await settle(page);
    await capture(page, 'before-2048-hub-desktop.png', true);

    await page.goto(`${BASE_URL}/#/games/2048`, { waitUntil: 'networkidle' });
    await page.getByText('没有找到这个游戏').waitFor();
    await settle(page);
    await capture(page, 'before-2048-route-desktop.png', true);
  } else {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.getByTestId('game-card-2048').waitFor();
    await settle(page);
    await capture(page, 'after-hub-desktop.png', true);

    await open2048(page, COLOUR_BOARD);
    await capture(page, 'after-2048-ready-desktop.png', true);

    await open2048(page, MERGE_BOARD);
    await page.keyboard.press('ArrowLeft');
    await page.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
    await page.getByTestId('score').filter({ hasText: '60' }).waitFor();
    await settle(page);
    await capture(page, 'after-2048-playing-desktop.png', true);

    await open2048(page, STUCK_BOARD);
    await page.keyboard.press('ArrowLeft');
    await page.getByTestId('overlay-title').filter({ hasText: '无路可走' }).waitFor();
    await settle(page);
    await capture(page, 'after-2048-gameover-desktop.png', true);
  }

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

  if (MODE === 'before') {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await settle(page);
    await capture(page, 'before-2048-hub-mobile.png', false);

    await page.goto(`${BASE_URL}/#/games/2048`, { waitUntil: 'networkidle' });
    await page.getByText('没有找到这个游戏').waitFor();
    await settle(page);
    await capture(page, 'before-2048-route-mobile.png', false);
  } else {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.getByTestId('game-card-2048').waitFor();
    await settle(page);
    await capture(page, 'after-hub-mobile.png', false);

    await open2048(page, COLOUR_BOARD);
    await capture(page, 'after-2048-ready-mobile.png', false);

    await open2048(page, MERGE_BOARD);
    await page.keyboard.press('ArrowLeft');
    await page.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
    await settle(page);
    await capture(page, 'after-2048-playing-mobile.png', false);

    await open2048(page, STUCK_BOARD);
    await page.keyboard.press('ArrowLeft');
    await page.getByTestId('overlay-title').filter({ hasText: '无路可走' }).waitFor();
    await settle(page);
    await capture(page, 'after-2048-gameover-mobile.png', false);
  }

  await context.close();
}

if (MODE === 'before' && !process.env.BASE_URL) {
  throw new Error(
    'The before mode needs BASE_URL pointing at a preview of the main baseline (see docs/screenshots/README.md).',
  );
}

if (!process.env.BASE_URL) {
  server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      HOST,
      '--port',
      String(PORT),
      '--strictPort',
    ],
    { stdio: 'ignore' },
  );
  process.on('exit', () => server?.kill());
  await waitForServer(ORIGIN);
}

await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch();
try {
  await captureDesktop(browser);
  await captureMobile(browser);
  console.log(`Captured ${MODE} 2048 screenshots in ${OUTPUT}`);
} finally {
  await browser.close();
  server?.kill();
}
