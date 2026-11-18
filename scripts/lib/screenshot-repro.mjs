import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CAPTURE_REPO_ROOT } from './capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SCREENSHOT_DIR,
  manifestEnvironmentMismatches,
  parseSha256Manifest,
} from './screenshot-sha256.mjs';

/**
 * Nightly two-run reproducibility check for the fixed-container screenshot
 * evidence (Issue #199).
 *
 * The manifest is the source of truth: every `captures[].command` names the
 * `npm run screenshots:container -- <target>` invocation that produced that
 * evidence. The repro entry derives the unique targets from those commands,
 * runs each target twice in a row in the fixed container, records one capture
 * log per run, hashes every manifested file right after each run, and then
 * verifies that both runs equal the manifest:
 *
 *   run 1 sha256 == manifest sha256 == run 2 sha256
 *
 * A run log also has to pass `verify-screenshot-sha256.mjs --log`, so the
 * environment fingerprint printed by the capture runtime is checked the same
 * way a human re-capture would check it.
 *
 * The entry never commits and never accepts a new hash by editing the
 * manifest: it only runs the existing capture scripts (which write their
 * normal evidence paths), and a mismatch is reported (with expected / actual
 * sha256, both logs, the environment fingerprint and the re-capture steps)
 * instead of being accepted. The scheduled workflow uploads the logs and
 * asserts the manifest is still byte-identical.
 */

/** Directory that receives one log per run, next to the container logs. */
export const DEFAULT_REPRO_LOG_DIR = 'test-results/screenshot-repro';
/** Every target is captured this many times, one log per run. */
export const REPRO_RUN_COUNT = 2;
/** The existing log-aware verifier the repro entry delegates to. */
export const SHA256_VERIFIER_PATH = 'scripts/verify-screenshot-sha256.mjs';

const CAPTURE_COMMAND_PREFIX = 'npm run screenshots:container -- ';
const CAPTURE_TARGET_PATTERN = /^screenshots(?::[A-Za-z0-9._-]+)+$/;

/** Raised when the manifest cannot drive a two-run repro. */
export class ScreenshotReproError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenshotReproError';
  }
}

/**
 * The container capture target named by one manifest `command`.
 *
 * The manifest validator in `screenshot-sha256.mjs` already pins each command
 * to the expected `npm run screenshots:container -- <target>` form. This
 * parser is deliberately strict anyway: the repro entry executes a subprocess,
 * so a malformed command must fail instead of being passed to a shell. Only
 * the target is used; the command string itself is never executed.
 */
export function parseCaptureTarget(command) {
  const normalized = typeof command === 'string' ? command.trim() : '';
  if (!normalized.startsWith(CAPTURE_COMMAND_PREFIX)) {
    throw new ScreenshotReproError(
      `cannot derive a repro target from ${JSON.stringify(command)}: expected ` +
        `"${CAPTURE_COMMAND_PREFIX}<target>".`,
    );
  }
  const target = normalized.slice(CAPTURE_COMMAND_PREFIX.length).trim();
  if (target === '' || /\s/.test(target) || !CAPTURE_TARGET_PATTERN.test(target)) {
    throw new ScreenshotReproError(
      `cannot derive a repro target from ${JSON.stringify(command)}: ` +
        `${JSON.stringify(target)} is not a screenshots npm script (e.g. screenshots:webkit).`,
    );
  }
  return target;
}

/**
 * Unique capture targets in manifest order, each with the files it owns.
 *
 * Several manifest entries share one command (the 2048 playing / gameover
 * evidence), so they are grouped instead of capturing that target twice per
 * run. The manifest order is kept so the workflow output is stable.
 */
export function deriveReproPlans(manifest) {
  const plans = new Map();
  for (const capture of manifest.captures) {
    const target = parseCaptureTarget(capture.command);
    let plan = plans.get(target);
    if (plan === undefined) {
      plan = { target, captures: [] };
      plans.set(target, plan);
    }
    plan.captures.push(capture);
  }
  return [...plans.values()];
}

/** One log file per target and run, below the ignored log directory. */
export function reproLogPath(logDir, target, run) {
  const safeTarget = target.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return resolve(logDir, `${safeTarget}-run${run}.log`);
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Read a log the runner may not have created; a missing log is empty. */
function readOptionalText(path, readText) {
  try {
    return readText(path);
  } catch {
    return '';
  }
}

/** The npm argv that invokes one container capture target. */
export function captureCommandArgs(target) {
  return ['run', 'screenshots:container', '--', target];
}

/** The argv (after the node executable) that runs the log-aware verifier. */
export function sha256VerifierArgs({ logPath, dir, manifestPath, repoRoot }) {
  return [
    resolve(repoRoot, SHA256_VERIFIER_PATH),
    '--dir',
    dir,
    '--manifest',
    manifestPath,
    '--log',
    logPath,
  ];
}

/** Run one target through the existing fixed-container entry. */
function spawnContainerCapture({ target, logPath, repoRoot, env }) {
  mkdirSync(dirname(logPath), { recursive: true });
  return new Promise((resolvePromise) => {
    let settled = false;
    let streamFailed = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      resolvePromise(code);
    };
    const stream = createWriteStream(logPath);
    const writeLog = (chunk) => {
      if (!streamFailed) stream.write(chunk);
    };
    stream.once('error', (error) => {
      // An unwritable log must fail the run, not crash with an unhandled
      // 'error' event or silently continue without the transcript.
      streamFailed = true;
      process.stderr.write(`cannot write capture log ${logPath}: ${errorMessage(error)}\n`);
      settle(1);
    });
    const finish = (code) => {
      if (settled) return;
      // Wait for the log stream's queued writes to reach the filesystem before
      // the caller reads the log and runs the sha256 verifier against it.
      stream.end(() => settle(code));
    };

    let child;
    try {
      child = spawn(npmCommand(), captureCommandArgs(target), {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      writeLog(`${errorMessage(error)}\n`);
      finish(1);
      return;
    }

    child.stdout?.on('data', (chunk) => {
      // Stream progress to the step output as well, so a long nightly capture
      // is visible while it runs; the log file keeps the full transcript.
      process.stdout.write(chunk);
      writeLog(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
      writeLog(chunk);
    });
    child.once('error', (error) => {
      writeLog(`${errorMessage(error)}\n`);
      finish(1);
    });
    child.once('close', (code) => {
      finish(code ?? 1);
    });
  });
}

/** Verify one run log with the existing hash + environment verifier. */
function spawnSha256Verifier({ logPath, dir, manifestPath, repoRoot }) {
  const result = spawnSync(
    process.execPath,
    sha256VerifierArgs({ logPath, dir, manifestPath, repoRoot }),
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.error) {
    return { code: 1, stdout: '', stderr: result.error.message };
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The `capture-env:` lines the capture runtime wrote to one run log. */
function environmentLines(logText) {
  return String(logText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('capture-env:'));
}

function sameLines(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function indent(text, prefix = '    ') {
  return String(text)
    .trim()
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function captureCommandFor(target) {
  return `${CAPTURE_COMMAND_PREFIX}${target}`;
}

/** Short one-line diagnosis for a file whose two runs / manifest disagree. */
function differenceDiagnosis(difference) {
  const { expected, run1, run2 } = difference;
  if (run1 === null || run2 === null) {
    return 'a run did not produce the file; see the capture / log failures above';
  }
  if (run1 !== run2 && run1 === expected) {
    return 'run 2 drifted from the manifest; the fixed environment was not stable';
  }
  if (run1 !== run2 && run2 === expected) {
    return 'run 1 drifted from the manifest; the fixed environment was not stable';
  }
  if (run1 === run2) {
    return 'both runs agree with each other but not with the manifest; refresh the evidence explicitly';
  }
  return 'both runs and the manifest disagree; re-capture and review the evidence';
}

function formatFailureReport(result) {
  const lines = [];
  lines.push(
    `FAIL: screenshot repro failed: ${result.differences.length} hash difference(s), ` +
      `${result.captureFailures.length} capture failure(s), ` +
      `${result.verifyFailures.length} log verification failure(s), ` +
      `${result.environmentMismatches.length} environment fingerprint mismatch(es).`,
  );

  if (result.differences.length > 0) {
    lines.push('', 'Hash differences:');
    for (const difference of result.differences) {
      lines.push(`  ${difference.file}`);
      lines.push(`    target: ${difference.target}`);
      lines.push(`    expected sha256: ${difference.expected}`);
      lines.push(`    run 1 sha256: ${difference.run1 ?? 'unavailable'}`);
      lines.push(`    run 2 sha256: ${difference.run2 ?? 'unavailable'}`);
      lines.push(`    run 1 log: ${difference.log1}`);
      lines.push(`    run 2 log: ${difference.log2}`);
      lines.push(`    recapture: ${captureCommandFor(difference.target)}`);
      lines.push(`    diagnosis: ${differenceDiagnosis(difference)}`);
    }
  }

  if (result.captureFailures.length > 0) {
    lines.push('', 'Capture failures:');
    for (const failure of result.captureFailures) {
      lines.push(
        `  ${failure.target} run ${failure.run}: exit ${failure.exitCode} (log: ${failure.logPath})`,
      );
    }
  }

  if (result.verifyFailures.length > 0) {
    lines.push('', 'Log verification failures:');
    for (const failure of result.verifyFailures) {
      lines.push(
        `  ${failure.target} run ${failure.run}: exit ${failure.exitCode} (log: ${failure.logPath})`,
      );
      if (failure.output.trim() !== '') {
        lines.push(indent(failure.output));
      }
    }
  }

  if (result.environmentMismatches.length > 0) {
    lines.push('', 'Environment fingerprint differences:');
    for (const mismatch of result.environmentMismatches) {
      lines.push(`  ${mismatch.target}:`);
      lines.push(`    run 1 (log: ${mismatch.log1}):`);
      lines.push(
        mismatch.run1.length === 0
          ? '      (no capture-env: fingerprint line)'
          : indent(mismatch.run1.join('\n'), '      '),
      );
      lines.push(`    run 2 (log: ${mismatch.log2}):`);
      lines.push(
        mismatch.run2.length === 0
          ? '      (no capture-env: fingerprint line)'
          : indent(mismatch.run2.join('\n'), '      '),
      );
    }
  }

  lines.push('', 'Capture logs:');
  for (const run of result.runs) {
    lines.push(`  ${run.target} run ${run.run}: ${run.logPath}`);
  }

  lines.push(
    '',
    'Environment fingerprints:',
    ...result.runs.flatMap((run) => {
      const fingerprintLines =
        run.fingerprints.length === 0
          ? ['      (no capture-env: fingerprint line)']
          : indent(run.fingerprints.join('\n'), '      ').split('\n');
      return [`  ${run.target} run ${run.run} (log: ${run.logPath}):`, ...fingerprintLines];
    }),
  );

  const affectedTargets = [...new Set(result.differences.map((entry) => entry.target))];
  lines.push('', 'Recapture steps:');
  lines.push('  1. Reproduce locally in the fixed container: npm run verify:screenshots:repro');
  if (affectedTargets.length === 0) {
    lines.push('  2. Re-capture an affected target: npm run screenshots:container -- <target>');
  } else {
    lines.push('  2. Re-capture the affected target(s):');
    for (const target of affectedTargets) {
      lines.push(`     ${target}: ${captureCommandFor(target)}`);
    }
  }
  lines.push(
    '  3. Verify both fresh capture logs: node scripts/verify-screenshot-sha256.mjs --log <log>',
  );
  lines.push(
    '  4. If the new bytes are intended, update docs/screenshots/capture-sha256-manifest.json ' +
      '(sha256 + provenance) and docs/screenshots/README.md in the same explicit ' +
      'evidence-refresh change; this workflow never edits either file.',
  );

  return lines.join('\n');
}

function formatSuccessReport(result) {
  const lines = [
    `OK: screenshot repro passed: ${result.plans.length} target(s) x ${REPRO_RUN_COUNT} runs, ` +
      `${result.verifiedFiles} file(s) matched the manifest and each other.`,
    `  manifest: ${result.manifestPath}`,
    `  screenshots: ${result.dir}`,
    `  log directory: ${result.logDir}`,
  ];
  for (const run of result.runs) {
    const status = run.exitCode === 0 ? 'ok' : `exit ${run.exitCode}`;
    lines.push(`  ${run.target} run ${run.run}: ${status} (log: ${run.logPath})`);
  }
  return lines.join('\n');
}

/**
 * Run every manifest target twice and report whether both runs match.
 *
 * `runCapture`, `verifyLog`, `hashFile`, `readText` and `mkdir` are injectable
 * so unit tests can use temporary fixtures instead of Docker, a browser and the
 * real four-minute captures.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   report: string,
 *   manifestPath: string,
 *   dir: string,
 *   logDir: string,
 *   plans: Array<{ target: string, captures: Array<{ file: string, sha256: string }> }>,
 *   runs: Array<{
 *     target: string,
 *     run: number,
 *     logPath: string,
 *     exitCode: number,
 *     fingerprints: string[],
 *     hashes: Array<{ file: string, sha256: string | null, error: string | null }>,
 *   }>,
 *   differences: Array<{
 *     file: string,
 *     target: string,
 *     expected: string,
 *     run1: string | null,
 *     run2: string | null,
 *     log1: string,
 *     log2: string,
 *   }>,
 *   captureFailures: Array<{ target: string, run: number, exitCode: number, logPath: string }>,
 *   verifyFailures: Array<{
 *     target: string,
 *     run: number,
 *     exitCode: number,
 *     logPath: string,
 *     output: string,
 *   }>,
 *   environmentMismatches: Array<{
 *     target: string,
 *     log1: string,
 *     log2: string,
 *     run1: string[],
 *     run2: string[],
 *   }>,
 *   verifiedFiles: number,
 * }>}
 */
export async function runScreenshotRepro({
  repoRoot = CAPTURE_REPO_ROOT,
  manifestPath = resolve(repoRoot, DEFAULT_MANIFEST_PATH),
  dir = resolve(repoRoot, DEFAULT_SCREENSHOT_DIR),
  logDir = resolve(repoRoot, DEFAULT_REPRO_LOG_DIR),
  env = process.env,
  logger = console,
  readText = (path) => readFileSync(path, 'utf8'),
  hashFile = sha256File,
  mkdir = mkdirSync,
  runCapture = spawnContainerCapture,
  verifyLog = spawnSha256Verifier,
} = {}) {
  let manifest;
  try {
    manifest = parseSha256Manifest(readText(manifestPath), { source: manifestPath });
  } catch (error) {
    throw new ScreenshotReproError(`cannot read the sha256 manifest: ${errorMessage(error)}`);
  }

  const environmentProblems = manifestEnvironmentMismatches(manifest);
  if (environmentProblems.length > 0) {
    throw new ScreenshotReproError(
      `the sha256 manifest does not match the fixed capture environment:\n` +
        environmentProblems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }

  const plans = deriveReproPlans(manifest);
  mkdir(logDir, { recursive: true });

  const runs = [];
  const captureFailures = [];
  const verifyFailures = [];

  for (const plan of plans) {
    for (let run = 1; run <= REPRO_RUN_COUNT; run += 1) {
      const logPath = reproLogPath(logDir, plan.target, run);
      let exitCode;
      try {
        exitCode = await runCapture({ target: plan.target, run, logPath, repoRoot, env, logger });
      } catch (error) {
        logger.error?.(`${plan.target} run ${run}: ${errorMessage(error)}`);
        exitCode = 1;
      }
      if (typeof exitCode !== 'number') {
        exitCode = 1;
      }
      const logText = readOptionalText(logPath, readText);

      if (exitCode !== 0) {
        captureFailures.push({ target: plan.target, run, exitCode, logPath });
      }

      // Assumption: the capture script rewrites the plan's manifested files.
      // A script that intentionally skips a historical file would leave the
      // committed bytes in place and pass; keep such entries out of the repro
      // manifest (the write guard already refuses cross-environment writes).
      const hashes = [];
      for (const capture of plan.captures) {
        try {
          hashes.push({ file: capture.file, sha256: hashFile(resolve(dir, capture.file)), error: null });
        } catch (error) {
          hashes.push({ file: capture.file, sha256: null, error: errorMessage(error) });
        }
      }

      let verified = { code: 0, stdout: '', stderr: '' };
      try {
        verified = await verifyLog({ logPath, dir, manifestPath, repoRoot });
      } catch (error) {
        verified = { code: 1, stdout: '', stderr: errorMessage(error) };
      }
      const output = `${verified.stdout ?? ''}\n${verified.stderr ?? ''}`;
      if (verified.code !== 0) {
        verifyFailures.push({
          target: plan.target,
          run,
          exitCode: verified.code,
          logPath,
          output,
        });
      }

      runs.push({
        target: plan.target,
        run,
        logPath,
        exitCode,
        fingerprints: environmentLines(logText),
        hashes,
      });
    }
  }

  const differences = [];
  const environmentMismatches = [];
  for (const plan of plans) {
    const run1 = runs.find((run) => run.target === plan.target && run.run === 1);
    const run2 = runs.find((run) => run.target === plan.target && run.run === 2);
    if (run1 === undefined || run2 === undefined) {
      continue;
    }

    for (const capture of plan.captures) {
      const first = run1.hashes.find((entry) => entry.file === capture.file);
      const second = run2.hashes.find((entry) => entry.file === capture.file);
      const run1Hash = first?.sha256 ?? null;
      const run2Hash = second?.sha256 ?? null;
      if (run1Hash !== capture.sha256 || run2Hash !== capture.sha256 || run1Hash !== run2Hash) {
        differences.push({
          file: capture.file,
          target: plan.target,
          expected: capture.sha256,
          run1: run1Hash,
          run2: run2Hash,
          log1: run1.logPath,
          log2: run2.logPath,
        });
      }
    }

    if (!sameLines(run1.fingerprints, run2.fingerprints)) {
      environmentMismatches.push({
        target: plan.target,
        log1: run1.logPath,
        log2: run2.logPath,
        run1: run1.fingerprints,
        run2: run2.fingerprints,
      });
    }
  }

  const verifiedFiles = plans.reduce((total, plan) => total + plan.captures.length, 0);
  const result = {
    ok:
      differences.length === 0 &&
      captureFailures.length === 0 &&
      verifyFailures.length === 0 &&
      environmentMismatches.length === 0,
    report: '',
    manifestPath,
    dir,
    logDir,
    plans,
    runs,
    differences,
    captureFailures,
    verifyFailures,
    environmentMismatches,
    verifiedFiles,
  };
  result.report = result.ok ? formatSuccessReport(result) : formatFailureReport(result);
  return result;
}
