/**
 * Capture the main-branch baseline for #487 t1 (PR #533).
 *
 * Usage:
 *   node evidence/plan-487-t0/capture-before.mjs <base-url> [out-dir]
 *
 * `base-url` must serve a production build of `main` (the revision named in
 * the evidence README). The script asserts the two baseline facts the PR
 * evidence claims: the hub has no online entry, and the online route still
 * shows the placeholder page instead of a mounted room.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:4398';
const out = resolve(process.argv[3] ?? 'evidence/plan-487-t0');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

await page.goto(`${base}/#/`, { waitUntil: 'networkidle' });
const entryCount = await page.locator('[data-testid="enter-online-minesweeper"]').count();
console.log(`baseline hub online entry count=${entryCount}`);
await page.screenshot({ path: `${out}/before-hub.png`, fullPage: true });

await page.goto(`${base}/#/online/minesweeper`, { waitUntil: 'networkidle' });
const heading = await page.locator('#view h1').textContent();
const onlineRoomCount = await page.locator('[data-testid="online-room"]').count();
console.log(`baseline online heading=${heading}`);
console.log(`baseline online-room count=${onlineRoomCount}`);
await page.screenshot({ path: `${out}/before-online.png`, fullPage: true });

await browser.close();

if (entryCount !== 0) fail('baseline unexpectedly has the hub entry');
if (heading !== '联机房间入口尚未接入') fail('baseline placeholder text changed');
if (onlineRoomCount !== 0) fail('baseline unexpectedly mounts the room');
console.log(process.exitCode === 1 ? 'RESULT: FAIL' : 'RESULT: PASS');
