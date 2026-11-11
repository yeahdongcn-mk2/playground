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
 * Capture the Before / After evidence for the breakout integration.
 *
 *   npm run screenshots:breakout
 *   BASE_URL=http://127.0.0.1:4184 node scripts/capture-breakout-screenshots.mjs --before
 *   npm run screenshots:breakout:webkit
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The before mode must point BASE_URL at a main baseline preview;
 * main has no breakout route, so no debug seam is needed there.
 *
 * The preview port is 4185 by default; on a shared host set `PREVIEW_PORT` to a
 * free port instead of editing this file. When that port is already taken, the
 * script fails with an explicit bind error instead of quietly talking to the
 * other server. A preview that exits right after the pre-spawn port probe
 * reports its exit code and stderr instead of being mistaken for the ready
 * server.
 *
 * `--webkit` captures the four stable phone states (ready / playing /
 * levelclear / gameover) on the iPhone SE WebKit device as
 * `after-breakout-<state>-webkit.png`. It is an After-only mode; the desktop and
 * hub evidence stay Chromium.
 *
 * The playing states pin `seed=7` and `?debug=1&steps=120`: the debug seam
 * pauses the loop and advances exactly 120 fixed simulation steps (1 s at the
 * engine's 120 Hz step), so their PNGs are reproducible byte-for-byte instead
 * of depending on wall-clock frame timing. See docs/screenshots/README.md for
 * the reproducible sha256 procedure.
 */

const HOST = '127.0.0.1';
const PORT = parsePreviewPort(process.env.PREVIEW_PORT, 4185);
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const ARGS = process.argv.slice(2);
const MODE = ARGS.includes('--before') ? 'before' : 'after';
const ENGINE = parseCaptureEngine(ARGS);
const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;
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

// The playing screenshots are deterministic: the debug seam advances exactly
// PLAYING_STEPS fixed engine steps after the serve and then pauses the loop.
const PLAYING_SEED = 7;
const PLAYING_STEPS = 120;

let server = null;

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function capture(page, name, fullPage) {
  await captureScreenshot(page, name, { engine: ENGINE, fullPage });
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
  await openBreakout(page, { seed: PLAYING_SEED, steps: PLAYING_STEPS });
  await page.getByTestId('overlay').getByRole('button', { name: '开始游戏' }).click();
  await page.getByTestId('overlay').waitFor({ state: 'hidden' });
  await page.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
  // Wait for the debug seam to finish its fixed steps. It pauses the game loop
  // afterwards, so no wall-clock delay can change the state before capture.
  await page.waitForFunction(
    (steps) =>
      document
        .querySelector('[data-testid="breakout-game"]')
        ?.getAttribute('data-debug-steps') === String(steps),
    PLAYING_STEPS,
  );
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

/** Capture the stable breakout phone states on the WebKit engine. */
async function captureWebkitMobile(browser) {
  const context = await createPhoneContext(browser, ENGINE);

  const ready = await context.newPage();
  await openReady(ready);
  await capture(ready, 'after-breakout-ready-webkit.png', false);
  await ready.close();

  const playing = await context.newPage();
  await openPlaying(playing);
  await capture(playing, 'after-breakout-playing-webkit.png', false);
  await playing.close();

  const cleared = await context.newPage();
  await openLevelClear(cleared);
  await capture(cleared, 'after-breakout-levelclear-webkit.png', false);
  await cleared.close();

  const over = await context.newPage();
  await openGameOver(over);
  await capture(over, 'after-breakout-gameover-webkit.png', false);
  await over.close();

  await context.close();
}

if (MODE === 'before' && IS_WEBKIT) {
  throw new Error('The --webkit mode captures After screenshots only.');
}

if (MODE === 'before' && !process.env.BASE_URL) {
  throw new Error(
    'The before mode needs BASE_URL pointing at a preview of the main baseline (see docs/screenshots/README.md).',
  );
}

await mkdir(OUTPUT, { recursive: true });

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

  const browser = await launchCaptureBrowser(ENGINE);
  try {
    if (IS_WEBKIT) {
      await captureWebkitMobile(browser);
    } else {
      await captureDesktop(browser);
      await captureMobile(browser);
    }
    console.log(
      `Captured ${MODE} breakout screenshots on ${engineLabel(ENGINE)} in ${OUTPUT}`,
    );
  } finally {
    await closeCaptureBrowser(browser);
  }
} finally {
  stopPreviewServer(server);
  server = null;
}
