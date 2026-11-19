// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHARED_HEADER_SELECTOR,
  SHARED_HEADER_SETTLE_FRAMES,
  repaintSharedHeader,
  settleSharedHeaderCompositing,
} from '../../scripts/lib/webkit-compositing-settle.mjs';
import type { SharedHeaderRepaintOptions } from '../../scripts/lib/webkit-compositing-settle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = readFileSync(join(ROOT, 'src', 'app', 'app.ts'), 'utf8');

/** A deferred promise whose resolution order a test can control. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Replace jsdom's missing / asynchronous `document.fonts` with a stub. */
function stubFonts(ready: Promise<void> = Promise.resolve()): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready },
  });
}

function installHeader(markup?: string): HTMLElement {
  document.body.innerHTML =
    markup ??
    '<header class="site-header">PLAYGROUND <span>ARCADE</span></header>';
  const header = document.querySelector<HTMLElement>(SHARED_HEADER_SELECTOR);
  if (!header) {
    throw new Error('test fixture did not create the shared header');
  }
  return header;
}

/**
 * Read the WebKit-prefixed filter as jsdom exposes it. jsdom's
 * CSSStyleDeclaration does not model the vendor property (its cssText stays
 * empty), but assigning / clearing the camelCase alias still records the value
 * the seam set, which is enough to prove the prefixed toggle runs.
 */
function webkitFilter(header: HTMLElement): string {
  return (
    header.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }
  ).webkitBackdropFilter ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/**
 * The seam is shared by every WebKit capture, not just the blank scene: it
 * waits for the header fonts, toggles both filter aliases in order, waits a
 * configurable number of double-rAF commits after each toggle and fails the
 * capture when the header is missing.
 */
describe('WebKit shared header compositing settle seam', () => {
  it('waits for the header fonts, then repaints it between committed frames', async () => {
    const header = installHeader();
    const fonts = deferred();
    stubFonts(fonts.promise);
    const observedFilters: Array<{ backdrop: string; webkit: string }> = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) => {
        observedFilters.push({
          backdrop: header.style.backdropFilter,
          webkit: webkitFilter(header),
        });
        callback(0);
        return 0;
      },
    );

    const pending = repaintSharedHeader({
      selector: SHARED_HEADER_SELECTOR,
      frames: SHARED_HEADER_SETTLE_FRAMES,
    });
    await Promise.resolve();
    // The filter must not be touched until the header fonts have loaded.
    expect(header.style.backdropFilter).toBe('');
    expect(observedFilters).toEqual([]);

    fonts.resolve();
    await expect(pending).resolves.toBe(true);
    // Two toggles, each followed by SHARED_HEADER_SETTLE_FRAMES double-rAF
    // waits: both aliases are off for the first side and restored for the
    // second instead of being left unfiltered or never toggled.
    expect(observedFilters).toEqual([
      ...Array(SHARED_HEADER_SETTLE_FRAMES * 2).fill({
        backdrop: 'none',
        webkit: 'none',
      }),
      ...Array(SHARED_HEADER_SETTLE_FRAMES * 2).fill({
        backdrop: '',
        webkit: '',
      }),
    ]);
    expect(header.style.backdropFilter).toBe('');
    expect(webkitFilter(header)).toBe('');
  });

  it('honours a custom header selector and frame budget', async () => {
    document.body.innerHTML = '<header class="custom-header">X</header>';
    const header = document.querySelector<HTMLElement>('.custom-header');
    if (!header) {
      throw new Error('test fixture did not create the custom header');
    }
    stubFonts();
    let frames = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) => {
        frames += 1;
        callback(0);
        return 0;
      },
    );

    await expect(
      repaintSharedHeader({ selector: '.custom-header', frames: 1 }),
    ).resolves.toBe(true);

    // One double-rAF wait per toggle side, so a hard-coded two-wait budget or
    // the shared `.site-header` selector would fail this case.
    expect(frames).toBe(4);
    expect(header.style.backdropFilter).toBe('');
  });

  it('fails instead of silently skipping a missing shared header', async () => {
    document.body.innerHTML = '';
    stubFonts();

    await expect(
      repaintSharedHeader({
        selector: SHARED_HEADER_SELECTOR,
        frames: SHARED_HEADER_SETTLE_FRAMES,
      }),
    ).resolves.toBe(false);

    // The default page.evaluate wiring reaches the in-page seam; a missing
    // header becomes a capture error rather than a silent no-op.
    const page = {
      evaluate: (
        repaint: (options: SharedHeaderRepaintOptions) => Promise<boolean>,
        options: SharedHeaderRepaintOptions,
      ) => repaint(options),
    } as unknown as Page;
    await expect(settleSharedHeaderCompositing(page)).rejects.toThrow(
      'Shared header ".site-header" was not found',
    );
  });

  it('passes the selector and frame budget to the in-page seam', async () => {
    const calls: Array<{ repaint: unknown; options: unknown }> = [];
    const page = {
      evaluate: async (repaint: unknown, options: unknown) => {
        calls.push({ repaint, options });
        return true;
      },
    } as unknown as Page;

    await settleSharedHeaderCompositing(page);

    expect(calls).toEqual([
      {
        repaint: repaintSharedHeader,
        options: {
          selector: SHARED_HEADER_SELECTOR,
          frames: SHARED_HEADER_SETTLE_FRAMES,
        },
      },
    ]);
    // The helper targets the real shell header and commits two double-rAF
    // waits per toggle; changing either constant must change this test.
    expect(APP).toContain('<header class="site-header">');
    expect(SHARED_HEADER_SELECTOR).toBe('.site-header');
    expect(SHARED_HEADER_SETTLE_FRAMES).toBe(2);
  });

  it('lets a non-blank capture inject evaluate and custom options', async () => {
    const calls: Array<{
      page: Page;
      repaint: unknown;
      options: unknown;
    }> = [];
    const page = {} as Page;
    const evaluate = async (
      capturePage: Page,
      repaint: unknown,
      options: unknown,
    ) => {
      calls.push({ page: capturePage, repaint, options });
      return true;
    };

    await settleSharedHeaderCompositing(page, {
      evaluate,
      selector: '.custom-header',
      frames: 3,
    });

    expect(calls).toEqual([
      {
        page,
        repaint: repaintSharedHeader,
        options: { selector: '.custom-header', frames: 3 },
      },
    ]);
  });
});
