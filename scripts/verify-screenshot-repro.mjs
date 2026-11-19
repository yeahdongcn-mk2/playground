#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPTURE_REPO_ROOT } from './lib/capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SCREENSHOT_DIR,
} from './lib/screenshot-sha256.mjs';
import {
  DEFAULT_REPRO_LOG_DIR,
  REPRO_RUN_COUNT,
  ScreenshotReproError,
  normalizeRunCount,
  runScreenshotRepro,
  validateCaptureTarget,
} from './lib/screenshot-repro.mjs';

const USAGE = `Usage: node scripts/verify-screenshot-repro.mjs [options]

Re-run the screenshot targets named by ${DEFAULT_MANIFEST_PATH} in the fixed
Playwright container. By default every target runs ${REPRO_RUN_COUNT} times;
--target selects a subset (repeatable) and --runs <N> changes the repetition
count, e.g. for reproducing a load-dependent drift. Every run keeps one capture
log and a copy of each manifested PNG under test-results/screenshot-repro/, so
drifting runs can be compared after the last run overwrote the shared paths.

Every manifested PNG must have the same sha256 in every run and equal the
manifest. Each run log is also checked with
node scripts/verify-screenshot-sha256.mjs --log.

The entry never commits, pushes or edits the manifest. On a mismatch it prints
the differing files with expected / per-run actual sha256, the capture log and
retained PNG paths, the environment fingerprint and the re-capture steps, and
appends the same report to $GITHUB_STEP_SUMMARY when set.

Options:
  --manifest <path>  sha256 manifest (default: ${DEFAULT_MANIFEST_PATH})
  --dir <path>       screenshot directory (default: ${DEFAULT_SCREENSHOT_DIR})
  --log-dir <path>   logs and per-run PNG copies (default: ${DEFAULT_REPRO_LOG_DIR})
  --target <name>    capture only this manifest target (repeatable;
                     default: every target the manifest names)
  --runs <N>         runs per target, positive integer (default: ${REPRO_RUN_COUNT})
  -h, --help         show this help

Exit codes: 0 every run matches the manifest and each log verifies,
            1 capture, hash, per-run PNG copy, environment or log verification
              failure,
            2 usage, an unreadable / invalid manifest, or a manifest whose
              recorded environment does not match the fixed capture one.`;

/** Parse the small CLI option set. Unknown options are usage errors. */
export function parseArgs(argv) {
  const options = {
    help: false,
    manifest: DEFAULT_MANIFEST_PATH,
    dir: DEFAULT_SCREENSHOT_DIR,
    logDir: DEFAULT_REPRO_LOG_DIR,
    targets: [],
    runs: REPRO_RUN_COUNT,
  };

  const valued = new Set(['--manifest', '--dir', '--log-dir', '--target', '--runs']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { ...options, help: true };
    }
    if (!valued.has(arg)) {
      throw new ScreenshotReproError(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new ScreenshotReproError(`${arg} needs a value`);
    }
    index += 1;
    if (arg === '--manifest') {
      options.manifest = value;
    } else if (arg === '--dir') {
      options.dir = value;
    } else if (arg === '--log-dir') {
      options.logDir = value;
    } else if (arg === '--target') {
      options.targets.push(validateCaptureTarget(value));
    } else {
      options.runs = normalizeRunCount(value);
    }
  }

  return options;
}

/**
 * Run the CLI and return its exit code.
 *
 * The optional dependencies keep the exit-code / step-summary contract
 * testable without Docker: unit tests inject a fake repro runner, a fake
 * summary file and a capturing logger.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    logger = console,
    runRepro = runScreenshotRepro,
    appendFile = appendFileSync,
    repoRoot = CAPTURE_REPO_ROOT,
  } = {},
) {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  const appendSummary = (text) => {
    if (summaryPath === undefined || summaryPath === '') return;
    appendFile(summaryPath, `${text.trimEnd()}\n`);
  };

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const usage = `error: ${detail}\n\n${USAGE}`;
    logger.error(usage);
    appendSummary(`FAIL: ${detail}`);
    return 2;
  }

  if (options.help) {
    logger.log(USAGE);
    return 0;
  }

  let result;
  try {
    result = await runRepro({
      manifestPath: resolve(repoRoot, options.manifest),
      dir: resolve(repoRoot, options.dir),
      logDir: resolve(repoRoot, options.logDir),
      targets: options.targets,
      runs: options.runs,
      repoRoot,
      env,
      progress: (line) => logger.log?.(line),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `FAIL: screenshot repro could not run: ${detail}`;
    logger.error(message);
    appendSummary(message);
    return error instanceof ScreenshotReproError ? 2 : 1;
  }

  if (result.ok) {
    logger.log(result.report);
  } else {
    logger.error(result.report);
  }
  appendSummary(result.report);
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        `verify:screenshots:repro: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
