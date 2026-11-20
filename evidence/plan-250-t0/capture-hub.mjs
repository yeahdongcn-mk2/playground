import { chromium } from '@playwright/test';

const [baseUrl, outputPrefix] = process.argv.slice(2);

if (baseUrl === undefined || outputPrefix === undefined) {
  console.error('usage: node evidence/plan-250-t0/capture-hub.mjs <url> <output-prefix>');
  process.exitCode = 2;
} else {
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [1440, 1000],
      [320, 640],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.getByTestId('game-card-zhen-sha').waitFor({ state: 'visible' });

      if (width === 1440) {
        await page.evaluate(() => {
          const games = document.querySelector('#games');
          if (games === null) throw new Error('missing #games');
          window.scrollTo(0, games.getBoundingClientRect().top + window.scrollY - 16);
        });
      } else {
        await page.evaluate(() => {
          const card = document.querySelector('[data-testid="game-card-zhen-sha"]');
          if (card === null) throw new Error('missing zhen-sha card');
          card.scrollIntoView({ block: 'start' });
          window.scrollBy(0, -12);
        });
      }

      await page.waitForTimeout(250);
      await page.screenshot({ path: `${outputPrefix}-${width}x${height}.png` });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
