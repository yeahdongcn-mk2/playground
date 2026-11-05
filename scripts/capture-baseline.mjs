import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const REPO = 'https://github.com/yeahdongcn-mk2/playground';
const COMMIT = process.env.BASELINE_COMMIT ?? '91fe3be04d5e53703f880fd3d5dc2a7d0ba47982';
const OUTPUT = 'docs/screenshots/before-base-repo.png';

await mkdir('docs/screenshots', { recursive: true });

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const response = await page.goto(`${REPO}/tree/${COMMIT}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!response?.ok()) {
    throw new Error(`GitHub returned ${response?.status() ?? 'no response'}`);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: OUTPUT });
  console.log(`Baseline screenshot written to ${OUTPUT} (${COMMIT.slice(0, 7)})`);
} finally {
  await browser.close();
}
