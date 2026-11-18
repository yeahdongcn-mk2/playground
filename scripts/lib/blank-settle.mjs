/**
 * Settle predicate and polling loop shared by the blank-canvas screenshot
 * scenes.
 *
 * The blank game snaps the orb to the pointer target and then fades its trail
 * out over 1.15 s. A frame is only reproducible once the orb sits exactly on
 * the target and the trail array is empty; until then the canvas depends on
 * how many frames ran inside the wall-clock wait.
 *
 * The scene settling is necessary but not sufficient on WebKit: the shared
 * site header keeps its own blurred `backdrop-filter` snapshot across a
 * client-side route switch, so its composited pixels can still land one 8-bit
 * step away from the committed frame (Issue #326). `settleBlankHeader` below
 * pins that snapshot after the scene settles.
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

/** Shared site header whose WebKit backdrop snapshot can outlive a route switch. */
export const BLANK_HEADER_SELECTOR = '.site-header';

/**
 * Double-rAF waits after each header filter toggle. Each wait resolves in the
 * animation frame after the one that applied the toggle, so the new filter
 * state is painted before the next step; two waits give WebKit an extra frame
 * to rebuild the blurred backdrop before the screenshot.
 */
export const BLANK_HEADER_SETTLE_FRAMES = 2;

/**
 * In-page half of `settleBlankHeader`.
 *
 * The shared site header is outside the game view and keeps its composited
 * `backdrop-filter: blur(18px)` layer across a client-side route switch. On
 * WebKit that snapshot can be committed one 8-bit step away from the committed
 * blank evidence even though the blank canvas itself has settled, so the same
 * build writes `cd4ed3fe…` or `5569689d…` (Issue #326). Waiting for the header
 * fonts and then toggling the same filter off and back on between committed
 * frames rebuilds the snapshot from the current page. The restored value is
 * the stylesheet's filter, so the visible rendering is unchanged; only the
 * compositing timing is pinned.
 *
 * This runs inside `page.evaluate`, so it only uses browser globals and its
 * serialisable options. It returns whether the header was found: a renamed
 * header must fail the capture instead of silently skipping the seam.
 */
export async function repaintBlankHeader({ selector, frames }) {
  await document.fonts.ready;
  const header = document.querySelector(selector);
  if (!(header instanceof HTMLElement)) {
    return false;
  }
  const nextCommittedFrame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  const waitForCommittedFrames = async () => {
    for (let index = 0; index < frames; index += 1) {
      await nextCommittedFrame();
    }
  };
  header.style.backdropFilter = 'none';
  header.style.webkitBackdropFilter = 'none';
  await waitForCommittedFrames();
  header.style.backdropFilter = '';
  header.style.webkitBackdropFilter = '';
  await waitForCommittedFrames();
  return true;
}

/**
 * Settle the shared site header after the blank scene has settled and before
 * the WebKit blank capture. The evaluate hook is injectable so a unit test can
 * drive the orchestration without a browser; the in-page repaint itself is
 * runtime-tested in jsdom. Only the WebKit blank path calls this: the hub
 * capture happens before the route switch, and the Chromium blank captures
 * keep their committed bytes.
 */
export async function settleBlankHeader(
  page,
  {
    evaluate = (capturePage, repaint, options) =>
      capturePage.evaluate(repaint, options),
    selector = BLANK_HEADER_SELECTOR,
    frames = BLANK_HEADER_SETTLE_FRAMES,
  } = {},
) {
  const repainted = await evaluate(page, repaintBlankHeader, {
    selector,
    frames,
  });
  if (!repainted) {
    throw new Error(
      `Blank header "${selector}" was not found, so its WebKit ` +
        'backdrop-filter could not be settled before the screenshot',
    );
  }
}
