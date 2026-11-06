import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

/**
 * Capture the Before / After evidence for the minesweeper integration.
 *
 *   npm run screenshots:minesweeper
 *   BASE_URL=http://127.0.0.1:4187 node scripts/capture-minesweeper-screenshots.mjs --before
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The before mode must point BASE_URL at a main baseline preview;
 * main has no minesweeper route, so no debug seam is needed there.
 */

const HOST = '127.0.0.1';
const PORT = 4186;
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const MODE = process.argv.includes('--before') ? 'before' : 'after';
const BASE_URL = process.env.BASE_URL ?? ORIGIN;

// The same deterministic layouts as tests/e2e/minesweeper-helpers.ts: a mine
// wall on row 4 (plus a corner mine) for the loss flow, and a mine block in
// the top-left corner for an instant win when (8, 8) is revealed.
const LOSS_MINES = ['0,0', ...Array.from({ length: 9 }, (_, col) => `4,${col}`)].join(';');
const WIN_MINES = [
  '0,0',
  '0,1',
  '0,2',
  '1,0',
  '1,1',
  '1,2',
  '2,0',
  '2,1',
  '2,2',
  '0,3',
].join(';');

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

function debugUrl(mines) {
  const query = new URLSearchParams({ debug: '1', mines });
  return `${BASE_URL}/#/games/minesweeper?${query.toString()}`;
}

async function openMinesweeper(page, mines) {
  await page.goto(debugUrl(mines), { waitUntil: 'networkidle' });
  await page.locator('[data-cell]').first().waitFor();
  await page.getByTestId('overlay').waitFor({ state: 'hidden' });
  await settle(page);
}

async function openReady(page) {
  await openMinesweeper(page, WIN_MINES);
  await page.getByTestId('status').filter({ hasText: '待开始' }).waitFor();
}

async function openPlaying(page) {
  await openMinesweeper(page, LOSS_MINES);
  await page.getByTestId('cell-7-4').click();
  await page.getByTestId('cell-0-0').click({ button: 'right' });
  await page.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
  await page.getByTestId('remaining-mines').filter({ hasText: '9' }).waitFor();
  // Let the elapsed-time HUD advance past 0:00 so the screenshot shows it live.
  await page.getByTestId('timer').filter({ hasNotText: '0:00' }).waitFor();
  await settle(page);
}

async function openLost(page) {
  await openMinesweeper(page, LOSS_MINES);
  await page.getByTestId('cell-7-4').click();
  await page.getByTestId('cell-0-0').click();
  await page.getByTestId('overlay-title').filter({ hasText: '踩到地雷' }).waitFor();
  await settle(page);
}

async function openWon(page) {
  await openMinesweeper(page, WIN_MINES);
  await page.getByTestId('cell-8-8').click();
  await page.getByTestId('overlay-title').filter({ hasText: '扫雷成功' }).waitFor();
  await settle(page);
}

async function captureDesktop(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });

  if (MODE === 'before') {
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await settle(hub);
    await capture(hub, 'before-minesweeper-hub-desktop.png', true);
    await hub.close();

    const route = await context.newPage();
    await route.goto(`${BASE_URL}/#/games/minesweeper`, { waitUntil: 'networkidle' });
    await route.getByText('没有找到这个游戏').waitFor();
    await settle(route);
    await capture(route, 'before-minesweeper-route-desktop.png', true);
    await route.close();
  } else {
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await hub.getByTestId('game-card-minesweeper').waitFor();
    await settle(hub);
    await capture(hub, 'after-hub-desktop.png', true);
    await hub.close();

    // A fresh page per state avoids a hash-remount race between screenshots.
    const ready = await context.newPage();
    await openReady(ready);
    await capture(ready, 'after-minesweeper-ready-desktop.png', true);
    await ready.close();

    const playing = await context.newPage();
    await openPlaying(playing);
    await capture(playing, 'after-minesweeper-playing-desktop.png', true);
    await playing.close();

    const lost = await context.newPage();
    await openLost(lost);
    await capture(lost, 'after-minesweeper-lost-desktop.png', true);
    await lost.close();

    const won = await context.newPage();
    await openWon(won);
    await capture(won, 'after-minesweeper-won-desktop.png', true);
    await won.close();
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

  if (MODE === 'before') {
    // Full-page so the single-column card grid (where minesweeper will appear)
    // is visible; a 390x844 viewport only reaches the hero.
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await settle(hub);
    await capture(hub, 'before-minesweeper-hub-mobile.png', true);
    await hub.close();
  } else {
    // Same full-page framing as the Before hub so the new card is comparable.
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await hub.getByTestId('game-card-minesweeper').waitFor();
    await settle(hub);
    await capture(hub, 'after-hub-mobile.png', true);
    await hub.close();
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
  console.log(`Captured ${MODE} minesweeper screenshots in ${OUTPUT}`);
} finally {
  await browser.close();
  server?.kill();
}
