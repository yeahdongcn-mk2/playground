/**
 * One-command local online demo (#541): the built static site plus the
 * standalone online Minesweeper room service.
 *
 * The demo is deliberately two plain child processes instead of a container
 * stack, so a machine without Docker can run the same ports the compose unit
 * uses:
 *
 * - the static site on `DEMO_SITE_PORT` (default 8080), served by
 *   `vite preview --strictPort`, and
 * - the room service on `DEMO_ROOM_PORT` (default 8787), started through the
 *   local `tsx` CLI so it runs the same `server/room/main.ts` entry as
 *   `npm run server:room`.
 *
 * `DEMO_ROOM_URL` is handed to the preview child; `vite.config.ts` uses it as
 * the `/ws` proxy target, so the browser keeps opening a same-origin socket
 * and the demo needs no CORS or second public origin. The port and URL
 * contract itself lives in `scripts/lib/demo-config.mjs` (the t1 contract) and
 * is not duplicated here.
 *
 * Startup waits for both `GET <room>/health` and the site entry before
 * printing the addresses. Shutdown is symmetric: SIGINT/SIGTERM ask both
 * children to stop together and wait for both to exit, so neither port is left
 * behind. A child that exits on its own while the demo runs is a failure; the
 * other child is stopped and the process exits non-zero.
 *
 * Environment resolution, the commands, readiness and shutdown all take
 * injected dependencies, so `tests/unit/run-demo.test.ts` exercises them with
 * fake children and never starts a server.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_DEMO_HOST,
  DEMO_WS_PATH,
  resolveDemoConfig,
} from './lib/demo-config.mjs';

/** Repository root, derived from this file rather than the caller's cwd. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Build output that must exist before `vite preview` can serve the site. */
export const DEMO_DIST_ENTRY = join('dist', 'index.html');

/** How long startup may take before the demo gives up. */
export const DEMO_READY_TIMEOUT_MS = 60_000;

/** Delay between readiness probes. */
export const DEMO_PROBE_INTERVAL_MS = 250;

/** Upper bound for one readiness probe, so a stuck socket cannot hang startup. */
export const DEMO_PROBE_TIMEOUT_MS = 1_000;

/** How long a child may ignore SIGTERM before it is force-killed. */
export const DEMO_KILL_TIMEOUT_MS = 5_000;

/** npm's executable name; the `.cmd` shim is what Windows can spawn. */
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Local Vite CLI, invoked through Node so no shell shim is involved. */
const VITE_ENTRY = join('node_modules', 'vite', 'bin', 'vite.js');

/** Local tsx CLI, invoked through Node for the same reason. */
const TSX_ENTRY = join('node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * One command run by the demo.
 *
 * `env` is the complete child environment, not a patch, so a caller can
 * inspect exactly what the process receives.
 */
function demoCommand(label, command, args, env, shell = false) {
  return Object.freeze({
    label,
    command,
    args: Object.freeze(args),
    env: Object.freeze({ ...env }),
    shell,
  });
}

/**
 * Resolve the complete demo plan from an environment map.
 *
 * `DEMO_SITE_PORT`, `DEMO_ROOM_PORT` and `DEMO_ROOM_URL` are parsed by the
 * shared contract, which also rejects invalid values with a readable error.
 * The room child always binds loopback on the resolved room port, and the
 * preview child always receives the resolved room origin for its `/ws` proxy,
 * so overriding only one of the ports cannot leave the pair pointing at
 * different services.
 */
export function createDemoPlan(env = process.env, cwd = REPO_ROOT) {
  const config = resolveDemoConfig(env);
  const roomPort = String(config.roomPort);
  const sitePort = String(config.sitePort);

  return Object.freeze({
    cwd,
    config,
    distEntry: join(cwd, DEMO_DIST_ENTRY),
    build: demoCommand(
      'site build',
      NPM_COMMAND,
      ['run', 'build'],
      env,
      process.platform === 'win32',
    ),
    room: demoCommand(
      'room service',
      process.execPath,
      [join(cwd, TSX_ENTRY), 'server/room/main.ts'],
      { ...env, HOST: DEFAULT_DEMO_HOST, PORT: roomPort },
    ),
    preview: demoCommand(
      'preview site',
      process.execPath,
      [
        join(cwd, VITE_ENTRY),
        'preview',
        '--host',
        DEFAULT_DEMO_HOST,
        '--port',
        sitePort,
        '--strictPort',
      ],
      { ...env, DEMO_ROOM_URL: config.roomUrl },
    ),
  });
}

/** Resolve once a child exits; report its actual exit code and signal. */
function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    const onError = (error) => {
      child.removeListener('exit', onExit);
      reject(error);
    };
    const onExit = (code, signal) => {
      child.removeListener('error', onError);
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

/**
 * Run `npm run build` before the demo when `dist/index.html` is missing.
 *
 * The build inherits stdio so the user sees the normal Vite output; a
 * non-zero exit stops the demo before either server starts.
 */
export async function runDemoBuild(
  plan,
  { spawnImpl = spawn, stdout = process.stdout } = {},
) {
  stdout.write(
    `${plan.distEntry} is missing; running npm run build before starting the demo.\n`,
  );

  const child = spawnImpl(plan.build.command, plan.build.args, {
    cwd: plan.cwd,
    env: plan.build.env,
    stdio: 'inherit',
    shell: plan.build.shell,
  });
  const { code, signal } = await waitForExit(child);

  if (code !== 0) {
    throw new Error(
      `The site build failed (exit code ${code}, signal ${signal ?? 'none'}). ` +
        'Run npm run build to see the error; the demo did not start.',
    );
  }
}

/**
 * Poll the room health URL and the site entry until both answer `200`.
 *
 * Each probe is bounded by `probeTimeoutMs`, and a probe is retried until the
 * overall deadline. The returned error names the URLs that never became
 * ready, which is enough to tell a room-service startup failure from a site
 * one; the children's own logs are already on the terminal.
 */
export async function waitForDemoReady(
  plan,
  {
    fetchImpl = fetch,
    sleep = delay,
    now = Date.now,
    timeoutMs = DEMO_READY_TIMEOUT_MS,
    probeIntervalMs = DEMO_PROBE_INTERVAL_MS,
    probeTimeoutMs = DEMO_PROBE_TIMEOUT_MS,
    signal,
  } = {},
) {
  const pending = [
    { label: 'room service', url: plan.config.healthUrl },
    { label: 'demo site', url: plan.config.siteUrl },
  ];
  const deadline = now() + timeoutMs;

  while (pending.length > 0) {
    if (signal?.aborted) {
      return;
    }

    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const probe = pending[index];
      try {
        const response = await fetchImpl(probe.url, {
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (response.ok) {
          pending.splice(index, 1);
        }
      } catch {
        // Not ready yet; retry until the deadline.
      }
    }

    if (pending.length === 0 || signal?.aborted) {
      return;
    }
    if (now() >= deadline) {
      const waiting = pending
        .map((probe) => `${probe.label} (${probe.url})`)
        .join(', ');
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${waiting}. ` +
          'Check the process output above for the port or startup error.',
      );
    }
    await sleep(probeIntervalMs);
  }
}

/**
 * Resolve `true` when every exit settles before `timeoutMs`, else `false`.
 *
 * The timer is unref'd so a stopped demo does not keep the event loop alive
 * for the remainder of the kill timeout after a clean shutdown.
 */
function waitForAllExits(exits, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    Promise.all(exits).then(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Stop every running child together and wait until both have exited.
 *
 * Both children get SIGTERM in the same turn, then the function waits for all
 * exits (not just the first), which is what releases the site and room ports.
 * A child that ignores SIGTERM is force-killed before the timeout is reported
 * as a warning. Already-exited children are skipped, so the same helper works
 * after an unexpected exit.
 */
export async function stopDemo(
  children,
  { killTimeoutMs = DEMO_KILL_TIMEOUT_MS, stderr = process.stderr } = {},
) {
  const running = children.filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  if (running.length === 0) {
    return;
  }

  // Attach exit listeners before signalling so an exit that wins the race with
  // `kill()` is still observed instead of leaving a dangling promise.
  const exits = running.map((child) => waitForExit(child).catch(() => undefined));
  for (const child of running) {
    try {
      child.kill('SIGTERM');
    } catch (error) {
      stderr.write(
        `Could not send SIGTERM to ${String(error)}; waiting for the process anyway.\n`,
      );
    }
  }

  if (await waitForAllExits(exits, killTimeoutMs)) {
    return;
  }

  const stubborn = running.filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  stderr.write(
    `One or more demo processes ignored SIGTERM after ${killTimeoutMs} ms; force-killing them.\n`,
  );
  for (const child of stubborn) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited between the check and the kill.
    }
  }
  await waitForAllExits(
    stubborn.map((child) => waitForExit(child).catch(() => undefined)),
    killTimeoutMs,
  );
}

/**
 * Register the two shutdown signals and expose a one-shot stop promise.
 *
 * `dispose()` removes the listeners, so a failed startup or a finished demo
 * leaves no handlers behind in a test process or a repeated caller.
 */
export function createDemoStopSignal(signals = process) {
  let dispose = () => {};
  const promise = new Promise((resolve) => {
    const stop = () => resolve(undefined);
    const onInterrupt = () => stop();
    const onTerminate = () => stop();
    signals.once('SIGINT', onInterrupt);
    signals.once('SIGTERM', onTerminate);
    dispose = () => {
      signals.removeListener('SIGINT', onInterrupt);
      signals.removeListener('SIGTERM', onTerminate);
    };
  });

  return { promise, dispose };
}

/** The addresses printed once both probes succeed. */
function readyMessage(plan) {
  const { config } = plan;
  return [
    'Demo ready:',
    `  site:      ${config.siteUrl}`,
    `  room:      ${config.roomUrl}`,
    `  health:    ${config.healthUrl}`,
    `  websocket: ${config.siteUrl}${DEMO_WS_PATH} (proxied to ${config.roomUrl})`,
    'Press Ctrl-C to stop both processes.',
    '',
  ].join('\n');
}

/** Human-readable message for any thrown value. */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start the demo and keep it running until SIGINT/SIGTERM.
 *
 * Returns `{ plan, code: 0 }` after a signal-triggered shutdown. Startup
 * failures and unexpected child exits throw after both children are stopped;
 * the CLI wrapper turns that into a non-zero exit code.
 *
 * Every dependency that talks to the outside world is injectable:
 * `spawnImpl`, `exists`, `fetchImpl`, `sleep`, `now`, `stdout`, `stderr` and
 * `signals`. That is what lets the unit test drive fake children, fake
 * readiness responses and a fake signal emitter without opening a port.
 */
export async function runDemo(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? REPO_ROOT;
  const spawnImpl = options.spawnImpl ?? spawn;
  const exists = options.exists ?? existsSync;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signals = options.signals ?? process;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEMO_READY_TIMEOUT_MS;
  const probeIntervalMs = options.probeIntervalMs ?? DEMO_PROBE_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEMO_PROBE_TIMEOUT_MS;
  const killTimeoutMs = options.killTimeoutMs ?? DEMO_KILL_TIMEOUT_MS;

  const plan = createDemoPlan(env, cwd);

  if (!exists(plan.distEntry)) {
    await runDemoBuild(plan, { spawnImpl, stdout });
  }

  const children = [];
  let stopping = false;
  let failStartup;
  const failed = new Promise((_, reject) => {
    failStartup = reject;
  });
  // Abort readiness polling when a child fails or a stop signal wins, so a
  // failed startup does not keep the process alive until the readiness timeout.
  const readinessAbort = new AbortController();

  /** Record the first unexpected failure; later children are stopped by runDemo. */
  const fail = (error) => {
    if (stopping) {
      return;
    }
    readinessAbort.abort();
    failStartup(error);
  };

  const spawnChild = (spec) => {
    stdout.write(`Starting ${spec.label}...\n`);
    const child = spawnImpl(spec.command, spec.args, {
      cwd: plan.cwd,
      env: spec.env,
      stdio: 'inherit',
      shell: spec.shell,
    });
    children.push(child);

    child.once('error', (error) => {
      fail(
        new Error(`Could not start the ${spec.label}: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once('exit', (code, signal) => {
      fail(
        new Error(
          `The ${spec.label} exited unexpectedly (exit code ${code}, ` +
            `signal ${signal ?? 'none'}).`,
        ),
      );
    });
    return child;
  };

  const stopSignal = createDemoStopSignal(signals);
  try {
    // Both servers start in the same turn; readiness then probes them in
    // parallel-ish (one bounded request at a time) until both answer.
    spawnChild(plan.room);
    spawnChild(plan.preview);

    const first = await Promise.race([
      waitForDemoReady(plan, {
        fetchImpl,
        sleep,
        now,
        timeoutMs: readyTimeoutMs,
        probeIntervalMs,
        probeTimeoutMs,
        signal: readinessAbort.signal,
      }).then(() => 'ready'),
      stopSignal.promise.then(() => 'stopped'),
      failed,
    ]);

    if (first === 'ready') {
      stdout.write(readyMessage(plan));
      await Promise.race([stopSignal.promise, failed]);
    } else {
      // The signal won the race; stop the readiness poll as well.
      readinessAbort.abort();
    }
  } catch (error) {
    stopping = true;
    readinessAbort.abort();
    stopSignal.dispose();
    await stopDemo(children, { killTimeoutMs, stderr });
    throw error;
  }

  stopping = true;
  stopSignal.dispose();
  await stopDemo(children, { killTimeoutMs, stderr });
  stdout.write('Demo stopped; both ports are released.\n');
  return { plan, code: 0 };
}

/**
 * CLI entry point: run the demo and map any failure to exit code 1.
 *
 * The signal path already returns normally after both children exit, so a
 * Ctrl-C is a successful stop, while a build failure, a startup error or a
 * crashed child sets a non-zero `process.exitCode`.
 */
export async function main(env = process.env, options = {}) {
  try {
    return await runDemo({ ...options, env });
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
    return { plan: null, code: 1 };
  }
}

/** True only when this module is the file Node was asked to run. */
function isDirectExecution() {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main();
}
