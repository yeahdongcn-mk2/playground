/**
 * Settle predicate shared by the blank-canvas screenshot scenes.
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
