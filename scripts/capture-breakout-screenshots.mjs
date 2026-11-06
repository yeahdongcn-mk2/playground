import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

/**
 * Capture the Before / After evidence for the breakout integration.
 *
 *   npm run screenshots:breakout
 *   BASE_URL=http://127.0.0.1:4184 node scripts/capture-breakout-screenshots.mjs --before
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The before mode must point BASE_URL at a main baseline preview;
 * main has no breakout route, so no debug seam is needed there.
 */

const HOST = '127.0.0.1';
const PORT = 4185;
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const MODE = process.argv.includes('--before') ? 'before' : 'after';
const BASE_URL = process.env.BASE_URL ?? ORIGIN;

// A single brick with the ball already aimed at its bottom edge. The engine
// resolves the hit immediately, so the level-clear overlay is deterministic.
// These layout numbers mirror DEFAULT_BREAKOUT_CONFIG in engine.ts; this is a
// standalone Node script, so it cannot import the TypeScript module directly.
const SINGLE_BRICK = '0,0';
const BRICK_BOTTOM = 72 + 24;
const BRICK_CENTER_X = 24 + (480 - 48 - 9 * 4) / 10 / 2;
const BALL_UNDER_BRICK = `${BRICK_CENTER_X},${BRICK_BOTTOM + 8 - 1},0,-200`;
const BALL_BELOW_COURT = '240,740,0,50';

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

function debugUrl(params) {
  const query = new URLSearchParams({ debug: '1', ...params });
  return `${BASE_URL}/#/games/breakout?${query.toString()}`;
}

async function openBreakout(page, params) {
  await page.goto(debugUrl(params), { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="breakout-board"] canvas');
  await page.getByTestId('overlay').waitFor();
  await settle(page);
}

async function openReady(page) {
  await openBreakout(page, {});
  await page.getByTestId('overlay-title').filter({ hasText: '击碎整面砖墙' }).waitFor();
  await page.getByTestId('status').filter({ hasText: '待开始' }).waitFor();
}

async function openPlaying(page) {
  await openBreakout(page, { seed: 7 });
  await page.getByTestId('overlay').getByRole('button', { name: '开始游戏' }).click();
  await page.getByTestId('overlay').waitFor({ state: 'hidden' });
  await page.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
  await page.waitForTimeout(800);
  await settle(page);
}

async function openLevelClear(page) {
  await openBreakout(page, { bricks: SINGLE_BRICK, ball: BALL_UNDER_BRICK });
  await page.getByTestId('overlay-title').filter({ hasText: '第 1 关清空' }).waitFor();
}

async function openGameOver(page) {
  await openBreakout(page, { lives: '1', ball: BALL_BELOW_COURT });
  await page.getByTestId('overlay-title').filter({ hasText: '生命用完了' }).waitFor();
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
    await capture(hub, 'before-breakout-hub-desktop.png', true);
    await hub.close();

    const route = await context.newPage();
    await route.goto(`${BASE_URL}/#/games/breakout`, { waitUntil: 'networkidle' });
    await route.getByText('没有找到这个游戏').waitFor();
    await settle(route);
    await capture(route, 'before-breakout-route-desktop.png', true);
    await route.close();
  } else {
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await hub.getByTestId('game-card-breakout').waitFor();
    await settle(hub);
    await capture(hub, 'after-hub-desktop.png', true);
    await hub.close();

    // A fresh page per state avoids a hash-remount race between screenshots.
    const ready = await context.newPage();
    await openReady(ready);
    await capture(ready, 'after-breakout-ready-desktop.png', true);
    await ready.close();

    const playing = await context.newPage();
    await openPlaying(playing);
    await capture(playing, 'after-breakout-playing-desktop.png', true);
    await playing.close();

    const cleared = await context.newPage();
    await openLevelClear(cleared);
    await capture(cleared, 'after-breakout-levelclear-desktop.png', true);
    await cleared.close();

    const over = await context.newPage();
    await openGameOver(over);
    await capture(over, 'after-breakout-gameover-desktop.png', true);
    await over.close();
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
    // Full-page so the single-column card grid (where breakout will appear) is
    // visible; a 390x844 viewport only reaches the hero.
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await settle(hub);
    await capture(hub, 'before-breakout-hub-mobile.png', true);
    await hub.close();

    const route = await context.newPage();
    await route.goto(`${BASE_URL}/#/games/breakout`, { waitUntil: 'networkidle' });
    await route.getByText('没有找到这个游戏').waitFor();
    await settle(route);
    await capture(route, 'before-breakout-route-mobile.png', false);
    await route.close();
  } else {
    // Same full-page framing as the Before hub so the breakout card is comparable.
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await hub.getByTestId('game-card-breakout').waitFor();
    await settle(hub);
    await capture(hub, 'after-hub-mobile.png', true);
    await hub.close();

    const ready = await context.newPage();
    await openReady(ready);
    await capture(ready, 'after-breakout-ready-mobile.png', false);
    await ready.close();

    const playing = await context.newPage();
    await openPlaying(playing);
    await capture(playing, 'after-breakout-playing-mobile.png', false);
    await playing.close();

    const over = await context.newPage();
    await openGameOver(over);
    await capture(over, 'after-breakout-gameover-mobile.png', false);
    await over.close();
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
  console.log(`Captured ${MODE} breakout screenshots in ${OUTPUT}`);
} finally {
  await browser.close();
  server?.kill();
}
