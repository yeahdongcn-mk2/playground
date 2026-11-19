import { describe, expect, it } from 'vitest';
import {
  FOCUS_VIEWPORT_TOLERANCE,
  focusViewportSignature,
  formatFocusSettleFailure,
  isFocusedInsideViewport,
  type FocusViewportSnapshot,
} from '../e2e/minesweeper-focus';

const VIEWPORT = { width: 375, height: 667 };

function snapshot(
  overrides: Partial<FocusViewportSnapshot> = {},
): FocusViewportSnapshot {
  return {
    focused: true,
    activeTestId: 'mobile-restart-button',
    activeTag: 'button',
    scrollX: 0,
    scrollY: 296,
    targetTestId: 'mobile-restart-button',
    rect: { x: 12, y: 308.9, width: 351, height: 45.5 },
    viewport: VIEWPORT,
    at: 1_000,
    ...overrides,
  };
}

describe('isFocusedInsideViewport', () => {
  it('accepts a focused target fully inside the viewport', () => {
    expect(isFocusedInsideViewport(snapshot())).toBe(true);
  });

  it('accepts the right / bottom edge with the existing 0.5px tolerance', () => {
    // Literal boundaries on purpose: deriving them from the constant would let
    // a relaxed tolerance keep this test green.
    expect(
      isFocusedInsideViewport(
        snapshot({
          rect: { x: 0, y: 0, width: 375.5, height: 667 },
        }),
      ),
    ).toBe(true);
    expect(
      isFocusedInsideViewport(
        snapshot({
          rect: { x: 0, y: 0, width: 375, height: 667.5 },
        }),
      ),
    ).toBe(true);
  });

  it('rejects a target that overflows the right / bottom beyond the tolerance', () => {
    // Just 0.0001px past the literal 0.5px tolerance must still fail.
    expect(
      isFocusedInsideViewport(
        snapshot({
          rect: { x: 0, y: 0, width: 375.5001, height: 100 },
        }),
      ),
    ).toBe(false);
    expect(
      isFocusedInsideViewport(
        snapshot({
          rect: { x: 0, y: 0, width: 100, height: 667.5001 },
        }),
      ),
    ).toBe(false);
  });

  it('pins the shared viewport tolerance at exactly 0.5px', () => {
    expect(FOCUS_VIEWPORT_TOLERANCE).toBe(0.5);
  });

  it('keeps the strict left / top bound, so a scrolled-away target fails', () => {
    expect(
      isFocusedInsideViewport(
        snapshot({ rect: { x: -0.01, y: 100, width: 100, height: 60 } }),
      ),
    ).toBe(false);
    expect(
      isFocusedInsideViewport(
        snapshot({ rect: { x: 10, y: -256.078125, width: 351, height: 45.5 } }),
      ),
    ).toBe(false);
  });

  it('requires the target itself to own focus', () => {
    expect(
      isFocusedInsideViewport(
        snapshot({
          focused: false,
          activeTestId: 'restart-button',
          activeTag: 'button',
        }),
      ),
    ).toBe(false);
  });

  it('rejects a missing layout box', () => {
    expect(isFocusedInsideViewport(snapshot({ rect: null }))).toBe(false);
  });
});

describe('focusViewportSignature', () => {
  it('ignores the sample clock but notices focus, scroll and rect changes', () => {
    const base = snapshot();
    expect(focusViewportSignature(snapshot({ at: 9_999 }))).toBe(
      focusViewportSignature(base),
    );
    expect(focusViewportSignature(snapshot({ scrollY: 862 }))).not.toBe(
      focusViewportSignature(base),
    );
    expect(
      focusViewportSignature(
        snapshot({ rect: { x: 12, y: -256.078125, width: 351, height: 45.5 } }),
      ),
    ).not.toBe(focusViewportSignature(base));
    expect(focusViewportSignature(snapshot({ focused: false }))).not.toBe(
      focusViewportSignature(base),
    );
  });
});

describe('formatFocusSettleFailure', () => {
  it('reports the last scrollY, rect, viewport and active element plus the reflow history', () => {
    const trigger = snapshot({
      focused: false,
      activeTestId: 'restart-button',
      scrollY: 862,
      rect: { x: 12, y: -256.078125, width: 351, height: 45.5 },
      at: 800,
    });
    const intermediate = snapshot({ scrollY: 500, at: 830 });
    const latest = snapshot({
      scrollY: 296,
      rect: { x: 12, y: 308.921875, width: 351, height: 45.5 },
      at: 860,
    });

    const message = formatFocusSettleFailure({
      label: 'compact restart after sidebar restart',
      timeout: 5_000,
      trigger,
      latest,
      reflow: [intermediate, latest],
      sampleCount: 3,
    });

    expect(message).toContain(
      'compact restart after sidebar restart did not settle as the focused element fully inside the viewport within 5000ms (3 samples)',
    );
    expect(message).toContain('trigger: scrollX=0 scrollY=862');
    expect(message).toContain('y=-256.078');
    expect(message).toContain('latest:  scrollX=0 scrollY=296');
    expect(message).toContain('y=308.922');
    expect(message).toContain('bottom=354.422');
    expect(message).toContain('viewport=375x667');
    expect(message).toContain('active=button[data-testid="restart-button"]');
    expect(message).toContain('focused=false');
    expect(message).toContain('target=mobile-restart-button');
    expect(message).toContain('reflow:  ');
    expect(message).toContain('reflow:  +30ms ');
    expect(message).toContain('scrollX=0 scrollY=500');
    expect(message).toContain(' -> +60ms ');
    expect(message).toContain(' -> ');
  });

  it('says when nothing moved after the trigger', () => {
    const frozen = snapshot({ focused: false, activeTestId: 'restart-button' });
    const message = formatFocusSettleFailure({
      label: 'compact restart',
      timeout: 2_000,
      trigger: frozen,
      latest: frozen,
      reflow: [],
      sampleCount: 1,
    });

    expect(message).toContain('within 2000ms (1 samples)');
    expect(message).toContain('no focus / scroll / rect change after the trigger');
  });
});
