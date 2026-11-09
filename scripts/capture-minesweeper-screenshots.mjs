import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from '@playwright/test';

/**
 * Capture the Before / After evidence for the minesweeper integration.
 *
 *   npm run screenshots:minesweeper
 *   BASE_URL=http://127.0.0.1:4188 npm run screenshots:minesweeper:touch-before
 *   npm run screenshots:minesweeper:narrow
 *   BASE_URL=http://127.0.0.1:4189 npm run screenshots:minesweeper:narrow-before
 *   npm run screenshots:minesweeper:min
 *   BASE_URL=http://127.0.0.1:4189 npm run screenshots:minesweeper:min-before
 *   npm run screenshots:minesweeper:restart
 *   BASE_URL=http://127.0.0.1:4191 npm run screenshots:minesweeper:restart-before
 *   npm run screenshots:minesweeper:large
 *   BASE_URL=http://127.0.0.1:4193 npm run screenshots:minesweeper:large-before
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The touch-before mode points BASE_URL at a preview of the commit
 * before this task's touch and mobile changes, where the page exists but only
 * has desktop-style pointer input, and captures the same phone game states.
 * The narrow modes capture the 360×740 ready state, the min modes capture the
 * 320×640 ready state and the restart modes capture the same 320×640 ready
 * state after the short-screen vertical compression; the large modes capture
 * the 16×30 expert board at 320×640 and 360×640 to show the narrow-screen
 * degradation hint. The before variants likewise need BASE_URL at their
 * baseline preview.
 *
 * The generic --before mode has been removed: it captured a main baseline
 * that had no minesweeper route. Its screenshots remain as historical
 * evidence, but passing --before is rejected instead of being treated as the
 * after mode.
 */

if (process.argv.slice(2).includes('--before')) {
  console.error(
    'The generic --before mode has been removed: its baseline (main without a minesweeper route) is historical evidence only. ' +
      'Use --touch-before, --narrow-before, --min-before, --restart-before or --large-before for their own baselines, or omit the flag to capture After screenshots.',
  );
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = 4186;
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const TOUCH_BEFORE = process.argv.includes('--touch-before');
const NARROW = process.argv.includes('--narrow');
const NARROW_BEFORE = process.argv.includes('--narrow-before');
const MIN = process.argv.includes('--min');
const MIN_BEFORE = process.argv.includes('--min-before');
const RESTART = process.argv.includes('--restart');
const RESTART_BEFORE = process.argv.includes('--restart-before');
const LARGE = process.argv.includes('--large');
const LARGE_BEFORE = process.argv.includes('--large-before');
const IS_COMPACT = RESTART || RESTART_BEFORE;
const IS_NARROW =
  NARROW || NARROW_BEFORE || MIN || MIN_BEFORE || RESTART || RESTART_BEFORE;
const IS_NARROW_BEFORE = NARROW_BEFORE || MIN_BEFORE || RESTART_BEFORE;
const NARROW_VIEWPORT =
  MIN || MIN_BEFORE || IS_COMPACT
    ? { width: 320, height: 640 }
    : { width: 360, height: 740 };
/** Narrow viewports that show the large-board degradation hint. */
const LARGE_VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 360, height: 640 },
];
const NARROW_FILE_SUFFIX = IS_COMPACT ? '-restart' : '';
const MODE = LARGE_BEFORE
  ? 'large-before'
  : LARGE
    ? 'large'
    : IS_NARROW_BEFORE
      ? 'narrow-before'
      : IS_NARROW
        ? 'narrow'
        : TOUCH_BEFORE
          ? 'touch-before'
          : 'after';
/** Human-readable mode for the log; restart reuses the narrow capture path. */
const MODE_LABEL = RESTART_BEFORE ? 'restart-before' : RESTART ? 'restart' : MODE;
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

  // Same full-page framing as the historical Before hub so the new card is comparable.
  const hub = await context.newPage();
  await hub.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await hub.getByTestId('game-card-minesweeper').waitFor();
  await settle(hub);
  await capture(hub, 'after-hub-mobile.png', true);
  await hub.close();

  await context.close();
}

async function openTouchGame(page, mines) {
  const query = new URLSearchParams({ debug: '1', mines });
  await page.goto(`${BASE_URL}/#/games/minesweeper?${query.toString()}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('[data-cell]').first().waitFor();
  await page.getByTestId('overlay').waitFor({ state: 'hidden' });
  await settle(page);
}

async function touchTap(page, locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('touch target has no bounding box');
  }
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function touchLongPress(page, locator, holdMs = 650) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('touch target has no bounding box');
  }
  const client = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    });
    await delay(holdMs);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

/**
 * Capture the same phone game states before and after the touch work. The
 * before mode must still use the mouse (a right click) to flag: that input is
 * exactly what the touch task adds, so the baseline cannot express the state
 * through touch yet.
 */
async function captureTouchMobile(browser, prefix) {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });

  const ready = await context.newPage();
  await openTouchGame(ready, WIN_MINES);
  await capture(ready, `${prefix}-minesweeper-ready-mobile.png`, false);
  await ready.close();

  const playing = await context.newPage();
  await openTouchGame(playing, LOSS_MINES);
  if (prefix === 'after') {
    await touchTap(playing, playing.getByTestId('cell-7-4'));
    await touchLongPress(playing, playing.getByTestId('cell-0-0'));
  } else {
    await playing.getByTestId('cell-7-4').click();
    await playing.getByTestId('cell-0-0').click({ button: 'right' });
  }
  await playing.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
  await playing.getByTestId('remaining-mines').filter({ hasText: '9' }).waitFor();
  // Both modes wait for the clock to leave 0:00 so the Before / After frames
  // show the same live HUD state despite the slower touch long press.
  await playing.getByTestId('timer').filter({ hasNotText: '0:00' }).waitFor();
  await settle(playing);
  await capture(playing, `${prefix}-minesweeper-playing-mobile.png`, false);
  await playing.close();

  const lost = await context.newPage();
  await openTouchGame(lost, LOSS_MINES);
  if (prefix === 'after') {
    await touchTap(lost, lost.getByTestId('cell-7-4'));
    await touchTap(lost, lost.getByTestId('cell-0-0'));
  } else {
    await lost.getByTestId('cell-7-4').click();
    await lost.getByTestId('cell-0-0').click();
  }
  await lost.getByTestId('overlay-title').filter({ hasText: '踩到地雷' }).waitFor();
  await settle(lost);
  await capture(lost, `${prefix}-minesweeper-lost-mobile.png`, false);
  await lost.close();

  const won = await context.newPage();
  await openTouchGame(won, WIN_MINES);
  if (prefix === 'after') {
    await touchTap(won, won.getByTestId('cell-8-8'));
  } else {
    await won.getByTestId('cell-8-8').click();
  }
  await won.getByTestId('overlay-title').filter({ hasText: '扫雷成功' }).waitFor();
  await settle(won);
  await capture(won, `${prefix}-minesweeper-won-mobile.png`, false);
  await won.close();

  await context.close();
}

/**
 * Capture the ready state at a narrow phone viewport: 360×740 for the narrow
 * mode, 320×640 for the min mode and 320×640 for the restart mode. Each pair
 * isolates one layout change: same scene, viewport, dark theme and
 * reduced-motion setting before and after. The restart mode uses its own file
 * suffix so it does not overwrite the min mode's earlier evidence.
 */
async function captureNarrow(browser, prefix, viewport, fileNameSuffix = '') {
  const { width, height } = viewport;
  const context = await browser.newContext({
    viewport,
    screen: viewport,
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });

  const ready = await context.newPage();
  await openTouchGame(ready, WIN_MINES);
  await ready.getByTestId('status').filter({ hasText: '待开始' }).waitFor();
  await settle(ready);
  await capture(
    ready,
    `${prefix}-minesweeper-ready-${width}x${height}${fileNameSuffix}.png`,
    false,
  );
  await ready.close();

  await context.close();
}

/**
 * Capture the 16×30 large-board state at the two narrow viewports that show
 * the degradation hint. The before baseline has no `board-size-warning`
 * element, so the same screenshot framing exposes only the missing hint; the
 * board itself stays identically scaled.
 */
async function openLargeBoard(page) {
  const query = new URLSearchParams({
    debug: '1',
    rows: '16',
    cols: '30',
    mineCount: '99',
    safeFirst: '1',
  });
  await page.goto(`${BASE_URL}/#/games/minesweeper?${query.toString()}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('[data-cell]').first().waitFor();
  await page.getByTestId('overlay').waitFor({ state: 'hidden' });
  await page.getByTestId('status').filter({ hasText: '待开始' }).waitFor();
  if (MODE === 'large') {
    await page.getByTestId('board-size-warning').waitFor({ state: 'visible' });
  }
  await settle(page);
}

async function captureLarge(browser, prefix) {
  for (const viewport of LARGE_VIEWPORTS) {
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      colorScheme: 'dark',
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await openLargeBoard(page);
    await capture(
      page,
      `${prefix}-minesweeper-large-board-${viewport.width}x${viewport.height}.png`,
      false,
    );
    await page.close();
    await context.close();
  }
}

if (MODE === 'touch-before' && !process.env.BASE_URL) {
  throw new Error(
    'The touch-before mode needs BASE_URL pointing at a preview of the pre-touch baseline commit (see docs/screenshots/README.md).',
  );
}

if (MODE === 'narrow-before' && !process.env.BASE_URL) {
  throw new Error(
    'The narrow-before / min-before / restart-before modes need BASE_URL pointing at the matching baseline preview (see docs/screenshots/README.md).',
  );
}

if (MODE === 'large-before' && !process.env.BASE_URL) {
  throw new Error(
    'The large-before mode needs BASE_URL pointing at a preview of the baseline before the large-board warning commit (see docs/screenshots/README.md).',
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
  if (MODE === 'large' || MODE === 'large-before') {
    await captureLarge(browser, MODE === 'large-before' ? 'before' : 'after');
  } else if (MODE === 'narrow' || MODE === 'narrow-before') {
    await captureNarrow(
      browser,
      MODE === 'narrow-before' ? 'before' : 'after',
      NARROW_VIEWPORT,
      NARROW_FILE_SUFFIX,
    );
  } else {
    if (MODE !== 'touch-before') {
      await captureDesktop(browser);
      await captureMobile(browser);
    }
    if (MODE === 'after') {
      await captureTouchMobile(browser, 'after');
    } else if (MODE === 'touch-before') {
      await captureTouchMobile(browser, 'before');
    }
  }
  console.log(`Captured ${MODE_LABEL} minesweeper screenshots in ${OUTPUT}`);
} finally {
  await browser.close();
  server?.kill();
}
