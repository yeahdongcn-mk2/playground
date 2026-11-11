/**
 * Settle predicate and polling loop shared by the blank-canvas screenshot
 * scenes.
 *
 * The blank game snaps the orb to the pointer target and then fades its trail
 * out over 1.15 s. A frame is only reproducible once the orb sits exactly on
 * the target and the trail array is empty; until then the canvas depends on
 * how many frames ran inside the wall-clock wait.
 */

/** How close (canvas CSS px) the snapped orb must be to the click target. */
export const BLANK_TARGET_TOLERANCE = 2;

/** Consecutive stable readout samples required before a capture. */
export const BLANK_STABLE_SAMPLES = 5;

/** Delay between two readout samples while waiting for a blank scene. */
export const BLANK_SETTLE_INTERVAL_MS = 100;

/** Wall-clock budget for a blank scene to reach the settled state. */
export const BLANK_SETTLE_TIMEOUT_MS = 15_000;

/** Whether a readout sample shows the orb snapped to the click target. */
export function isBlankAtTarget(
  sample,
  target,
  tolerance = BLANK_TARGET_TOLERANCE,
) {
  return (
    Math.abs(sample.x - target.x) <= tolerance &&
    Math.abs(sample.y - target.y) <= tolerance
  );
}

/**
 * Advance the streak of consecutive readout samples that show a snapped orb
 * with no trail left. Any movement, target miss or live trail dot resets the
 * streak, so a capture cannot reuse a stale "stopped" reading from before the
 * orb started moving.
 */
export function nextBlankStableStreak(
  streak,
  sample,
  target,
  { required = BLANK_STABLE_SAMPLES, tolerance = BLANK_TARGET_TOLERANCE } = {},
) {
  const settled = sample.trail === 0 && isBlankAtTarget(sample, target, tolerance);
  if (!settled) {
    return 0;
  }
  return Math.min(streak + 1, required);
}

/** Read the live orb position / trail count exposed by the HUD readout. */
export function readBlankReadout(page) {
  return page.locator('[data-testid="readout"]').evaluate((element) => ({
    x: Number(element.dataset.x),
    y: Number(element.dataset.y),
    trail: Number(element.dataset.trail),
  }));
}

/**
 * Poll the HUD readout until the orb has stayed on the click target with no
 * trail for `required` consecutive samples, then return the settled sample.
 * The readout, timer, delay, sample count and tolerance are injectable so a
 * unit test can drive the whole loop with a fake page instead of relying on
 * file-text assertions. The e2e framework case reuses this loop with its own
 * product-level tolerance instead of a fixed wall-clock poll.
 *
 * A scene that never settles throws, naming the last readout, rather than
 * silently capturing an intermediate frame.
 */
export async function waitForBlankSettled(
  page,
  target,
  {
    read = readBlankReadout,
    wait = (capturePage, delayMs) => capturePage.waitForTimeout(delayMs),
    now = Date.now,
    intervalMs = BLANK_SETTLE_INTERVAL_MS,
    timeoutMs = BLANK_SETTLE_TIMEOUT_MS,
    required = BLANK_STABLE_SAMPLES,
    tolerance = BLANK_TARGET_TOLERANCE,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let streak = 0;
  let last = null;
  while (now() < deadline) {
    last = await read(page);
    streak = nextBlankStableStreak(streak, last, target, { required, tolerance });
    if (streak >= required) {
      return last;
    }
    await wait(page, intervalMs);
  }
  throw new Error(
    `Blank canvas did not settle at (${target.x}, ${target.y}) within ` +
      `${timeoutMs} ms (last readout x=${last?.x}, ` +
      `y=${last?.y}, trail=${last?.trail})`,
  );
}
