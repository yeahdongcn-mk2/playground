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
import type {
  ZhenShaDebugApi,
  ZhenShaDebugState,
  ZhenShaDebugWindow,
} from './debug';
import {
  formatSettlementElapsed,
  SETTLEMENT_HEIGHT,
  SETTLEMENT_WIDTH,
  type ZhenShaSettlement,
} from './settlement';

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

interface QuadraticCurveCall {
  readonly controlX: number;
  readonly controlY: number;
  readonly x: number;
  readonly y: number;
}

interface FakeContext {
  readonly calls: string[];
  readonly quadraticCurves: QuadraticCurveCall[];
  /** Every string passed to fillText, so the seal readout can be asserted. */
  readonly texts: string[];
  /** `strokeStyle` captured at each `stroke()` call, in call order. */
  readonly strokeStyles: string[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save: () => void;
  restore: () => void;
  scale: () => void;
  clearRect: () => void;
  fillRect: () => void;
  strokeRect: () => void;
  beginPath: () => void;
  arc: () => void;
  fill: () => void;
  stroke: () => void;
  closePath: () => void;
  moveTo: () => void;
  lineTo: () => void;
  quadraticCurveTo: (controlX: number, controlY: number, x: number, y: number) => void;
  fillText: (text: string) => void;
}

/** Minimal 2D context stub: records every call so the test can prove drawing ran. */
function createFakeContext(): FakeContext {
  const calls: string[] = [];
  const quadraticCurves: QuadraticCurveCall[] = [];
  const texts: string[] = [];
  const strokeStyles: string[] = [];
  const record =
    (name: string) =>
    (): void => {
      calls.push(name);
    };
  const context: FakeContext = {
    calls,
    quadraticCurves,
    texts,
    strokeStyles,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: record('save'),
    restore: record('restore'),
    scale: record('scale'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: () => {
      calls.push('stroke');
      strokeStyles.push(context.strokeStyle);
    },
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    quadraticCurveTo: (controlX, controlY, x, y) => {
      calls.push('quadraticCurveTo');
      quadraticCurves.push({ controlX, controlY, x, y });
    },
    fillText: (value: string): void => {
      calls.push('fillText');
      texts.push(value);
    },
  };
  return context;
}

const canvasContexts = new WeakMap<HTMLCanvasElement, FakeContext>();

/** One fake 2D context per canvas, so a test can tell the seal from the scene. */
function contextFor(canvas: HTMLCanvasElement): FakeContext {
  let context = canvasContexts.get(canvas);
  if (context === undefined) {
    context = createFakeContext();
    canvasContexts.set(canvas, context);
  }
  return context;
}

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
  const root = document.createElement('div');
  document.body.append(root);
  const handle = mountZhenSha(root, createServices(), signal);
  const canvas = required<HTMLCanvasElement>(root, '[data-testid="zhen-sha-canvas"]');
  const view: MountedView = {
    root,
    stage: required<HTMLElement>(root, '[data-testid="zhen-sha-stage"]'),
    canvas,
    handle,
    context: contextFor(canvas),
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

/** Debug state plus the settlement this view adds to the shared debug seam. */
interface TestDebugState extends ZhenShaDebugState {
  readonly settlement: ZhenShaSettlement | null;
}

interface TestDebugApi extends ZhenShaDebugApi {
  readonly getState: () => TestDebugState;
}

function debugApi(): TestDebugApi | undefined {
  return (window as unknown as ZhenShaDebugWindow).__playground as TestDebugApi | undefined;
}

/** Mount with the `?debug=1` hash route, which pauses the frame loop. */
function mountDebugView(signal: AbortSignal = new AbortController().signal): MountedView {
  window.location.hash = '#/games/zhen-sha?debug=1';
  return mountView(signal);
}

/**
 * The fixed win sequence used by both the jsdom tests and the Playwright e2e:
 * three perfect taps at impact ticks 180 / 360 / 540, then charge + strike in
 * the break. Every tap resolves on its tick, so no real frame timing leaks in.
 */
const WIN_EVENT_STEPS = [180, 360, 540, 540, 542, 542] as const;

function playWin(api: TestDebugApi): TestDebugState {
  api.step(FIRST_TELEGRAPH_TICKS);
  api.input('block');
  api.step(1);
  api.step(TELEGRAPH_TICKS + RECOVERY_TICKS - 1);
  api.input('block');
  api.step(1);
  api.step(TELEGRAPH_TICKS + RECOVERY_TICKS - 1);
  api.input('block');
  api.step(1);
  api.input('charge');
  api.step(1);
  api.input('strike');
  api.step(1);
  return api.getState();
}

function overlay(): HTMLElement {
  if (mounted === null) {
    throw new Error('no mounted view');
  }
  return required<HTMLElement>(mounted.root, '[data-testid="overlay"]');
}

function settlementCanvas(): HTMLCanvasElement {
  if (mounted === null) {
    throw new Error('no mounted view');
  }
  return required<HTMLCanvasElement>(mounted.root, '[data-testid="settlement-canvas"]');
}

/** The 2D context of the settlement canvas, distinct from the scene canvas. */
function sealContext(): FakeContext {
  return contextFor(settlementCanvas());
}

/**
 * Stub the browser download primitives so clicking the save button can be
 * observed without a real canvas encoder or navigation. jsdom has no
 * createObjectURL, so both URL methods are installed and restored here.
 */
function installDownloadHarness(
  options: { readonly blob?: Blob | null; readonly dataUrl?: string } = {},
) {
  const canvases: HTMLCanvasElement[] = [];
  const anchors: HTMLAnchorElement[] = [];
  const blobs: Blob[] = [];

  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback, type?: string) {
      canvases.push(this);
      const blob =
        options.blob === undefined
          ? new Blob(['seal'], { type: type ?? 'image/png' })
          : options.blob;
      callback(blob);
    });
  const toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return options.dataUrl ?? 'data:image/png;base64,iVBORw0KGgo=';
    });

  const previousCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const previousRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const createObjectURL = vi.fn((blob: Blob): string => {
    blobs.push(blob);
    return 'blob:zhen-sha-seal';
  });
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });

  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });

  return {
    canvases,
    anchors,
    blobs,
    toBlob,
    toDataURL,
    createObjectURL,
    revokeObjectURL,
    restore: () => {
      click.mockRestore();
      toBlob.mockRestore();
      toDataURL.mockRestore();
      if (previousCreate === undefined) {
        Reflect.deleteProperty(URL, 'createObjectURL');
      } else {
        Object.defineProperty(URL, 'createObjectURL', previousCreate);
      }
      if (previousRevoke === undefined) {
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      } else {
        Object.defineProperty(URL, 'revokeObjectURL', previousRevoke);
      }
    },
  };
}

function saveSealButton(): HTMLButtonElement {
  if (mounted === null) {
    throw new Error('no mounted view');
  }
  return required<HTMLButtonElement>(mounted.root, '[data-testid="overlay-save-seal"]');
}

function unmountView(view: MountedView): void {
  view.handle.destroy();
  view.root.remove();
  if (mounted === view) {
    mounted = null;
  }
}

/**
 * Flash strokes are the only ones drawn in this gold, so their presence proves
 * a flash effect survived the step and reached the canvas.
 */
function goldFlashStrokes(context: FakeContext, from = 0): string[] {
  return context.strokeStyles
    .slice(from)
    .filter((style) => style.startsWith('rgba(255, 233, 168,'));
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

/** The most recent quadraticCurveTo call belonging to the staff arc. */
function latestStaffArc(context: FakeContext): QuadraticCurveCall {
  const call = context.quadraticCurves.findLast(
    (curve) => curve.controlX === 178 && curve.x === 318,
  );
  if (call === undefined) {
    throw new Error('the staff arc was not stroked on the canvas');
  }
  return call;
}

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement) {
      return contextFor(this);
    },
  });
  installFrameStub();
  installPointerEventFallback();
});

afterEach(() => {
  mounted?.handle.destroy();
  mounted?.root.remove();
  mounted = null;
  delete (window as unknown as ZhenShaDebugWindow).__playground;
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

  it('lifts the CSS gold edge and the canvas arc by the same amount while charging', () => {
    const view = mountView();
    primeLoop();

    // The CSS gold edge is a class toggle; the polygon geometry lives in
    // zhen-sha.css and is locked by marks.test.ts. These literals are the
    // staff arc's anchors in the 360x560 logical canvas.
    const [controlY, endY, lift, endLiftRatio] = [420, 456, 34, 0.4];
    expect(view.stage.classList.contains('is-arc-lifted')).toBe(false);
    const restingArc = latestStaffArc(view.context);
    expect(restingArc.controlY).toBe(controlY);
    expect(restingArc.y).toBe(endY);

    view.stage.dispatchEvent(pointerEvent('pointerdown'));
    advanceMs(250);

    expect(view.stage.classList.contains('is-arc-lifted')).toBe(true);

    // The recorded quadraticCurveTo arguments prove the canvas applies the
    // lift to both anchors; removing `- lift` or `- lift * ratio` from
    // drawStaff fails here instead of only changing pixels.
    const chargingArc = latestStaffArc(view.context);
    expect(chargingArc.controlY).toBe(controlY - lift);
    expect(chargingArc.y).toBe(endY - lift * endLiftRatio);

    view.stage.dispatchEvent(pointerEvent('pointerup'));
    advanceMs(1000);
    expect(view.stage.classList.contains('is-arc-lifted')).toBe(false);
    const settledArc = latestStaffArc(view.context);
    expect(settledArc.controlY).toBe(controlY);
    expect(settledArc.y).toBe(endY);
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

describe('zhen-sha settlement', () => {
  it('shows the battle seal on a win with the same numbers as the snapshot and events', () => {
    const view = mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    const state = playWin(api);

    expect(state.status).toBe('won');
    expect(state.perfects).toBe(3);
    expect(state.score).toBe(1900);
    expect(state.elapsedMs).toBeCloseTo(543 * FIXED_STEP_MS, 9);
    expect(state.boss).toEqual({ name: '黑煞', phase: 1, guard: 'broken' });

    const settlement = state.settlement;
    expect(settlement).not.toBeNull();
    if (settlement === null) {
      return;
    }
    // The settlement is a projection of this snapshot and this event order.
    expect(settlement.perfects).toBe(state.perfects);
    expect(settlement.elapsedMs).toBe(state.elapsedMs);
    expect(settlement.boss).toEqual({ name: state.boss.name, phase: state.boss.phase });
    expect(settlement.slashes.map((slash) => slash.step)).toEqual([...WIN_EVENT_STEPS]);

    expect(overlay().hidden).toBe(false);
    expect(text('settlement-perfects')).toBe('3');
    expect(text('settlement-elapsed')).toBe(formatSettlementElapsed(state.elapsedMs));
    expect(text('settlement-elapsed')).toBe('4.5s');
    expect(text('settlement-slashes')).toBe('6 道');
    expect(text('settlement-boss')).toBe('黑煞 · 第 1 阶段');
    expect(text('overlay-title')).toBe('一棍定魂');

    // The seal canvas was painted once, with the original seal face and the
    // snapshot-derived readout.
    expect(settlementCanvas().dataset.stamps).toBe('1');
    // The seal has its own canvas/context; painting it on the scene canvas would
    // bump the stamp counter but leave the visible preview blank.
    expect(sealContext().texts).toContain('镇');
    expect(sealContext().texts).toContain('煞');
    expect(sealContext().texts).toContain('完美 3 次');
    expect(sealContext().texts).toContain('用时 4.5s');
    expect(sealContext().texts).toContain('黑煞 · 第 1 阶段');
    expect(view.context).not.toBe(sealContext());
  });

  it('stamps the settlement once and never regenerates it on later frames', () => {
    mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    const settlement = playWin(api).settlement;
    expect(settlement).not.toBeNull();

    const seal = sealContext();
    const textCalls = seal.texts.length;
    const fillCalls = seal.calls.filter((call) => call === 'fillRect').length;
    api.step(12);

    expect(api.getState().settlement).toBe(settlement);
    expect(settlementCanvas().dataset.stamps).toBe('1');
    expect(seal.texts.length).toBe(textCalls);
    expect(seal.calls.filter((call) => call === 'fillRect').length).toBe(fillCalls);
    expect(overlay().hidden).toBe(false);
    expect(text('settlement-perfects')).toBe('3');
  });

  it('keeps the stamp counter on the seal canvas, not the settlement card', () => {
    mountDebugView();

    expect(settlementCanvas().dataset.stamps).toBe('0');
    const card = required<HTMLElement>(mounted!.root, '[data-testid="settlement"]');
    expect(card.hasAttribute('data-stamps')).toBe(false);
  });

  it('saves the settled seal as a 1080x1440 PNG and releases the object URL', async () => {
    mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    const save = saveSealButton();
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');

    const harness = installDownloadHarness();
    try {
      // With no settlement there is nothing to export.
      save.click();
      await Promise.resolve();
      expect(harness.canvases).toHaveLength(0);

      playWin(api);
      save.click();
      await vi.waitFor(() => expect(harness.anchors).toHaveLength(1));

      const [exportCanvas] = harness.canvases;
      expect(exportCanvas?.width).toBe(SETTLEMENT_WIDTH);
      expect(exportCanvas?.height).toBe(SETTLEMENT_HEIGHT);

      const [anchor] = harness.anchors;
      expect(anchor?.download).toMatch(/^zhen-sha-seal-\d+\.png$/);
      expect(anchor?.getAttribute('href')).toBe('blob:zhen-sha-seal');
      expect(anchor?.isConnected).toBe(false);

      expect(harness.createObjectURL).toHaveBeenCalledTimes(1);
      // The download helper releases the object URL on the next macrotask so
      // WebKit/Firefox can still read the blob after the synthetic click.
      await vi.waitFor(() => expect(harness.revokeObjectURL).toHaveBeenCalledTimes(1));
      expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:zhen-sha-seal');
      expect(harness.blobs[0]).toBeInstanceOf(Blob);
      // The seal export never needs a data URL when toBlob works, and it never
      // reaches the network.
      expect(harness.toDataURL).not.toHaveBeenCalled();
      expect(xhrOpen).not.toHaveBeenCalled();

      expect(save.hasAttribute('aria-disabled')).toBe(false);
      expect(save.hasAttribute('aria-busy')).toBe(false);
      expect(text('announcer')).toBe('战绩符已保存');
    } finally {
      harness.restore();
    }
  });

  it('falls back to toDataURL when the canvas cannot encode a blob', async () => {
    mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    playWin(api);

    const harness = installDownloadHarness({
      blob: null,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
    try {
      saveSealButton().click();
      await vi.waitFor(() => expect(harness.anchors).toHaveLength(1));

      expect(harness.toBlob).toHaveBeenCalledTimes(1);
      expect(harness.toDataURL).toHaveBeenCalledTimes(1);
      expect(harness.anchors[0]?.download).toMatch(/^zhen-sha-seal-\d+\.png$/);
      expect(harness.blobs[0]?.type).toBe('image/png');
      await vi.waitFor(() => expect(harness.revokeObjectURL).toHaveBeenCalledTimes(1));
    } finally {
      harness.restore();
    }
  });

  it('announces a failed save and restores the button', async () => {
    mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    playWin(api);

    const harness = installDownloadHarness();
    harness.createObjectURL.mockImplementation(() => {
      throw new Error('object URLs unavailable');
    });
    try {
      const save = saveSealButton();
      save.click();
      await vi.waitFor(() =>
        expect(text('announcer')).toBe('战绩符保存失败，请重试'),
      );

      expect(harness.anchors).toHaveLength(0);
      expect(save.hasAttribute('aria-disabled')).toBe(false);
      expect(save.hasAttribute('aria-busy')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('does not start a second download while one save is in flight', async () => {
    mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    playWin(api);

    let releaseBlob: (blob: Blob | null) => void = () => {};
    const harness = installDownloadHarness();
    harness.toBlob.mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      harness.canvases.push(this);
      releaseBlob = callback;
    });
    try {
      const save = saveSealButton();
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => expect(save.getAttribute('aria-disabled')).toBe('true'));
      releaseBlob(new Blob(['seal'], { type: 'image/png' }));
      await vi.waitFor(() => expect(harness.anchors).toHaveLength(1));
      expect(harness.createObjectURL).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(harness.revokeObjectURL).toHaveBeenCalledTimes(1));
    } finally {
      harness.restore();
    }
  });

  it('does not announce a save that finishes after a restart', async () => {
    mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    playWin(api);

    let releaseBlob: (blob: Blob | null) => void = () => {};
    const harness = installDownloadHarness();
    harness.toBlob.mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      harness.canvases.push(this);
      releaseBlob = callback;
    });
    try {
      const beforeRestart = text('announcer');
      saveSealButton().click();
      await vi.waitFor(() =>
        expect(saveSealButton().getAttribute('aria-busy')).toBe('true'),
      );

      required<HTMLButtonElement>(mounted!.root, '[data-testid="overlay-restart"]').click();
      releaseBlob(new Blob(['seal'], { type: 'image/png' }));
      await vi.waitFor(() => expect(harness.anchors).toHaveLength(1));

      // The old duel's completion must not overwrite the new duel's message.
      expect(beforeRestart).toBe('你赢了，一棍定魂');
      expect(text('announcer')).toBe(beforeRestart);
      expect(saveSealButton().hasAttribute('aria-busy')).toBe(false);
      expect(saveSealButton().hasAttribute('aria-disabled')).toBe(false);
      await vi.waitFor(() => expect(harness.revokeObjectURL).toHaveBeenCalledTimes(1));
    } finally {
      harness.restore();
    }
  });

  it('shows the defeat seal and restart clears it back to boss 1 phase 1', () => {
    mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }

    api.step(600);
    const lost = api.getState();
    expect(lost.status).toBe('lost');
    expect(lost.hits).toBe(MAX_HITS);
    expect(lost.perfects).toBe(0);
    expect(lost.boss).toEqual({ name: '黑煞', phase: 1, guard: 'up' });
    expect(lost.settlement?.slashes).toHaveLength(4);
    expect(lost.settlement?.perfects).toBe(lost.perfects);
    expect(lost.settlement?.elapsedMs).toBe(lost.elapsedMs);

    expect(overlay().hidden).toBe(false);
    expect(text('overlay-title')).toBe('被黑煞击倒');
    expect(text('settlement-perfects')).toBe('0');
    expect(text('settlement-elapsed')).toBe('5.0s');
    expect(text('settlement-slashes')).toBe('4 道');
    expect(text('settlement-boss')).toBe('黑煞 · 第 1 阶段');
    expect(settlementCanvas().dataset.stamps).toBe('1');

    required<HTMLButtonElement>(mounted!.root, '[data-testid="overlay-restart"]').click();
    const reset = api.getState();
    expect(reset.status).toBe('playing');
    expect(reset.step).toBe(0);
    expect(reset.settlement).toBeNull();
    expect(reset.boss).toEqual({ name: '黑煞', phase: 1, guard: 'up' });
    expect(overlay().hidden).toBe(true);
    expect(settlementCanvas().dataset.stamps).toBe('0');

    // A second duel stamps once from scratch; the old six arcs never stack.
    const won = playWin(api);
    expect(won.status).toBe('won');
    expect(won.settlement?.slashes).toHaveLength(6);
    expect(settlementCanvas().dataset.stamps).toBe('1');
    expect(text('settlement-slashes')).toBe('6 道');

    required<HTMLButtonElement>(mounted!.root, '[data-testid="restart-button"]').click();
    expect(api.getState().status).toBe('playing');
    expect(api.getState().settlement).toBeNull();
  });

  it('remounts a fresh duel after the settlement returns to the lobby', () => {
    const first = mountDebugView();
    const api = debugApi();
    if (api === undefined) {
      throw new Error('the debug seam should be installed');
    }
    playWin(api);
    expect(first.root.querySelector('[data-testid="settlement"]')).not.toBeNull();

    // The shell unmounts the game on the route change; mirror that teardown.
    first.handle.destroy();
    first.root.remove();
    mounted = null;
    window.location.hash = '#/';
    expect(debugApi()).toBeUndefined();

    const second = mountDebugView();
    const fresh = debugApi();
    if (fresh === undefined) {
      throw new Error('the debug seam should be reinstalled on re-entry');
    }
    const state = fresh.getState();
    expect(state.status).toBe('playing');
    expect(state.step).toBe(0);
    expect(state.settlement).toBeNull();
    expect(state.boss).toEqual({ name: '黑煞', phase: 1, guard: 'up' });
    expect(required<HTMLElement>(second.root, '[data-testid="overlay"]').hidden).toBe(true);
  });

  it('exposes the settlement only through the debug seam and removes it on destroy', () => {
    window.location.hash = '#/games/zhen-sha';
    const normal = mountView();
    expect(debugApi()).toBeUndefined();
    normal.handle.destroy();
    normal.root.remove();
    mounted = null;

    const debugView = mountDebugView();
    const api = debugApi();
    expect(api).toBeDefined();
    expect(api?.getState().settlement).toBeNull();

    api?.destroy();
    expect(debugApi()).toBeUndefined();
    debugView.root.remove();
    mounted = null;
  });
});

describe('zhen-sha debug seam', () => {
  it('stays off on a normal entry and leaves the wall-clock loop running', () => {
    window.location.hash = '#/games/zhen-sha';
    mountView();
    primeLoop();

    expect(debugApi()).toBeUndefined();
    expect(pendingFrames.size).toBe(1);
  });

  it('does not start rAF and replays the same seed + inputs deterministically', () => {
    window.location.hash =
      '#/games/zhen-sha?debug=1&seed=7&inputs=block@180,block@360,block@540,charge@541,strike@542';
    const first = mountView();
    const api = debugApi();
    expect(api?.gameId).toBe('zhen-sha');
    expect(pendingFrames.size).toBe(0);

    api!.step(543);
    const replay = api!.getState();
    expect(replay).toMatchObject({
      seed: 7,
      status: 'won',
      perfects: 3,
      score: 1900,
    });
    expect(text('status')).toBe('胜利');
    expect(text('perfects')).toBe('3');
    expect(text('score')).toBe('1900');
    expect(required<HTMLElement>(first.root, '[data-testid="overlay"]').hidden).toBe(false);

    // Restart re-arms the URL schedule, so the same run can be replayed again.
    api!.restart();
    expect(api!.getState()).toMatchObject({ status: 'playing', perfects: 0, score: 0 });
    api!.step(543);
    expect(api!.getState()).toEqual(replay);

    unmountView(first);
    const second = mountView();
    const callsBefore = second.context.calls.length;
    const strokesBefore = second.context.strokeStyles.length;
    debugApi()!.step(543);
    expect(debugApi()!.getState()).toEqual(replay);
    // The step must render synchronously, and the winning flash raised on the
    // last tick must still be drawn instead of being aged out by all 543 ticks.
    expect(second.context.calls.length).toBeGreaterThan(callsBefore);
    expect(goldFlashStrokes(second.context, strokesBefore).length).toBeGreaterThan(0);
  });

  it('ages the flash from its event tick instead of the whole step span', () => {
    window.location.hash = '#/games/zhen-sha?debug=1&inputs=block@180';
    const view = mountView();
    const api = debugApi()!;

    // One call spans 181 ticks but the perfect parry lands on the last one, so
    // its flash must be almost full rather than already expired.
    api.step(181);
    expect(api.getState()).toMatchObject({ status: 'playing', perfects: 1 });
    expect(goldFlashStrokes(view.context).length).toBeGreaterThan(0);

    const strokesBeforeDecay = view.context.strokeStyles.length;
    api.step(60);
    expect(goldFlashStrokes(view.context, strokesBeforeDecay)).toHaveLength(0);
  });

  it('steps 180 ticks then lands three blocks and the 541/542 finisher', () => {
    window.location.hash = '#/games/zhen-sha?debug=1&seed=9';
    mountView();
    const api = debugApi()!;

    api.step(180);
    api.input('block');
    api.step(180);
    api.input('block');
    api.step(180);
    api.input('block');
    api.step(1);
    expect(api.getState()).toMatchObject({ perfects: 3, score: 900 });
    expect(api.getState().breakTicksLeft).toBeGreaterThan(0);

    api.input('charge', 541);
    api.step(1);
    api.input('strike', 542);
    api.step(1);

    expect(api.getState()).toMatchObject({
      seed: 9,
      status: 'won',
      perfects: 3,
      score: 1900,
      step: 543,
    });
  });

  it('edges a held press by fixed steps so tick 27 charges it', () => {
    window.location.hash = '#/games/zhen-sha?debug=1&inputs=block@180,block@360,block@540';
    const view = mountView();
    const api = debugApi()!;
    api.step(541);
    expect(api.getState().breakTicksLeft).toBeGreaterThan(0);

    view.stage.dispatchEvent(pointerEvent('pointerdown'));
    api.step(26);
    expect(api.getState().charging).toBe(false);
    api.step(1);
    expect(api.getState().charging).toBe(true);

    view.stage.dispatchEvent(pointerEvent('pointerup'));
    api.step(1);
    expect(api.getState()).toMatchObject({ status: 'won', charging: false, score: 1900 });
  });

  it('loses after 600 input-free fixed ticks', () => {
    window.location.hash = '#/games/zhen-sha?debug=1';
    mountView();
    const api = debugApi()!;

    api.step(600);

    expect(api.getState()).toMatchObject({ status: 'lost', hits: MAX_HITS, seed: 1 });
    expect(text('status')).toBe('失败');
    expect(text('hits')).toBe(`3 / ${MAX_HITS}`);
  });

  it('removes __playground and the exact listeners on destroy', () => {
    window.location.hash = '#/games/zhen-sha?debug=1';
    const log = recordListenerCalls();
    const view = mountView();
    expect(debugApi()?.gameId).toBe('zhen-sha');

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

    view.handle.destroy();
    view.handle.destroy();

    expect(debugApi()).toBeUndefined();
    expectTrackedListenersRemoved(log, expected);
  });

  it('removes __playground when the mount signal aborts', () => {
    window.location.hash = '#/games/zhen-sha?debug=1';
    const controller = new AbortController();
    mountView(controller.signal);
    expect(debugApi()?.gameId).toBe('zhen-sha');

    controller.abort();

    expect(debugApi()).toBeUndefined();
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
