#!/usr/bin/env node
/**
 * Capture the same fixed win on two builds so the result overlay can be
 * compared Before / After.
 *
 * Usage:
 *   node evidence/plan-251-t1/capture-settlement.mjs \
 *     --before http://127.0.0.1:4190 --after http://127.0.0.1:4191 \
 *     --out evidence/plan-251-t1
 *
 * The player path is the same real pointer sequence in both builds: page.clock
 * freezes wall time and advances exactly 1500 / 3000 / 4500 ms to the three
 * impact ticks, then holds for 300 ms and releases for the finisher. This keeps
 * the game code untouched; only the browser clock is controlled.
 *
 * The After build is also used to save one real 1080x1440 battle-seal PNG
 * through the new "保存战绩符" button, so the PR can attach the actual
 * downloaded artifact rather than only a screenshot of it.
 */
import { readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const VIEWPORTS = [
  { label: '1440x1000', width: 1440, height: 1000 },
  { label: '320x640', width: 320, height: 640 },
];

function parseArgs(argv) {
  const options = { before: null, after: null, out: 'evidence/plan-251-t1' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--before') options.before = argv[index + 1];
    else if (arg === '--after') options.after = argv[index + 1];
    else if (arg === '--out') options.out = argv[index + 1];
    else throw new Error(`unknown argument: ${arg}`);
    index += 1;
  }
  if (!options.before || !options.after) {
    throw new Error('both --before and --after base URLs are required');
  }
  return options;
}

async function tap(page) {
  await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="zhen-sha-stage"]');
    if (!stage) throw new Error('missing zhen-sha stage');
    stage.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }),
    );
    stage.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' }),
    );
  });
}

async function playWin(page) {
  await page.clock.runFor(32);
  let elapsed = 32;
  for (const impactMs of [1500, 3000, 4500]) {
    await page.clock.runFor(impactMs - elapsed);
    elapsed = impactMs;
    await tap(page);
    await page.clock.runFor(16);
    elapsed += 16;
  }
  // Charge past the 220 ms hold threshold inside the 2000 ms break window.
  await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="zhen-sha-stage"]');
    if (!stage) throw new Error('missing zhen-sha stage');
    stage.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, pointerType: 'mouse' }),
    );
  });
  await page.clock.runFor(300);
  await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="zhen-sha-stage"]');
    if (!stage) throw new Error('missing zhen-sha stage');
    stage.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 2, pointerType: 'mouse' }),
    );
  });
  await page.clock.runFor(64);
}

async function capture(browser, baseUrl, viewport, path) {
  // Wall-clock time is frozen by page.clock, but a heavily loaded machine can
  // still coalesce frames so a tap lands outside the perfect band. Retry the
  // whole duel until the fixed sequence really reaches the victory overlay;
  // never save a screenshot of a different outcome.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${baseUrl}/#/games/zhen-sha`);
    await page.getByTestId('zhen-sha-game').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await playWin(page);

    let won = false;
    try {
      await page.getByTestId('overlay').waitFor({ state: 'visible', timeout: 2_000 });
      won = (await page.getByTestId('overlay-title').textContent()) === '一棍定魂';
    } catch {
      won = false;
    }
    if (!won) {
      await context.close();
      continue;
    }

    await page.getByTestId('perfects').waitFor();
    await page.waitForTimeout(80);
    const state = await page.evaluate(() => {
      const overlay = document.querySelector('[data-testid="overlay"]');
      const card = document.querySelector('[data-testid="settlement"]');
      const canvas = document.querySelector('[data-testid="settlement-canvas"]');
      const stage = document.querySelector('[data-testid="zhen-sha-stage"]');
      const box = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      return {
        status: document.querySelector('[data-testid="status"]')?.textContent ?? null,
        overlayHidden: overlay?.hidden ?? null,
        overlayScrollTop: overlay?.scrollTop ?? null,
        overlayClientHeight: overlay?.clientHeight ?? null,
        overlayScrollHeight: overlay?.scrollHeight ?? null,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
        overlay: box(overlay),
        card: box(card),
        canvas: box(canvas),
        stage: box(stage),
        stamps: canvas?.dataset.stamps ?? null,
        text: overlay?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      };
    });

    // The baseline result sits inside the stage below the fold at 320x640, so
    // scroll it into view; the fixed After overlay ignores this scroll. Record
    // the offset so the comparison states it instead of hiding it.
    const scrollY = await page.evaluate(() => {
      const overlay = document.querySelector('[data-testid="overlay"]');
      if (!overlay) return window.scrollY;
      overlay.scrollTop = 0;
      if (getComputedStyle(overlay).position !== 'fixed') {
        const rect = overlay.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          const top = rect.top + window.scrollY;
          window.scrollTo(0, Math.max(0, top - 40));
        }
      }
      return window.scrollY;
    });
    await page.waitForTimeout(50);
    await page.screenshot({ path, animations: 'disabled' });
    await context.close();
    return { ...state, attempt, scrollY };
  }
  throw new Error(`could not capture a fixed win from ${baseUrl} at ${viewport.label}`);
}

/** Play the deterministic win through the After build's debug seam. */
async function playDebugWin(page) {
  return page.evaluate(() => {
    const api = window.__playground;
    if (api?.gameId !== 'zhen-sha') {
      throw new Error('zhen-sha debug seam is not available');
    }
    api.step(180);
    api.input('block');
    api.step(1);
    api.step(179);
    api.input('block');
    api.step(1);
    api.step(179);
    api.input('block');
    api.step(1);
    api.input('charge');
    api.step(1);
    api.input('strike');
    api.step(1);
    return api.getState();
  });
}

/** Save one real PNG through the "保存战绩符" button and record its header. */
async function captureSeal(browser, baseUrl, path) {
  const viewport = VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/#/games/zhen-sha?debug=1`);
    await page.getByTestId('zhen-sha-game').waitFor();
    await page.evaluate(() => document.fonts.ready);

    const state = await playDebugWin(page);
    if (state.status !== 'won') {
      throw new Error(`expected a won duel, got ${String(state.status)}`);
    }

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('overlay-save-seal').click(),
    ]);
    const source = await download.path();
    if (source === null) {
      throw new Error('the download has no local path');
    }
    await copyFile(source, path);
    const png = readFileSync(path);
    return {
      path,
      filename: download.suggestedFilename(),
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      bytes: png.byteLength,
    };
  } finally {
    await context.close();
  }
}

const options = parseArgs(process.argv.slice(2));
await mkdir(options.out, { recursive: true });
const browser = await chromium.launch();
const report = [];
for (const viewport of VIEWPORTS) {
  for (const [side, baseUrl] of [
    ['before', options.before],
    ['after', options.after],
  ]) {
    const path = join(options.out, `plan-251-t1-${side}-${viewport.label}.png`);
    const state = await capture(browser, baseUrl, viewport, path);
    report.push({ side, viewport: viewport.label, path, state });
    console.log(`${side} ${viewport.label}: ${JSON.stringify(state)}`);
  }
}
const seal = await captureSeal(
  browser,
  options.after,
  join(options.out, 'plan-251-t1-after-seal-1080x1440.png'),
);
console.log(`after seal: ${JSON.stringify(seal)}`);
await browser.close();
console.log(`\nCaptured ${report.length} screenshots into ${options.out}`);
