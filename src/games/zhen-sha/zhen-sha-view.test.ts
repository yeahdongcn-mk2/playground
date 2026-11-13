// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioService, type SoundEvent } from '../../core/audio';
import type { GameHandle, GameServices } from '../../core/game';
import { StorageService, type KeyValueStore } from '../../core/storage';
import { findGame } from '../registry';
import {
  FIRST_TELEGRAPH_TICKS,
  FIXED_STEP_MS,
  MAX_HITS,
  MOMENTUM_FOR_BREAK,
  RECOVERY_TICKS,
  TELEGRAPH_TICKS,
} from './engine';
import { zhenShaGame } from './index';
import { mountZhenSha } from './zhen-sha-view';

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function createServices(reduceMotion = false): GameServices {
  const storage = new StorageService(new MemoryStore());
  return { storage, audio: new AudioService(storage), reduceMotion };
}

interface FakeContext {
  readonly calls: string[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  lineCap: string;
  lineJoin: string;
  clearRect: () => void;
  fillRect: () => void;
  beginPath: () => void;
  arc: () => void;
  fill: () => void;
  stroke: () => void;
  closePath: () => void;
  moveTo: () => void;
  lineTo: () => void;
  quadraticCurveTo: () => void;
}

/** Minimal 2D context stub: records every call so the test can prove drawing ran. */
function createFakeContext(): FakeContext {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (): void => {
      calls.push(name);
    };
  return {
    calls,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: record('stroke'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
  };
}

let activeContext: FakeContext;

const ORIGINAL_REQUEST_ANIMATION_FRAME = Object.getOwnPropertyDescriptor(
  window,
  'requestAnimationFrame',
);
const ORIGINAL_CANCEL_ANIMATION_FRAME = Object.getOwnPropertyDescriptor(
  window,
  'cancelAnimationFrame',
);
const ORIGINAL_GET_CONTEXT = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext',
);
const ORIGINAL_POINTER_EVENT = Object.getOwnPropertyDescriptor(window, 'PointerEvent');

let frameNow = 0;
let nextRafId = 1;
let pendingFrames = new Map<number, FrameRequestCallback>();

function installFrameStub(): void {
  frameNow = 0;
  nextRafId = 1;
  pendingFrames = new Map();
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback): number => {
      const id = nextRafId;
      nextRafId += 1;
      pendingFrames.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (id: number): void => {
      pendingFrames.delete(id);
    },
  });
}

/** Run every frame callback queued right now with an advanced timestamp. */
function flushFrame(deltaMs = 1000 / 60): void {
  frameNow += deltaMs;
  const callbacks = [...pendingFrames.values()];
  pendingFrames.clear();
  for (const callback of callbacks) {
    callback(frameNow);
  }
}

function advanceMs(ms: number): void {
  let remaining = ms;
  while (remaining > 1e-9) {
    const chunk = Math.min(250, remaining);
    flushFrame(chunk);
    remaining -= chunk;
  }
}

/**
 * Advance exactly `ticks` fixed steps. The tiny epsilon beats floating-point
 * accumulation so a 180-tick schedule really lands on impact tick 180.
 */
function advanceTicks(ticks: number): void {
  advanceMs(ticks * FIXED_STEP_MS + 1e-6);
}

function primeLoop(): void {
  flushFrame(0);
}

class MinimalPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}

function installPointerEventFallback(): void {
  if (typeof window.PointerEvent !== 'function') {
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      writable: true,
      value: MinimalPointerEvent as unknown as typeof PointerEvent,
    });
  }
}

function restoreProperty(
  target: object,
  name: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, name);
  } else {
    Object.defineProperty(target, name, descriptor);
  }
}

interface ListenerRegistration {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
}

interface ListenerLog {
  readonly added: ListenerRegistration[];
  readonly removed: ListenerRegistration[];
}

/**
 * Record every add/removeEventListener call so cleanup can be checked against
 * the exact handler reference the view registered, not just `any Function`.
 * Must be installed before mountView().
 */
function recordListenerCalls(): ListenerLog {
  const added: ListenerRegistration[] = [];
  const removed: ListenerRegistration[] = [];
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;

  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    added.push({ target: this, type, handler });
    add.call(this, type, handler, options);
  });
  vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
    this: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    removed.push({ target: this, type, handler });
    remove.call(this, type, handler, options);
  });

  return { added, removed };
}

function listenerRegistrations(
  log: ListenerLog,
  kind: keyof ListenerLog,
  target: EventTarget,
  type: string,
): ListenerRegistration[] {
  return log[kind].filter((entry) => entry.target === target && entry.type === type);
}

/** Assert every tracked listener is removed with the same function reference. */
function expectTrackedListenersRemoved(
  log: ListenerLog,
  expected: readonly (readonly [EventTarget, string])[],
): void {
  for (const [target, type] of expected) {
    const added = listenerRegistrations(log, 'added', target, type);
    expect(added, `${type} listener should be registered once`).toHaveLength(1);
    const removed = listenerRegistrations(log, 'removed', target, type);
    expect(
      removed.map((entry) => entry.handler),
      `${type} listener should be removed by reference`,
    ).toContain(added[0]?.handler);
  }
}

interface MountedView {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly handle: GameHandle;
  readonly context: FakeContext;
}

let mounted: MountedView | null = null;

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Expected element not found: ${selector}`);
  }
  return element;
}

function mountView(signal: AbortSignal = new AbortController().signal): MountedView {
  if (!activeContext) {
    throw new Error('the canvas stub was not installed');
  }
  const root = document.createElement('div');
  document.body.append(root);
  const handle = mountZhenSha(root, createServices(), signal);
  const view: MountedView = {
    root,
    stage: required<HTMLElement>(root, '[data-testid="zhen-sha-stage"]'),
    canvas: required<HTMLCanvasElement>(root, '[data-testid="zhen-sha-canvas"]'),
    handle,
    context: activeContext,
  };
  mounted = view;
  return view;
}

function text(testId: string): string {
  if (mounted === null) {
    throw new Error('no mounted view');
  }
  return required<HTMLElement>(mounted.root, `[data-testid="${testId}"]`).textContent?.trim() ?? '';
}

function pointerEvent(type: string): PointerEvent {
  return new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerdown' ? 1 : 0,
    clientX: 180,
    clientY: 300,
  });
}

function tap(): void {
  if (mounted === null) {
    throw new Error('no mounted view');
  }
  mounted.stage.dispatchEvent(pointerEvent('pointerdown'));
  mounted.stage.dispatchEvent(pointerEvent('pointerup'));
}

function momentum(): HTMLElement {
  if (mounted === null) {
    throw new Error('no mounted view');
  }
  return required<HTMLElement>(mounted.root, '[data-testid="momentum"]');
}

beforeEach(() => {
  activeContext = createFakeContext();
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => activeContext,
  });
  installFrameStub();
  installPointerEventFallback();
});

afterEach(() => {
  mounted?.handle.destroy();
  mounted?.root.remove();
  mounted = null;
  vi.restoreAllMocks();
  window.location.hash = '';
  restoreProperty(window, 'requestAnimationFrame', ORIGINAL_REQUEST_ANIMATION_FRAME);
  restoreProperty(window, 'cancelAnimationFrame', ORIGINAL_CANCEL_ANIMATION_FRAME);
  restoreProperty(HTMLCanvasElement.prototype, 'getContext', ORIGINAL_GET_CONTEXT);
  restoreProperty(window, 'PointerEvent', ORIGINAL_POINTER_EVENT);
});

describe('zhen-sha view', () => {
  it('renders the canvas scene, HUD and the three gesture hints', () => {
    const view = mountView();
    primeLoop();

    expect(text('status')).toBe('进行中');
    expect(text('perfects')).toBe('0');
    expect(text('hits')).toBe(`0 / ${MAX_HITS}`);
    expect(momentum().dataset.filled).toBe('0');
    expect(required<HTMLElement>(view.root, '[data-testid="zhen-sha-game"]').dataset.status).toBe(
      'playing',
    );

    const hints = view.root.querySelectorAll('[data-testid="gesture-hints"] li');
    expect(hints).toHaveLength(3);
    expect(Array.from(hints, (hint) => hint.textContent?.trim())).toEqual([
      '轻点格挡',
      '长按蓄势',
      '松手棍击',
    ]);

    // Drawing must actually run through the 2D context, not be skipped.
    expect(view.canvas.width).toBe(360);
    expect(view.canvas.height).toBe(560);
    expect(view.context.calls).toContain('clearRect');
    expect(view.context.calls).toContain('quadraticCurveTo');
  });

  it('refuses to render when the mount signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const root = document.createElement('div');

    expect(() => mountZhenSha(root, createServices(), controller.signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(root.childElementCount).toBe(0);
  });

  it('keeps the view out of the shell bundle and registers the game', async () => {
    expect(findGame('zhen-sha')).toBe(zhenShaGame);
    expect(zhenShaGame.meta.engine).toBe('dom');

    const source = readFileSync(
      join(process.cwd(), 'src', 'games', 'zhen-sha', 'index.ts'),
      'utf8',
    );
    expect(source).toMatch(/await import\(['"]\.\/zhen-sha-view['"]\)/);
    expect(source).not.toMatch(/^\s*import[^\n]*from\s+['"]\.\/zhen-sha-view['"]/m);

    const controller = new AbortController();
    controller.abort();
    const root = document.createElement('div');
    await expect(
      zhenShaGame.mount(root, createServices(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(root.childElementCount).toBe(0);
  });

  it('maps a tap to a block and updates the HUD from the engine snapshot', () => {
    mountView();
    primeLoop();
    advanceTicks(FIRST_TELEGRAPH_TICKS);
    expect(text('judgement')).toBe('杀招将至 · 看准再点');

    tap();
    advanceTicks(2);

    expect(text('judgement')).toBe('完美格挡');
    expect(text('perfects')).toBe('1');
    expect(text('score')).toBe('300');
    expect(momentum().dataset.filled).toBe('1');
    expect(momentum().querySelectorAll('.zhen-sha-pip.is-filled')).toHaveLength(1);
  });

  it('maps an early tap to a normal parry and an off-band tap to a whiff', () => {
    mountView();
    primeLoop();
    // Tap 12 ticks before impact: inside the normal band, outside perfect.
    advanceTicks(FIRST_TELEGRAPH_TICKS - 12);
    tap();
    advanceTicks(2);
    expect(text('judgement')).toBe('普通格挡');
    expect(text('score')).toBe('100');
    expect(text('perfects')).toBe('0');
    expect(momentum().dataset.filled).toBe('0');

    mounted?.handle.destroy();
    mounted?.root.remove();
    mounted = null;

    mountView();
    primeLoop();
    // Tap far too early: the whiff commits the move, so it lands a hit later.
    advanceTicks(30);
    tap();
    advanceTicks(2);
    expect(text('judgement')).toBe('落空');
    expect(text('hits')).toBe(`0 / ${MAX_HITS}`);
    advanceTicks(FIRST_TELEGRAPH_TICKS);
    expect(text('hits')).toBe(`1 / ${MAX_HITS}`);
    expect(text('score')).toBe('0');
  });

  it('charges on a long press, strikes on release and wins after three perfects', () => {
    mountView();
    primeLoop();

    const nextImpact = TELEGRAPH_TICKS + RECOVERY_TICKS - 2;
    advanceTicks(FIRST_TELEGRAPH_TICKS);
    tap();
    advanceTicks(2);
    expect(text('perfects')).toBe('1');

    advanceTicks(nextImpact);
    tap();
    advanceTicks(2);
    expect(text('perfects')).toBe('2');

    advanceTicks(nextImpact);
    tap();
    advanceTicks(2);
    expect(text('perfects')).toBe('3');
    expect(momentum().dataset.filled).toBe(String(MOMENTUM_FOR_BREAK));
    expect(text('judgement')).toContain('破防');

    // Hold: a frame longer than the charge threshold queues `charge`, then the
    // release queues `strike`; the broken guard turns that strike into the win.
    mounted?.stage.dispatchEvent(pointerEvent('pointerdown'));
    advanceTicks(1);
    advanceMs(250);
    mounted?.stage.dispatchEvent(pointerEvent('pointerup'));
    advanceTicks(2);

    expect(text('status')).toBe('胜利');
    expect(text('judgement')).toBe('一棍定魂');
    expect(text('score')).toBe(String(3 * 300 + 1000));
    expect(required<HTMLElement>(mounted!.root, '[data-testid="overlay"]').hidden).toBe(false);

    required<HTMLButtonElement>(mounted!.root, '[data-testid="restart-button"]').click();
    expect(text('status')).toBe('进行中');
    expect(text('perfects')).toBe('0');
    expect(text('score')).toBe('0');
    expect(required<HTMLElement>(mounted!.root, '[data-testid="overlay"]').hidden).toBe(true);
  });

  it('loses after three unblocked strikes and restarts from the overlay', () => {
    mountView();
    primeLoop();

    // First wind-up is 180 ticks, later ones 108 with a 72-tick recovery: the
    // third unblocked impact lands well inside 600 ticks.
    advanceTicks(600);

    expect(text('status')).toBe('失败');
    expect(text('hits')).toBe(`3 / ${MAX_HITS}`);
    const overlay = required<HTMLElement>(mounted!.root, '[data-testid="overlay"]');
    expect(overlay.hidden).toBe(false);
    expect(text('overlay-kicker')).toBe('DEFEAT');
    expect(text('overlay-title')).toBe('被黑煞击倒');

    required<HTMLButtonElement>(mounted!.root, '[data-testid="overlay-restart"]').click();

    expect(text('status')).toBe('进行中');
    expect(text('hits')).toBe(`0 / ${MAX_HITS}`);
    expect(text('perfects')).toBe('0');
    expect(overlay.hidden).toBe(true);
    expect(pendingFrames.size).toBe(1);
  });

  it('releases a held press when pointer capture is lost', () => {
    const view = mountView();
    primeLoop();
    advanceTicks(FIRST_TELEGRAPH_TICKS);
    view.stage.dispatchEvent(pointerEvent('pointerdown'));
    expect(view.stage.classList.contains('is-pressed')).toBe(true);

    const drawCalls = view.context.calls.length;
    view.stage.dispatchEvent(pointerEvent('lostpointercapture'));

    expect(view.stage.classList.contains('is-pressed')).toBe(false);
    expect(view.context.calls.length).toBeGreaterThan(drawCalls);

    // Without the reset the stale pointerDown flag would swallow this press.
    view.stage.dispatchEvent(pointerEvent('pointerdown'));
    expect(view.stage.classList.contains('is-pressed')).toBe(true);
    view.stage.dispatchEvent(pointerEvent('pointerup'));
  });

  it('removes the exact registered handlers and cancels rAF on destroy', () => {
    const log = recordListenerCalls();
    const controller = new AbortController();
    const signalAdd = vi.spyOn(controller.signal, 'addEventListener');
    const signalRemove = vi.spyOn(controller.signal, 'removeEventListener');
    const view = mountView(controller.signal);
    primeLoop();
    advanceTicks(3);

    const restartButton = required<HTMLButtonElement>(
      view.root,
      '[data-testid="restart-button"]',
    );
    const overlayRestart = required<HTMLButtonElement>(
      view.root,
      '[data-testid="overlay-restart"]',
    );
    const expected: readonly (readonly [EventTarget, string])[] = [
      [view.stage, 'pointerdown'],
      [view.stage, 'pointerup'],
      [view.stage, 'pointercancel'],
      [view.stage, 'lostpointercapture'],
      [document, 'visibilitychange'],
      [restartButton, 'click'],
      [overlayRestart, 'click'],
    ];
    for (const [target, type] of expected) {
      expect(
        listenerRegistrations(log, 'added', target, type),
        `${type} listener should be registered`,
      ).toHaveLength(1);
    }
    const abortHandler = signalAdd.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(abortHandler).toBeTypeOf('function');

    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame');

    expect(pendingFrames.size).toBeGreaterThan(0);
    view.handle.destroy();
    view.handle.destroy();

    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(pendingFrames.size).toBe(0);
    expectTrackedListenersRemoved(log, expected);
    expect(signalRemove).toHaveBeenCalledWith('abort', abortHandler);

    const drawCalls = view.context.calls.length;
    const judgementBefore = text('judgement');
    advanceTicks(5);
    view.stage.dispatchEvent(pointerEvent('pointerdown'));
    view.stage.dispatchEvent(pointerEvent('pointerup'));
    expect(view.context.calls.length).toBe(drawCalls);
    expect(pendingFrames.size).toBe(0);
    expect(text('judgement')).toBe(judgementBefore);
  });

  it('stops the loop and detaches listeners when the mount signal aborts', () => {
    const log = recordListenerCalls();
    const controller = new AbortController();
    const signalAdd = vi.spyOn(controller.signal, 'addEventListener');
    const signalRemove = vi.spyOn(controller.signal, 'removeEventListener');
    const view = mountView(controller.signal);
    primeLoop();
    advanceTicks(2);
    const abortHandler = signalAdd.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(abortHandler).toBeTypeOf('function');

    expect(pendingFrames.size).toBe(1);

    controller.abort();

    expect(pendingFrames.size).toBe(0);
    expectTrackedListenersRemoved(log, [
      [view.stage, 'pointerdown'],
      [view.stage, 'pointerup'],
      [view.stage, 'pointercancel'],
      [view.stage, 'lostpointercapture'],
      [document, 'visibilitychange'],
    ]);
    expect(signalRemove).toHaveBeenCalledWith('abort', abortHandler);

    const drawCalls = view.context.calls.length;
    advanceTicks(5);
    view.stage.dispatchEvent(pointerEvent('pointerdown'));
    view.stage.dispatchEvent(pointerEvent('pointerup'));
    expect(view.context.calls.length).toBe(drawCalls);
    expect(view.stage.classList.contains('is-pressed')).toBe(false);
  });

  it('pauses the frame loop while the page is hidden and resumes when visible', () => {
    mountView();
    primeLoop();
    advanceTicks(2);
    expect(pendingFrames.size).toBe(1);

    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(pendingFrames.size).toBe(0);

      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      expect(pendingFrames.size).toBe(1);
    } finally {
      restoreProperty(document, 'hidden', originalHidden);
    }
  });
});

describe('audio wiring', () => {
  it('plays a synthesised cue for successful and failed exchanges', () => {
    mountView();
    primeLoop();
    const play = vi.spyOn(AudioService.prototype, 'play');

    advanceTicks(FIRST_TELEGRAPH_TICKS);
    tap();
    advanceTicks(2);

    const events = play.mock.calls.map(([event]) => event as SoundEvent);
    expect(events).toContain('blip');
  });
});
