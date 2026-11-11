import { describe, expect, it } from 'vitest';
import {
  assessFrameworkTapDiagnostics,
  formatFrameworkTapDiagnostics,
  isFrameworkTapSettled,
  type FrameworkTapDiagnostics,
  type FrameworkTapProbeSnapshot,
  type FrameworkTapReadout,
} from '../e2e/framework-diagnostics';

const TARGET = {
  viewportX: 40,
  viewportY: 100,
  localX: 20,
  localY: 60,
  tolerance: 8,
};

const CANVAS = { x: 20, y: 40, width: 300, height: 400 };

/** Readout right after the blank game mounted, before the tap. */
const BASELINE: FrameworkTapReadout = {
  x: 150,
  y: 200,
  trail: 0,
  inputMode: '待机',
};

/** Readout after a successful tap: the tapped point, still with a small trail. */
const SETTLED: FrameworkTapReadout = {
  x: 20,
  y: 60,
  trail: 3,
  inputMode: '指针 / 触屏',
};

function probeSnapshot(
  rafFrames: number,
  pointerDown: number,
  touchStart: number,
  target = 'game-canvas',
): FrameworkTapProbeSnapshot {
  const event = { x: 40, y: 100, target };
  return {
    pointerDown,
    // Only a target inside the canvas moves the readout, so a document-level
    // event on some other element stays out of the canvas counters.
    canvasPointerDown: target === 'game-canvas' ? pointerDown : 0,
    touchStart,
    canvasTouchStart: target === 'game-canvas' ? touchStart : 0,
    click: touchStart,
    rafFrames,
    lastPointerDown: pointerDown > 0 ? event : null,
    lastTouchStart: touchStart > 0 ? event : null,
  };
}

function diagnostics(overrides: {
  readout: FrameworkTapReadout | null;
  probeAfter: FrameworkTapProbeSnapshot;
  baseline?: FrameworkTapReadout;
  stageState?: string | null;
  visibility?: string;
  tapError?: string | null;
}): FrameworkTapDiagnostics {
  return {
    target: TARGET,
    canvas: CANVAS,
    baseline: overrides.baseline ?? BASELINE,
    page: {
      readout: overrides.readout,
      stageState: overrides.stageState === undefined ? 'ready' : overrides.stageState,
      visibility: overrides.visibility ?? 'visible',
    },
    // The tap poll started with 100 delivered frames; `probeAfter` says how
    // many the loop delivered while the assertion waited.
    probeBefore: probeSnapshot(100, 0, 0),
    probeAfter: overrides.probeAfter,
    elapsedMs: 3_000,
    tapError: overrides.tapError ?? null,
  };
}

describe('framework mobile tap diagnostics', () => {
  it('blames tap delivery when the canvas never saw the tap', () => {
    const evidence = diagnostics({
      readout: BASELINE,
      probeAfter: probeSnapshot(280, 0, 0),
    });

    const assessment = assessFrameworkTapDiagnostics(evidence);
    expect(assessment.verdict).toBe('tap-not-delivered');
    expect(assessment.tapDelivered).toBe(false);
    expect(assessment.readoutUpdated).toBe(false);
    expect(assessment.frameLoopAdvanced).toBe(true);

    const message = formatFrameworkTapDiagnostics(evidence);
    expect(message).toContain('判定: tap 没有送达 canvas');
    expect(message).toContain('tap 送达: 否');
    expect(message).toContain('readout 更新: 否');
    expect(message).toContain('帧循环推进: 是');
    expect(message).toContain('blank-stage data-state=ready');
    expect(message).toContain('页面可见性=visible');
    expect(message).toContain('rAF +180 帧 / 3000ms');
  });

  it('does not blame the readout when the tap landed outside the canvas', () => {
    const evidence = diagnostics({
      readout: BASELINE,
      // The event reached the document (so the old document-level counter was
      // non-zero), but its target was `blank-stage`, not the canvas.
      probeAfter: probeSnapshot(280, 1, 1, 'blank-stage'),
    });

    const assessment = assessFrameworkTapDiagnostics(evidence);
    expect(assessment.verdict).toBe('tap-not-delivered');
    expect(assessment.tapDelivered).toBe(false);
    expect(assessment.pointerDown).toBe(1);
    expect(assessment.canvasPointerDown).toBe(0);
    expect(assessment.touchStart).toBe(1);
    expect(assessment.canvasTouchStart).toBe(0);

    const message = formatFrameworkTapDiagnostics(evidence);
    expect(message).toContain('判定: tap 没有送达 canvas');
    expect(message).toContain('canvas pointerdown +0、canvas touchstart +0');
    expect(message).toContain('document 级 pointerdown +1、touchstart +1');
    expect(message).toContain('最后 pointerdown=(40, 100) @ blank-stage');
  });

  it('blames the readout when a delivered tap left it unchanged', () => {
    const evidence = diagnostics({
      readout: BASELINE,
      probeAfter: probeSnapshot(280, 1, 1),
    });

    const assessment = assessFrameworkTapDiagnostics(evidence);
    expect(assessment.verdict).toBe('readout-not-updated');
    expect(assessment.tapDelivered).toBe(true);
    expect(assessment.readoutUpdated).toBe(false);
    expect(assessment.frameLoopAdvanced).toBe(true);

    const message = formatFrameworkTapDiagnostics(evidence);
    expect(message).toContain('判定: tap 已送达，但 readout 没有更新');
    expect(message).toContain('tap 送达: 是');
    expect(message).toContain('readout 更新: 否');
    expect(message).toContain('帧循环推进: 是');
  });

  it('reports a settled tap without inventing a failure', () => {
    const evidence = diagnostics({
      readout: SETTLED,
      probeAfter: probeSnapshot(280, 1, 1),
    });

    const assessment = assessFrameworkTapDiagnostics(evidence);
    expect(assessment.verdict).toBe('settled');
    expect(assessment.withinTolerance).toBe(true);
    expect(assessment.readoutUpdated).toBe(true);

    const message = formatFrameworkTapDiagnostics(evidence);
    expect(message).toContain('判定: readout 已停稳在 tap 目标容差内');
    expect(message).toContain('tap 送达: 是');
    expect(message).toContain('readout 更新: 是');
    expect(message).toContain('帧循环推进: 是');
    expect(message).toContain('input-mode=指针 / 触屏');
  });

  it('keeps the settled tolerance inclusive at its boundary', () => {
    expect(isFrameworkTapSettled({ x: 20 + 8, y: 60 - 8 }, TARGET)).toBe(true);
    expect(isFrameworkTapSettled({ x: 20 + 9, y: 60 }, TARGET)).toBe(false);
    expect(isFrameworkTapSettled({ x: 20, y: 60 - 9 }, TARGET)).toBe(false);
  });

  it('reports a stalled animation loop when nothing advanced', () => {
    const evidence = diagnostics({
      readout: BASELINE,
      probeAfter: probeSnapshot(100, 1, 1),
    });

    const assessment = assessFrameworkTapDiagnostics(evidence);
    expect(assessment.verdict).toBe('frame-loop-stalled');
    expect(assessment.frameLoopAdvanced).toBe(false);

    const message = formatFrameworkTapDiagnostics(evidence);
    expect(message).toContain('判定: 帧循环没有推进');
    expect(message).toContain('帧循环推进: 否');
    expect(message).toContain('rAF +0 帧 / 3000ms');
  });

  it('surfaces missing readout and tap errors instead of hiding them', () => {
    const evidence = diagnostics({
      readout: null,
      probeAfter: probeSnapshot(100, 0, 0),
      tapError: 'touchscreen.tap: hasTouch is false',
    });

    const assessment = assessFrameworkTapDiagnostics(evidence);
    expect(assessment.verdict).toBe('readout-missing');

    const message = formatFrameworkTapDiagnostics(evidence);
    expect(message).toContain('判定: readout 元素缺失');
    expect(message).toContain('tap 后 readout: 元素缺失');
    expect(message).toContain('tap 调用错误: touchscreen.tap: hasTouch is false');
  });
});
