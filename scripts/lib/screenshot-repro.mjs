import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
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
 * evidence. The repro entry derives the unique targets from those commands and
 * runs them in the fixed container: by default every target twice, or the
 * `--target` subset for `--runs <N>` repetitions (Issue #328). Each run keeps
 * one capture log and a copy of every manifested PNG, then hashes every
 * manifested file right after the run, and finally checks every run against the
 * manifest and the other runs:
 *
 *   run 1 sha256 == ... == run N sha256 == manifest sha256
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
/** Default number of runs per target when `--runs` is not passed. */
export const REPRO_RUN_COUNT = 2;
/** The existing log-aware verifier the repro entry delegates to. */
export const SHA256_VERIFIER_PATH = 'scripts/verify-screenshot-sha256.mjs';
/** Default number of CPU load worker processes; 0 keeps the repro load-free. */
export const DEFAULT_LOAD_COUNT = 0;
/** How long a load worker gets after SIGTERM before SIGKILL is sent. */
export const LOAD_KILL_GRACE_MS = 5000;
/** The inline script each load worker runs until the repro stops it. */
const LOAD_WORKER_SOURCE = 'let value = 0; for (;;) { value = Math.sqrt(value + 1); }';

const CAPTURE_COMMAND_PREFIX = 'npm run screenshots:container -- ';
const CAPTURE_TARGET_PATTERN = /^screenshots(?::[A-Za-z0-9._-]+)+$/;

/** Raised when the manifest / CLI cannot drive a repro. */
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

/** Validate one `--target` value without requiring the npm command prefix. */
export function validateCaptureTarget(target) {
  const value = typeof target === 'string' ? target.trim() : '';
  if (value === '' || /\s/.test(value) || !CAPTURE_TARGET_PATTERN.test(value)) {
    throw new ScreenshotReproError(
      `invalid repro target ${JSON.stringify(target)}: expected a screenshots npm ` +
        `script such as screenshots:webkit.`,
    );
  }
  return value;
}

/** Parse a `--runs` value: a positive integer, the default is REPRO_RUN_COUNT. */
export function normalizeRunCount(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new ScreenshotReproError(
      `--runs needs a positive integer, got ${JSON.stringify(value)}.`,
    );
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count)) {
    throw new ScreenshotReproError(
      `--runs is too large, got ${JSON.stringify(value)}.`,
    );
  }
  return count;
}

/**
 * Parse a `--load` value: a non-negative integer; 0 disables the load.
 *
 * The CLI default is DEFAULT_LOAD_COUNT, so this parser only accepts a value
 * that was actually passed and rejects an empty or malformed one.
 */
export function normalizeLoadCount(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new ScreenshotReproError(
      `--load needs a non-negative integer (0 disables the load), ` +
        `got ${JSON.stringify(value)}.`,
    );
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count)) {
    throw new ScreenshotReproError(
      `--load is too large, got ${JSON.stringify(value)}.`,
    );
  }
  return count;
}

/**
 * Select the requested manifest targets, in manifest order.
 *
 * No requested targets means every target (the default two-run check). A
 * target that the manifest does not name is a usage error: running it would
 * have nothing to compare against. Duplicate `--target` values are harmless.
 */
export function selectReproPlans(plans, targets = []) {
  if (targets.length === 0) {
    return plans;
  }
  const requested = new Set(targets.map((target) => validateCaptureTarget(target)));
  const available = new Set(plans.map((plan) => plan.target));
  const unknown = [...requested].filter((target) => !available.has(target));
  if (unknown.length > 0) {
    throw new ScreenshotReproError(
      `unknown repro target(s): ${unknown.join(', ')}; the manifest names: ` +
        `${[...available].join(', ')}.`,
    );
  }
  return plans.filter((plan) => requested.has(plan.target));
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

function safeTargetName(target) {
  return target.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/** One log file per target and run, below the ignored log directory. */
export function reproLogPath(logDir, target, run) {
  return resolve(logDir, `${safeTargetName(target)}-run${run}.log`);
}

/**
 * Directory that keeps this run's PNG copies, one per manifested file.
 *
 * A later run deletes and re-captures the shared evidence paths, so the copy is
 * the only way to compare two drifting runs after the whole repro finishes.
 */
export function reproArtifactDir(logDir, target, run) {
  return resolve(logDir, `${safeTargetName(target)}-run${run}-png`);
}

/** Path of one run's retained copy of a manifested PNG. */
export function reproArtifactPath(logDir, target, run, file) {
  return resolve(reproArtifactDir(logDir, target, run), file);
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

/** The argv (after the node executable) that runs one CPU load worker. */
export function loadWorkerArgs() {
  return ['-e', LOAD_WORKER_SOURCE];
}

/**
 * Start `count` CPU-burning child processes and keep them running until stop().
 *
 * The repro entry wraps every selected run in this controller and calls
 * `stop()` from a `finally`, so a normal finish, a failed capture and a thrown
 * exception all reclaim the workers and wait for their exit. Each worker runs
 * an inline infinite loop through `node -e`, so it needs no separate script
 * file; SIGTERM stops it, with SIGKILL as a bounded fallback. Start and stop
 * failures are recorded instead of thrown, so the caller can still report the
 * capture results and the load state together.
 *
 * `spawn`, `logger` and `killGraceMs` are injectable so the unit tests can use
 * fake child processes without putting real CPU load on the host.
 */
export function startCpuLoad({
  count = DEFAULT_LOAD_COUNT,
  spawn: spawnChild = spawn,
  logger = console,
  killGraceMs = LOAD_KILL_GRACE_MS,
} = {}) {
  const requested = normalizeLoadCount(count);
  const workers = [];
  const failures = [];

  for (let index = 0; index < requested; index += 1) {
    const worker = {
      index: index + 1,
      child: null,
      closed: false,
      stopping: false,
      exitedEarly: false,
    };

    let child;
    try {
      child = spawnChild(process.execPath, loadWorkerArgs(), { stdio: 'ignore' });
    } catch (error) {
      failures.push({
        index: worker.index,
        phase: 'start',
        message: errorMessage(error),
      });
      continue;
    }
    worker.child = child;

    child.once('error', (error) => {
      const message = errorMessage(error);
      failures.push({
        index: worker.index,
        phase: child.pid === undefined ? 'start' : 'runtime',
        message,
      });
      // A failed spawn has no process to wait for; a later runtime error (for
      // example a failed kill) must not make stop() skip the real child.
      if (child.pid === undefined) worker.closed = true;
    });
    child.once('exit', (code, signal) => {
      worker.closed = true;
      if (!worker.stopping) {
        worker.exitedEarly = true;
        failures.push({
          index: worker.index,
          phase: 'runtime',
          message:
            `exited before stop (code ${code ?? 'null'}, ` +
            `signal ${signal ?? 'null'})`,
        });
      }
    });
    child.once('close', () => {
      worker.closed = true;
    });
    workers.push(worker);
  }

  const snapshot = () => {
    // A synchronous spawn throw leaves `child` null; an asynchronous spawn
    // error leaves it without a pid. Neither counts as a started worker.
    const spawned = workers.filter(
      (worker) => worker.child !== null && typeof worker.child.pid === 'number',
    );
    const stopped = spawned.filter((worker) => worker.closed).length;
    return {
      requested,
      started: spawned.length,
      stopped,
      exitedEarly: workers.filter((worker) => worker.exitedEarly).length,
      active: spawned.length - stopped,
      failures: failures.map((failure) => ({ ...failure })),
    };
  };

  let stoppedState = null;

  const stop = async () => {
    if (stoppedState !== null) return stoppedState;

    const waits = workers
      .filter((worker) => worker.child !== null && !worker.closed)
      .map((worker) => {
        // Mark first, synchronously: an exit racing with the kill must not be
        // misreported as the worker having died on its own.
        worker.stopping = true;
        return new Promise((resolvePromise) => {
          let done = false;
          let graceTimer = null;
          let hardTimer = null;
          const settle = () => {
            if (done) return;
            done = true;
            if (graceTimer !== null) clearTimeout(graceTimer);
            if (hardTimer !== null) clearTimeout(hardTimer);
            resolvePromise();
          };
          const sendSignal = (signal) => {
            try {
              worker.child.kill(signal);
            } catch (error) {
              failures.push({
                index: worker.index,
                phase: 'stop',
                message: `cannot send ${signal}: ${errorMessage(error)}`,
              });
            }
          };

          worker.child.once('exit', settle);
          worker.child.once('close', settle);
          if (worker.closed) {
            settle();
            return;
          }
          sendSignal('SIGTERM');
          graceTimer = setTimeout(() => {
            if (done) return;
            logger.error?.(
              `load worker ${worker.index} did not exit after SIGTERM; sending SIGKILL`,
            );
            sendSignal('SIGKILL');
          }, killGraceMs);
          hardTimer = setTimeout(() => {
            if (done) return;
            failures.push({
              index: worker.index,
              phase: 'stop',
              message: `did not exit within ${killGraceMs * 2}ms`,
            });
            settle();
          }, killGraceMs * 2);
        });
      });

    await Promise.all(waits);
    // 'exit' can fire before 'close'; one event-loop turn lets the close and
    // reaped-state handlers land before the final snapshot is taken.
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    stoppedState = snapshot();
    return stoppedState;
  };

  return {
    requested,
    get started() {
      return snapshot().started;
    },
    get failures() {
      return snapshot().failures;
    },
    get pids() {
      return workers
        .map((worker) => worker.child?.pid)
        .filter((pid) => typeof pid === 'number');
    },
    snapshot,
    stop,
  };
}

/**
 * Run one target through the existing fixed-container entry.
 *
 * `spawn` is injectable so tests can supply a fake child process instead of
 * launching npm (and therefore Docker).
 */
export function spawnContainerCapture({
  target,
  logPath,
  repoRoot,
  env,
  spawn: spawnChild = spawn,
}) {
  mkdirSync(dirname(logPath), { recursive: true });
  return new Promise((resolvePromise) => {
    let settled = false;
    let streamFailed = false;
    let childExitCode = null;
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
      // 'error' event or silently continue without the transcript. Do not
      // settle here: the capture may still be writing the shared evidence
      // paths, and a following run must not overlap with it.
      streamFailed = true;
      process.stderr.write(`cannot write capture log ${logPath}: ${errorMessage(error)}\n`);
      if (childExitCode !== null) {
        settle(childExitCode);
      }
    });
    const finish = (code) => {
      if (settled) return;
      if (streamFailed) {
        settle(code);
        return;
      }
      // Wait for the log stream's queued writes to reach the filesystem before
      // the caller reads the log and runs the sha256 verifier against it.
      stream.end(() => settle(code));
    };

    let child;
    try {
      child = spawnChild(npmCommand(), captureCommandArgs(target), {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      writeLog(`${errorMessage(error)}\n`);
      childExitCode = 1;
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
      childExitCode = 1;
      finish(1);
    });
    child.once('close', (code) => {
      childExitCode = code ?? 1;
      finish(childExitCode);
    });
  });
}

/**
 * Verify one run log with the existing hash + environment verifier.
 *
 * `spawnSync` is injectable so tests can assert a non-zero verifier exit is
 * mapped to `verifyFailures` without running the real sha256 script.
 */
export function spawnSha256Verifier({
  logPath,
  dir,
  manifestPath,
  repoRoot,
  spawnSync: spawnSyncVerifier = spawnSync,
}) {
  const result = spawnSyncVerifier(
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

/** Short one-line diagnosis for a file whose runs / manifest disagree. */
function differenceDiagnosis(difference) {
  const entries = difference.runHashes ?? [];
  const missing = entries.filter((entry) => entry.sha256 === null);
  if (missing.length > 0) {
    return (
      `${missing.length} of ${entries.length} run(s) did not produce the file; ` +
      'see the capture / log failures above'
    );
  }
  if (new Set(entries.map((entry) => entry.sha256)).size === 1) {
    return 'all runs agree with each other but not with the manifest; refresh the evidence explicitly';
  }
  const drifted = entries
    .filter((entry) => entry.sha256 !== difference.expected)
    .map((entry) => entry.run);
  return (
    `${drifted.length} of ${entries.length} run(s) disagree with the manifest ` +
    `(run ${drifted.join(', ')}); the fixed environment was not stable across runs`
  );
}

/** One-line load state for both the success and the failure report. */
function formatLoadSummary(load) {
  const failureText =
    load.failures.length === 0 ? '' : `, ${load.failures.length} failure(s)`;
  const activeText =
    load.active === 0 ? ' (all exited)' : `, ${load.active} still active`;
  return (
    `${load.started}/${load.requested} CPU worker process(es) started, ` +
    `${load.stopped} stopped${activeText}${failureText}`
  );
}

function formatFailureReport(result) {
  const lines = [];
  lines.push(
    `FAIL: screenshot repro failed: ${result.differences.length} hash difference(s), ` +
      `${result.captureFailures.length} capture failure(s), ` +
      `${result.verifyFailures.length} log verification failure(s), ` +
      `${result.environmentMismatches.length} environment fingerprint mismatch(es), ` +
      `${result.artifactFailures.length} per-run PNG copy failure(s).`,
  );

  if (result.load.requested > 0) {
    lines.push('', `Load: ${formatLoadSummary(result.load)}.`);
    for (const failure of result.load.failures) {
      lines.push(`  worker ${failure.index} (${failure.phase}): ${failure.message}`);
    }
  }

  if (result.differences.length > 0) {
    lines.push('', 'Hash differences:');
    for (const difference of result.differences) {
      lines.push(`  ${difference.file}`);
      lines.push(`    target: ${difference.target}`);
      lines.push(`    expected sha256: ${difference.expected}`);
      for (const entry of difference.runHashes) {
        lines.push(`    run ${entry.run} sha256: ${entry.sha256 ?? 'unavailable'}`);
        lines.push(`    run ${entry.run} log: ${entry.logPath}`);
        lines.push(
          `    run ${entry.run} png: ${entry.copyPath ?? 'not retained'}`,
        );
      }
      lines.push(`    recapture: ${captureCommandFor(difference.target)}`);
      lines.push(`    diagnosis: ${differenceDiagnosis(difference)}`);
    }
  }

  if (result.artifactFailures.length > 0) {
    lines.push('', 'Per-run PNG copy failures:');
    for (const failure of result.artifactFailures) {
      lines.push(
        `  ${failure.target} run ${failure.run}: ${failure.file} -> ` +
          `${failure.path}: ${failure.message}`,
      );
    }
  }

  if (result.captureFailures.length > 0) {
    lines.push('', 'Capture failures:');
    for (const failure of result.captureFailures) {
      const reason =
        typeof failure.failureReason === 'string' && failure.failureReason !== ''
          ? `: ${failure.failureReason}`
          : '';
      lines.push(
        `  ${failure.target} run ${failure.run}: exit ${failure.exitCode}${reason} (log: ${failure.logPath})`,
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
      for (const run of mismatch.runs) {
        lines.push(`    run ${run.run} (log: ${run.logPath}):`);
        lines.push(
          run.fingerprints.length === 0
            ? '      (no capture-env: fingerprint line)'
            : indent(run.fingerprints.join('\n'), '      '),
        );
      }
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
    `OK: screenshot repro passed: ${result.plans.length} target(s) x ${result.runsPerTarget} runs, ` +
      `${result.verifiedFiles} file(s) matched the manifest and each other.`,
    `  manifest: ${result.manifestPath}`,
    `  screenshots: ${result.dir}`,
    `  log directory: ${result.logDir}`,
    `  per-run PNG copies: ${result.logDir}/<target>-run<N>-png/`,
    ...(result.load.requested > 0
      ? [`  load: ${formatLoadSummary(result.load)}`]
      : []),
    '',
    'Per-run sha256:',
  ];
  for (const run of result.runs) {
    const status = run.exitCode === 0 ? 'ok' : `exit ${run.exitCode}`;
    lines.push(`  ${run.target} run ${run.run}: ${status} (log: ${run.logPath})`);
    for (const entry of run.hashes) {
      lines.push(
        `    ${entry.file}: ${entry.sha256 ?? 'unavailable'}` +
          `${entry.copyPath === null ? '' : ` (kept: ${entry.copyPath})`}`,
      );
    }
  }

  lines.push('', 'Per-file summary:');
  for (const plan of result.plans) {
    for (const capture of plan.captures) {
      const entries = result.runs
        .filter((run) => run.target === plan.target)
        .map((run) => ({
          run: run.run,
          sha256: run.hashes.find((entry) => entry.file === capture.file)?.sha256 ?? null,
        }));
      lines.push(`  ${capture.file}: ${capture.sha256} (manifest)`);
      for (const entry of entries) {
        lines.push(
          `    run ${entry.run}: ${entry.sha256 ?? 'unavailable'}` +
            `${entry.sha256 === capture.sha256 ? ' == manifest' : ''}`,
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Run the selected manifest targets `runs` times and report whether every run
 * matches the manifest and the other runs.
 *
 * `runCapture`, `verifyLog`, `spawn`, `spawnSync`, `hashFile`, `readText`,
 * `copyFile`, `mkdir`, `removeFile`, `spawnLoadWorker` and `killGraceMs` are
 * injectable so unit tests can use temporary fixtures instead of Docker, a
 * browser, real CPU load and the real four-minute captures. The real defaults
 * are used by the CLI entry; `spawn` / `spawnSync` feed the default
 * `runCapture` / `verifyLog` and are ignored when those are supplied.
 *
 * `load` keeps `count` CPU worker processes running around every selected run
 * (`0` keeps the default load-free behaviour). The workers are stopped and
 * awaited in a `finally`, so a failed capture or a thrown exception does not
 * leave them behind.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   report: string,
 *   manifestPath: string,
 *   dir: string,
 *   logDir: string,
 *   runsPerTarget: number,
 *   load: {
 *     requested: number,
 *     started: number,
 *     stopped: number,
 *     exitedEarly: number,
 *     active: number,
 *     failures: Array<{ index: number, phase: 'start' | 'stop' | 'runtime', message: string }>,
 *   },
 *   plans: Array<{ target: string, captures: Array<{ file: string, sha256: string }> }>,
 *   runs: Array<{
 *     target: string,
 *     run: number,
 *     logPath: string,
 *     exitCode: number,
 *     fingerprints: string[],
 *     hashes: Array<{
 *       file: string,
 *       sha256: string | null,
 *       error: string | null,
 *       copyPath: string | null,
 *     }>,
 *   }>,
 *   differences: Array<{
 *     file: string,
 *     target: string,
 *     expected: string,
 *     runHashes: Array<{
 *       run: number,
 *       sha256: string | null,
 *       logPath: string,
 *       copyPath: string | null,
 *     }>,
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
 *   artifactFailures: Array<{
 *     target: string,
 *     run: number,
 *     file: string,
 *     path: string,
 *     message: string,
 *   }>,
 *   environmentMismatches: Array<{
 *     target: string,
 *     runs: Array<{ run: number, logPath: string, fingerprints: string[] }>,
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
  targets = [],
  runs: requestedRuns = REPRO_RUN_COUNT,
  load = DEFAULT_LOAD_COUNT,
  env = process.env,
  logger = console,
  progress = () => {},
  readText = (path) => readFileSync(path, 'utf8'),
  hashFile = sha256File,
  copyFile = copyFileSync,
  mkdir = mkdirSync,
  removeFile = (path) => rmSync(path, { force: true }),
  spawn: spawnChild = spawn,
  spawnLoadWorker = spawnChild,
  spawnSync: spawnSyncVerifier = spawnSync,
  killGraceMs = LOAD_KILL_GRACE_MS,
  runCapture = (options) => spawnContainerCapture({ ...options, spawn: spawnChild }),
  verifyLog = (options) => spawnSha256Verifier({ ...options, spawnSync: spawnSyncVerifier }),
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

  const plans = selectReproPlans(deriveReproPlans(manifest), targets);
  const runsPerTarget = normalizeRunCount(requestedRuns);
  mkdir(logDir, { recursive: true });

  const runs = [];
  const captureFailures = [];
  const verifyFailures = [];
  const artifactFailures = [];

  // Start the optional CPU load right before the first capture and stop it
  // in a `finally`, so every selected run sees the same pressure and a
  // failed capture or exception cannot leave the workers running.
  const loadController = startCpuLoad({
    count: load,
    spawn: spawnLoadWorker,
    logger,
    killGraceMs,
  });
  let loadState = loadController.snapshot();

  try {
    for (const plan of plans) {
      for (let run = 1; run <= runsPerTarget; run += 1) {
        const logPath = reproLogPath(logDir, plan.target, run);
        const artifactDir = reproArtifactDir(logDir, plan.target, run);

        // A repeated invocation reuses the same log directory, so this run number
        // may still hold PNG copies from an earlier invocation. Remove them before
        // the capture: if this run fails to write a file, its slot must read as
        // "not retained" instead of exposing stale bytes as if they belonged to
        // this run.
        for (const capture of plan.captures) {
          try {
            removeFile(reproArtifactPath(logDir, plan.target, run, capture.file));
          } catch (error) {
            artifactFailures.push({
              target: plan.target,
              run,
              file: capture.file,
              path: reproArtifactPath(logDir, plan.target, run, capture.file),
              message:
                'cannot remove the stale per-run PNG copy before the capture: ' +
                errorMessage(error),
            });
          }
        }

        // The CI workspace is disposable, so remove the target's manifested
        // files before every run. A capture that silently skips a frozen
        // historical file (the "Refusing to overwrite historical" write guard)
        // then fails with an unavailable hash instead of matching the committed
        // bytes it never refreshed. A local run deletes the same tracked files,
        // so reproduce on a temp copy and use `git restore docs/screenshots`
        // after a failure (docs/screenshots/README.md documents this).
        const removalFailures = [];
        for (const capture of plan.captures) {
          try {
            removeFile(resolve(dir, capture.file));
          } catch (error) {
            removalFailures.push(`${capture.file}: ${errorMessage(error)}`);
          }
        }

        let exitCode;
        let failureReason = null;
        if (removalFailures.length > 0) {
          failureReason =
            'cannot remove stale evidence before the capture: ' + removalFailures.join('; ');
          logger.error?.(`${plan.target} run ${run}: ${failureReason}`);
          exitCode = 1;
        } else {
          try {
            exitCode = await runCapture({ target: plan.target, run, logPath, repoRoot, env, logger });
          } catch (error) {
            logger.error?.(`${plan.target} run ${run}: ${errorMessage(error)}`);
            exitCode = 1;
          }
        }
        if (!Number.isFinite(exitCode)) {
          exitCode = 1;
        }
        const logText = readOptionalText(logPath, readText);

        if (exitCode !== 0) {
          captureFailures.push({ target: plan.target, run, exitCode, logPath, failureReason });
        }

        const hashes = [];
        for (const capture of plan.captures) {
          const filePath = resolve(dir, capture.file);
          let sha256 = null;
          let hashError = null;
          try {
            sha256 = hashFile(filePath);
          } catch (error) {
            hashError = errorMessage(error);
          }

          // Keep this run's bytes before the next run removes and re-captures the
          // shared evidence paths. Without the copy, a drift comparison after the
          // repro finishes would only see the last run.
          let copyPath = null;
          if (sha256 !== null) {
            const artifactPath = reproArtifactPath(logDir, plan.target, run, capture.file);
            try {
              mkdir(artifactDir, { recursive: true });
              copyFile(filePath, artifactPath);
              copyPath = artifactPath;
            } catch (error) {
              artifactFailures.push({
                target: plan.target,
                run,
                file: capture.file,
                path: artifactPath,
                message: errorMessage(error),
              });
            }
          }

          hashes.push({ file: capture.file, sha256, error: hashError, copyPath });
          progress(
            `  ${plan.target} run ${run}: ${capture.file} ` +
              `sha256 ${sha256 ?? 'unavailable'}` +
              `${copyPath === null ? '' : ` (kept: ${copyPath})`}`,
          );
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
  } finally {
    loadState = await loadController.stop();
  }

  const differences = [];
  const environmentMismatches = [];
  for (const plan of plans) {
    const planRuns = runs.filter((run) => run.target === plan.target);
    if (planRuns.length === 0) {
      continue;
    }

    for (const capture of plan.captures) {
      const runHashes = planRuns.map((run) => {
        const entry = run.hashes.find((item) => item.file === capture.file);
        return {
          run: run.run,
          sha256: entry?.sha256 ?? null,
          logPath: run.logPath,
          copyPath: entry?.copyPath ?? null,
        };
      });
      const everyRunMatchesManifest = runHashes.every(
        (entry) => entry.sha256 === capture.sha256,
      );
      const sameAcrossRuns = new Set(runHashes.map((entry) => entry.sha256)).size === 1;
      if (!everyRunMatchesManifest || !sameAcrossRuns) {
        differences.push({
          file: capture.file,
          target: plan.target,
          expected: capture.sha256,
          runHashes,
          run1: runHashes[0]?.sha256 ?? null,
          run2: runHashes[1]?.sha256 ?? null,
          log1: runHashes[0]?.logPath ?? '',
          log2: runHashes[1]?.logPath ?? '',
        });
      }
    }

    const first = planRuns[0];
    if (planRuns.some((run) => !sameLines(first.fingerprints, run.fingerprints))) {
      environmentMismatches.push({
        target: plan.target,
        runs: planRuns.map((run) => ({
          run: run.run,
          logPath: run.logPath,
          fingerprints: run.fingerprints,
        })),
        log1: first.logPath,
        log2: planRuns[1]?.logPath ?? '',
        run1: first.fingerprints,
        run2: planRuns[1]?.fingerprints ?? [],
      });
    }
  }

  const verifiedFiles = plans.reduce((total, plan) => total + plan.captures.length, 0);
  const result = {
    ok:
      differences.length === 0 &&
      captureFailures.length === 0 &&
      verifyFailures.length === 0 &&
      artifactFailures.length === 0 &&
      environmentMismatches.length === 0 &&
      loadState.failures.length === 0 &&
      loadState.active === 0,
    report: '',
    manifestPath,
    dir,
    logDir,
    runsPerTarget,
    load: loadState,
    plans,
    runs,
    differences,
    captureFailures,
    verifyFailures,
    artifactFailures,
    environmentMismatches,
    verifiedFiles,
  };
  result.report = result.ok ? formatSuccessReport(result) : formatFailureReport(result);
  return result;
}
