import { writeSync } from 'node:fs';
import { dprForCaptureTarget, normalizeCaptureTargets } from './capture-env.mjs';

/**
 * Machine-readable capture-target declarations (Issue #293).
 *
 * Each `capture-*.mjs` script owns the list of capture targets it records and
 * exposes it through `--print-capture-targets`. The container entry and the
 * tests consume that declaration instead of re-deriving the target set from a
 * hand-written script-name / passthrough-flag table, so a new mode or a changed
 * branch cannot silently desynchronise `CAPTURE_TARGET` from the evidence the
 * script actually writes.
 *
 * This module is the single source for the target ids, the shared WebKit /
 * narrow flag spellings and the one-line print format. The DPR contract stays
 * in `capture-env.mjs`: {@link dprForCaptureTarget} is reused for validation
 * instead of keeping a second target-to-DPR map here.
 */

/** The capture target ids every declaration may name, in contract order. */
export const CAPTURE_TARGET_IDS = Object.freeze({
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
  MOBILE_TOUCH: 'mobile-touch',
  WEBKIT: 'webkit',
});

/** Print the declared targets as one JSON line on stdout and exit 0. */
export const PRINT_CAPTURE_TARGETS_FLAG = '--print-capture-targets';

/** Engine selector shared by every screenshot script. */
export const WEBKIT_FLAG = '--webkit';
/** WebKit-only narrow-screen evidence matrix. */
export const WEBKIT_NARROW_FLAG = '--webkit-narrow';
/** Before baseline of the WebKit narrow-screen evidence matrix. */
export const WEBKIT_NARROW_BEFORE_FLAG = '--webkit-narrow-before';

/** Selects the Chromium Pixel 7 `mobile-touch` mode. */
export const MINESWEEPER_TOUCH_BEFORE_FLAG = '--touch-before';

/**
 * Minesweeper modes that only create the custom DPR-2 phone context. They take
 * precedence over `--touch-before`, matching the script's MODE ordering.
 */
export const MINESWEEPER_NARROW_FLAGS = Object.freeze([
  '--narrow',
  '--narrow-before',
  '--min',
  '--min-before',
  '--restart',
  '--restart-before',
  '--short',
  '--short-before',
  '--large',
  '--large-before',
]);

/** Whether this argv asks for the machine-readable declaration only. */
export function isPrintCaptureTargetsRequested(args = process.argv.slice(2)) {
  return (Array.isArray(args) ? args : []).includes(PRINT_CAPTURE_TARGETS_FLAG);
}

/**
 * Build the one-line declaration object a screenshot script prints.
 *
 * `script` is the repository-relative script path, so a consumer can tie an
 * unexpected target back to the exact declaration. Every target id is
 * validated against the fixed capture-env DPR contract; an empty list is
 * rejected because a capture script always records at least one context.
 *
 * @returns {{ script: string, targets: string[] }}
 */
export function captureTargetsDeclaration(script, targets) {
  if (typeof script !== 'string' || script.trim() === '') {
    throw new Error(
      'A capture target declaration needs the repository-relative capture script name.',
    );
  }

  const normalized = normalizeCaptureTargets(targets);
  if (normalized === null) {
    throw new Error(`Capture target declaration for ${script} is empty.`);
  }

  // capture-env owns the target/DPR contract: reuse it instead of keeping a
  // second table here, and fail loudly if a declaration names an unknown id.
  for (const target of normalized) {
    dprForCaptureTarget(target);
  }

  return { script, targets: normalized };
}

/** Format a declaration exactly as the `--print-capture-targets` line. */
export function formatCaptureTargetsDeclaration(script, targets) {
  return JSON.stringify(captureTargetsDeclaration(script, targets));
}

/**
 * Print one JSON declaration line and exit with status 0.
 *
 * The write is synchronous so piping stdout to a consumer cannot truncate the
 * declaration when the process exits immediately afterwards. Both sinks are
 * injectable for tests.
 */
export function printCaptureTargets(
  script,
  targets,
  {
    write = (text) => writeSync(1, text),
    exit = (code) => process.exit(code),
  } = {},
) {
  write(`${formatCaptureTargetsDeclaration(script, targets)}\n`);
  exit(0);
}
