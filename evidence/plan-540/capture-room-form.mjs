#!/usr/bin/env node
/**
 * Capture the online Minesweeper create form for #540 t2 evidence.
 *
 * The `#/online/minesweeper` route is not on main yet (#543), so both trees
 * serve `evidence/plan-540/harness.html`: it renders the real app shell and
 * mounts the production `mountOnlineRoom` composition root. The before and
 * after trees load the identical page, at the same viewports and theme.
 *
 * Usage:
 *   node evidence/plan-540/capture-room-form.mjs \
 *     --before http://127.0.0.1:4191 \
 *     --after http://127.0.0.1:4190 \
 *     --out evidence/plan-540
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const HARNESS_PATH = '/evidence/plan-540/harness.html';
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 320, height: 640 },
];

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value pairs, got: ${argv.join(' ')}`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (!args.before || !args.after || !args.out) {
  throw new Error('Usage: capture-room-form.mjs --before <url> --after <url> --out <dir>');
}

await mkdir(args.out, { recursive: true });

const browser = await chromium.launch();

async function openHarness(baseUrl, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(new URL(HARNESS_PATH, baseUrl).href, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.evidenceReady === 'true');
  await page.waitForSelector('[data-testid="online-room"]');
  await page.evaluate(() => document.fonts.ready);
  return { context, page, pageErrors };
}

async function scrollCreateFormIntoView(page, viewport) {
  await page.evaluate(({ narrow }) => {
    if (!narrow) {
      window.scrollTo(0, 0);
      return;
    }
    const form = document.querySelector('[data-testid="create-form"]');
    const header = document.querySelector('.site-header');
    if (!(form instanceof HTMLElement)) {
      throw new Error('missing create form');
    }
    const headerHeight = header instanceof HTMLElement ? header.getBoundingClientRect().height : 0;
    window.scrollTo(0, form.getBoundingClientRect().top + window.scrollY - headerHeight - 12);
  }, { narrow: viewport.width <= 560 });
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
  await page.waitForTimeout(100);
}

async function formMetrics(page) {
  return page.evaluate(() => {
    const form = document.querySelector('[data-testid="create-form"]');
    const select = document.querySelector('[data-testid="difficulty"]');
    const fields = document.querySelector('[data-testid="custom-fields"]');
    const rect = form instanceof HTMLElement ? form.getBoundingClientRect() : null;
    return {
      scrollY: Math.round(window.scrollY),
      form: rect === null ? null : {
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      selectedDifficulty: select instanceof HTMLSelectElement ? select.value : null,
      customFieldsVisible: fields instanceof HTMLElement ? !fields.hidden : null,
      error: document.querySelector('[data-testid="form-error"]')?.textContent ?? '',
    };
  });
}

async function shoot(page, name, viewport, metrics) {
  await page.screenshot({ path: join(args.out, name), animations: 'disabled' });
  console.log(`${name} ${JSON.stringify({ viewport, ...metrics })}`);
}

async function closeHarness(harness) {
  if (harness.pageErrors.length > 0) {
    throw new Error(`Page errors: ${harness.pageErrors.join(' | ')}`);
  }
  await harness.context.close();
}

try {
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;

    const before = await openHarness(args.before, viewport);
    await scrollCreateFormIntoView(before.page, viewport);
    await shoot(before.page, `before-${label}.png`, viewport, await formMetrics(before.page));
    await closeHarness(before);

    const after = await openHarness(args.after, viewport);
    await after.page.selectOption('[data-testid="difficulty"]', 'custom');
    await after.page.fill('[data-testid="custom-rows"]', '12');
    await after.page.fill('[data-testid="custom-cols"]', '12');
    await after.page.fill('[data-testid="custom-mines"]', '20');
    await scrollCreateFormIntoView(after.page, viewport);
    await shoot(after.page, `after-${label}.png`, viewport, await formMetrics(after.page));
    await closeHarness(after);
  }

  // Extra after-only states: the new focus ring and the shared error region.
  const desktop = VIEWPORTS[0];
  const focus = await openHarness(args.after, desktop);
  await focus.page.selectOption('[data-testid="difficulty"]', 'custom');
  await focus.page.fill('[data-testid="custom-rows"]', '12');
  await focus.page.fill('[data-testid="custom-cols"]', '12');
  await focus.page.fill('[data-testid="custom-mines"]', '20');
  await scrollCreateFormIntoView(focus.page, desktop);
  await focus.page.focus('[data-testid="custom-rows"]');
  await focus.page.waitForTimeout(100);
  await focus.page.screenshot({
    path: join(args.out, 'after-focus-1440x1000.png'),
    animations: 'disabled',
  });
  console.log('after-focus-1440x1000.png focus ring on custom rows');
  await closeHarness(focus);

  const invalid = await openHarness(args.after, desktop);
  await invalid.page.fill('[data-testid="nickname"]', 'Ada');
  await invalid.page.selectOption('[data-testid="difficulty"]', 'custom');
  await invalid.page.fill('[data-testid="custom-rows"]', '4');
  await invalid.page.fill('[data-testid="custom-cols"]', '12');
  await invalid.page.fill('[data-testid="custom-mines"]', '20');
  await invalid.page.click('[data-testid="create-room"]');
  await invalid.page.waitForSelector('[data-testid="form-error"]:not([hidden])');
  await shoot(
    invalid.page,
    'after-invalid-1440x1000.png',
    desktop,
    await formMetrics(invalid.page),
  );
  await closeHarness(invalid);
} finally {
  await browser.close();
}

console.log(`Captured create-form evidence into ${args.out}`);
