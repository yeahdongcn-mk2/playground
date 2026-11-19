import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  WEBKIT_ENGINE,
  assertAllDeclaredCaptureTargets,
  captureScreenshot,
  captureStableBytes,
  closeCaptureBrowser,
  createDesktopContext,
  createMobileContext,
  createPhoneContext,
  engineLabel,
  expectedCaptureSha256,
  launchCaptureBrowser,
  parseCaptureEngine,
  repaintWebkitReadyOverlay,
  settleWebkitReadyPaint,
  startPreviewServer,
  stopPreviewServer,
} from './lib/capture-runtime.mjs';
import {
  CAPTURE_TARGET_IDS,
  isPrintCaptureTargetsRequested,
  printCaptureTargets,
} from './lib/capture-targets.mjs';
import {
  DEFAULT_PREVIEW_PORT,
  assertPortAvailable,
  parsePreviewPort,
} from './lib/preview-port.mjs';
import { waitForPreviewServer } from './lib/preview-server.mjs';
import { settleSharedHeaderCompositing } from './lib/webkit-compositing-settle.mjs';

/**
 * Capture the Before / After evidence for the Minesweeper best-time leaderboard.
 *
 *   npm run screenshots:minesweeper:scores
 *   BASE_URL=http://127.0.0.1:4192 node scripts/capture-minesweeper-scores-screenshots.mjs --before
 *   npm run screenshots:minesweeper:scores:webkit
 *
 * Pass `--clear` for the clear-records follow-up: the After run requires the
 * enabled 「清空记录」 action in the populated panel, while `--before` must point
 * at the revision that already had the leaderboard but no clear action.
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The before mode must point BASE_URL at a preview of the baseline
 * revision (the commit before this task). Both modes open the same fixed
 * beginner board, win it with one click at (8, 8) and seed a long custom-board
 * record, so the only visible difference between Before and After is the new
 * sidebar action.
 *
 * The preview port is 4192 by default; on a shared host set `PREVIEW_PORT` to a
 * free port instead of editing this file. When that port is already taken, the
 * script fails with an explicit bind error instead of quietly talking to the
 * other server. A preview that exits right after the pre-spawn port probe
 * reports its exit code and stderr instead of being mistaken for the ready
 * server.
 *
 * `--webkit` captures the 320×640 phone panel on the iPhone SE WebKit device
 * as `after-<prefix>-webkit.png`; it is an After-only mode and the desktop
 * evidence stays Chromium. The clear-records variant is Chromium-only because
 * the current panel always renders the clear action.
 *
 * The WebKit leaderboard capture first runs a scroll round-trip
 * (`settleWebkitReadyPaint`) so the sticky header and the page's gradient
 * tiles repaint from the settled top. It then hides and restores the win
 * overlay for two frames (`repaintWebkitReadyOverlay`) so its blurred,
 * translucent backdrop rebuilds the board / card raster on the canonical paint
 * path, and finally settles the shared site header's composited backdrop
 * (`settleSharedHeaderCompositing`, Issue #341). It captures two consecutive
 * byte-identical full-page frames (Issue #341 t3). The review of PR #363 showed
 * that even those seams can land on a byte-stable but wrong 1-LSB raster of the
 * board band, the win card or the far-down custom-difficulty button under
 * host load. Such a raster survives any frame gate, so the capture samples a
 * fresh page and only accepts bytes equal to the manifest entry; the sampled
 * page's seams make the canonical raster overwhelmingly likely, and ten misses
 * fail before writing instead of replacing the evidence. Pass
 * `--allow-new-bytes` for an intentional leaderboard UI change. The seams and
 * the resampling stay on this WebKit path only: `--before`, `--clear` and the
 * Chromium captures keep their committed single-screenshot bytes.
 *
 * The plain Chromium After mode refuses to overwrite the
 * `after-minesweeper-scores-*.png` files: they are the #45 subtask 1 historical
 * evidence, captured before the current panel gained the 「清空记录」 action.
 * Re-running `npm run screenshots:minesweeper:scores` on today's UI would
 * silently replace them with the current panel. Pass
 * `--allow-historical-overwrite` to regenerate them on purpose, and update
 * docs/screenshots/README.md plus the full-page sizes at the same time. The
 * `--before`, `--clear` and `--webkit` modes never hit this guard.
 */

const ARGS = process.argv.slice(2);

/** Repository-relative name of this script, used in its target declaration. */
const SCRIPT_NAME = 'scripts/capture-minesweeper-scores-screenshots.mjs';

/**
 * Capture targets this script records for one argv (Issue #293).
 *
 * WebKit records the 320x640 panel as the `webkit` target. Chromium records the
 * desktop and 320x640 phone contexts for both the plain and clear-records
 * variants; `--before` and `--allow-historical-overwrite` change the evidence
 * files, never the targets.
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
const BEFORE = ARGS.includes('--before');
const CLEAR = ARGS.includes('--clear');
const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes('--allow-historical-overwrite');
// Intentional leaderboard UI change: write the new bytes after one sample
// instead of resampling until the recorded sha256 is reproduced.
const ALLOW_NEW_BYTES = ARGS.includes('--allow-new-bytes');
const ENGINE = parseCaptureEngine(ARGS);
const IS_WEBKIT = ENGINE === WEBKIT_ENGINE;
const FILE_PREFIX = CLEAR ? 'minesweeper-clear-scores' : 'minesweeper-scores';
const BASE_URL = process.env.BASE_URL ?? ORIGIN;
const HISTORICAL_AFTER_EVIDENCE = [
  `${OUTPUT}/after-minesweeper-scores-desktop.png`,
  `${OUTPUT}/after-minesweeper-scores-320x640.png`,
];

// Same deterministic beginner layout as tests/e2e/minesweeper-helpers.ts:
// a mine block in the top-left corner plus (0, 3). Revealing (8, 8) wins.
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

const SCORES_KEY = 'playground:v1:minesweeper.scores';
// A 30x30 board with the unsafe-first-click policy carries the longest custom
// label the UI can render ("…（首点不安全）"), so the mobile capture also
// exercises the wrapping rule that prevents horizontal overflow.
const SEEDED_SCORES = {
  version: 1,
  records: { 'custom:30x30x100:unsafe': 125_000 },
};

let server = null;

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function capture(page, name, options = {}) {
  await captureScreenshot(page, name, {
    engine: ENGINE,
    fullPage: true,
    ...options,
  });
}

async function seedScores(page) {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: SCORES_KEY, value: SEEDED_SCORES },
  );
}

async function openWin(page) {
  const query = new URLSearchParams({ debug: '1', mines: WIN_MINES });
  await page.goto(`${BASE_URL}/#/games/minesweeper?${query.toString()}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('[data-cell]').first().waitFor();
  await page.getByTestId('status').filter({ hasText: '待开始' }).waitFor();
  await page.getByTestId('cell-8-8').click();
  await page.getByTestId('overlay-title').filter({ hasText: '扫雷成功' }).waitFor();

  if (BEFORE) {
    const panel = await page.getByTestId('scores-panel').count();
    if (CLEAR) {
      // The clear-records baseline already has the panel; only the action is
      // missing. A wrong BASE_URL must fail instead of saving an After UI under
      // a before filename.
      const clearButton = await page.getByTestId('clear-scores-button').count();
      if (panel !== 1 || clearButton !== 0) {
        throw new Error(
          'Clear-records Before baseline must have the scores panel but no clear action; point BASE_URL at the revision just before this task.',
        );
      }
    } else if (panel !== 0) {
      // A baseline without the new card is required; otherwise a wrong BASE_URL
      // would silently save an "after" UI under a before filename.
      throw new Error(
        'Before baseline already has the scores panel; point BASE_URL at the pre-leaderboard revision.',
      );
    }
  } else {
    // Wait for the freshly recorded beginner time and the seeded custom row so
    // the screenshot shows the populated panel, not an empty state.
    await page
      .getByTestId('score-beginner-time')
      .filter({ hasNotText: '—' })
      .waitFor();
    await page.getByTestId('scores-custom').waitFor();
    if (CLEAR) {
      const clearButton = page.getByTestId('clear-scores-button');
      await clearButton.waitFor();
      if (await clearButton.isDisabled()) {
        throw new Error('After capture expected the enabled clear action');
      }
      if ((await clearButton.getAttribute('aria-label')) !== '清空记录') {
        throw new Error('Clear action is missing its accessible name');
      }
    }
  }
  await settle(page);
}

async function captureDesktop(browser) {
  const context = await createDesktopContext(browser, {
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await seedScores(page);
  await openWin(page);
  await capture(
    page,
    `${BEFORE ? 'before' : 'after'}-${FILE_PREFIX}-desktop.png`,
  );
  await context.close();
}

async function captureMobile(browser) {
  const context = await createMobileContext(browser, {
    viewport: { width: 320, height: 640 },
    screen: { width: 320, height: 640 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await seedScores(page);
  await openWin(page);
  await capture(
    page,
    `${BEFORE ? 'before' : 'after'}-${FILE_PREFIX}-320x640.png`,
  );
  await context.close();
}

/**
 * Fresh pages sampled before a load-dependent but stable raster variant is
 * fatal. The canonical page is common, so the expected number of samples is
 * low; ten makes the residual miss probability negligible without letting a
 * sustained bad host state write the wrong evidence.
 */
const WEBKIT_CAPTURE_ATTEMPTS = 10;

/**
 * Capture the 320×640 leaderboard panel on the WebKit engine.
 *
 * Under sustained host load WebKit can rasterise an individual composited tile
 * (shared header, board backdrop, win card / primary button, far-down
 * custom-difficulty button) one 8-bit step away from the recorded evidence.
 * That wrong raster is byte-stable across consecutive frames, so the
 * stable-frame gate alone cannot see it. The seams below make the canonical
 * path much more likely but cannot prove it was taken, so this function samples
 * a fresh page and accepts it only when the bytes equal the manifest entry; a
 * miss fails before writing instead of replacing the committed evidence.
 */
async function captureWebkitMobile(browser) {
  const name = `after-${FILE_PREFIX}-webkit.png`;
  const expectedSha256 = ALLOW_NEW_BYTES ? null : expectedCaptureSha256(name);
  const attempts = expectedSha256 === null ? 1 : WEBKIT_CAPTURE_ATTEMPTS;
  const observed = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const context = await createPhoneContext(browser, ENGINE, {
      viewport: { width: 320, height: 640 },
    });
    try {
      // WebKit's first page in a fresh browser process can rasterise the sticky
      // header, board gradients and control gradients one 8-bit step away from
      // the committed evidence (Issue #318, observed again for the scores page
      // in Issue #341). Load a throwaway copy first so the sampled page is not
      // the first page in the process.
      const warmUp = await context.newPage();
      try {
        await seedScores(warmUp);
        await openWin(warmUp);
      } finally {
        await warmUp.close();
      }
      const page = await context.newPage();
      await seedScores(page);
      await openWin(page);
      // Issue #341 rework: a scroll round-trip forces the page and header to
      // repaint from the settled top before the seams below, so the full-page
      // capture does not reuse a load-dependent tile raster.
      await settleWebkitReadyPaint(page);
      // The win overlay's blurred, translucent backdrop can keep a 1-LSB raster
      // of the board band and of its own card / primary button that the frame
      // gate cannot see, because that wrong raster persists across frames.
      // Hiding and restoring the overlay forces a fresh snapshot on the
      // canonical paint path, exactly like the WebKit lost capture (Issue #318
      // t1). It runs before the header seam: the header seam must be the last
      // compositing change, otherwise its rebuilt header snapshot is discarded
      // by the overlay repaint.
      await repaintWebkitReadyOverlay(page);
      // Issue #341: rebuild the shared header's WebKit backdrop snapshot from
      // the settled page. The seam is WebKit-only (this function only runs for
      // the `--webkit` engine) and does not apply to `--before` / `--clear` /
      // Chromium.
      await settleSharedHeaderCompositing(page);
      const bytes = await captureStableBytes(page, { fullPage: true });
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (expectedSha256 === null || actualSha256 === expectedSha256) {
        // The bytes already passed the stable-frame check; hand them to the
        // manifested writer so it still applies the fixed-environment guard and
        // the atomic write, without taking a third screenshot.
        await capture(page, name, { capturedBytes: bytes });
        return;
      }
      observed.push(actualSha256);
      console.warn(
        `WebKit scores capture attempt ${attempt}/${attempts} produced ${actualSha256}, ` +
          `not the recorded ${expectedSha256}; sampling a fresh page.`,
      );
    } finally {
      await context.close();
    }
  }
  throw new Error(
    `The WebKit scores capture did not reproduce the recorded ${name} sha256 ` +
      `${expectedSha256} in ${attempts} fresh pages (observed: ${observed.join(', ')}). ` +
      'Nothing was written. Re-run when the host load drops; if the leaderboard UI ' +
      'changed intentionally, re-run with --allow-new-bytes and update the manifest.',
  );
}

if (BEFORE && IS_WEBKIT) {
  throw new Error('The --webkit mode captures After screenshots only.');
}

if (CLEAR && IS_WEBKIT) {
  throw new Error(
    'The --webkit mode captures the shared scores panel only; the clear-records variant is Chromium-only.',
  );
}

// The plain Chromium After mode would otherwise overwrite the #45 subtask 1
// historical evidence with today's panel, which already has 「清空记录」. Fail
// before creating the output directory, probing the port or launching anything.
if (!BEFORE && !CLEAR && !IS_WEBKIT && !ALLOW_HISTORICAL_OVERWRITE) {
  const existing = HISTORICAL_AFTER_EVIDENCE.filter((file) => existsSync(file));
  if (existing.length > 0) {
    throw new Error(
      'Refusing to overwrite the #45 subtask 1 historical After evidence: ' +
        `${existing.join(', ')}. The current UI already includes the 「清空记录」 ` +
        'action, so this command would replace the historical baseline and drift ' +
        'from docs/screenshots/README.md. Re-run with --allow-historical-overwrite ' +
        'only when intentionally regenerating these files, and update that document ' +
        'plus the full-page sizes in the same change.',
    );
  }
}

await mkdir(OUTPUT, { recursive: true });

try {
  if (!BEFORE) {
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
  } finally {
    await closeCaptureBrowser(browser);
  }
} finally {
  stopPreviewServer(server);
  server = null;
}

assertAllDeclaredCaptureTargets(DECLARED_CAPTURE_TARGETS, {
  source: SCRIPT_NAME,
});
console.log(
  `Saved ${BEFORE ? 'Before' : 'After'} Minesweeper leaderboard screenshots on ${engineLabel(ENGINE)} to ${OUTPUT}/`,
);
