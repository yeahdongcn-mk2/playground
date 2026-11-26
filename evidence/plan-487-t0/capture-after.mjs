/**
 * Capture and verify the PR head for #487 t1 (PR #533).
 *
 * Usage:
 *   node evidence/plan-487-t0/capture-after.mjs <base-url> [out-dir]
 *
 * `base-url` must serve a production build of the PR head (the revision named
 * in the evidence README). On top of the two labelled screenshots, the script
 * checks the behaviours the PR claims: the hub entry links to the online
 * route, the real lazy room mounts, `?room=` is forwarded, leaving the route
 * destroys the room, and a failed chunk load can be retried.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:4399';
const out = resolve(process.argv[3] ?? 'evidence/plan-487-t0');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

// The hub entry is present and links to the online route.
const page = await context.newPage();
await page.goto(`${base}/#/`, { waitUntil: 'networkidle' });
const entry = page.locator('[data-testid="enter-online-minesweeper"]');
await entry.waitFor();
const href = await entry.getAttribute('href');
console.log(`hub entry href=${href}`);
if (href !== '#/online/minesweeper') fail('hub entry href mismatch');
await page.screenshot({ path: `${out}/after-hub.png`, fullPage: true });

// The real lazy room view mounts on the online route.
await page.goto(`${base}/#/online/minesweeper`, { waitUntil: 'networkidle' });
await page.locator('[data-testid="online-room"]').waitFor({ timeout: 10_000 });
await page.locator('[data-testid="create-form"]').waitFor({ timeout: 5_000 });
console.log(`title=${await page.title()}`);
await page.screenshot({ path: `${out}/after-online.png`, fullPage: true });

// The room id from the hash is forwarded to the room view.
await page.goto(`${base}/#/online/minesweeper?room=room_487_demo`, { waitUntil: 'networkidle' });
await page.locator('[data-testid="online-room"]').waitFor({ timeout: 10_000 });
const roomValue = await page.locator('[data-testid="join-room-id"]').inputValue();
console.log(`join-room-id=${roomValue}`);
if (roomValue !== 'room_487_demo') fail('room id was not passed through');

// Leaving the route destroys the room view.
await page.goto(`${base}/#/`, { waitUntil: 'networkidle' });
await page.locator('[data-testid="enter-online-minesweeper"]').waitFor();
if ((await page.locator('[data-testid="online-room"]').count()) !== 0) {
  fail('room view survived leaving the route');
}

// A failing lazy chunk shows the retryable error; retrying succeeds.
const retryPage = await context.newPage();
let blockChunk = true;
await retryPage.route('**/online-room-*.js', async (route) => {
  if (blockChunk) {
    await route.abort('failed');
  } else {
    await route.continue();
  }
});
await retryPage.goto(`${base}/#/online/minesweeper`, { waitUntil: 'domcontentloaded' });
const retryButton = retryPage.locator('#view [data-action="retry"]');
await retryButton.waitFor({ timeout: 10_000 });
console.log(`error title=${await retryPage.title()}`);
if ((await retryPage.title()) !== '联机房间加载失败 · Playground Arcade') {
  fail('missing failure title');
}
blockChunk = false;
await retryButton.click();
try {
  await retryPage.locator('[data-testid="online-room"]').waitFor({ timeout: 10_000 });
  console.log('retry mounted the room');
} catch {
  fail('retry did not mount the room (real browser dynamic-import retry)');
}

await browser.close();
console.log(process.exitCode === 1 ? 'RESULT: FAIL' : 'RESULT: PASS');
