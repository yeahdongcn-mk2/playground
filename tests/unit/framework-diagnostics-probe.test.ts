// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  frameworkTapProbeInitScript,
  type FrameworkTapProbeSnapshot,
} from '../e2e/framework-diagnostics';

interface ProbeWindow {
  __frameworkTapProbe?: { snapshot(): FrameworkTapProbeSnapshot };
}

function probeSnapshot(): FrameworkTapProbeSnapshot {
  const api = (window as unknown as ProbeWindow).__frameworkTapProbe;
  if (!api) {
    throw new Error('framework tap probe is not installed');
  }
  return api.snapshot();
}

/** Run the exact function `page.addInitScript` serializes into the browser. */
function installProbe(): void {
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      callback(0);
      return 0;
    }) as typeof window.requestAnimationFrame;
  }
  frameworkTapProbeInitScript();
}

function mountStage(): { stage: HTMLElement; canvas: HTMLCanvasElement } {
  document.body.innerHTML = '';
  const stage = document.createElement('div');
  stage.dataset.testid = 'blank-stage';
  const canvas = document.createElement('canvas');
  canvas.dataset.testid = 'game-canvas';
  stage.append(canvas);
  document.body.append(stage);
  return { stage, canvas };
}

function pointerDownOn(target: Element, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
}

function touchStartOn(target: Element, x: number, y: number): void {
  const event = new Event('touchstart', { bubbles: true });
  const touch = { clientX: x, clientY: y };
  Object.defineProperties(event, {
    touches: { value: [touch] },
    changedTouches: { value: [touch] },
  });
  target.dispatchEvent(event);
}

describe('framework tap probe wiring', () => {
  it('counts a canvas tap in the document-level and canvas-level counters', () => {
    installProbe();
    const { canvas } = mountStage();
    const before = probeSnapshot();

    pointerDownOn(canvas, 30, 70);
    touchStartOn(canvas, 30, 70);

    const after = probeSnapshot();
    expect(after.pointerDown - before.pointerDown).toBe(1);
    expect(after.canvasPointerDown - before.canvasPointerDown).toBe(1);
    expect(after.touchStart - before.touchStart).toBe(1);
    expect(after.canvasTouchStart - before.canvasTouchStart).toBe(1);
    expect(after.lastPointerDown).toEqual({ x: 30, y: 70, target: 'game-canvas' });
    expect(after.lastTouchStart).toEqual({ x: 30, y: 70, target: 'game-canvas' });
  });

  it('records an outside tap without counting it as canvas delivery', () => {
    installProbe();
    const { stage } = mountStage();
    const before = probeSnapshot();

    pointerDownOn(stage, 5, 7);
    touchStartOn(stage, 5, 7);

    const after = probeSnapshot();
    expect(after.pointerDown - before.pointerDown).toBe(1);
    expect(after.canvasPointerDown - before.canvasPointerDown).toBe(0);
    expect(after.touchStart - before.touchStart).toBe(1);
    expect(after.canvasTouchStart - before.canvasTouchStart).toBe(0);
    expect(after.lastPointerDown?.target).toBe('blank-stage');
    expect(after.lastTouchStart?.target).toBe('blank-stage');
  });

  it('counts frames through the wrapped requestAnimationFrame', async () => {
    installProbe();
    const before = probeSnapshot();

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });

    expect(probeSnapshot().rafFrames - before.rafFrames).toBe(1);
  });
});
