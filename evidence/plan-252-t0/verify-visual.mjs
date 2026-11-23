import { chromium } from '@playwright/test';

/**
 * Cross-check the hub Before / After screenshots captured from two production
 * builds. It proves the After page (not just the source) promotes zhen-sha into
 * the hero, keeps the feature card in the first screen and leaves the other six
 * lobby entries in place, while the Before page still carries the orb hero and
 * the snake CTA.
 */
const [beforeUrl, afterUrl] = process.argv.slice(2);

const VIEWPORTS = [
  { name: '1440x1000', viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: '320x640', viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

const GRID_IDS = ['snake', 'tetris', '2048', 'breakout', 'minesweeper', 'blank'];

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

async function readPage(browser, url, config) {
  const context = await browser.newContext({
    viewport: config.viewport,
    deviceScaleFactor: config.deviceScaleFactor,
    isMobile: config.isMobile,
    hasTouch: config.hasTouch,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const hero = document.querySelector('.hero');
    const card = document.querySelector('[data-testid="game-card-zhen-sha"]');
    const primary = document.querySelector('.hero .button--primary');
    const cta = document.querySelector('[data-testid="enter-zhen-sha"]');
    const art = card === null ? null : card.querySelector('.game-card-art');
    const box = (element) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
      };
    };
    const gridIds = [...document.querySelectorAll('.game-grid [data-testid^="game-card-"]')]
      .map((element) => element.getAttribute('data-testid') ?? '')
      .filter((id) => !id.startsWith('game-card-last-played-'));
    return {
      heroPrimaryTestId: primary?.getAttribute('data-testid') ?? null,
      heroPrimaryCount: document.querySelectorAll('.hero .button--primary').length,
      zhenShaCount: document.querySelectorAll('[data-testid="game-card-zhen-sha"]').length,
      zhenShaHref: card?.getAttribute('href') ?? null,
      zhenShaInHero: hero !== null && card !== null && hero.contains(card),
      zhenShaHiddenAncestor: card?.closest('[aria-hidden="true"]') !== null,
      zhenShaBox: box(card),
      ctaHref: cta?.getAttribute('href') ?? null,
      ctaInHero: hero !== null && cta !== null && hero.contains(cta),
      zhenShaInlineSvg: art?.querySelectorAll('svg').length ?? 0,
      artBackground: art === null ? null : getComputedStyle(art).backgroundImage,
      artBefore: art === null ? null : getComputedStyle(art, '::before').content,
      orbCoreCount: document.querySelectorAll('.orb-core').length,
      gridIds,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  await context.close();
  return info;
}

if (beforeUrl === undefined || afterUrl === undefined) {
  console.error(
    'usage: node evidence/plan-252-t0/verify-visual.mjs <before-url> <after-url>',
  );
  process.exitCode = 2;
} else {
  const browser = await chromium.launch();
  try {
    for (const config of VIEWPORTS) {
      const before = await readPage(browser, beforeUrl, config);
      const after = await readPage(browser, afterUrl, config);
      const { width, height } = config.viewport;

      // Before: the shared orb hero still owns the visual and the snake CTA is
      // the primary entry; zhen-sha is still a grid card.
      expect(before.orbCoreCount === 1, `${config.name}: Before lost the orb hero`);
      expect(
        before.heroPrimaryTestId === 'enter-snake',
        `${config.name}: Before hero CTA was not enter-snake`,
      );
      expect(
        before.zhenShaInHero === false,
        `${config.name}: Before already promoted zhen-sha into the hero`,
      );
      expect(
        before.gridIds.includes('game-card-zhen-sha'),
        `${config.name}: Before grid lost the zhen-sha card`,
      );

      // After: the feature card is the hero visual and the only primary CTA.
      expect(after.orbCoreCount === 0, `${config.name}: After still renders the orb`);
      expect(
        after.heroPrimaryCount === 1 && after.heroPrimaryTestId === 'enter-zhen-sha',
        `${config.name}: After hero primary CTA is not enter-zhen-sha`,
      );
      expect(
        after.zhenShaCount === 1,
        `${config.name}: After should render exactly one zhen-sha card`,
      );
      expect(
        after.zhenShaHref === '#/games/zhen-sha',
        `${config.name}: After feature card href is ${after.zhenShaHref}`,
      );
      expect(after.zhenShaInHero, `${config.name}: After card is not inside the hero`);
      expect(
        after.zhenShaHiddenAncestor === false,
        `${config.name}: After card is under aria-hidden`,
      );
      expect(
        after.zhenShaInlineSvg === 1,
        `${config.name}: After feature card has ${after.zhenShaInlineSvg} inline SVGs`,
      );
      expect(
        after.artBackground !== null && !after.artBackground.includes('data:image/svg+xml'),
        `${config.name}: After art still comes from a CSS data URI`,
      );
      expect(
        after.artBefore === 'none' || after.artBefore === 'normal',
        `${config.name}: After art still paints a ::before layer (${after.artBefore})`,
      );
      expect(
        after.ctaHref === '#/games/zhen-sha' && after.ctaInHero,
        `${config.name}: After CTA does not point at the zhen-sha route`,
      );

      const box = after.zhenShaBox;
      expect(box !== null, `${config.name}: After feature card has no box`);
      expect(box.x >= 0 && box.y >= 0, `${config.name}: feature card starts outside the viewport`);
      expect(
        box.right <= width && box.bottom <= height,
        `${config.name}: feature card ends at ${box.right}x${box.bottom}, outside ${width}x${height}`,
      );
      expect(
        after.scrollWidth <= after.clientWidth,
        `${config.name}: After scrolls horizontally (${after.scrollWidth} > ${after.clientWidth})`,
      );

      // The other six entries each appear once; the grid never repeats zhen-sha.
      const afterGridIds = after.gridIds.sort();
      expect(
        JSON.stringify(afterGridIds) ===
          JSON.stringify(GRID_IDS.map((id) => `game-card-${id}`).sort()),
        `${config.name}: After grid entries are ${JSON.stringify(afterGridIds)}`,
      );

      console.log(
        `${config.name}: OK (card ${Math.round(box.x)},${Math.round(box.y)}→${Math.round(box.right)},${Math.round(box.bottom)})`,
      );
    }
  } finally {
    await browser.close();
  }
}
