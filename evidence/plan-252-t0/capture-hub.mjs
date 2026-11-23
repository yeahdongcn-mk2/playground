import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [baseUrl, outputPrefix] = process.argv.slice(2);

if (baseUrl === undefined || outputPrefix === undefined) {
  console.error(
    'usage: node evidence/plan-252-t0/capture-hub.mjs <url> <output-prefix>',
  );
  process.exitCode = 2;
} else {
  /** Desktop and the documented narrow viewport, in the dark theme. */
  const VIEWPORTS = [
    {
      name: '1440x1000',
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
    {
      name: '320x640',
      viewport: { width: 320, height: 640 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
  ];

  const sha256 = (path) =>
    createHash('sha256').update(readFileSync(path)).digest('hex');

  /** PNG IHDR width/height, recorded in the screenshot README. */
  const pngSize = (path) => {
    const bytes = readFileSync(path);
    if (bytes.readUInt32BE(0) !== 0x89504e47) {
      throw new Error(`${path} is not a PNG`);
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };

  const browser = await chromium.launch();
  try {
    for (const config of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: config.viewport,
        deviceScaleFactor: config.deviceScaleFactor,
        isMobile: config.isMobile,
        hasTouch: config.hasTouch,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      // Same wait window as the shared hub capture: fonts and the first paint
      // are settled while the page stays at the top of the document.
      await page.waitForTimeout(400);
      const path = `${outputPrefix}-${config.name}.png`;
      await page.screenshot({ path, fullPage: false });
      const size = pngSize(path);
      console.log(
        `${path} ${size.width}x${size.height} sha256=${sha256(path)}`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
