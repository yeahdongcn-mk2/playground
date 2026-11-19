/**
 * Reusable WebKit compositing settle seam for captures that include the shared
 * site header.
 *
 * The shared site header keeps its own blurred `backdrop-filter` snapshot in a
 * composited layer that outlives a client-side route switch. On WebKit that
 * snapshot can be committed one 8-bit step away from the committed evidence
 * even after the target scene has settled (Issue #326 for the blank canvas,
 * Issue #341 for the hub / scores captures). Waiting for the header fonts and
 * toggling the same filter off and back on between committed frames rebuilds
 * the snapshot from the current page. The restored value is the stylesheet's
 * filter, so the visible rendering is unchanged; only the compositing timing
 * is pinned.
 *
 * Any WebKit capture may call `settleSharedHeaderCompositing(page, {
 * selector, frames, evaluate })`. The blank path keeps its own
 * `settleBlankHeader` wrapper in `blank-settle.mjs` and reuses this module
 * instead of carrying a second copy of the toggle / frame sequence.
 */

/** Shared site header whose WebKit backdrop snapshot can outlive a route switch. */
export const SHARED_HEADER_SELECTOR = '.site-header';

/**
 * Double-rAF waits after each header filter toggle. Each wait resolves in the
 * animation frame after the one that applied the toggle, so the new filter
 * state is painted before the next step; two waits give WebKit an extra frame
 * to rebuild the blurred backdrop before the screenshot.
 */
export const SHARED_HEADER_SETTLE_FRAMES = 2;

/**
 * In-page half of `settleSharedHeaderCompositing`.
 *
 * This runs inside `page.evaluate`, so it only uses browser globals and its
 * serialisable options. It returns whether the header was found: a renamed
 * header must fail the capture instead of silently skipping the seam.
 */
export async function repaintSharedHeader({ selector, frames }) {
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
 * Settle the shared site header before a WebKit screenshot. The evaluate hook
 * is injectable so a unit test can drive the orchestration without a browser;
 * the in-page repaint itself is runtime-tested in jsdom. A missing header
 * throws, naming the selector, instead of silently capturing an unsettled
 * composited header.
 */
export async function settleSharedHeaderCompositing(
  page,
  {
    evaluate = (capturePage, repaint, options) =>
      capturePage.evaluate(repaint, options),
    selector = SHARED_HEADER_SELECTOR,
    frames = SHARED_HEADER_SETTLE_FRAMES,
  } = {},
) {
  const repainted = await evaluate(page, repaintSharedHeader, {
    selector,
    frames,
  });
  if (!repainted) {
    throw new Error(
      `Shared header "${selector}" was not found, so its WebKit ` +
        'backdrop-filter could not be settled before the screenshot',
    );
  }
}
