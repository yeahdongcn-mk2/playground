// @vitest-environment jsdom
import type { Page } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BREAKOUT_FREEZE_TIMEOUT_MS,
  BREAKOUT_FROZEN_ATTRIBUTE,
  BREAKOUT_GAME_SELECTOR,
  freezeBreakoutLoop,
  requestBreakoutFreeze,
} from '../../scripts/lib/breakout-freeze.mjs';
import type { BreakoutFreezeRequest } from '../../scripts/lib/breakout-freeze.mjs';

const TARGET = { selector: BREAKOUT_GAME_SELECTOR };
const GAME_ROOT = '<section data-testid="breakout-game"></section>';

interface DebugWindow {
  __playground?: {
    gameId: string;
    freeze?: () => boolean;
  };
}

function debugWindow(): DebugWindow {
  return window as unknown as DebugWindow;
}

function gameRoot(): HTMLElement {
  const root = document.querySelector(BREAKOUT_GAME_SELECTOR);
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing breakout game root fixture');
  }
  return root;
}

type InPageFreeze = (options: { selector: string }) => BreakoutFreezeRequest;
type MarkerPredicate = (options: {
  selector: string;
  attribute: string;
}) => boolean;

function pageWith(
  evaluate: (
    fn: InPageFreeze,
    arg: { selector: string },
  ) => Promise<BreakoutFreezeRequest>,
  waitForFunction: (
    fn: MarkerPredicate,
    arg: { selector: string; attribute: string },
    options: { timeout: number },
  ) => Promise<void>,
): Page {
  return { evaluate, waitForFunction } as unknown as Page;
}

/** Execute the real in-page freeze request against the jsdom fixture. */
function runInPage(
  fn: InPageFreeze,
  arg: { selector: string },
): Promise<BreakoutFreezeRequest> {
  return Promise.resolve(fn(arg));
}

beforeEach(() => {
  document.body.innerHTML = GAME_ROOT;
});

afterEach(() => {
  delete debugWindow().__playground;
  document.body.innerHTML = '';
});

describe('breakout terminal freeze seam (Issue #328)', () => {
  it('reports a missing game root instead of freezing an unrelated page', () => {
    document.body.innerHTML = '';
    expect(requestBreakoutFreeze(TARGET)).toEqual({
      found: false,
      frozen: false,
    });
  });

  it('reports a missing debug API instead of pretending the loop stopped', () => {
    expect(requestBreakoutFreeze(TARGET)).toEqual({
      found: true,
      frozen: false,
    });
  });

  it('publishes the explicit marker only through the debug freeze result', () => {
    const freeze = vi.fn(() => {
      gameRoot().setAttribute(BREAKOUT_FROZEN_ATTRIBUTE, '1');
      return true;
    });
    debugWindow().__playground = { gameId: 'breakout', freeze };

    expect(requestBreakoutFreeze(TARGET)).toEqual({
      found: true,
      frozen: true,
    });
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(gameRoot().getAttribute(BREAKOUT_FROZEN_ATTRIBUTE)).toBe('1');
  });

  it('rejects a debug freeze that does not confirm the loop stopped', () => {
    const freeze = vi.fn(() => false);
    debugWindow().__playground = { gameId: 'breakout', freeze };

    expect(requestBreakoutFreeze(TARGET)).toEqual({
      found: true,
      frozen: false,
    });
    expect(gameRoot().hasAttribute(BREAKOUT_FROZEN_ATTRIBUTE)).toBe(false);
  });

  it('requests the freeze and waits for the explicit marker', async () => {
    const freeze = vi.fn(() => {
      gameRoot().setAttribute(BREAKOUT_FROZEN_ATTRIBUTE, '1');
      return true;
    });
    debugWindow().__playground = { gameId: 'breakout', freeze };

    const evaluate = vi.fn(runInPage);
    const waitForFunction = vi.fn(
      async (
        predicate: MarkerPredicate,
        arg: { selector: string; attribute: string },
        options: { timeout: number },
      ) => {
        expect(options).toEqual({ timeout: BREAKOUT_FREEZE_TIMEOUT_MS });
        expect(predicate(arg)).toBe(true);
      },
    );

    await freezeBreakoutLoop(pageWith(evaluate, waitForFunction));

    expect(freeze).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(waitForFunction).toHaveBeenCalledTimes(1);
    expect(gameRoot().getAttribute(BREAKOUT_FROZEN_ATTRIBUTE)).toBe('1');
  });

  it('supports a custom selector / marker and timeout', async () => {
    document.body.innerHTML =
      '<section data-testid="other-game"></section>';
    debugWindow().__playground = {
      gameId: 'breakout',
      freeze: () => {
        document
          .querySelector('[data-testid="other-game"]')
          ?.setAttribute('data-other-frozen', '1');
        return true;
      },
    };
    const evaluate = vi.fn(runInPage);
    const waitForFunction = vi.fn(
      async (
        predicate: MarkerPredicate,
        arg: { selector: string; attribute: string },
        options: { timeout: number },
      ) => {
        expect(arg).toEqual({
          selector: '[data-testid="other-game"]',
          attribute: 'data-other-frozen',
        });
        expect(options).toEqual({ timeout: 1234 });
        expect(predicate(arg)).toBe(true);
      },
    );

    await freezeBreakoutLoop(pageWith(evaluate, waitForFunction), {
      selector: '[data-testid="other-game"]',
      attribute: 'data-other-frozen',
      timeout: 1234,
    });

    expect(waitForFunction).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the game root is missing', async () => {
    document.body.innerHTML = '';
    const waitForFunction = vi.fn();
    await expect(
      freezeBreakoutLoop(pageWith(vi.fn(runInPage), waitForFunction)),
    ).rejects.toThrow(/game root "\[data-testid="breakout-game"\]" was not found/);
    expect(waitForFunction).not.toHaveBeenCalled();
  });

  it('fails loudly when the debug API does not freeze the loop', async () => {
    debugWindow().__playground = {
      gameId: 'breakout',
      freeze: () => false,
    };
    const waitForFunction = vi.fn();
    await expect(
      freezeBreakoutLoop(pageWith(vi.fn(runInPage), waitForFunction)),
    ).rejects.toThrow(/did not expose freeze\(\) or did not confirm/);
    expect(waitForFunction).not.toHaveBeenCalled();
  });

  it('does not trust the boolean without the explicit marker', async () => {
    debugWindow().__playground = {
      gameId: 'breakout',
      freeze: () => true,
    };
    const waitForFunction = vi.fn(async () => {
      throw new Error('Timeout 10000ms exceeded.');
    });
    await expect(
      freezeBreakoutLoop(pageWith(vi.fn(runInPage), waitForFunction)),
    ).rejects.toThrow(
      /did not publish data-debug-frozen="1" within 10000 ms.*Timeout 10000ms exceeded/,
    );
    expect(waitForFunction).toHaveBeenCalledTimes(1);
  });
});
