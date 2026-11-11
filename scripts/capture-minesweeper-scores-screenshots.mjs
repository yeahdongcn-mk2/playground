import { existsSync } from 'node:fs';
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
 * The plain Chromium After mode refuses to overwrite the
 * `after-minesweeper-scores-*.png` files: they are the #45 subtask 1 historical
 * evidence, captured before the current panel gained the 「清空记录」 action.
 * Re-running `npm run screenshots:minesweeper:scores` on today's UI would
 * silently replace them with the current panel. Pass
 * `--allow-historical-overwrite` to regenerate them on purpose, and update
 * docs/screenshots/README.md plus the full-page sizes at the same time. The
 * `--before`, `--clear` and `--webkit` modes never hit this guard.
 */

const HOST = '127.0.0.1';
const PORT = parsePreviewPort();
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const ARGS = process.argv.slice(2);
const BEFORE = ARGS.includes('--before');
const CLEAR = ARGS.includes('--clear');
const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes('--allow-historical-overwrite');
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

async function capture(page, name) {
  await captureScreenshot(page, name, { engine: ENGINE, fullPage: true });
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
  const context = await browser.newContext({
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
  const context = await browser.newContext({
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

/** Capture the 320×640 leaderboard panel on the WebKit engine. */
async function captureWebkitMobile(browser) {
  const context = await createPhoneContext(browser, ENGINE, {
    viewport: { width: 320, height: 640 },
  });
  const page = await context.newPage();
  await seedScores(page);
  await openWin(page);
  await capture(page, `after-${FILE_PREFIX}-webkit.png`);
  await context.close();
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

console.log(
  `Saved ${BEFORE ? 'Before' : 'After'} Minesweeper leaderboard screenshots on ${engineLabel(ENGINE)} to ${OUTPUT}/`,
);
