#!/usr/bin/env node
/**
 * Install Playwright browsers for CI with bounded retries and diagnostics.
 *
 * The browsers to install are the CLI arguments (for example `webkit`), so a
 * job that only needs one engine can reuse the same bounded install. With no
 * arguments it installs Chromium and WebKit.
 *
 * This is the bounded fallback kept by Issue #213. Both the PR `verify` job and
 * the scheduled `.github/workflows/flake-watch.yml` job now run in the pinned
 * official Playwright image and no longer install browsers, so no workflow
 * invokes this wrapper. It stays as a tested rollback path: remove the job's
 * `container:` block first (the image's `PLAYWRIGHT_BROWSERS_PATH` would
 * otherwise redirect the browsers away from the cache), then re-add the
 * `webkit` install step with step-level `timeout-minutes: 8` to restore the
 * bounded-install behavior from Issue #202.
 *
 * GitHub's ubuntu runners intermittently fail inside
 * `npx playwright install --with-deps ...` while apt resolves or fetches from
 * the Ubuntu mirrors. Before this wrapper existed such an attempt could spend
 * the whole job timeout (20 minutes in `ci.yml`, 30 in `flake-watch.yml`)
 * without installing a single browser. The wrapper now:
 *
 * 1. runs the install at most MAX_ATTEMPTS times,
 * 2. gives every attempt its own per-attempt timeout,
 * 3. terminates the whole process group (so apt goes away too) on timeout,
 * 4. retries with a backoff,
 * 5. prints node/npm/Playwright versions, the ~/.cache/ms-playwright
 *    contents and apt DNS/404 hints when an attempt fails.
 *
 * The rollback step should set `timeout-minutes: 8`, so the worst case here
 * (2 * 180s + backoff + kill grace) still exits before the step timeout and
 * long before the job timeout.
 *
 * The timeout, retry delay, SIGTERM grace, post-SIGKILL group-settle wait and
 * root-kill escalation can be tuned through PLAYWRIGHT_INSTALL_TIMEOUT_MS,
 * PLAYWRIGHT_INSTALL_RETRY_DELAY_MS, PLAYWRIGHT_INSTALL_KILL_GRACE_MS,
 * PLAYWRIGHT_INSTALL_GROUP_SETTLE_MS and PLAYWRIGHT_INSTALL_SUDO_KILL=0; the
 * unit tests use them to exercise the retry and timeout paths quickly and
 * without passwordless sudo.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const INSTALL_COMMAND = 'npx';
const DEFAULT_BROWSERS = ['chromium', 'webkit'];
/** Browsers named on the command line, or both engines when none are named. */
const BROWSERS = process.argv.slice(2).filter((arg) => arg.trim() !== '');
const INSTALL_BROWSERS = BROWSERS.length > 0 ? BROWSERS : DEFAULT_BROWSERS;
const INSTALL_ARGS = ['playwright', 'install', '--with-deps', ...INSTALL_BROWSERS];
const BROWSER_LABEL = INSTALL_BROWSERS.join(' + ');
const MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
/** Time allowed for a SIGKILLed group to disappear before a retry. */
const DEFAULT_GROUP_SETTLE_MS = 1_000;

const APT_FAILURE_PATTERN =
  /Temporary failure resolving|Could not resolve|Failed to fetch|404\s+Not Found|Could not get lock|exit code:?\s*100/i;

/** Read a positive integer env override, falling back for unset/invalid values. */
function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(
      `[install-playwright-ci] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`,
    );
    return fallback;
  }
  return value;
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Read an installed package version without starting another npx process. */
function readPackageVersion(name) {
  for (const base of [ROOT, process.cwd()]) {
    const path = join(base, 'node_modules', ...name.split('/'), 'package.json');
    try {
      const version = JSON.parse(readFileSync(path, 'utf8')).version;
      if (typeof version === 'string' && version.length > 0) return version;
    } catch {
      // Try the next candidate, then report the version as unknown.
    }
  }
  return 'unknown';
}

function readNpmVersion() {
  const userAgent = process.env.npm_config_user_agent ?? '';
  const match = /\bnpm\/(\S+)/.exec(userAgent);
  if (match?.[1] !== undefined) return match[1];

  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return result.stdout?.trim() || 'unknown';
}

function describePlaywrightVersion() {
  const parts = [];
  for (const name of ['@playwright/test', 'playwright-core']) {
    const version = readPackageVersion(name);
    if (version !== 'unknown') parts.push(`${name} ${version}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

/** Describe the restored browser cache so a cache miss is visible in the log. */
function describeBrowserCache() {
  const dir = join(homedir(), '.cache', 'ms-playwright');
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort();
    return {
      dir,
      detail: entries.length === 0 ? 'empty' : `${entries.length} entries: ${entries.join(', ')}`,
    };
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const detail =
      code === 'ENOENT'
        ? 'missing'
        : `unreadable (${error instanceof Error ? error.message : String(error)})`;
    return { dir, detail };
  }
}

function aptFailureHint(output) {
  if (!APT_FAILURE_PATTERN.test(output)) return null;
  return (
    'apt/DNS or mirror failure detected (Temporary failure resolving, apt 404 or exit 100); ' +
    'this is usually a transient GitHub runner or Ubuntu mirror problem. The wrapper retried ' +
    'with backoff; if it keeps failing, re-run the job or check the apt sources. Browsers are ' +
    'reused from ~/.cache/ms-playwright when the cache key matches package-lock.json.'
  );
}

function printDiagnostics({ attempt, attempts, elapsedMs, output }) {
  const cache = describeBrowserCache();
  console.error(
    `[install-playwright-ci] attempt ${attempt}/${attempts} failed after ${formatDuration(elapsedMs)}`,
  );
  console.error(
    `[install-playwright-ci] node ${process.version}; npm ${readNpmVersion()}; ` +
      `Playwright ${describePlaywrightVersion()}`,
  );
  console.error(`[install-playwright-ci] ${cache.dir}: ${cache.detail}`);

  const hint = aptFailureHint(output);
  if (hint !== null) {
    console.error(`[install-playwright-ci] hint: ${hint}`);
  }
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }

  try {
    // The child was spawned detached, so its PID is also its process-group id;
    // the negative PID reaches npx, Playwright and apt/apt-get together.
    process.kill(-child.pid, signal);
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'ESRCH') child.kill(signal);
  }
}

/**
 * `playwright install --with-deps` runs apt through sudo, so apt is owned by
 * root and cannot be signalled by the runner user. Passwordless sudo is what
 * Playwright already needs on ubuntu-latest; use it as a best-effort escalation
 * for the same process group. A failure is only reported if the group is still
 * visible after SIGKILL (see the timeout path). Tests disable it because they
 * run without passwordless sudo.
 */
function sudoKillProcessGroup(pgid, signal) {
  if (process.platform !== 'linux') return;
  if (process.getuid?.() === 0) return;
  if (process.env.PLAYWRIGHT_INSTALL_SUDO_KILL === '0') return;

  spawnSync('sudo', ['-n', 'kill', `-${signal}`, '--', `-${pgid}`], {
    stdio: 'ignore',
    timeout: 5_000,
  });
}

/**
 * A group still visible after SIGKILL (EPERM counts as still alive).
 *
 * `kill(-pgid, 0)` also reports an unreaped zombie as alive. In a CI container
 * PID 1 may not reap orphans promptly, so a SIGKILLed group can linger as
 * zombies for the whole settle window and make the wrapper skip the retry.
 * On Linux, confirm with /proc that at least one non-zombie process is left.
 */
function isProcessGroupAlive(pgid) {
  if (pgid === undefined) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'EPERM') return false;
  }

  if (process.platform !== 'linux') return true;

  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      } catch {
        continue;
      }
      const close = stat.lastIndexOf(')');
      if (close === -1) continue;
      // /proc/<pid>/stat after the comm field: state, ppid, pgrp.
      const fields = stat.slice(close + 2).split(' ');
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === pgid && state !== 'Z') return true;
    }
    return false;
  } catch {
    // If /proc is unreadable, keep the conservative kill(0) answer.
    return true;
  }
}

/**
 * The runner can cancel this wrapper through the step/job timeout while npx and
 * apt are still running. Because the install gets its own process group, the
 * wrapper must forward the signal; otherwise the detached apt/apt-get survives
 * the step and keeps the dpkg lock.
 */
let activeChild = null;
let activeKillGraceMs = DEFAULT_KILL_GRACE_MS;

function shutdownFromSignal(signal) {
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  console.error(
    `[install-playwright-ci] received ${signal}; terminating the Playwright/apt process group`,
  );

  const child = activeChild;
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    process.exit(exitCode);
  }

  signalProcessGroup(child, 'SIGTERM');
  if (child.pid !== undefined) sudoKillProcessGroup(child.pid, 'TERM');
  const forceExit = setTimeout(() => {
    console.error(
      `[install-playwright-ci] still running ${formatDuration(activeKillGraceMs)} after ` +
        `${signal}; sending SIGKILL to the process group`,
    );
    signalProcessGroup(child, 'SIGKILL');
    if (child.pid !== undefined) sudoKillProcessGroup(child.pid, 'KILL');
    process.exit(exitCode);
  }, activeKillGraceMs);

  child.once('close', () => {
    clearTimeout(forceExit);
    process.exit(exitCode);
  });
}

process.once('SIGTERM', () => shutdownFromSignal('SIGTERM'));
process.once('SIGINT', () => shutdownFromSignal('SIGINT'));

/**
 * Run one install attempt and resolve with its outcome. On timeout the whole
 * process group gets SIGTERM first and SIGKILL after the grace period.
 */
function runAttempt({ attempt, attempts, timeoutMs, killGraceMs, groupSettleMs }) {
  const startedAt = Date.now();

  return new Promise((resolveAttempt) => {
    let settled = false;
    let timedOut = false;
    let abandoned = false;
    let output = '';
    let timeoutTimer;
    let killTimer;
    let finishTimer;
    let closeStatus = null;
    let closeSignal = null;
    let child;

    const appendOutput = (chunk) => {
      output = (output + chunk).slice(-16_000);
    };

    const settle = (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      if (activeChild === child) activeChild = null;
      resolveAttempt({
        attempt,
        status,
        signal,
        error,
        timedOut,
        abandoned,
        output,
        elapsedMs: Date.now() - startedAt,
      });
    };

    try {
      child = spawn(INSTALL_COMMAND, INSTALL_ARGS, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      settle(null, null, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    activeChild = child;
    child.stdout?.on('data', (chunk) => {
      appendOutput(String(chunk));
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      appendOutput(String(chunk));
      process.stderr.write(chunk);
    });
    child.once('error', (error) => settle(null, null, error));
    child.once('close', (status, signal) => {
      closeStatus = status;
      closeSignal = signal;
      // After a timeout keep the escalation timers running: the direct child
      // closing does not prove that its root-owned apt descendants are gone.
      if (!timedOut) settle(status, signal);
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      const pgid = child.pid;
      console.error(
        `[install-playwright-ci] attempt ${attempt}/${attempts} timed out after ` +
          `${formatDuration(timeoutMs)}; sending SIGTERM to process group ${pgid ?? 'unknown'}`,
      );
      signalProcessGroup(child, 'SIGTERM');
      if (pgid !== undefined) sudoKillProcessGroup(pgid, 'TERM');

      killTimer = setTimeout(() => {
        console.error(
          `[install-playwright-ci] attempt ${attempt}/${attempts} still running ` +
            `${formatDuration(killGraceMs)} after SIGTERM; sending SIGKILL`,
        );
        signalProcessGroup(child, 'SIGKILL');
        if (pgid !== undefined) sudoKillProcessGroup(pgid, 'KILL');

        // Give the killed group a moment to disappear, then settle even if the
        // direct child already closed. A group that is still visible after
        // SIGKILL (for example root-owned apt) must not race the next attempt.
        finishTimer = setTimeout(() => {
          if (pgid !== undefined && isProcessGroupAlive(pgid)) {
            abandoned = true;
            console.error(
              `[install-playwright-ci] process group ${pgid} is still alive after SIGKILL ` +
                '(sudo escalation may have failed); not retrying',
            );
          }
          // Unref/destroy so an unkillable group cannot keep the wrapper alive.
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          settle(closeStatus, closeSignal);
        }, groupSettleMs);
      }, killGraceMs);
    }, timeoutMs);
  });
}

async function main() {
  const attempts = MAX_ATTEMPTS;
  const timeoutMs = readPositiveInteger('PLAYWRIGHT_INSTALL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const retryDelayMs = readPositiveInteger(
    'PLAYWRIGHT_INSTALL_RETRY_DELAY_MS',
    DEFAULT_RETRY_DELAY_MS,
  );
  const killGraceMs = readPositiveInteger(
    'PLAYWRIGHT_INSTALL_KILL_GRACE_MS',
    DEFAULT_KILL_GRACE_MS,
  );
  const groupSettleMs = readPositiveInteger(
    'PLAYWRIGHT_INSTALL_GROUP_SETTLE_MS',
    DEFAULT_GROUP_SETTLE_MS,
  );
  activeKillGraceMs = killGraceMs;
  const programStartedAt = Date.now();

  console.log(
    `[install-playwright-ci] installing ${BROWSER_LABEL} with ` +
      `"${INSTALL_COMMAND} ${INSTALL_ARGS.join(' ')}" ` +
      `(attempts: ${attempts}, per-attempt timeout: ${formatDuration(timeoutMs)})`,
  );

  let timedOut = false;
  let attemptsRun = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsRun = attempt;
    console.log(`[install-playwright-ci] attempt ${attempt}/${attempts} started`);
    const result = await runAttempt({ attempt, attempts, timeoutMs, killGraceMs, groupSettleMs });
    timedOut = timedOut || result.timedOut;

    if (result.status === 0 && !result.timedOut && result.error === undefined) {
      console.log(
        `[install-playwright-ci] ${BROWSER_LABEL} installed successfully in ` +
          `${formatDuration(result.elapsedMs)}`,
      );
      return 0;
    }

    printDiagnostics({ ...result, attempts });
    if (result.error !== undefined) {
      console.error(`[install-playwright-ci] spawn error: ${result.error.message}`);
    } else if (result.timedOut) {
      console.error(
        `[install-playwright-ci] attempt ${attempt}/${attempts} exceeded its own ` +
          `${formatDuration(timeoutMs)} timeout`,
      );
    } else {
      console.error(
        `[install-playwright-ci] attempt ${attempt}/${attempts} exited with status ` +
          `${result.status ?? 'null'}${result.signal === null ? '' : ` (signal ${result.signal})`}`,
      );
    }

    if (result.abandoned) {
      console.error(
        '[install-playwright-ci] not retrying: the previous process group survived SIGKILL',
      );
      break;
    }

    if (attempt < attempts) {
      const backoffMs = retryDelayMs * 2 ** (attempt - 1);
      console.error(`[install-playwright-ci] retrying in ${formatDuration(backoffMs)}`);
      await delay(backoffMs);
    }
  }

  console.error(
    `[install-playwright-ci] FAILED after ${attemptsRun} attempt${attemptsRun === 1 ? '' : 's'} ` +
      `in ${formatDuration(Date.now() - programStartedAt)}`,
  );
  console.error(
    '[install-playwright-ci] next steps: re-run the CI job; transient runner DNS/apt mirror ' +
      'failures usually clear. If it repeats, check the apt sources and whether the Playwright ' +
      'browser cache was restored.',
  );
  return timedOut ? 124 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    `[install-playwright-ci] unexpected error: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exitCode = 1;
}
