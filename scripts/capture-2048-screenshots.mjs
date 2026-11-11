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
import {
  HISTORICAL_OVERWRITE_FLAG,
  guardHistoricalAfterEvidence,
} from './lib/screenshot-evidence.mjs';

/**
 * Capture the Before / After evidence for the 2048 integration PR.
 *
 *   npm run screenshots:2048
 *   BASE_URL=http://127.0.0.1:4184 node scripts/capture-2048-screenshots.mjs --before
 *   npm run screenshots:2048:webkit
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The before mode must point BASE_URL at a main baseline preview;
 * main has no 2048 route, so no debug seam is needed there.
 *
 * The preview port is 4183 by default; on a shared host set `PREVIEW_PORT` to a
 * free port instead of editing this file. When that port is already taken, the
 * script fails with an explicit bind error instead of quietly talking to the
 * other server. A preview that exits right after the pre-spawn port probe
 * reports its exit code and stderr instead of being mistaken for the ready
 * server.
 *
 * `--webkit` captures the three stable phone states (ready / playing /
 * gameover) on the iPhone SE WebKit device as `after-2048-<state>-webkit.png`.
 * It is an After-only mode; the desktop and hub evidence stay Chromium.
 *
 * Playing and gameover pin `seed=135` in addition to the board, so the tile
 * spawned after ArrowLeft is deterministic. See docs/screenshots/README.md for
 * the reproducible sha256 procedure and its conditions.
 *
 * The After mode skips the frozen `after-2048-ready-desktop.png` and
 * `after-2048-ready-mobile.png` historical evidence and prints a warning unless
 * `--allow-historical-overwrite` is passed; the playing / gameover / hub
 * captures still refresh.
 */

const HOST = '127.0.0.1';
const PORT = parsePreviewPort(process.env.PREVIEW_PORT, 4183);
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const ARGS = process.argv.slice(2);
const MODE = ARGS.includes('--before') ? 'before' : 'after';
const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes(HISTORICAL_OVERWRITE_FLAG);
const ENGINE = parseCaptureEngine(ARGS);
const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;
const BASE_URL = process.env.BASE_URL ?? ORIGIN;
const COLOR_BOARD = '2,4,8,16/32,64,128,256/512,1024,2048,./.,.,.,.';
const MERGE_BOARD = '2,2,4,4/8,8,16,16/.,.,.,./.,.,.,.';
const STUCK_BOARD = '2,2,16,8/8,4,2,16/4,8,16,2/16,2,4,8';
/** Fixed debug RNG seed; the engine test pins the same value and boards. */
const DEBUG_SEED = '135';

let server = null;

/** URL after the hash route, e.g. `#/games/2048?debug=1&board=...&seed=135`. */
function gameUrl(board) {
  return `${BASE_URL}/#/games/2048?debug=1&board=${board}&seed=${DEBUG_SEED}`;
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  // Two animation frames commit the canvas paint triggered by the last state
  // change; the timeout only keeps the Phaser loop as a fallback, so the
  // deterministic result does not depend on a fixed wall-clock delay alone.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await page.waitForTimeout(300);
}

async function capture(page, name, fullPage) {
  const write = guardHistoricalAfterEvidence({
    file: name,
    mode: MODE,
    allowHistoricalOverwrite: ALLOW_HISTORICAL_OVERWRITE,
  });
  if (!write) return;
  await captureScreenshot(page, name, { engine: ENGINE, fullPage });
}

async function open2048(page, board) {
  await page.goto(gameUrl(board), {
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

  if (MODE === 'before') {
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await settle(hub);
    await capture(hub, 'before-2048-hub-desktop.png', true);
    await hub.close();

    const route = await context.newPage();
    await route.goto(`${BASE_URL}/#/games/2048`, { waitUntil: 'networkidle' });
    await route.getByText('没有找到这个游戏').waitFor();
    await settle(route);
    await capture(route, 'before-2048-route-desktop.png', true);
    await route.close();
  } else {
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await hub.getByTestId('game-card-2048').waitFor();
    await settle(hub);
    await capture(hub, 'after-hub-desktop.png', true);
    await hub.close();

    // A fresh page per state avoids a hash-remount race between screenshots.
    const ready = await context.newPage();
    await open2048(ready, COLOR_BOARD);
    await capture(ready, 'after-2048-ready-desktop.png', true);
    await ready.close();

    const playing = await context.newPage();
    await open2048(playing, MERGE_BOARD);
    await playing.keyboard.press('ArrowLeft');
    await playing.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
    await playing.getByTestId('score').filter({ hasText: '60' }).waitFor();
    await settle(playing);
    await capture(playing, 'after-2048-playing-desktop.png', true);
    await playing.close();

    const over = await context.newPage();
    await open2048(over, STUCK_BOARD);
    await over.keyboard.press('ArrowLeft');
    await over.getByTestId('overlay-title').filter({ hasText: '无路可走' }).waitFor();
    // Wait for the final score line, not just the overlay: it proves the
    // game-over text and the deterministic seeded spawn have both rendered.
    await over
      .getByTestId('overlay-score')
      .filter({ hasText: '本局 4 分 · 最大方块 16' })
      .waitFor();
    await settle(over);
    await capture(over, 'after-2048-gameover-desktop.png', true);
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
    // Full-page so the single-column card grid (where 2048 will appear) is visible;
    // a 390x844 viewport only reaches the hero.
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await settle(hub);
    await capture(hub, 'before-2048-hub-mobile.png', true);
    await hub.close();

    const route = await context.newPage();
    await route.goto(`${BASE_URL}/#/games/2048`, { waitUntil: 'networkidle' });
    await route.getByText('没有找到这个游戏').waitFor();
    await settle(route);
    await capture(route, 'before-2048-route-mobile.png', false);
    await route.close();
  } else {
    // Same full-page framing as the Before hub so the 2048 card is comparable.
    const hub = await context.newPage();
    await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await hub.getByTestId('game-card-2048').waitFor();
    await settle(hub);
    await capture(hub, 'after-hub-mobile.png', true);
    await hub.close();

    const ready = await context.newPage();
    await open2048(ready, COLOR_BOARD);
    await capture(ready, 'after-2048-ready-mobile.png', false);
    await ready.close();

    const playing = await context.newPage();
    await open2048(playing, MERGE_BOARD);
    await playing.keyboard.press('ArrowLeft');
    await playing.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
    await playing.getByTestId('score').filter({ hasText: '60' }).waitFor();
    await settle(playing);
    await capture(playing, 'after-2048-playing-mobile.png', false);
    await playing.close();

    const over = await context.newPage();
    await open2048(over, STUCK_BOARD);
    await over.keyboard.press('ArrowLeft');
    await over.getByTestId('overlay-title').filter({ hasText: '无路可走' }).waitFor();
    // Wait for the final score line, not just the overlay: it proves the
    // game-over text and the deterministic seeded spawn have both rendered.
    await over
      .getByTestId('overlay-score')
      .filter({ hasText: '本局 4 分 · 最大方块 16' })
      .waitFor();
    await settle(over);
    await capture(over, 'after-2048-gameover-mobile.png', false);
    await over.close();
  }

  await context.close();
}

/** Capture the three stable 2048 phone states on the WebKit engine. */
async function captureWebkitMobile(browser) {
  const context = await createPhoneContext(browser, ENGINE);

  const ready = await context.newPage();
  await open2048(ready, COLOR_BOARD);
  await capture(ready, 'after-2048-ready-webkit.png', false);
  await ready.close();

  const playing = await context.newPage();
  await open2048(playing, MERGE_BOARD);
  await playing.keyboard.press('ArrowLeft');
  await playing.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
  await playing.getByTestId('score').filter({ hasText: '60' }).waitFor();
  await settle(playing);
  await capture(playing, 'after-2048-playing-webkit.png', false);
  await playing.close();

  const over = await context.newPage();
  await open2048(over, STUCK_BOARD);
  await over.keyboard.press('ArrowLeft');
  await over.getByTestId('overlay-title').filter({ hasText: '无路可走' }).waitFor();
  await over
    .getByTestId('overlay-score')
    .filter({ hasText: '本局 4 分 · 最大方块 16' })
    .waitFor();
  await settle(over);
  await capture(over, 'after-2048-gameover-webkit.png', false);
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
      `Captured ${MODE} 2048 screenshots on ${engineLabel(ENGINE)} in ${OUTPUT}`,
    );
  } finally {
    await closeCaptureBrowser(browser);
  }
} finally {
  stopPreviewServer(server);
  server = null;
}
