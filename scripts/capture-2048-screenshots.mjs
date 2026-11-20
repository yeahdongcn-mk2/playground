import { mkdir } from 'node:fs/promises';
import {
  WEBKIT_ENGINE,
  assertAllDeclaredCaptureTargets,
  captureManifestedScreenshot,
  captureScreenshot,
  closeCaptureBrowser,
  createDesktopContext,
  createMobileContext,
  createPhoneContext,
  engineLabel,
  launchCaptureBrowser,
  parseCaptureEngine,
  repaintWebkitReadyOverlay,
  settleCapturePaint,
  settleWebkitReadyPaint,
  startPreviewServer,
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
import {
  settleBackdropLayersCompositing,
  settleSharedHeaderCompositing,
} from './lib/webkit-compositing-settle.mjs';

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
 * spawned after ArrowLeft is deterministic. The WebKit ready scene additionally
 * runs two repaint seams before its capture: a scroll round-trip repaints the
 * sticky site header, and hiding the READY overlay for two frames repaints the
 * card and its blurred backdrop. Either can otherwise rasterise in two subtly
 * different ways and break fixed-container byte equality. The ready capture
 * then waits for two byte-identical consecutive screenshots, so a blurred
 * overlay frame still mid-raster under concurrent host load is not written.
 * playing / gameover already pin the board and key press, but the shared site
 * header can still commit either blurred backdrop snapshot one 8-bit step away
 * from the committed evidence under concurrent host load. Playing calls
 * `settleSharedHeaderCompositing` as the last paint step; gameover rebuilds the
 * shared header and its own translucent overlay backdrop together with
 * `settleBackdropLayersCompositing`, because sequential single-layer toggles
 * resample the other layer into a different 1-LSB variant. The ready scene
 * keeps its original scroll + overlay seam and two-frame stable capture
 * untouched (its remaining ready-scene drift belongs to Issue #374).
 *
 * Under concurrent host load a wrong raster can also be byte-stable across
 * frames (2048 gameover's overlay backdrop), so no frame gate can prove the
 * committed variant was taken. Playing / gameover are therefore sampled from a
 * fresh page until their bytes equal the manifest sha256 (up to
 * `MANIFEST_CAPTURE_ATTEMPTS` pages); a run that never matches fails before
 * writing instead of replacing the evidence. Pass `--allow-new-bytes` for an
 * intentional visual change and the usual manifest update.
 * See docs/screenshots/README.md for the reproducible sha256 procedure and its
 * conditions.
 *
 * The After mode skips the frozen `after-2048-ready-desktop.png` and
 * `after-2048-ready-mobile.png` historical evidence and prints a warning unless
 * `--allow-historical-overwrite` is passed; the playing / gameover captures
 * still refresh. The shared hub screenshots belong to
 * `scripts/capture-screenshots.mjs`, so this game script never writes them.
 */

const ARGS = process.argv.slice(2);

/** Repository-relative name of this script, used in its target declaration. */
const SCRIPT_NAME = 'scripts/capture-2048-screenshots.mjs';

/** Default preview port for this script; `PREVIEW_PORT` overrides it at runtime. */
const DEFAULT_PREVIEW_PORT = 4183;

/**
 * Capture targets this script records for one argv (Issue #293).
 *
 * WebKit records the three phone states as the `webkit` target. Chromium
 * records the desktop and 390x844 phone contexts in both modes; `--before` and
 * `--allow-historical-overwrite` change which PNGs are written, never which
 * contexts are created.
 */
function captureTargets(args) {
  return parseCaptureEngine(args) === WEBKIT_ENGINE
    ? [CAPTURE_TARGET_IDS.WEBKIT]
    : [CAPTURE_TARGET_IDS.DESKTOP, CAPTURE_TARGET_IDS.MOBILE];
}

const DECLARED_CAPTURE_TARGETS = captureTargets(ARGS);
if (isPrintCaptureTargetsRequested(ARGS)) {
  printCaptureTargets(
    SCRIPT_NAME,
    DECLARED_CAPTURE_TARGETS,
    DEFAULT_PREVIEW_PORT,
  );
}

const HOST = '127.0.0.1';
const PORT = parsePreviewPort(process.env.PREVIEW_PORT, DEFAULT_PREVIEW_PORT);
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const MODE = ARGS.includes('--before') ? 'before' : 'after';
const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes(HISTORICAL_OVERWRITE_FLAG);
// Intentional visual change: write the first sample after one capture instead
// of resampling until the recorded sha256 is reproduced.
const ALLOW_NEW_BYTES = ARGS.includes('--allow-new-bytes');
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
  // Shared settle contract: fonts, two animation frames and a short fallback.
  await settleCapturePaint(page);
}

async function capture(page, name, fullPage, options) {
  const write = guardHistoricalAfterEvidence({
    file: name,
    mode: MODE,
    allowHistoricalOverwrite: ALLOW_HISTORICAL_OVERWRITE,
  });
  if (!write) return;
  await captureScreenshot(page, name, { engine: ENGINE, fullPage, ...options });
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
  const context = await createDesktopContext(browser, {
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
  const context = await createMobileContext(browser, {
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

/**
 * Capture one WebKit state, resampling a fresh page until its bytes equal the
 * manifest sha256. The page is created from the shared phone context after the
 * committed ready page already ran, so every sample is a later, settled page;
 * each retry is still a fresh compositor state.
 *
 * `checkEnvironment` runs on the first sample only: a host run fails with the
 * write guard's own message before spending the sample budget.
 */
async function sampleWebkitState(context, { name, prepare, captureBytes }) {
  await captureManifestedScreenshot({
    name,
    engine: ENGINE,
    openPage: () => context.newPage(),
    prepare,
    captureBytes,
    checkEnvironment: (page) => capture(page, name, false, { checkOnly: true }),
    write: (page, bytes) =>
      capture(page, name, false, { capturedBytes: bytes }),
    allowNewBytes: ALLOW_NEW_BYTES,
  });
}

/** Capture the three stable 2048 phone states on the WebKit engine. */
async function captureWebkitMobile(browser) {
  const context = await createPhoneContext(browser, ENGINE);
  try {
    const ready = await context.newPage();
    await open2048(ready, COLOR_BOARD);
    // WebKit's first paint of the sticky site header can settle in two subtly
    // different rasters (Issue #199). The ready scene is the first page of
    // this run; a scroll round-trip repaints the header deterministically
    // before the capture. The READY card and its blurred backdrop can still
    // composite from two different rasters under concurrent host load, so
    // the overlay also goes through a hide / restore repaint. The capture
    // waits for two byte-identical consecutive screenshots instead of writing
    // a single in-flight frame. This ready path is intentionally unchanged
    // (Issue #341 t3); its remaining ready-scene drift belongs to #374.
    await settleWebkitReadyPaint(ready);
    await repaintWebkitReadyOverlay(ready);
    await capture(ready, 'after-2048-ready-webkit.png', false, { stable: true });
    await ready.close();

    await sampleWebkitState(context, {
      name: 'after-2048-playing-webkit.png',
      prepare: async (playing) => {
        await open2048(playing, MERGE_BOARD);
        await playing.keyboard.press('ArrowLeft');
        await playing.getByTestId('status').filter({ hasText: '进行中' }).waitFor();
        await playing.getByTestId('score').filter({ hasText: '60' }).waitFor();
        await settle(playing);
        // The fixed seed / step path pins the board, but the shared sticky
        // header's blurred backdrop snapshot can still land one 8-bit step
        // away under load (4173dce8…). Rebuild it from the settled page
        // before writing.
        await settleSharedHeaderCompositing(playing);
      },
    });

    await sampleWebkitState(context, {
      name: 'after-2048-gameover-webkit.png',
      prepare: async (over) => {
        await open2048(over, STUCK_BOARD);
        await over.keyboard.press('ArrowLeft');
        await over
          .getByTestId('overlay-title')
          .filter({ hasText: '无路可走' })
          .waitFor();
        await over
          .getByTestId('overlay-score')
          .filter({ hasText: '本局 4 分 · 最大方块 16' })
          .waitFor();
        await settle(over);
        // Same shared-header snapshot risk as playing, on the committed
        // bf7548b7… bytes. The game-over card's translucent backdrop has its
        // own 1-LSB variants, so rebuild the header and that backdrop in one
        // committed frame; a separate header-only seam would resample the
        // overlay to another variant.
        await settleBackdropLayersCompositing(over);
      },
    });
  } finally {
    await context.close();
  }
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
    assertAllDeclaredCaptureTargets(DECLARED_CAPTURE_TARGETS, {
      source: SCRIPT_NAME,
    });
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
