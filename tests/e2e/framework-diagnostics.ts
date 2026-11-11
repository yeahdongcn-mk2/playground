import type { Page } from '@playwright/test';

/**
 * Diagnostics for the framework mobile blank-canvas tap case.
 *
 * The WebKit project occasionally misses the 3s position poll on a cold CI
 * start (issue #117), and a bare `Timeout 3000ms exceeded` does not tell us
 * whether the tap ever reached the canvas, whether the readout moved, or
 * whether the frame loop was running. A page-side probe installed with
 * `addInitScript` collects those facts, and the pure formatting logic below
 * turns them into one failure message that can be asserted from a unit test.
 */

export interface FrameworkTapProbeEvent {
  readonly x: number;
  readonly y: number;
  readonly target: string;
}

/** Counters the `addInitScript` probe keeps in the page. */
export interface FrameworkTapProbeSnapshot {
  /** `pointerdown` events seen anywhere in the document. */
  readonly pointerDown: number;
  /** `pointerdown` events whose target is inside the game canvas. */
  readonly canvasPointerDown: number;
  /** `touchstart` events seen anywhere in the document. */
  readonly touchStart: number;
  /** `touchstart` events whose target is inside the game canvas. */
  readonly canvasTouchStart: number;
  readonly click: number;
  readonly rafFrames: number;
  readonly lastPointerDown: FrameworkTapProbeEvent | null;
  readonly lastTouchStart: FrameworkTapProbeEvent | null;
}

export interface FrameworkTapReadout {
  readonly x: number;
  readonly y: number;
  readonly trail: number;
  readonly inputMode: string;
}

export interface FrameworkTapPageSnapshot {
  readonly readout: FrameworkTapReadout | null;
  readonly stageState: string | null;
  readonly visibility: string;
}

export interface FrameworkTapTarget {
  readonly viewportX: number;
  readonly viewportY: number;
  readonly localX: number;
  readonly localY: number;
  readonly tolerance: number;
}

export interface FrameworkTapCanvas {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FrameworkTapDiagnostics {
  readonly target: FrameworkTapTarget;
  readonly canvas: FrameworkTapCanvas;
  /** Readout captured just before the tap, used to tell "moved" from "stuck". */
  readonly baseline: FrameworkTapReadout | null;
  readonly page: FrameworkTapPageSnapshot;
  readonly probeBefore: FrameworkTapProbeSnapshot;
  readonly probeAfter: FrameworkTapProbeSnapshot;
  readonly elapsedMs: number;
  readonly tapError: string | null;
}

export type FrameworkTapVerdict =
  | 'settled'
  | 'tap-not-delivered'
  | 'readout-not-updated'
  | 'frame-loop-stalled'
  | 'position-mismatch'
  | 'readout-missing';

export interface FrameworkTapAssessment {
  readonly verdict: FrameworkTapVerdict;
  readonly tapDelivered: boolean;
  readonly readoutUpdated: boolean;
  readonly frameLoopAdvanced: boolean;
  readonly withinTolerance: boolean;
  /** Document-level `pointerdown` delta; includes taps outside the canvas. */
  readonly pointerDown: number;
  /** Document-level `touchstart` delta; includes taps outside the canvas. */
  readonly touchStart: number;
  /** `pointerdown` delta whose target was the game canvas. */
  readonly canvasPointerDown: number;
  /** `touchstart` delta whose target was the game canvas. */
  readonly canvasTouchStart: number;
  readonly frames: number;
}

interface FrameworkTapProbeApi {
  snapshot(): FrameworkTapProbeSnapshot;
}

interface FrameworkTapProbeWindow {
  __frameworkTapProbe?: FrameworkTapProbeApi;
}

/**
 * The probe body. It is kept as one exported, self-contained function because
 * `addInitScript` serializes it into the browser and because a unit test runs
 * the very same function in jsdom: a probe that silently stops counting must
 * fail a test instead of only producing a wrong failure message later.
 *
 * Counting listeners on `document` (capture phase) means the probe does not
 * have to race the asynchronously created canvas, and it still records whether
 * the event reached the canvas subtree. Every counter is kept twice: once for
 * the whole document (to see where a stray tap landed) and once for events
 * whose target is the canvas (the only ones that can move the readout).
 */
export function frameworkTapProbeInitScript(): void {
  type EventRecord = { x: number; y: number; target: string };

  let pointerDown = 0;
  let canvasPointerDown = 0;
  let touchStart = 0;
  let canvasTouchStart = 0;
  let click = 0;
  let rafFrames = 0;
  let lastPointerDown: EventRecord | null = null;
  let lastTouchStart: EventRecord | null = null;

  const describeTarget = (target: EventTarget | null): string => {
    if (target instanceof Element) {
      if (target.closest('canvas[data-testid="game-canvas"]')) {
        return 'game-canvas';
      }
      if (target.closest('[data-testid="blank-stage"]')) {
        return 'blank-stage';
      }
      return target.tagName.toLowerCase();
    }
    return target === null ? 'null' : String(target);
  };

  document.addEventListener(
    'pointerdown',
    (event) => {
      pointerDown += 1;
      const target = describeTarget(event.target);
      if (target === 'game-canvas') {
        canvasPointerDown += 1;
      }
      lastPointerDown = {
        x: event.clientX,
        y: event.clientY,
        target,
      };
    },
    true,
  );
  document.addEventListener(
    'touchstart',
    (event) => {
      touchStart += 1;
      const touch = event.touches[0] ?? event.changedTouches[0];
      const target = describeTarget(event.target);
      if (target === 'game-canvas') {
        canvasTouchStart += 1;
      }
      lastTouchStart = {
        x: touch?.clientX ?? -1,
        y: touch?.clientY ?? -1,
        target,
      };
    },
    true,
  );
  document.addEventListener(
    'click',
    () => {
      click += 1;
    },
    true,
  );

  // Phaser drives its loop through window.requestAnimationFrame. Wrapping it
  // is enough to tell a throttled/hidden page from a running loop; returning
  // the native id keeps cancelAnimationFrame working untouched.
  const nativeRequest = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = ((callback: FrameRequestCallback): number =>
    nativeRequest((time) => {
      rafFrames += 1;
      callback(time);
    })) as typeof window.requestAnimationFrame;

  Object.assign(window, {
    __frameworkTapProbe: {
      snapshot: (): FrameworkTapProbeSnapshot => ({
        pointerDown,
        canvasPointerDown,
        touchStart,
        canvasTouchStart,
        click,
        rafFrames,
        lastPointerDown,
        lastTouchStart,
      }),
    } satisfies FrameworkTapProbeApi,
  } satisfies FrameworkTapProbeWindow);
}

/** Install the tap/readout/frame probe before the first navigation. */
export async function installFrameworkTapProbe(page: Page): Promise<void> {
  await page.addInitScript(frameworkTapProbeInitScript);
}

/** Read the counters kept by `installFrameworkTapProbe`. */
export async function readFrameworkTapProbe(page: Page): Promise<FrameworkTapProbeSnapshot> {
  return page.evaluate(() => {
    const api = (window as unknown as FrameworkTapProbeWindow).__frameworkTapProbe;
    if (!api) {
      throw new Error('Framework tap probe is not installed');
    }
    return api.snapshot();
  });
}

/** Read the readout / stage / visibility state relevant to a failed tap. */
export async function readFrameworkTapPageSnapshot(page: Page): Promise<FrameworkTapPageSnapshot> {
  return page.evaluate(() => {
    const readout = document.querySelector('[data-testid="readout"]');
    const inputMode = document.querySelector('[data-testid="input-mode"]');
    const stage = document.querySelector('[data-testid="blank-stage"]');
    const numberAttribute = (element: Element, name: string): number => {
      const value = Number(element.getAttribute(name));
      return Number.isFinite(value) ? value : Number.NaN;
    };
    return {
      readout: readout
        ? {
            x: numberAttribute(readout, 'data-x'),
            y: numberAttribute(readout, 'data-y'),
            trail: numberAttribute(readout, 'data-trail'),
            inputMode: inputMode?.textContent?.trim() ?? '',
          }
        : null,
      stageState: stage?.getAttribute('data-state') ?? null,
      visibility: document.visibilityState,
    };
  });
}

export interface CollectFrameworkTapDiagnosticsInput {
  readonly target: FrameworkTapTarget;
  readonly canvas: FrameworkTapCanvas;
  readonly baseline: FrameworkTapReadout | null;
  readonly probeBefore: FrameworkTapProbeSnapshot;
  readonly elapsedMs: number;
  readonly tapError: string | null;
}

/** Collect everything a failure message needs after the tap poll gave up. */
export async function collectFrameworkTapDiagnostics(
  page: Page,
  input: CollectFrameworkTapDiagnosticsInput,
): Promise<FrameworkTapDiagnostics> {
  const [probeAfter, pageSnapshot] = await Promise.all([
    readFrameworkTapProbe(page),
    readFrameworkTapPageSnapshot(page),
  ]);
  return { ...input, probeAfter, page: pageSnapshot };
}

/** True when a readout is within `tolerance` of the tapped canvas point. */
export function isFrameworkTapSettled(
  readout: { readonly x: number; readonly y: number },
  target: FrameworkTapTarget,
): boolean {
  return (
    Math.abs(readout.x - target.localX) <= target.tolerance &&
    Math.abs(readout.y - target.localY) <= target.tolerance
  );
}

/** Classify a failed (or settled) tap from the collected evidence. */
export function assessFrameworkTapDiagnostics(
  diagnostics: FrameworkTapDiagnostics,
): FrameworkTapAssessment {
  const current = diagnostics.page.readout;
  const baseline = diagnostics.baseline;
  const pointerDown = Math.max(
    0,
    diagnostics.probeAfter.pointerDown - diagnostics.probeBefore.pointerDown,
  );
  const touchStart = Math.max(
    0,
    diagnostics.probeAfter.touchStart - diagnostics.probeBefore.touchStart,
  );
  const canvasPointerDown = Math.max(
    0,
    diagnostics.probeAfter.canvasPointerDown - diagnostics.probeBefore.canvasPointerDown,
  );
  const canvasTouchStart = Math.max(
    0,
    diagnostics.probeAfter.canvasTouchStart - diagnostics.probeBefore.canvasTouchStart,
  );
  const frames = Math.max(0, diagnostics.probeAfter.rafFrames - diagnostics.probeBefore.rafFrames);
  // A tap only counts as delivered when it reached the canvas: a document-level
  // hit on `blank-stage`/HUD cannot move the readout and must be reported as
  // "tap 没有送达 canvas", not as "readout 没有更新".
  const tapDelivered = canvasPointerDown > 0 || canvasTouchStart > 0;
  const readoutUpdated = Boolean(
    current && baseline && (current.x !== baseline.x || current.y !== baseline.y),
  );
  const withinTolerance = Boolean(current && isFrameworkTapSettled(current, diagnostics.target));
  const frameLoopAdvanced = frames > 0;

  let verdict: FrameworkTapVerdict;
  if (!current) {
    verdict = 'readout-missing';
  } else if (withinTolerance) {
    verdict = 'settled';
  } else if (!tapDelivered) {
    verdict = 'tap-not-delivered';
  } else if (!readoutUpdated) {
    verdict = frameLoopAdvanced ? 'readout-not-updated' : 'frame-loop-stalled';
  } else if (!frameLoopAdvanced) {
    verdict = 'frame-loop-stalled';
  } else {
    verdict = 'position-mismatch';
  }

  return {
    verdict,
    tapDelivered,
    readoutUpdated,
    frameLoopAdvanced,
    withinTolerance,
    pointerDown,
    touchStart,
    canvasPointerDown,
    canvasTouchStart,
    frames,
  };
}

const VERDICT_LABELS: Record<FrameworkTapVerdict, string> = {
  settled: 'readout 已停稳在 tap 目标容差内',
  'tap-not-delivered': 'tap 没有送达 canvas',
  'readout-not-updated': 'tap 已送达，但 readout 没有更新',
  'frame-loop-stalled': '帧循环没有推进',
  'position-mismatch': 'readout 已更新，但未到达 tap 目标',
  'readout-missing': 'readout 元素缺失',
};

function round1(value: number): string {
  if (!Number.isFinite(value)) {
    return 'NaN';
  }
  return String(Math.round(value * 10) / 10);
}

function formatEvent(event: FrameworkTapProbeEvent | null): string {
  if (!event) {
    return '无';
  }
  return `(${round1(event.x)}, ${round1(event.y)}) @ ${event.target}`;
}

function formatReadout(readout: FrameworkTapReadout | null): string {
  if (!readout) {
    return '元素缺失';
  }
  return `x=${readout.x} y=${readout.y} trail=${readout.trail}，input-mode=${readout.inputMode || '空'}`;
}

/**
 * Render one self-contained failure message. It always reports the three facts
 * issue #117 asks for: did the tap reach the canvas, did the readout move, and
 * did the frame loop advance, plus the stage/visibility context.
 */
export function formatFrameworkTapDiagnostics(diagnostics: FrameworkTapDiagnostics): string {
  const assessment = assessFrameworkTapDiagnostics(diagnostics);
  const { target, canvas } = diagnostics;
  const baselineSuffix = diagnostics.baseline
    ? `（tap 前 x=${diagnostics.baseline.x} y=${diagnostics.baseline.y}）`
    : '';
  const lines = [
    'framework 手机端 tap 诊断',
    `判定: ${VERDICT_LABELS[assessment.verdict]}`,
    `tap 目标: viewport (${round1(target.viewportX)}, ${round1(target.viewportY)}) → canvas 内 (${round1(target.localX)}, ${round1(target.localY)})，容差 ±${target.tolerance}`,
    `canvas: x=${round1(canvas.x)} y=${round1(canvas.y)} width=${round1(canvas.width)} height=${round1(canvas.height)}`,
    `blank-stage data-state=${diagnostics.page.stageState ?? '元素缺失'}，页面可见性=${diagnostics.page.visibility}`,
    `tap 送达: ${assessment.tapDelivered ? '是' : '否'}（canvas pointerdown +${assessment.canvasPointerDown}、canvas touchstart +${assessment.canvasTouchStart}；document 级 pointerdown +${assessment.pointerDown}、touchstart +${assessment.touchStart}；最后 pointerdown=${formatEvent(diagnostics.probeAfter.lastPointerDown)}）`,
    `tap 后 readout: ${formatReadout(diagnostics.page.readout)}`,
    `readout 更新: ${assessment.readoutUpdated ? '是' : '否'}${baselineSuffix}`,
    `帧循环推进: ${assessment.frameLoopAdvanced ? '是' : '否'}（rAF +${assessment.frames} 帧 / ${Math.round(diagnostics.elapsedMs)}ms）`,
  ];
  if (diagnostics.tapError) {
    lines.push(`tap 调用错误: ${diagnostics.tapError}`);
  }
  return lines.join('\n');
}
