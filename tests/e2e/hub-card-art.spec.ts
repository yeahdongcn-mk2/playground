import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const FEATURE_CARD = '[data-testid="game-card-zhen-sha"]';
const FEATURE_ART = `${FEATURE_CARD} .game-card-art`;
const HERO_CTA = '[data-testid="enter-zhen-sha"]';
const GRID_GAME_IDS = ['snake', 'tetris', '2048', 'breakout', 'minesweeper', 'blank'] as const;

interface FeatureArtStyle {
  readonly hasModifier: boolean;
  readonly artAriaHidden: string | null;
  readonly inlineSvgCount: number;
  readonly svgClass: string | null;
  readonly backgroundImage: string;
  readonly svgWidth: number;
  readonly svgHeight: number;
  readonly goldPixels: number;
  readonly inkPixels: number;
  readonly engineColor: string | null;
  readonly engineBorderColor: string | null;
}

async function readFeatureArt(page: Page): Promise<FeatureArtStyle> {
  return page.locator(FEATURE_ART).evaluate(async (element) => {
    const style = getComputedStyle(element);
    const svg = element.querySelector('svg');
    const engine = element.querySelector('.game-card-engine');
    const engineStyle = engine === null ? null : getComputedStyle(engine);
    const svgRect = svg === null ? null : svg.getBoundingClientRect();

    // Paint the inline SVG once so the assertion proves the art actually
    // renders instead of only checking markup or a computed-style string.
    let goldPixels = 0;
    let inkPixels = 0;
    if (svg !== null) {
      const serialized = new XMLSerializer().serializeToString(svg);
      const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (context !== null) {
          context.drawImage(image, 0, 0);
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let index = 0; index < data.length; index += 4) {
            const red = data[index] ?? 0;
            const green = data[index + 1] ?? 0;
            const blue = data[index + 2] ?? 0;
            const alpha = data[index + 3] ?? 0;
            if (red > 200 && green > 140 && blue < 130 && alpha > 40) goldPixels += 1;
            if (red < 20 && green < 20 && blue < 20 && alpha > 80) inkPixels += 1;
          }
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    return {
      hasModifier: element.classList.contains('game-card-art--zhen-sha'),
      artAriaHidden: element.getAttribute('aria-hidden'),
      inlineSvgCount: element.querySelectorAll('svg').length,
      svgClass: svg?.getAttribute('class') ?? null,
      backgroundImage: style.backgroundImage,
      svgWidth: svgRect?.width ?? 0,
      svgHeight: svgRect?.height ?? 0,
      goldPixels,
      inkPixels,
      engineColor: engineStyle?.color ?? null,
      engineBorderColor: engineStyle?.borderTopColor ?? null,
    };
  });
}

function expectInlineInkAndGold(art: FeatureArtStyle): void {
  expect(art.hasModifier).toBe(true);
  // The decorative art layer is hidden; the card link and CTA are not.
  expect(art.artAriaHidden).toBe('true');
  expect(art.inlineSvgCount).toBe(1);
  expect(art.svgClass).toBe('zhen-sha-card-art');
  expect(art.backgroundImage).toMatch(/246,\s*196,\s*83/);
  expect(art.backgroundImage).toMatch(/8,\s*7,\s*10/);
  expect(art.svgWidth).toBeGreaterThan(40);
  expect(art.svgHeight).toBeGreaterThan(20);

  // The decoded inline SVG must actually paint: a malformed SVG would still
  // keep its DOM node but render no gold/ink pixels.
  expect(art.goldPixels).toBeGreaterThan(100);
  expect(art.inkPixels).toBeGreaterThan(500);

  expect(art.engineColor).toBe('rgb(246, 196, 83)');
  expect(art.engineBorderColor).toBe('rgba(246, 196, 83, 0.34)');
}

async function expectInsideViewport(
  page: Page,
  selector: string,
  width: number,
  height: number,
): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} should render a box`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
}

/** The CTA is in normal flow, not collapsed and not covered by a sibling. */
async function expectCtaReachable(page: Page): Promise<void> {
  const cta = page.locator(HERO_CTA);
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute('href', '#/games/zhen-sha');

  const box = await cta.boundingBox();
  expect(box, 'the hero CTA should render a box').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  await cta.scrollIntoViewIfNeeded();
  const obstructed = await cta.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return top === null || !(top === element || element.contains(top));
  });
  expect(obstructed, 'the hero CTA must not be covered by another element').toBe(false);
}

test.describe('zhen-sha hero feature card at 1440x1000', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('renders inline ink-and-gold art fully inside the first screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

    const art = await readFeatureArt(page);
    expectInlineInkAndGold(art);
    // The feature card keeps the base card art height on desktop.
    expect(art.svgHeight).toBeGreaterThan(0);

    await expectInsideViewport(page, FEATURE_CARD, 1440, 1000);
    await expectInsideViewport(page, FEATURE_ART, 1440, 1000);
    await expectInsideViewport(page, HERO_CTA, 1440, 1000);
    await expectCtaReachable(page);

    // The interactive card is never inside an aria-hidden subtree.
    expect(
      await page
        .locator(FEATURE_CARD)
        .evaluate((element) => element.closest('[aria-hidden="true"]') !== null),
    ).toBe(false);

    // The hero has exactly one primary button and it is the zhen-sha CTA.
    expect(await page.locator('.hero .button--primary').count()).toBe(1);
    expect(
      await page
        .locator('.hero .button--primary')
        .evaluate((element) => element.getAttribute('data-testid')),
    ).toBe('enter-zhen-sha');
  });

  test('opens the zhen-sha route from the hero CTA', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('enter-zhen-sha').click();
    await expect(page).toHaveURL(/#\/games\/zhen-sha/);
    await expect(page.getByTestId('zhen-sha-game')).toBeVisible();
  });

  test('keeps the other six entries in the lobby grid exactly once', async ({ page }) => {
    await page.goto('/');
    for (const id of GRID_GAME_IDS) {
      await expect(page.getByTestId(`game-card-${id}`)).toHaveCount(1);
    }
    await expect(page.getByTestId('game-card-zhen-sha')).toHaveCount(1);
    await expect(page.getByTestId('game-card-zhen-sha')).toHaveClass(/game-card--feature/);
  });
});

test.describe('zhen-sha hero feature card at 320x640', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('keeps the feature card in the first screen without horizontal scroll', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

    const art = await readFeatureArt(page);
    expectInlineInkAndGold(art);
    // 320px hits the documented narrow card art height.
    const artBox = await page.locator(FEATURE_ART).boundingBox();
    expect(artBox).not.toBeNull();
    expect(artBox!.height).toBe(156);

    await expectInsideViewport(page, FEATURE_CARD, 320, 640);
    await expectCtaReachable(page);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});
