import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

/**
 * Capture the Before / After evidence for the Minesweeper best-time leaderboard.
 *
 *   npm run screenshots:minesweeper:scores
 *   BASE_URL=http://127.0.0.1:4192 node scripts/capture-minesweeper-scores-screenshots.mjs --before
 *
 * The after mode builds first (the npm script does) and serves the production
 * preview. The before mode must point BASE_URL at a preview of the baseline
 * revision (the commit before this task), which has the storage module but no
 * leaderboard panel. Both modes open the same fixed beginner board, win it with
 * one click at (8, 8) and seed a long custom-board record, so the only visible
 * difference between Before and After is the new sidebar card.
 */

const HOST = '127.0.0.1';
const PORT = 4192;
const ORIGIN = `http://${HOST}:${PORT}`;
const OUTPUT = 'docs/screenshots';
const BEFORE = process.argv.includes('--before');
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
// A 30x30 board keeps the longest custom label the UI can render, so the mobile
// capture also exercises the wrapping rule that prevents horizontal overflow.
const SEEDED_SCORES = {
  version: 1,
  records: { 'custom:30x30x100:safe': 125_000 },
};

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

  if (!BEFORE) {
    // Wait for the freshly recorded beginner time and the seeded custom row so
    // the screenshot shows the populated panel, not an empty state.
    await page
      .getByTestId('score-beginner-time')
      .filter({ hasNotText: '—' })
      .waitFor();
    await page.getByTestId('scores-custom').waitFor();
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
    `${BEFORE ? 'before' : 'after'}-minesweeper-scores-desktop.png`,
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
    `${BEFORE ? 'before' : 'after'}-minesweeper-scores-320x640.png`,
  );
  await context.close();
}

await mkdir(OUTPUT, { recursive: true });

try {
  if (!BEFORE) {
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
    await waitForServer(ORIGIN);
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
