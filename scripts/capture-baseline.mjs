import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const COMMIT = '937e06c90f852a9cf675a972656d6a23822b44d8';
const URL = `https://github.com/yeahdongcn-mk2/playground/tree/${COMMIT}`;

await mkdir('docs/screenshots', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: 'docs/screenshots/before-base-repo.png',
    fullPage: false,
    animations: 'disabled',
  });
  console.log('Baseline screenshot written to docs/screenshots/before-base-repo.png');
} finally {
  await browser.close();
}
