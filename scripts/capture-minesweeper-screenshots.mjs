import { mkdir } from 'node:fs/promises';
import {
  WEBKIT_ENGINE,
  assertAllDeclaredCaptureTargets,
  captureScreenshot,
  closeCaptureBrowser,
  createDesktopContext,
  createMobileContext,
  createPhoneContext,
  createTouchMobileContext,
  engineLabel,
  launchCaptureBrowser,
  parseCaptureEngine,
  startPreviewServer,
  stopPreviewServer,
} from './lib/capture-runtime.mjs';
import {
  CAPTURE_TARGET_IDS,
  MINESWEEPER_NARROW_FLAGS,
  MINESWEEPER_TOUCH_BEFORE_FLAG,
  WEBKIT_NARROW_BEFORE_FLAG,
  WEBKIT_NARROW_FLAG,
  isPrintCaptureTargetsRequested,
  printCaptureTargets,
} from './lib/capture-targets.mjs';
import { assertPortAvailable, parsePreviewPort } from './lib/preview-port.mjs';
import { waitForPreviewServer } from './lib/preview-server.mjs';
import {
  HISTORICAL_OVERWRITE_FLAG,
  guardHistoricalAfterEvidence,
} from './lib/screenshot-evidence.mjs';
import { touchLongPress } from './lib/touch-input.mjs';

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
 *   npm run screenshots:minesweeper:short
 *   BASE_URL=http://127.0.0.1:4192 npm run screenshots:minesweeper:short-before
 *   npm run screenshots:minesweeper:large
 *   BASE_URL=http://127.0.0.1:4193 npm run screenshots:minesweeper:large-before
 *
 * Add `--webkit` to the after mode to capture the four stable phone states
 * (ready / playing / lost / won) on the WebKit engine as
 * `after-minesweeper-<state>-webkit.png`. The dedicated
 * `--webkit-narrow` / `--webkit-narrow-before` modes capture the Issue #83
 * narrow-screen matrix at 320×640, 360×640, 375×667 and 412×839 into the
 * committed `*-minesweeper-webkit-narrow-<W>x<H>.png` evidence files; the
 * before variant needs BASE_URL at the `d6aeb3d` baseline preview.
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The touch-before mode points BASE_URL at a preview of the commit
 * before this task's touch and mobile changes, where the page exists but only
 * has desktop-style pointer input, and captures the same phone game states.
 * The narrow modes capture the 360×740 ready state, the min modes capture the
 * 320×640 ready state and the restart modes capture the 320×640 ready state
 * after the Issue #53 short-screen compression; the short modes capture the
 * 360×640 and 375×667 ready states that keep the restart entry in the first
 * screen after the Issue #60 fix; the large modes capture the 16×30 expert
 * board at 320×640 and 360×640 to show the narrow-screen degradation hint.
 * Every before mode likewise needs BASE_URL at its baseline preview.
 *
 * The preview port is 4186 by default; on a shared host or in a parallel
 * worktree set `PREVIEW_PORT` to a free port instead of editing this file.
 * When that port is already taken, the script fails before writing any
 * screenshot instead of quietly talking to the other server.
 *
 * The generic --before mode has been removed: it captured a main baseline
 * that had no minesweeper route. Its screenshots remain as historical
 * evidence, but passing --before is rejected instead of being treated as the
 * after mode.
 *
 * The After mode (Chromium and WebKit phone states) skips the frozen desktop /
 * mobile / WebKit gameplay PNGs and prints a warning unless
 * `--allow-historical-overwrite` is passed. The shared hub screenshots belong to
 * `scripts/capture-screenshots.mjs`, so this script no longer writes them; the
 * dedicated narrow / short / large / restart modes and the `--webkit-narrow` CI
 * matrix keep writing, so current evidence and the CI smoke re-capture still
 * refresh.
 */

const ARGS = process.argv.slice(2);

/** Repository-relative name of this script, used in its target declaration. */
const SCRIPT_NAME = 'scripts/capture-minesweeper-screenshots.mjs';

/**
 * Capture targets this script records for one argv (Issue #293).
 *
 * The declaration mirrors the script's real branch order:
 *
 * 1. a WebKit flag records only the `webkit` phone target (the dedicated
 *    `--webkit-narrow` matrix also records only `webkit`);
 * 2. the Chromium narrow family (`--narrow`, `--min`, `--restart`, `--short`,
 *    `--large` and their `-before` forms) records only the DPR-2 `mobile`
 *    target and takes precedence over `--touch-before`;
 * 3. `--touch-before` records only the Pixel 7 `mobile-touch` target;
 * 4. the After run records desktop and mobile-touch (no 390x844 `mobile`
 *    context; the shared hub capture moved to `capture-screenshots.mjs`).
 *
 * `--before` (removed), `--allow-historical-overwrite` and the target's
 * BASE_URL never change this set.
 */
function captureTargets(args) {
  if (parseCaptureEngine(args) === WEBKIT_ENGINE) {
    return [CAPTURE_TARGET_IDS.WEBKIT];
  }
  if (MINESWEEPER_NARROW_FLAGS.some((flag) => args.includes(flag))) {
    return [CAPTURE_TARGET_IDS.MOBILE];
  }
  if (args.includes(MINESWEEPER_TOUCH_BEFORE_FLAG)) {
    return [CAPTURE_TARGET_IDS.MOBILE_TOUCH];
  }
  return [CAPTURE_TARGET_IDS.DESKTOP, CAPTURE_TARGET_IDS.MOBILE_TOUCH];
}

const DECLARED_CAPTURE_TARGETS = captureTargets(ARGS);
if (isPrintCaptureTargetsRequested(ARGS)) {
  printCaptureTargets(SCRIPT_NAME, DECLARED_CAPTURE_TARGETS);
}

if (ARGS.includes('--before')) {
  console.error(
    'The generic --before mode has been removed: its baseline (main without a minesweeper route) is historical evidence only. ' +
      'Use --touch-before, --narrow-before, --min-before, --restart-before, --short-before or --large-before for their own baselines, or omit the flag to capture After screenshots.',
  );
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = parsePreviewPort(process.env.PREVIEW_PORT, 4186);
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes(HISTORICAL_OVERWRITE_FLAG);
const ENGINE = parseCaptureEngine(ARGS);
const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;
const WEBKIT_NARROW = ARGS.includes(WEBKIT_NARROW_FLAG);
const WEBKIT_NARROW_BEFORE = ARGS.includes(WEBKIT_NARROW_BEFORE_FLAG);
const TOUCH_BEFORE = ARGS.includes(MINESWEEPER_TOUCH_BEFORE_FLAG);
const NARROW = ARGS.includes('--narrow');
const NARROW_BEFORE = ARGS.includes('--narrow-before');
const MIN = ARGS.includes('--min');
const MIN_BEFORE = ARGS.includes('--min-before');
const RESTART = ARGS.includes('--restart');
const RESTART_BEFORE = ARGS.includes('--restart-before');
const SHORT = ARGS.includes('--short');
const SHORT_BEFORE = ARGS.includes('--short-before');
const LARGE = ARGS.includes('--large');
const LARGE_BEFORE = ARGS.includes('--large-before');
const IS_COMPACT = RESTART || RESTART_BEFORE;
const IS_NARROW =
  NARROW || NARROW_BEFORE || MIN || MIN_BEFORE || RESTART || RESTART_BEFORE;
const CHROMIUM_NARROW_MODE =
  NARROW ||
  NARROW_BEFORE ||
  MIN ||
  MIN_BEFORE ||
  RESTART ||
  RESTART_BEFORE ||
  SHORT ||
  SHORT_BEFORE ||
  LARGE ||
  LARGE_BEFORE;

if (IS_WEBKIT && CHROMIUM_NARROW_MODE && !WEBKIT_NARROW && !WEBKIT_NARROW_BEFORE) {
  throw new Error(
    'The --webkit flag captures the stable phone states only; use --webkit-narrow or --webkit-narrow-before for the WebKit narrow matrix. Do not combine --webkit with the Chromium narrow modes.',
  );
}
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
/** The two short phones fixed by Issue #60. */
const SHORT_VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 375, height: 667 },
];
/** The Issue #83 WebKit narrow-screen evidence matrix. */
const WEBKIT_NARROW_VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 412, height: 839 },
];
const NARROW_FILE_SUFFIX = IS_COMPACT ? '-restart' : '';
const MODE = WEBKIT_NARROW_BEFORE
  ? 'webkit-narrow-before'
  : WEBKIT_NARROW
    ? 'webkit-narrow'
    : SHORT_BEFORE
      ? 'short-before'
      : SHORT
        ? 'short'
        : LARGE_BEFORE
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
const MODE_LABEL = (() => {
  if (WEBKIT_NARROW_BEFORE || WEBKIT_NARROW) return MODE;
  if (IS_WEBKIT && MODE === 'touch-before') return 'webkit-touch-before';
  if (RESTART_BEFORE) return 'restart-before';
  if (RESTART) return 'restart';
  return MODE;
})();
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

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
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
  const context = await createDesktopContext(browser, {
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });

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

/** File name for one phone state on the selected engine. */
function touchMobileName(prefix, state) {
  return IS_WEBKIT
    ? `${prefix}-minesweeper-${state}-webkit.png`
    : `${prefix}-minesweeper-${state}-mobile.png`;
}

/**
 * Capture the same phone game states before and after the touch work. The
 * before mode must still use the mouse (a right click) to flag: that input is
 * exactly what the touch task adds, so the baseline cannot express the state
 * through touch yet.
 *
 * Chromium keeps the historical Pixel 7 framing and `-mobile` file names
 * through `createTouchMobileContext`, which records the separate
 * `mobile-touch` fingerprint at DPR 2.625. The WebKit run uses the same
 * iPhone SE (3rd gen) device as the e2e project and writes `-webkit` file
 * names, so both evidence sets can coexist.
 */
async function captureTouchMobile(browser, prefix) {
  const context = IS_WEBKIT
    ? await createPhoneContext(browser, ENGINE)
    : await createTouchMobileContext(browser, {
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });

  const ready = await context.newPage();
  await openTouchGame(ready, WIN_MINES);
  await capture(ready, touchMobileName(prefix, 'ready'), false);
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
  await capture(playing, touchMobileName(prefix, 'playing'), false);
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
  await capture(lost, touchMobileName(prefix, 'lost'), false);
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
  await capture(won, touchMobileName(prefix, 'won'), false);
  await won.close();

  await context.close();
}

/**
 * Capture the Issue #83 WebKit narrow-screen matrix: the ready state at the
 * four contract viewports, with the engine, viewport and theme logged for each
 * file. The committed After images are reproducible from this branch; the
 * Before images need BASE_URL at the `d6aeb3d` baseline preview.
 */
async function captureWebkitNarrow(browser, prefix) {
  for (const viewport of WEBKIT_NARROW_VIEWPORTS) {
    const context = await createPhoneContext(browser, ENGINE, { viewport });
    const page = await context.newPage();
    await openTouchGame(page, WIN_MINES);
    await page.getByTestId('status').filter({ hasText: '待开始' }).waitFor();
    await settle(page);
    await capture(
      page,
      `${prefix}-minesweeper-webkit-narrow-${viewport.width}x${viewport.height}.png`,
      false,
    );
    await page.close();
    await context.close();
  }
}

/**
 * Capture the ready state at a narrow phone viewport: 360×740 for the narrow
 * mode, 320×640 for the min and restart modes, and 360×640 / 375×667 for the
 * short mode. Each pair isolates one layout change: same scene, viewport, dark
 * theme and reduced-motion setting before and after. The restart mode uses its
 * own file suffix so it does not overwrite the min mode's earlier evidence;
 * the short mode keeps the plain ready filenames.
 */
async function captureNarrow(browser, prefix, viewport, fileNameSuffix = '') {
  const { width, height } = viewport;
  const context = await createMobileContext(browser, {
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
    const context = await createMobileContext(browser, {
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

if (MODE === 'short-before' && !process.env.BASE_URL) {
  throw new Error(
    'The short-before mode needs BASE_URL pointing at a preview of the baseline commit before the Issue #60 short-screen fix (see docs/screenshots/README.md).',
  );
}

if (MODE === 'webkit-narrow-before' && !process.env.BASE_URL) {
  throw new Error(
    'The webkit-narrow-before mode needs BASE_URL pointing at a preview of the d6aeb3d baseline commit (see docs/screenshots/README.md).',
  );
}

if (!process.env.BASE_URL) {
  // Fail before spawning (and before mkdir or the browser) when another server
  // owns the port; otherwise the readiness poll would connect to that server
  // and write its build as After evidence.
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

await mkdir(OUTPUT, { recursive: true });
const browser = await launchCaptureBrowser(ENGINE);
try {
  if (MODE === 'webkit-narrow' || MODE === 'webkit-narrow-before') {
    await captureWebkitNarrow(browser, MODE === 'webkit-narrow-before' ? 'before' : 'after');
  } else if (MODE === 'large' || MODE === 'large-before') {
    await captureLarge(browser, MODE === 'large-before' ? 'before' : 'after');
  } else if (MODE === 'short' || MODE === 'short-before') {
    for (const viewport of SHORT_VIEWPORTS) {
      await captureNarrow(
        browser,
        MODE === 'short-before' ? 'before' : 'after',
        viewport,
      );
    }
  } else if (MODE === 'narrow' || MODE === 'narrow-before') {
    await captureNarrow(
      browser,
      MODE === 'narrow-before' ? 'before' : 'after',
      NARROW_VIEWPORT,
      NARROW_FILE_SUFFIX,
    );
  } else if (IS_WEBKIT) {
    // WebKit only needs the stable phone states; desktop and hub evidence stay
    // on the existing Chromium scripts.
    await captureTouchMobile(browser, MODE === 'touch-before' ? 'before' : 'after');
  } else {
    if (MODE !== 'touch-before') {
      await captureDesktop(browser);
    }
    if (MODE === 'after') {
      await captureTouchMobile(browser, 'after');
    } else if (MODE === 'touch-before') {
      await captureTouchMobile(browser, 'before');
    }
  }
  assertAllDeclaredCaptureTargets(DECLARED_CAPTURE_TARGETS, {
    source: SCRIPT_NAME,
  });
  console.log(
    `Captured ${MODE_LABEL} minesweeper screenshots on ${engineLabel(ENGINE)} in ${OUTPUT}`,
  );
} finally {
  await closeCaptureBrowser(browser);
  stopPreviewServer(server);
}
