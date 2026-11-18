// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLANK_HEADER_SELECTOR,
  BLANK_HEADER_SETTLE_FRAMES,
  BLANK_SETTLE_INTERVAL_MS,
  BLANK_SETTLE_TIMEOUT_MS,
  BLANK_STABLE_SAMPLES,
  BLANK_TARGET_TOLERANCE,
  isBlankAtTarget,
  nextBlankStableStreak,
  readBlankReadout,
  repaintBlankHeader,
  settleBlankHeader,
  waitForBlankSettled,
} from '../../scripts/lib/blank-settle.mjs';
import type {
  BlankHeaderRepaintOptions,
  BlankReadoutSample,
} from '../../scripts/lib/blank-settle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-screenshots.mjs'),
  'utf8',
);
const VIEW = readFileSync(join(ROOT, 'src', 'games', 'blank', 'view.ts'), 'utf8');
const APP = readFileSync(join(ROOT, 'src', 'app', 'app.ts'), 'utf8');
const SCENE = readFileSync(
  join(ROOT, 'src', 'games', 'blank', 'scene.ts'),
  'utf8',
);

/** The body of `tapBlankCanvas`, where the settle wait must stay awaited. */
function tapBlankCanvasBody(): string {
  const match = /async function tapBlankCanvas\b[\s\S]*?\n}/.exec(SCRIPT);
  if (!match) {
    throw new Error('capture-screenshots.mjs no longer defines tapBlankCanvas');
  }
  return match[0];
}

/** The body of one top-level function, found by matching braces. */
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
  const header = document.querySelector<HTMLElement>(BLANK_HEADER_SELECTOR);
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

/** Drop comments so a commented-out call cannot satisfy the static pin. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Guard for the committed blank-canvas PNGs. The blank scene has no RNG, so
 * determinism only needs the orb to snap to the pointer target and the trail
 * to fade out before the screenshot. The settle loop is runtime-tested with a
 * fake page, and the capture script is statically pinned so deleting the
 * `await waitForBlankSettled(...)` inside `tapBlankCanvas` fails here instead
 * of silently restoring click-and-capture-immediately frames.
 */
describe('blank canvas screenshot determinism guard', () => {
  it('reads x, y and trail from the blank HUD readout', async () => {
    let selector = '';
    const page = {
      locator(candidate: string) {
        selector = candidate;
        return {
          evaluate(
            fn: (element: { dataset: Record<string, string> }) => unknown,
          ) {
            return Promise.resolve(
              fn({ dataset: { x: '12', y: '34', trail: '0' } }),
            );
          },
        };
      },
    } as unknown as Page;

    await expect(readBlankReadout(page)).resolves.toEqual({
      x: 12,
      y: 34,
      trail: 0,
    });
    expect(selector).toBe('[data-testid="readout"]');
  });

  it('polls until the required run of settled samples (movement resets it)', async () => {
    const target = { x: 100, y: 60 };
    const samples: BlankReadoutSample[] = [
      { x: 40, y: 20, trail: 0 }, // stale reading from before the click
      { x: 100, y: 60, trail: 1 }, // on target but the trail is still alive
      { x: 100, y: 60, trail: 0 }, // streak 1
      { x: 101, y: 60, trail: 0 }, // streak 2
      { x: 150, y: 60, trail: 0 }, // movement resets the streak
      { x: 100, y: 60, trail: 0 }, // streak 1
      { x: 100, y: 60, trail: 0 }, // streak 2
      { x: 100, y: 60, trail: 0 }, // streak 3 -> settled
    ];
    let current = 0;
    const reads: number[] = [];
    const waits: number[] = [];

    const result = await waitForBlankSettled({} as Page, target, {
      required: 3,
      intervalMs: 25,
      timeoutMs: 10_000,
      now: () => current,
      read: async () => {
        reads.push(current);
        const sample = samples.shift();
        if (!sample) {
          throw new Error('read after the expected settle');
        }
        return sample;
      },
      wait: async (_page, delayMs) => {
        waits.push(delayMs);
        current += delayMs;
      },
    });

    expect(result).toEqual({ x: 100, y: 60, trail: 0 });
    expect(samples).toHaveLength(0);
    expect(reads).toHaveLength(8);
    // No delay after the settled sample: the capture follows immediately.
    expect(waits).toEqual(Array(7).fill(25));
  });

  it('throws with the last readout when the orb never settles', async () => {
    const target = { x: 100, y: 60 };
    let current = 1_000;
    const waits: number[] = [];

    const error = await waitForBlankSettled({} as Page, target, {
      intervalMs: 100,
      timeoutMs: 250,
      now: () => current,
      read: async () => ({ x: 0, y: 0, trail: 1 }),
      wait: async (_page, delayMs) => {
        waits.push(delayMs);
        current += delayMs;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Blank canvas did not settle at (100, 60) within 250 ms ' +
        '(last readout x=0, y=0, trail=1)',
    );
    // It polls until the deadline, then fails instead of capturing.
    expect(waits.length).toBeGreaterThan(0);
    expect(current).toBeGreaterThanOrEqual(1_250);
  });

  it('uses the production defaults: five settled samples, 100 ms apart', async () => {
    const target = { x: 10, y: 20 };
    const settled = { x: 10, y: 20, trail: 0 };
    const samples: BlankReadoutSample[] = [
      settled,
      settled,
      settled,
      settled,
      settled,
    ];
    let current = 0;
    const waits: number[] = [];

    const result = await waitForBlankSettled({} as Page, target, {
      now: () => current,
      read: async () => {
        const sample = samples.shift();
        if (!sample) {
          throw new Error('read after the expected settle');
        }
        return sample;
      },
      wait: async (_page, delayMs) => {
        waits.push(delayMs);
        current += delayMs;
      },
    });

    expect(result).toEqual(settled);
    expect(samples).toHaveLength(0);
    // Exactly BLANK_STABLE_SAMPLES reads; the default interval between them.
    expect(waits).toEqual(
      Array(BLANK_STABLE_SAMPLES - 1).fill(BLANK_SETTLE_INTERVAL_MS),
    );
  });

  it('wires the default page read/wait path', async () => {
    const target = { x: 5, y: 6 };
    const waits: number[] = [];
    const page = {
      locator(selector: string) {
        expect(selector).toBe('[data-testid="readout"]');
        return {
          evaluate(
            fn: (element: { dataset: Record<string, string> }) => unknown,
          ) {
            return Promise.resolve(
              fn({ dataset: { x: '5', y: '6', trail: '0' } }),
            );
          },
        };
      },
      async waitForTimeout(delayMs: number) {
        waits.push(delayMs);
      },
    } as unknown as Page;

    await expect(waitForBlankSettled(page, target)).resolves.toEqual({
      x: 5,
      y: 6,
      trail: 0,
    });
    expect(waits).toEqual(
      Array(BLANK_STABLE_SAMPLES - 1).fill(BLANK_SETTLE_INTERVAL_MS),
    );
  });

  it('keeps the settle wait inside tapBlankCanvas instead of the old delay', () => {
    const body = stripComments(tapBlankCanvasBody());
    expect(body).toMatch(/await\s+waitForBlankSettled\(\s*page,\s*target\b/);
    expect(SCRIPT).not.toContain('waitForTimeout(700)');
    expect(SCRIPT).toContain('settleBlankHeader,');
    expect(SCRIPT).toContain('waitForBlankSettled,');
    expect(SCRIPT).toContain("} from './lib/blank-settle.mjs';");
    // The polling constants and failure message live in the tested module.
    expect(BLANK_SETTLE_INTERVAL_MS).toBe(100);
    expect(BLANK_SETTLE_TIMEOUT_MS).toBe(15_000);
  });

  it('settles every blank scene (desktop, mobile, WebKit)', () => {
    expect([...SCRIPT.matchAll(/await tapBlankCanvas\(page, box/g)]).toHaveLength(3);
    expect(SCRIPT).toContain('await tapBlankCanvas(page, box, 0.66, 0.4);');
    expect(SCRIPT).toContain(
      'await tapBlankCanvas(page, box, 0.36, 0.62, { touch: true });',
    );
  });

  it('publishes the live trail count from the scene state', () => {
    expect(VIEW).toContain('readout.dataset.trail = String(state.trail);');
    expect(VIEW).toContain('data-x="0" data-y="0" data-trail="0"');
    expect(SCENE).toContain('trail: this.trail.length,');
  });

  it('accepts only a sample at the target and with no trail left', () => {
    const target = { x: 120, y: 80 };
    // Pin the documented capture contract, not just self-consistency.
    expect(BLANK_TARGET_TOLERANCE).toBe(2);
    expect(BLANK_STABLE_SAMPLES).toBe(5);
    expect(isBlankAtTarget({ x: 120, y: 80, trail: 0 }, target)).toBe(true);
    expect(
      isBlankAtTarget(
        {
          x: 120 + BLANK_TARGET_TOLERANCE,
          y: 80 - BLANK_TARGET_TOLERANCE,
          trail: 0,
        },
        target,
      ),
    ).toBe(true);
    expect(
      isBlankAtTarget(
        { x: 120 + BLANK_TARGET_TOLERANCE + 0.5, y: 80, trail: 0 },
        target,
      ),
    ).toBe(false);
    expect(
      nextBlankStableStreak(2, { x: 120, y: 80, trail: 0 }, target),
    ).toBe(3);
    // A live trail dot resets even when the orb already sits on the target.
    expect(
      nextBlankStableStreak(2, { x: 120, y: 80, trail: 1 }, target),
    ).toBe(0);
  });

  it('resets the streak when the orb is still moving or misses the target', () => {
    const target = { x: 200, y: 150 };
    const onTarget = { x: 200, y: 150, trail: 0 };
    const moving = { x: 190, y: 150, trail: 0 };
    // A still centre reading from before the click must not count.
    const beforeClick = { x: 100, y: 100, trail: 0 };

    let streak = 0;
    streak = nextBlankStableStreak(streak, beforeClick, target);
    expect(streak).toBe(0);
    streak = nextBlankStableStreak(streak, moving, target);
    expect(streak).toBe(0);
    streak = nextBlankStableStreak(streak, onTarget, target);
    expect(streak).toBe(1);
    streak = nextBlankStableStreak(streak, moving, target);
    expect(streak).toBe(0);
  });

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

    const pending = repaintBlankHeader({
      selector: BLANK_HEADER_SELECTOR,
      frames: BLANK_HEADER_SETTLE_FRAMES,
    });
    await Promise.resolve();
    // The filter must not be touched until the header fonts have loaded.
    expect(header.style.backdropFilter).toBe('');
    expect(observedFilters).toEqual([]);

    fonts.resolve();
    await expect(pending).resolves.toBe(true);
    // Two toggles, each followed by BLANK_HEADER_SETTLE_FRAMES double-rAF
    // waits: both aliases are off for the first side and restored for the
    // second instead of being left unfiltered or never toggled.
    expect(observedFilters).toEqual([
      ...Array(BLANK_HEADER_SETTLE_FRAMES * 2).fill({
        backdrop: 'none',
        webkit: 'none',
      }),
      ...Array(BLANK_HEADER_SETTLE_FRAMES * 2).fill({
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
      repaintBlankHeader({ selector: '.custom-header', frames: 1 }),
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
      repaintBlankHeader({
        selector: BLANK_HEADER_SELECTOR,
        frames: BLANK_HEADER_SETTLE_FRAMES,
      }),
    ).resolves.toBe(false);

    // The default page.evaluate wiring reaches the in-page seam; a missing
    // header becomes a capture error rather than a silent no-op.
    const page = {
      evaluate: (
        repaint: (options: BlankHeaderRepaintOptions) => Promise<boolean>,
        options: BlankHeaderRepaintOptions,
      ) => repaint(options),
    } as unknown as Page;
    await expect(settleBlankHeader(page)).rejects.toThrow(
      'Blank header ".site-header" was not found',
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

    await settleBlankHeader(page);

    expect(calls).toEqual([
      {
        repaint: repaintBlankHeader,
        options: {
          selector: BLANK_HEADER_SELECTOR,
          frames: BLANK_HEADER_SETTLE_FRAMES,
        },
      },
    ]);
    // The helper targets the real shell header and commits two double-rAF
    // waits per toggle; changing either constant must change this test.
    expect(APP).toContain('<header class="site-header">');
    expect(BLANK_HEADER_SELECTOR).toBe('.site-header');
    expect(BLANK_HEADER_SETTLE_FRAMES).toBe(2);
  });

  it('settles the shared header only for the WebKit blank capture', () => {
    const body = functionBody(SCRIPT, 'captureWebkitMobile');
    const tapAt = body.indexOf(
      'await tapBlankCanvas(page, box, 0.36, 0.62, { touch: true });',
    );
    const seamAt = body.indexOf('await settleBlankHeader(page);');
    const captureAt = body.indexOf(
      "captureScreenshot(page, 'after-blank-webkit.png'",
    );
    // The seam runs after the blank scene settles and before its screenshot.
    expect(tapAt).toBeGreaterThan(-1);
    expect(seamAt).toBeGreaterThan(tapAt);
    expect(captureAt).toBeGreaterThan(seamAt);
    expect([...body.matchAll(/await settleBlankHeader\(page\);/g)]).toHaveLength(1);

    // The hub capture precedes the route switch, and the Chromium blank
    // captures keep their committed bytes, so neither may run the seam.
    expect(body.slice(0, tapAt)).not.toContain('settleBlankHeader');
    for (const name of ['captureDesktop', 'captureMobile']) {
      expect(functionBody(SCRIPT, name)).not.toContain('settleBlankHeader');
    }
  });

  it('caps the streak at the configured sample count', () => {
    const target = { x: 0, y: 0 };
    const sample = { x: 0, y: 0, trail: 0 };
    let streak = 0;
    for (let index = 0; index < BLANK_STABLE_SAMPLES + 3; index += 1) {
      streak = nextBlankStableStreak(streak, sample, target);
    }
    expect(streak).toBe(BLANK_STABLE_SAMPLES);
    expect(
      nextBlankStableStreak(0, sample, target, { required: 2 }),
    ).toBe(1);
    expect(
      nextBlankStableStreak(1, sample, target, { required: 2 }),
    ).toBe(2);
  });
});
