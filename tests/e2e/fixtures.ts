import { expect, test as base, type Page } from '@playwright/test';

/** Fail any test that triggers an uncaught page error. */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });
      await use(errors);
      expect(errors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export interface GamePosition {
  x: number;
  y: number;
}

export async function openBlankGame(page: Page): Promise<void> {
  await page.goto('/#/games/blank');
  await expect(page.getByTestId('blank-game')).toBeVisible();
  await expect(page.getByTestId('blank-stage')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('blank-loading')).toBeHidden();
}

export async function readPosition(
  page: Page,
): Promise<GamePosition> {
  const readout = page.getByTestId('readout');
  const [x, y] = await Promise.all([
    readout.getAttribute('data-x'),
    readout.getAttribute('data-y'),
  ]);
  return { x: Number(x), y: Number(y) };
}

export async function canvasBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('canvas[data-testid="game-canvas"]').boundingBox();
  if (!box) {
    throw new Error('Game canvas has no bounding box');
  }
  return box;
}

/**
 * Track window-level `blur` listeners added via addEventListener. Phaser also
 * assigns window.onblur, which is not counted here and is library-global.
 */
export async function installBlurListenerProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const blurListeners = new Set<EventListenerOrEventListenerObject>();
    const visibilityListeners = new Set<EventListenerOrEventListenerObject>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'blur') blurListeners.add(listener);
      return add(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'blur') blurListeners.delete(listener);
      return remove(type, listener, options);
    }) as typeof window.removeEventListener;

    const documentAdd = document.addEventListener.bind(document);
    const documentRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'visibilitychange') visibilityListeners.add(listener);
      return documentAdd(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'visibilitychange') visibilityListeners.delete(listener);
      return documentRemove(type, listener, options);
    }) as typeof document.removeEventListener;

    const probe = {
      __blurListenerCount: () => blurListeners.size,
      __visibilityListenerCount: () => visibilityListeners.size,
    };
    Object.assign(window, probe);
  });
}

export async function blurListenerCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __blurListenerCount: () => number }).__blurListenerCount(),
  );
}

export async function visibilityListenerCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __visibilityListenerCount: () => number })
        .__visibilityListenerCount(),
  );
}

interface ListenerProbeApi {
  setTarget(name: string, target: EventTarget | null): void;
  count(name: string, type: string): number;
  pendingLongTimers(): number;
}

interface ListenerProbeWindow {
  __listenerProbe?: ListenerProbeApi;
}

/**
 * Count the listeners that are *effectively* active on window, document and a
 * game element. Unlike a plain add/remove counter this also drops listeners
 * registered with `{ signal }` when that signal aborts, so it catches leaks
 * that teardown only handles through `AbortController`. It also tracks timers
 * of one second or longer, such as the 2048 scene-ready timeout.
 */
export async function installListenerProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Entry {
      readonly target: EventTarget;
      readonly type: string;
      readonly listener: EventListenerOrEventListenerObject;
      readonly capture: boolean;
    }

    const entries = new Set<Entry>();
    const targets = new Map<string, EventTarget>();
    const longTimers = new Set<number>();

    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const captureOf = (options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean =>
      typeof options === 'boolean' ? options : Boolean(options?.capture);
    const removeEntry = (
      target: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      capture: boolean,
    ): void => {
      for (const entry of entries) {
        if (
          entry.target === target &&
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === capture
        ) {
          entries.delete(entry);
        }
      }
    };

    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener) {
        const capture = captureOf(options);
        const existing = [...entries].some(
          (entry) =>
            entry.target === this &&
            entry.type === type &&
            entry.listener === listener &&
            entry.capture === capture,
        );
        if (!existing) {
          const entry: Entry = { target: this, type, listener, capture };
          entries.add(entry);
          const signal =
            typeof options === 'object' && options !== null ? options.signal : undefined;
          if (signal) {
            // The browser drops signal-bound listeners without calling
            // removeEventListener, so mirror that here.
            nativeAdd.call(signal, 'abort', () => entries.delete(entry), { once: true });
          }
        }
      }
      nativeAdd.call(this, type, listener, options);
    } as typeof EventTarget.prototype.addEventListener;

    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      removeEntry(this, type, listener, captureOf(options));
      nativeRemove.call(this, type, listener, options);
    } as typeof EventTarget.prototype.removeEventListener;

    const nativeSetTimeout = window.setTimeout.bind(window) as (
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => number;
    const nativeClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ): number => {
      const id = nativeSetTimeout(handler, timeout, ...args);
      if (typeof timeout === 'number' && timeout >= 1_000) {
        longTimers.add(id);
      }
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number): void => {
      if (typeof id === 'number') {
        longTimers.delete(id);
      }
      nativeClearTimeout(id);
    }) as typeof window.clearTimeout;

    targets.set('window', window);
    targets.set('document', document);

    const api: ListenerProbeApi = {
      setTarget(name, target) {
        if (target) {
          targets.set(name, target);
        } else {
          targets.delete(name);
        }
      },
      count(name, type) {
        const target = targets.get(name);
        if (!target) {
          return -1;
        }
        let total = 0;
        for (const entry of entries) {
          if (entry.target === target && entry.type === type) {
            total += 1;
          }
        }
        return total;
      },
      pendingLongTimers() {
        return longTimers.size;
      },
    };
    Object.assign(window, { __listenerProbe: api });
  });
}

/** Point a named probe target at an element matching `selector`. */
export async function trackProbeTarget(
  page: Page,
  name: string,
  selector: string,
): Promise<void> {
  await page.evaluate(
    ({ name, selector }) => {
      const api = (window as unknown as ListenerProbeWindow).__listenerProbe;
      api?.setTarget(name, document.querySelector(selector));
    },
    { name, selector },
  );
}

/** Count active listeners of `type` on a probe target ('window', 'stage', ...). */
export async function listenerCount(page: Page, name: string, type: string): Promise<number> {
  return page.evaluate(
    ({ name, type }) => {
      const api = (window as unknown as ListenerProbeWindow).__listenerProbe;
      if (!api) {
        throw new Error('Listener probe is not installed');
      }
      return api.count(name, type);
    },
    { name, type },
  );
}

/** Number of pending timers with a delay of at least one second. */
export async function pendingLongTimerCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as unknown as ListenerProbeWindow).__listenerProbe;
    if (!api) {
      throw new Error('Listener probe is not installed');
    }
    return api.pendingLongTimers();
  });
}
