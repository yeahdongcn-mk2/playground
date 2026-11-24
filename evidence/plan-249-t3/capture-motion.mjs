import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

const [baseUrl, outputPrefix] = process.argv.slice(2);

if (baseUrl === undefined || outputPrefix === undefined) {
  console.error(
    'usage: node evidence/plan-249-t3/capture-motion.mjs <base-url> <output-prefix>',
  );
  process.exitCode = 2;
} else {
  mkdirSync(dirname(outputPrefix), { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [320, 640],
      [1440, 1000],
    ]) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 1,
          colorScheme: 'dark',
          reducedMotion,
        });
        const page = await context.newPage();
        // Freeze the duel at the same tick in Before and After. Pause the
        // manual clock before the app boots so page-load time cannot advance
        // it, then advance exactly 932 ms (900 + 32) and let the pending frame
        // paint.
        await page.clock.install({ time: new Date('2026-01-01T00:00:00.000Z') });
        await page.clock.pauseAt(new Date('2026-01-01T00:00:01.000Z'));
        await page.goto(`${baseUrl}/#/games/zhen-sha`, { waitUntil: 'networkidle' });
        await page.clock.runFor(900);
        await page.clock.runFor(32);
        // Scroll the whole stage into view the same way in both revisions:
        // 320x640 needs a small scroll, 1440x1000 already fits.
        await page.evaluate(() => {
          const stage = document.querySelector('[data-testid="zhen-sha-stage"]');
          if (stage === null) {
            throw new Error('missing zhen-sha stage');
          }
          const rect = stage.getBoundingClientRect();
          if (rect.bottom > window.innerHeight) {
            window.scrollBy(0, Math.ceil(rect.bottom - window.innerHeight + 8));
          }
        });
        await page.waitForTimeout(120);

        if (reducedMotion === 'no-preference') {
          // Stop the three decorative loops at the same phase in both
          // revisions instead of racing the compositor.
          await page.evaluate(() => {
            for (const animation of document.getAnimations()) {
              animation.pause();
              animation.currentTime = 1500;
            }
          });
        }

        const suffix = `${width}x${height}`;
        const mode = reducedMotion === 'reduce' ? '-reduce' : '';
        await page.screenshot({ path: `${outputPrefix}${mode}-${suffix}.png` });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
