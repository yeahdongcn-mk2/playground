import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { assertPortAvailable, parsePreviewPort } from './lib/preview-port.mjs';

/**
 * Capture the Before / After evidence for the Minesweeper best-time leaderboard.
 *
 *   npm run screenshots:minesweeper:scores
 *   BASE_URL=http://127.0.0.1:4192 node scripts/capture-minesweeper-scores-screenshots.mjs --before
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
 * other server.
 */

const HOST = '127.0.0.1';
const PORT = parsePreviewPort();
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const BEFORE = process.argv.includes('--before');
const CLEAR = process.argv.includes('--clear');
const FILE_PREFIX = CLEAR ? 'minesweeper-clear-scores' : 'minesweeper-scores';
const BASE_URL = process.env.BASE_URL ?? ORIGIN;

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

/** Error shown when the preview dies before the capture can connect to it. */
function previewStartupError(detail) {
  const suffix = detail.trim() === '' ? '' : `\n${detail.trim()}`;
  return new Error(
    `The preview server exited before ${ORIGIN} became ready. ` +
      `Port ${PORT} may be taken by another process; set PREVIEW_PORT to a ` +
      `free port (for example PREVIEW_PORT=${PORT + 1}).${suffix}`,
  );
}

async function waitForServer(url, { timeoutMs = 30_000, failure } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failureDetail = failure?.();
    if (failureDetail != null) {
      throw previewStartupError(failureDetail);
    }
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
  const failureDetail = failure?.();
  throw new Error(
    `Timed out waiting for ${url}. If the preview is on another port, set ` +
      `PREVIEW_PORT to match it.` +
      (failureDetail == null ? '' : `\n${failureDetail}`),
  );
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function capture(page, name) {
  await page.screenshot({
    path: `${OUTPUT}/${name}`,
    fullPage: true,
    animations: 'disabled',
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

await mkdir(OUTPUT, { recursive: true });

try {
  if (!BEFORE) {
    // Fail with the real cause when the port is taken; otherwise the readiness
    // probe would connect to the other server and an unrelated locator timeout
    // would be reported much later.
    await assertPortAvailable(PORT, HOST);
    let stderr = '';
    let startupFailure = null;
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
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stderr?.setEncoding('utf8');
    server.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    server.once('error', (error) => {
      startupFailure = `Failed to spawn the preview server: ${error.message}`;
    });
    server.once('close', (code, signal) => {
      startupFailure ??=
        `vite preview stopped (exit code ${code}, signal ${signal ?? 'none'}).` +
        (stderr.trim() === '' ? '' : `\n${stderr.trim()}`);
    });
    await waitForServer(ORIGIN, {
      failure: () => startupFailure,
    });
  }

  const browser = await chromium.launch();
  try {
    await captureDesktop(browser);
    await captureMobile(browser);
  } finally {
    await browser.close();
  }
} finally {
  if (server) {
    server.kill('SIGTERM');
    server = null;
  }
}

console.log(
  `Saved ${BEFORE ? 'Before' : 'After'} Minesweeper leaderboard screenshots to ${OUTPUT}/`,
);
