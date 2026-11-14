import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import {
  WEBKIT_ENGINE,
  assertAllDeclaredCaptureTargets,
  captureScreenshot,
  closeCaptureBrowser,
  createDesktopContext,
  createMobileContext,
  createPhoneContext,
  engineLabel,
  launchCaptureBrowser,
  parseCaptureEngine,
  stopPreviewServer,
} from './lib/capture-runtime.mjs';
import {
  CAPTURE_TARGET_IDS,
  isPrintCaptureTargetsRequested,
  printCaptureTargets,
} from './lib/capture-targets.mjs';
import { assertPortAvailable, parsePreviewPort } from './lib/preview-port.mjs';
import { waitForPreviewServer } from './lib/preview-server.mjs';
import {
  HISTORICAL_OVERWRITE_FLAG,
  guardHistoricalAfterEvidence,
} from './lib/screenshot-evidence.mjs';

/**
 * Capture the before/after evidence used in the PR description.
 *
 *   node scripts/capture-snake-screenshots.mjs --before   # framework baseline (t2 head)
 *   node scripts/capture-snake-screenshots.mjs            # snake integrated
 *   npm run screenshots:snake:webkit                      # WebKit phone evidence
 *
 * The dev server is used on purpose: the deterministic first fruit (?food=...)
 * is a DEV-only seam, and the screenshots should show the same rendering the
 * player gets in development. `--webkit` captures the stable phone frame on the
 * iPhone SE WebKit device as `after-snake-webkit.png`.
 *
 * The playing screenshot pins `seed=7&ticks=3`: the debug seam seeds the
 * next-fruit RNG and advances exactly three engine ticks, then freezes the run,
 * so its PNG is reproducible byte-for-byte instead of depending on wall-clock
 * frame timing. See docs/screenshots/README.md for the reproducible sha256
 * procedure.
 *
 * The After mode skips the frozen ready / gameover desktop and mobile PNGs and
 * prints a warning unless `--allow-historical-overwrite` is passed; the playing
 * capture still refreshes. The shared hub screenshots belong to
 * `scripts/capture-screenshots.mjs`, so this game script never writes them.
 *
 * The dev server port is 5188 by default; on a shared host set `PREVIEW_PORT`
 * to a free port instead of editing this file. When that port is already
 * taken, the script fails with an explicit bind error instead of quietly
 * talking to the other server. A dev server that exits right after the
 * pre-spawn port probe reports its exit code and stderr instead of being
 * mistaken for the ready server.
 */

const ARGS = process.argv.slice(2);

/** Repository-relative name of this script, used in its target declaration. */
const SCRIPT_NAME = 'scripts/capture-snake-screenshots.mjs';

/**
 * Capture targets this script records for one argv (Issue #293).
 *
 * WebKit records the stable phone frame only. Chromium records the desktop and
 * 390x844 phone contexts in both the Before and After modes; the historical
 * overwrite guard skips PNG writes, not the contexts that produce the target
 * evidence.
 */
function captureTargets(args) {
  return parseCaptureEngine(args) === WEBKIT_ENGINE
    ? [CAPTURE_TARGET_IDS.WEBKIT]
    : [CAPTURE_TARGET_IDS.DESKTOP, CAPTURE_TARGET_IDS.MOBILE];
}

const DECLARED_CAPTURE_TARGETS = captureTargets(ARGS);
if (isPrintCaptureTargetsRequested(ARGS)) {
  printCaptureTargets(SCRIPT_NAME, DECLARED_CAPTURE_TARGETS);
}

const HOST = '127.0.0.1';
const PORT = parsePreviewPort(process.env.PREVIEW_PORT, 5188);
const ORIGIN = `http://${HOST}:${PORT}`;
const SERVER_NAME = 'dev';
const OUTPUT = 'docs/screenshots';
const MODE = ARGS.includes('--before') ? 'before' : 'after';
const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes(HISTORICAL_OVERWRITE_FLAG);
const ENGINE = parseCaptureEngine(ARGS);
const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;

// The playing screenshot is deterministic: the debug seam advances exactly
// PLAYING_TICKS engine ticks after the fixed first fruit and then freezes the
// run, so the captured snake, next fruit, score and length depend only on this
// seed and tick count. The engine test pins the same values.
const PLAYING_SEED = 7;
const PLAYING_TICKS = 3;

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
  const write = guardHistoricalAfterEvidence({
    file: name,
    mode: MODE,
    allowHistoricalOverwrite: ALLOW_HISTORICAL_OVERWRITE,
  });
  if (!write) return;
  await captureScreenshot(page, name, { engine: ENGINE, fullPage });
}

/** Capture the stable snake phone frame on the WebKit engine. */
async function captureWebkitMobile(browser) {
  const mobile = await createPhoneContext(browser, ENGINE);
  const mobileGame = await mobile.newPage();
  await mobileGame.goto(`${ORIGIN}/#/games/snake?debug=1&food=11,10`, { waitUntil: 'networkidle' });
  await waitForSnakeReady(mobileGame);
  await mobileGame.getByTestId('dpad').scrollIntoViewIfNeeded();
  await mobileGame.evaluate(() => window.scrollBy(0, -16));
  await mobileGame.waitForTimeout(300);
  await capture(mobileGame, 'after-snake-webkit.png', false);
  await mobile.close();
}

if (MODE === 'before' && IS_WEBKIT) {
  throw new Error('The --webkit mode captures After screenshots only.');
}

let server = null;
let browser;
try {
  // The fixed first fruit is a DEV-only seam, so this script runs the Vite dev
  // server rather than `vite preview`. Probe the port first: otherwise the dev
  // server exits immediately (--strictPort) while the readiness poll connects
  // to whatever else owns the port and captures screenshots from it.
  await assertPortAvailable(PORT, HOST, { serverName: SERVER_NAME });

  // Test seam: point PREVIEW_ENTRY at a stand-in that exits non-zero so the
  // unit test can exercise the post-probe startup failure without a server.
  server = spawn(
    process.execPath,
    [
      process.env.PREVIEW_ENTRY || 'node_modules/vite/bin/vite.js',
      '--host',
      HOST,
      '--port',
      String(PORT),
      '--strictPort',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  process.on('exit', () => server?.kill());
  await waitForPreviewServer(server, {
    origin: ORIGIN,
    port: PORT,
    serverName: SERVER_NAME,
  });

  await mkdir(OUTPUT, { recursive: true });
  browser = await launchCaptureBrowser(ENGINE);

  if (IS_WEBKIT) {
    await captureWebkitMobile(browser);
  } else {
    const desktop = await createDesktopContext(browser, {
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

      const mobile = await createMobileContext(browser, {
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
      const ready = await desktop.newPage();
      await ready.goto(`${ORIGIN}/#/games/snake?debug=1&food=11,10`, { waitUntil: 'networkidle' });
      await waitForSnakeReady(ready);
      await capture(ready, 'after-snake-ready.png', true);

      const playing = await desktop.newPage();
      await playing.goto(
        `${ORIGIN}/#/games/snake?debug=1&food=11,10&seed=${PLAYING_SEED}&ticks=${PLAYING_TICKS}`,
        { waitUntil: 'networkidle' },
      );
      await waitForSnakeReady(playing);
      await playing.keyboard.press('Space');
      // Wait for the debug seam to finish its fixed ticks. It freezes the run
      // afterwards, so no wall-clock delay can change the state.
      await playing.waitForFunction(
        (ticks) =>
          document
            .querySelector('[data-testid="snake-game"]')
            ?.getAttribute('data-debug-ticks') === String(ticks),
        PLAYING_TICKS,
      );
      await settle(playing);
      await capture(playing, 'after-snake-playing.png', true);

      const over = await desktop.newPage();
      await over.goto(`${ORIGIN}/#/games/snake?debug=1&food=0,0`, { waitUntil: 'networkidle' });
      await waitForSnakeReady(over);
      await over.keyboard.press('Space');
      await over.keyboard.press('ArrowUp');
      await over.waitForFunction(() => window.__playground?.getState().status === 'gameover');
      await over.waitForTimeout(300);
      await capture(over, 'after-snake-gameover.png', true);

      const mobile = await createMobileContext(browser, {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
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
  }

  assertAllDeclaredCaptureTargets(DECLARED_CAPTURE_TARGETS, {
    source: SCRIPT_NAME,
  });
  console.log(`Captured ${MODE} screenshots on ${engineLabel(ENGINE)} in ${OUTPUT}`);
} finally {
  await closeCaptureBrowser(browser);
  stopPreviewServer(server);
  server = null;
}
