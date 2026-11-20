/**
 * Validated inputs for the scheduled / manual concurrent-load screenshot repro
 * (Issue #352).
 *
 * `.github/workflows/capture-repro-load.yml` repeats a small set of the WebKit
 * targets most affected by host concurrency (#328 / #341 / #342) at least four
 * times while CPU-burning workers keep the runner loaded. A workflow dispatch
 * can override the target list, the run count and the worker count, so the
 * three raw inputs must be validated before they reach a `run:` script:
 *
 * - every target has to be one of the manifest capture targets,
 * - `runs` is a positive integer and the gate requires at least
 *   MIN_REPRO_LOAD_RUNS runs, otherwise that check is the default nightly,
 * - `load` is a positive integer bounded by MAX_LOAD_COUNT, so a typo cannot
 *   spawn an unbounded number of CPU-burning processes.
 *
 * Empty inputs fall back to the workflow defaults, which is what a scheduled
 * run (no `inputs` context) passes.
 */
import {
  deriveReproPlans,
  normalizeLoadCount,
  normalizeRunCount,
  validateCaptureTarget,
} from './screenshot-repro.mjs';

/** The affected WebKit targets the load gate repeats by default. */
export const DEFAULT_REPRO_LOAD_TARGETS = Object.freeze([
  'screenshots:webkit',
  'screenshots:breakout:webkit',
  'screenshots:snake:webkit',
]);

/** Runs per target; the gate needs at least four to catch an intermittent drift. */
export const DEFAULT_REPRO_LOAD_RUNS = 4;
/** Minimum `runs` the load gate accepts; the nightly already covers two. */
export const MIN_REPRO_LOAD_RUNS = 4;
/** CPU-burning worker processes kept alive around every capture run. */
export const DEFAULT_REPRO_LOAD_WORKERS = 8;

/**
 * Workflow environment variables the input CLI reads the dispatch inputs from.
 *
 * Names live here so the workflow contract test can compare the YAML `env:`
 * map with what `scripts/check-repro-load-inputs.mjs` actually reads.
 */
export const REPRO_LOAD_INPUT_ENV = Object.freeze({
  targets: 'REPRO_LOAD_INPUT_TARGETS',
  runs: 'REPRO_LOAD_INPUT_RUNS',
  load: 'REPRO_LOAD_INPUT_LOAD',
});

/** Raised when a dispatch input cannot drive the load gate. */
export class ReproLoadInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReproLoadInputError';
  }
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/** Keep one error type for every invalid input path. */
function toInputError(error) {
  if (error instanceof ReproLoadInputError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ReproLoadInputError(detail);
}

/**
 * Unique capture targets the manifest names, in manifest order.
 *
 * `deriveReproPlans` parses `captures[].command` with the same strict parser the
 * repro entry uses, so the accepted target set and the runnable target set
 * cannot drift apart.
 *
 * @param {import('./screenshot-sha256.mjs').ScreenshotSha256Manifest} manifest
 * @returns {string[]}
 */
export function manifestCaptureTargets(manifest) {
  try {
    return deriveReproPlans(manifest).map((plan) => plan.target);
  } catch (error) {
    throw toInputError(error);
  }
}

/**
 * Parse the comma-separated `targets` input into validated manifest targets.
 *
 * Blank input selects DEFAULT_REPRO_LOAD_TARGETS. Duplicate entries are
 * dropped; an empty entry, a malformed target or a target the manifest does
 * not name is a usage error.
 *
 * @param {unknown} value raw `targets` input
 * @param {string[]} supportedTargets targets the manifest names
 * @returns {string[]}
 */
export function parseTargetList(value, supportedTargets) {
  if (!Array.isArray(supportedTargets) || supportedTargets.length === 0) {
    throw new ReproLoadInputError('the sha256 manifest names no supported capture target.');
  }
  const entries = isBlank(value)
    ? [...DEFAULT_REPRO_LOAD_TARGETS]
    : String(value).trim().split(',');
  const available = new Set(supportedTargets);
  const targets = [];

  for (const entry of entries) {
    const text = String(entry).trim();
    if (text === '') {
      throw new ReproLoadInputError(
        `the targets input contains an empty entry: ${JSON.stringify(value)}.`,
      );
    }

    let target;
    try {
      target = validateCaptureTarget(text);
    } catch (error) {
      throw toInputError(error);
    }

    if (!available.has(target)) {
      throw new ReproLoadInputError(
        `unsupported targets entry ${JSON.stringify(target)}: the manifest names ` +
          `${[...available].join(', ')}.`,
      );
    }
    if (!targets.includes(target)) targets.push(target);
  }

  return targets;
}

/**
 * Parse the `runs` input: a positive integer of at least MIN_REPRO_LOAD_RUNS.
 *
 * @param {unknown} value raw `runs` input
 * @returns {number}
 */
export function normalizeRuns(value) {
  if (isBlank(value)) return DEFAULT_REPRO_LOAD_RUNS;

  let runs;
  try {
    runs = normalizeRunCount(value);
  } catch (error) {
    throw toInputError(error);
  }
  if (runs < MIN_REPRO_LOAD_RUNS) {
    throw new ReproLoadInputError(
      `runs must be at least ${MIN_REPRO_LOAD_RUNS} so a load-only drift can fail the gate, ` +
        `got ${runs}.`,
    );
  }
  return runs;
}

/**
 * Parse the `load` input: a positive integer of CPU workers, at most
 * MAX_LOAD_COUNT.
 *
 * Unlike the repro entry's `--load 0`, the gate rejects zero: a dispatch that
 * disables the load would only duplicate the two-run nightly.
 *
 * @param {unknown} value raw `load` input
 * @returns {number}
 */
export function normalizeLoad(value) {
  if (isBlank(value)) return DEFAULT_REPRO_LOAD_WORKERS;

  let load;
  try {
    load = normalizeLoadCount(value);
  } catch (error) {
    throw toInputError(error);
  }
  if (load === 0) {
    throw new ReproLoadInputError(
      'load must be a positive integer; 0 would run the gate without concurrent load.',
    );
  }
  return load;
}

/**
 * Validate the three dispatch inputs against the manifest targets.
 *
 * @param {{ targets?: unknown, runs?: unknown, load?: unknown }} [raw]
 * @param {string[]} [supportedTargets]
 * @returns {{ targets: string[], runs: number, load: number }}
 */
export function normalizeReproLoadInputs(raw = {}, supportedTargets) {
  if (!Array.isArray(supportedTargets)) {
    throw new ReproLoadInputError(
      'supportedTargets must be the capture target list derived from the manifest.',
    );
  }
  return {
    targets: parseTargetList(raw.targets, supportedTargets),
    runs: normalizeRuns(raw.runs),
    load: normalizeLoad(raw.load),
  };
}

/**
 * The `$GITHUB_OUTPUT` body for the validated inputs.
 *
 * Only normalized values are written, so the capture step consumes step outputs
 * instead of a raw dispatch expression.
 *
 * @param {{ targets: string[], runs: number, load: number }} inputs
 * @returns {string}
 */
export function formatGithubOutput({ targets, runs, load }) {
  return `targets=${targets.join(',')}\nruns=${runs}\nload=${load}\n`;
}
