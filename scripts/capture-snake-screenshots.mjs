import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

/**
 * Capture the before/after evidence used in the PR description.
 *
 *   node scripts/capture-snake-screenshots.mjs --before   # framework baseline (t2 head)
 *   node scripts/capture-snake-screenshots.mjs            # snake integrated
 *
 * The dev server is used on purpose: the deterministic first fruit (?food=...)
 * is a DEV-only seam, and the screenshots should show the same rendering the
 * player gets in development.
 */

const HOST = '127.0.0.1';
const PORT = 5188;
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const MODE = process.argv.includes('--before') ? 'before' : 'after';

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

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function waitForSnakeReady(page) {
  await page.waitForSelector('[data-testid="snake-board"] canvas');
  await page.waitForFunction(() => window.__playground?.getState().status === 'ready');
  await settle(page);
}

async function capture(page, name, fullPage = true) {
  await page.screenshot({
    path: `${OUTPUT}/${name}`,
    fullPage,
    animations: 'disabled',
  });
}

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', HOST, '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());

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

  if (MODE === 'before') {
    const hub = await desktop.newPage();
    await hub.goto(ORIGIN, { waitUntil: 'networkidle' });
    await settle(hub);
    await capture(hub, 'before-framework-hub.png', true);

    const blank = await desktop.newPage();
    await blank.goto(`${ORIGIN}/#/games/blank`, { waitUntil: 'networkidle' });
    await blank.waitForSelector('[data-testid="blank-stage"][data-state="ready"]');
    await settle(blank);
    await capture(blank, 'before-framework-blank.png', true);

    const snakeRoute = await desktop.newPage();
    await snakeRoute.goto(`${ORIGIN}/#/games/snake`, { waitUntil: 'networkidle' });
    await settle(snakeRoute);
    await capture(snakeRoute, 'before-framework-snake-route.png', true);

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
    await settle(mobileHub);
    await capture(mobileHub, 'before-framework-hub-mobile.png', false);
    await mobile.close();
  } else {
    const hub = await desktop.newPage();
    await hub.goto(ORIGIN, { waitUntil: 'networkidle' });
    await settle(hub);
    await capture(hub, 'after-hub-desktop.png', true);

    const ready = await desktop.newPage();
    await ready.goto(`${ORIGIN}/#/games/snake?debug=1&food=11,10`, { waitUntil: 'networkidle' });
    await waitForSnakeReady(ready);
    await capture(ready, 'after-snake-ready.png', true);

    const playing = await desktop.newPage();
    await playing.goto(`${ORIGIN}/#/games/snake?debug=1&food=11,10`, { waitUntil: 'networkidle' });
    await waitForSnakeReady(playing);
    await playing.keyboard.press('Space');
    await playing.waitForFunction(() => window.__playground?.getState().score >= 10);
    await playing.waitForTimeout(120);
    await capture(playing, 'after-snake-playing.png', true);

    const over = await desktop.newPage();
    await over.goto(`${ORIGIN}/#/games/snake?debug=1&food=0,0`, { waitUntil: 'networkidle' });
    await waitForSnakeReady(over);
    await over.keyboard.press('Space');
    await over.keyboard.press('ArrowUp');
    await over.waitForFunction(() => window.__playground?.getState().status === 'gameover');
    await over.waitForTimeout(300);
    await capture(over, 'after-snake-gameover.png', true);

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
    await settle(mobileHub);
    await capture(mobileHub, 'after-hub-mobile.png', false);

    const mobileGame = await mobile.newPage();
    await mobileGame.goto(`${ORIGIN}/#/games/snake?debug=1&food=11,10`, { waitUntil: 'networkidle' });
    await waitForSnakeReady(mobileGame);
    await mobileGame.getByTestId('dpad').scrollIntoViewIfNeeded();
    await mobileGame.evaluate(() => window.scrollBy(0, -16));
    await mobileGame.waitForTimeout(300);
    await capture(mobileGame, 'after-snake-mobile.png', false);
    await mobile.close();
  }

  await desktop.close();
  console.log(`Captured ${MODE} screenshots in ${OUTPUT}`);
} finally {
  await browser?.close();
  server.kill();
}
