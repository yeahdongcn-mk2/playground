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
 *
 * Issue #341 t2 found a second, independent drift source on the hub page: the
 * `99dfef39…` variant differs from the committed `after-hub-webkit.png` by
 * 259936 pixels, but only 2429 of them are the shared header (each channel 1
 * step). The large differences are the hero orb core rendered at the
 * reduced-motion `breathe` animation's scale(0.97) instead of the resting
 * scale(1). `settleHubHeroCompositing` below is the same seam for that
 * element: it finishes the page's reduced-motion animations, checks none is
 * still running, then waits committed frames before the screenshot.
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

/**
 * Hub hero element whose reduced-motion animation leaves a residual composited
 * transform. The orb core is the only element with a large pixel difference in
 * the `99dfef39…` hub drift (Issue #341 t2); the selector also proves the hub
 * page loaded the hero before the capture is allowed to continue.
 */
export const HUB_HERO_SELECTOR = '.orb-core';

/** Committed double-rAF waits after the hub hero animations finish. */
export const HUB_HERO_SETTLE_FRAMES = 2;

/**
 * In-page half of `settleHubHeroCompositing`.
 *
 * The capture context runs with `prefers-reduced-motion: reduce`, so every CSS
 * animation (`breathe` on the orb core, `orbit` on both rings) is a single
 * 0.001 ms iteration. A loaded WebKit can still composite that animation's
 * frame instead of the resting style, which shifts the orb gradient / glow by
 * up to 198 per channel. Finishing every animation and then checking that none
 * is still running removes the residual transform before the committed-frame
 * waits. `pending` lets the host fail instead of capturing an unsettled frame.
 *
 * This runs inside `page.evaluate`, so it only uses browser globals and its
 * serialisable options.
 */
export async function settleHubHeroAnimations({ selector, frames }) {
  await document.fonts.ready;
  const hero = document.querySelector(selector);
  if (!(hero instanceof HTMLElement)) {
    return { found: false, pending: 0 };
  }
  const animations = document.getAnimations();
  for (const animation of animations) {
    try {
      animation.finish();
    } catch {
      // An infinite animation cannot be finished; the pending check below
      // reports it instead of hanging on its never-resolving `finished`.
    }
  }
  const finished = animations.filter(
    (animation) => animation.playState === 'finished',
  );
  await Promise.all(finished.map((animation) => animation.finished));
  const pending = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === 'running' || animation.playState === 'pending',
    ).length;
  if (pending > 0) {
    return { found: true, pending };
  }
  const nextCommittedFrame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  for (let index = 0; index < frames; index += 1) {
    await nextCommittedFrame();
  }
  return { found: true, pending: 0 };
}

/**
 * Settle the hub hero's reduced-motion animation state before a WebKit
 * screenshot. The evaluate hook is injectable so a unit test can drive the
 * orchestration without a browser; the in-page finish / pending check is
 * runtime-tested in jsdom. A missing hero or an animation that never finishes
 * throws, naming the selector, instead of silently capturing a frame that
 * still carries the animation's composited transform.
 */
export async function settleHubHeroCompositing(
  page,
  {
    evaluate = (capturePage, settle, options) =>
      capturePage.evaluate(settle, options),
    selector = HUB_HERO_SELECTOR,
    frames = HUB_HERO_SETTLE_FRAMES,
  } = {},
) {
  const result = await evaluate(page, settleHubHeroAnimations, {
    selector,
    frames,
  });
  if (!result?.found) {
    throw new Error(
      `Hub hero "${selector}" was not found, so its WebKit ` +
        'animation state could not be settled before the screenshot',
    );
  }
  if (result.pending > 0) {
    throw new Error(
      `Hub hero "${selector}" still had ${result.pending} running ` +
        'animation(s), so its WebKit composited paint could not be settled ' +
        'before the screenshot',
    );
  }
}
