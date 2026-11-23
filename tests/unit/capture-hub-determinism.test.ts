// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HUB_HERO_SELECTOR,
  HUB_HERO_SETTLE_FRAMES,
  SHARED_HEADER_SELECTOR,
  SHARED_HEADER_SETTLE_FRAMES,
  settleHubHeroAnimations,
  settleHubHeroCompositing,
  settleSharedHeaderCompositing,
} from '../../scripts/lib/webkit-compositing-settle.mjs';
import type {
  HubHeroAnimationsOptions,
  HubHeroAnimationsResult,
  SharedHeaderRepaintOptions,
} from '../../scripts/lib/webkit-compositing-settle.mjs';
import { renderHub } from '../../src/app/hub';
import { games } from '../../src/games/registry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-screenshots.mjs'),
  'utf8',
);
const HUB_VIEW = readFileSync(join(ROOT, 'src', 'app', 'hub.ts'), 'utf8');
const APP = readFileSync(join(ROOT, 'src', 'app', 'app.ts'), 'utf8');

/** The body of one top-level `async function name(...)`, found by braces. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) {
    throw new Error(`missing function: ${name}`);
  }
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

/** Drop comments so a commented-out call cannot satisfy the static pins. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** Replace jsdom's missing / asynchronous `document.fonts` with a stub. */
function stubFonts(): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
}

interface FakeAnimation {
  playState: string;
  finished: Promise<void>;
  finish(): void;
}

/** Replace jsdom's missing `document.getAnimations` with scripted animations. */
function stubAnimations(animations: FakeAnimation[]): void {
  Object.defineProperty(document, 'getAnimations', {
    configurable: true,
    value: () => animations as unknown as Animation[],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/**
 * Guard for the committed hub WebKit PNG.
 *
 * The `99dfef39…` hub drift (Issue #341 t2) is two effects in one frame: the
 * shared header's known 1-step backdrop snapshot (2429 px) and, far larger, a
 * hero visual composited at a reduced-motion animation's end frame instead of
 * the resting style. Both seams therefore run between the hub load and the
 * `after-hub-webkit.png` screenshot. Issue #252 replaced the orb with the
 * zhen-sha feature card, so the hero selector moved to that card while the seam
 * itself is unchanged. Static pins keep the order, the WebKit-only scope and the
 * Chromium captures untouched; jsdom cases prove the animation settle finishes
 * before the committed-frame waits and that a missing header / hero fails the
 * capture instead of silently skipping it.
 */
describe('hub WebKit screenshot determinism guard', () => {
  it('reuses the shared compositing seam instead of a second paint recipe', () => {
    expect(SCRIPT).toContain(
      "import {\n  settleHubHeroCompositing,\n  settleSharedHeaderCompositing,\n} from './lib/webkit-compositing-settle.mjs';",
    );
    // The capture script must not inline the toggle / animation / frame waits a
    // second time (that belongs to scripts/lib/webkit-compositing-settle.mjs).
    expect(SCRIPT).not.toContain('requestAnimationFrame');
    expect(SCRIPT).not.toContain('backdropFilter');
  });

  it('settles the header and hero after the hub load and before its screenshot', () => {
    const body = functionBody(stripComments(SCRIPT), 'captureWebkitMobile');
    const hubLoadAt = body.indexOf('page.goto(`${BASE_URL}/`');
    const fontsAt = body.indexOf('page.evaluate(() => document.fonts.ready)');
    const headerSeamAt = body.indexOf(
      'await settleSharedHeaderCompositing(page);',
    );
    const heroSeamAt = body.indexOf('await settleHubHeroCompositing(page);');
    const hubCaptureAt = body.indexOf(
      "captureScreenshot(page, 'after-hub-webkit.png'",
    );
    const blankRouteAt = body.indexOf(
      'page.goto(`${BASE_URL}/#/games/blank`',
    );

    // Both seams run after the hub has loaded and painted, and before the hub
    // screenshot; a commented-out or relocated call fails here. The hero
    // animation settle is closest to the screenshot because it removes the
    // residual transform the capture would otherwise composite.
    expect(hubLoadAt).toBeGreaterThan(-1);
    expect(fontsAt).toBeGreaterThan(hubLoadAt);
    expect(headerSeamAt).toBeGreaterThan(fontsAt);
    expect(heroSeamAt).toBeGreaterThan(headerSeamAt);
    expect(hubCaptureAt).toBeGreaterThan(heroSeamAt);
    expect(blankRouteAt).toBeGreaterThan(hubCaptureAt);
    expect(
      [...body.matchAll(/await settleSharedHeaderCompositing\(page\);/g)],
    ).toHaveLength(1);
    expect(
      [...body.matchAll(/await settleHubHeroCompositing\(page\);/g)],
    ).toHaveLength(1);

    // The blank path still keeps its own ordering: tap the settled scene, pin
    // the header through the blank wrapper, then capture after-blank-webkit.
    const tapAt = body.indexOf(
      'await tapBlankCanvas(page, box, 0.36, 0.62, { touch: true });',
    );
    const blankSeamAt = body.indexOf('await settleBlankHeader(page);');
    const blankCaptureAt = body.indexOf(
      "captureScreenshot(page, 'after-blank-webkit.png'",
    );
    expect(tapAt).toBeGreaterThan(blankRouteAt);
    expect(blankSeamAt).toBeGreaterThan(tapAt);
    expect(blankCaptureAt).toBeGreaterThan(blankSeamAt);
  });

  it('keeps the hub seams out of the Chromium captures', () => {
    const source = stripComments(SCRIPT);
    for (const name of ['captureDesktop', 'captureMobile']) {
      const body = functionBody(source, name);
      expect(body).not.toContain('settleSharedHeaderCompositing');
      expect(body).not.toContain('settleHubHeroCompositing');
    }
    // captureWebkitMobile is reached only from the WebKit dispatch; the
    // Chromium branch keeps its committed hub bytes.
    expect(source).toMatch(
      /if \(IS_WEBKIT\) \{\s*await captureWebkitMobile\(browser\);/,
    );
    expect(source).toMatch(
      /\} else \{\s*await captureDesktop\(browser\);\s*await captureMobile\(browser\);/,
    );
  });

  it('targets the real shell header and hero so missing elements fail', async () => {
    document.body.innerHTML = '';
    stubFonts();
    const page = {
      evaluate: (
        settle: (options: SharedHeaderRepaintOptions) => Promise<unknown>,
        options: SharedHeaderRepaintOptions,
      ) => settle(options),
    } as unknown as Page;
    await expect(settleSharedHeaderCompositing(page)).rejects.toThrow(
      'Shared header ".site-header" was not found',
    );

    await expect(settleHubHeroCompositing(page)).rejects.toThrow(
      'Hub hero "[data-testid="game-card-zhen-sha"]" was not found',
    );
    expect(APP).toContain('<header class="site-header">');
    // Render the real hub instead of grepping the template: the test id is
    // emitted from the registry, so only the rendered string proves the
    // selector still targets the shipped feature card.
    expect(HUB_VIEW).toContain("FEATURE_GAME_ID = 'zhen-sha'");
    expect(
      renderHub(games, { lastPlayed: () => null }),
    ).toContain('data-testid="game-card-zhen-sha"');
    expect(HUB_HERO_SELECTOR).toBe('[data-testid="game-card-zhen-sha"]');
    expect(HUB_HERO_SETTLE_FRAMES).toBe(2);
    expect(SHARED_HEADER_SELECTOR).toBe('.site-header');
    expect(SHARED_HEADER_SETTLE_FRAMES).toBe(2);
  });

  it('finishes running animations, then waits committed frames', async () => {
    stubFonts();
    document.body.innerHTML =
      '<div class="hero-visual"><a data-testid="game-card-zhen-sha"></a></div>';
    let rafCalls = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCalls += 1;
      callback(0);
      return 0;
    });
    const animation: FakeAnimation = {
      playState: 'running',
      finished: Promise.resolve(),
      finish() {
        animation.playState = 'finished';
      },
    };
    stubAnimations([animation]);

    await expect(
      settleHubHeroAnimations({
        selector: HUB_HERO_SELECTOR,
        frames: HUB_HERO_SETTLE_FRAMES,
      }),
    ).resolves.toEqual({ found: true, pending: 0 });
    // One double-rAF wait per configured frame after the animations finish.
    expect(rafCalls).toBe(HUB_HERO_SETTLE_FRAMES * 2);
    expect(animation.playState).toBe('finished');

    const calls: Array<{ settle: unknown; options: unknown }> = [];
    const page = {
      evaluate: async (settle: unknown, options: unknown) => {
        calls.push({ settle, options });
        return { found: true, pending: 0 };
      },
    } as unknown as Page;
    await settleHubHeroCompositing(page);
    expect(calls).toEqual([
      {
        settle: settleHubHeroAnimations,
        options: {
          selector: HUB_HERO_SELECTOR,
          frames: HUB_HERO_SETTLE_FRAMES,
        },
      },
    ]);

    vi.unstubAllGlobals();
  });

  it('fails when an animation never finishes instead of capturing it', async () => {
    stubFonts();
    document.body.innerHTML =
      '<div class="hero-visual"><a data-testid="game-card-zhen-sha"></a></div>';
    let rafCalls = 0;
    vi.stubGlobal('requestAnimationFrame', () => {
      rafCalls += 1;
      return 0;
    });
    const endless: FakeAnimation = {
      playState: 'running',
      finished: new Promise<void>(() => {}),
      finish() {
        // An infinite animation cannot be finished; it stays running.
        throw new Error('infinite');
      },
    };
    stubAnimations([endless]);
    const page = {
      evaluate: (
        settle: (options: HubHeroAnimationsOptions) => Promise<HubHeroAnimationsResult>,
        options: HubHeroAnimationsOptions,
      ) => settle(options),
    } as unknown as Page;

    await expect(settleHubHeroCompositing(page)).rejects.toThrow(
      'still had 1 running animation(s)',
    );
    expect(rafCalls).toBe(0);

    vi.unstubAllGlobals();
  });

  it('lets a capture inject the hero selector and frame budget', async () => {
    const calls: Array<{
      page: Page;
      settle: unknown;
      options: unknown;
    }> = [];
    const page = {} as Page;
    const evaluate = async (
      capturePage: Page,
      settle: unknown,
      options: unknown,
    ) => {
      calls.push({ page: capturePage, settle, options });
      return { found: true, pending: 0 };
    };

    await settleHubHeroCompositing(page, {
      evaluate,
      selector: '.custom-hero',
      frames: 3,
    });

    expect(calls).toEqual([
      {
        page,
        settle: settleHubHeroAnimations,
        options: { selector: '.custom-hero', frames: 3 },
      },
    ]);
  });
});
