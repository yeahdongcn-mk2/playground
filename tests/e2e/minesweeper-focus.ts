/**
 * Pure building blocks for the minesweeper "focused and fully visible" e2e
 * wait. The Playwright helper lives in `minesweeper-helpers.ts`; this module
 * keeps the settling predicate and the failure report free of browser state so
 * a unit test can pin both without launching a browser.
 */

/** Extra pixels tolerated at the viewport's right / bottom edges. */
export const FOCUS_VIEWPORT_TOLERANCE = 0.5;

/** A target's `getBoundingClientRect()` at sample time. */
export interface FocusViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The viewport at sample time. */
export interface FocusViewportSize {
  readonly width: number;
  readonly height: number;
}

/** One observation of the focus / scroll / layout state. */
export interface FocusViewportSnapshot {
  /** `document.activeElement === target`. */
  readonly focused: boolean;
  /** `data-testid` of the active element, or `null` when it has none. */
  readonly activeTestId: string | null;
  /** Lower-case tag name of the active element, or `null` when unavailable. */
  readonly activeTag: string | null;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly targetTestId: string | null;
  /** Target rect, or `null` when the element has no layout box. */
  readonly rect: FocusViewportRect | null;
  readonly viewport: FocusViewportSize;
  /** Page-side `performance.now()`, used to order the reflow samples. */
  readonly at: number;
}

/** Everything the timeout error reports about the wait. */
export interface FocusSettleFailure {
  readonly label: string;
  readonly timeout: number;
  /** First observation, taken right after the caller saw the restart trigger. */
  readonly trigger: FocusViewportSnapshot;
  /** Last observation before the timeout. */
  readonly latest: FocusViewportSnapshot;
  /**
   * Observations after the trigger, deduplicated to focus / scroll / rect
   * changes: the post-restart reflow history.
   */
  readonly reflow: readonly FocusViewportSnapshot[];
  readonly sampleCount: number;
}

/**
 * The wait succeeds only when the target owns focus and its whole box is
 * inside the viewport. Left / top keep the existing strict bound; right /
 * bottom keep the existing 0.5px tolerance, so this matches
 * `expectInsideViewport` instead of silently relaxing it.
 */
export function isFocusedInsideViewport(snapshot: FocusViewportSnapshot): boolean {
  if (!snapshot.focused) {
    return false;
  }
  const { rect, viewport } = snapshot;
  if (!rect) {
    return false;
  }
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= viewport.width + FOCUS_VIEWPORT_TOLERANCE &&
    rect.y + rect.height <= viewport.height + FOCUS_VIEWPORT_TOLERANCE
  );
}

/**
 * Stable signature of the facts the wait cares about. `at` is excluded so a
 * sample that only advanced the clock is not reported as a reflow.
 */
export function focusViewportSignature(snapshot: FocusViewportSnapshot): string {
  const { rect } = snapshot;
  return [
    snapshot.focused,
    snapshot.activeTag,
    snapshot.activeTestId,
    snapshot.scrollX,
    snapshot.scrollY,
    snapshot.targetTestId,
    rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : 'none',
    snapshot.viewport.width,
    snapshot.viewport.height,
  ].join('|');
}

/** Compact number formatting so scroll / rect evidence stays readable. */
function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(3));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function describeSnapshot(snapshot: FocusViewportSnapshot): string {
  const { rect } = snapshot;
  const rectText = rect
    ? `x=${formatNumber(rect.x)}, y=${formatNumber(rect.y)}, ` +
      `w=${formatNumber(rect.width)}, h=${formatNumber(rect.height)}, ` +
      `right=${formatNumber(rect.x + rect.width)}, ` +
      `bottom=${formatNumber(rect.y + rect.height)}`
    : 'none';
  const active =
    snapshot.activeTag === null
      ? 'null'
      : snapshot.activeTestId === null
        ? snapshot.activeTag
        : `${snapshot.activeTag}[data-testid="${snapshot.activeTestId}"]`;
  return (
    `scrollX=${formatNumber(snapshot.scrollX)}` +
    ` scrollY=${formatNumber(snapshot.scrollY)}` +
    ` rect={${rectText}}` +
    ` viewport=${formatNumber(snapshot.viewport.width)}x${formatNumber(snapshot.viewport.height)}` +
    ` active=${active} focused=${snapshot.focused}` +
    ` target=${snapshot.targetTestId ?? 'unknown'}`
  );
}

/**
 * Build the timeout message. It includes the last `scrollY`, target rect,
 * viewport and `document.activeElement` testid / tag, plus the trigger and
 * reflow snapshots: an unchanged scrolled-away rect means the focus auto-scroll
 * never landed, while samples that keep moving mean layout was still settling.
 */
export function formatFocusSettleFailure(failure: FocusSettleFailure): string {
  const { label, timeout, trigger, latest, reflow, sampleCount } = failure;
  const reflowText =
    reflow.length === 0
      ? 'no focus / scroll / rect change after the trigger'
      : reflow.map((snapshot) => describeSnapshot(snapshot)).join(' -> ');
  return [
    `${label} did not settle as the focused element fully inside the viewport ` +
      `within ${timeout}ms (${sampleCount} samples)`,
    `  trigger: ${describeSnapshot(trigger)}`,
    `  latest:  ${describeSnapshot(latest)}`,
    `  reflow:  ${reflowText}`,
  ].join('\n');
}
