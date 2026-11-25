import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createNetServer, connect, type Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NPM = 'npm';

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface CapturedOutput {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly spawnError: () => Error | undefined;
  /** Resolves after both stdio streams are drained and closed. */
  readonly closed: Promise<void>;
}

const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child)));
});

/** True once the child has exited, normally or through a signal. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Start capturing a child's pipes and remember any spawn failure. */
function captureOutput(child: ChildProcess): CapturedOutput {
  let stdout = '';
  let stderr = '';
  let spawnError: Error | undefined;
  const closed = new Promise<void>((resolveClose) => {
    // 'close' fires after the stdio streams are drained, so output read after
    // this promise settles is complete even for a process that exited early.
    child.once('close', () => resolveClose());
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  // A failed spawn emits 'error' on the child; without a listener Node would
  // surface it as an uncaught exception instead of a readable test failure.
  child.once('error', (error: Error) => {
    spawnError = error;
  });

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    spawnError: () => spawnError,
    closed,
  };
}

function spawnRoomProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): ChildProcess {
  const child = spawn(command, [...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      ...env,
    },
    // A detached child is its own process-group leader. npm does not forward
    // SIGTERM, so the group is what the tests signal and clean up.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.once('exit', () => {
    const index = children.indexOf(child);
    if (index >= 0) {
      children.splice(index, 1);
    }
  });
  return child;
}

/** Send a signal to the child's process group, falling back to the child. */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // The group may already be gone; fall through to a direct kill.
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/**
 * Force-stop everything a failed assertion left running.
 *
 * The group is signalled even when the leader already exited: in the npm case
 * the leader can die from SIGTERM while the tsx/node server keeps the group
 * (and the temp port) alive. Cleanup failures are warned about instead of
 * silently swallowed.
 */
async function stopChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: the whole group is already gone.
  }
  if (!hasExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited between the check and the kill.
    }
  }
  await waitForExit(child, 5_000).catch(() => undefined);
  await waitForProcessGroupGone(pid, 5_000).catch((error: unknown) => {
    console.warn(
      `room-server test cleanup could not verify process group ${pid}: ${errorText(error)}`,
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  if (hasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    };
    child.once('exit', onExit);
  });
}

/** Bind and release an ephemeral port so the process tests get a free one. */
async function freePort(): Promise<number> {
  const server: Server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

/** Describe how a failed child left the world, for readable assertion errors. */
function exitState(child: ChildProcess): string {
  if (child.signalCode !== null) {
    return `was terminated by ${child.signalCode}`;
  }
  if (child.exitCode !== null) {
    return `exited with code ${child.exitCode}`;
  }
  return 'is still running';
}

function unreachableDetail(
  child: ChildProcess,
  output: CapturedOutput,
  phase: string,
): string {
  return (
    `room server ${phase} (${exitState(child)}).\n` +
    `stdout:\n${output.stdout()}\n` +
    `stderr:\n${output.stderr()}`
  );
}

/**
 * Poll `/health` until it answers, failing fast when the child dies or its
 * spawn fails. The actual JSON body is asserted by the caller.
 */
async function waitForHealth(
  child: ChildProcess,
  output: CapturedOutput,
  port: number,
  timeoutMs = 30_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const error = output.spawnError();
    if (error !== undefined) {
      throw error;
    }
    if (hasExited(child)) {
      throw new Error(unreachableDetail(child, output, 'exited before /health answered'));
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        return response;
      }
      lastError = new Error(`/health answered ${response.status}`);
    } catch (caught) {
      lastError = caught;
    }
    await delay(50);
  }
  throw new Error(
    `${unreachableDetail(child, output, 'never answered /health')}\nlast error: ${String(lastError)}`,
  );
}

/** Wait until the startup line naming the actual bound port reaches stdout. */
async function waitForListeningLine(
  child: ChildProcess,
  output: CapturedOutput,
  port: number,
  timeoutMs = 10_000,
): Promise<void> {
  const expected = `room server listening on http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output.stdout().includes(expected)) {
      return;
    }
    if (hasExited(child)) {
      throw new Error(unreachableDetail(child, output, 'exited before printing its address'));
    }
    await delay(25);
  }
  throw new Error(
    `${unreachableDetail(child, output, 'did not print its listening address')}\n` +
      `expected stdout to contain: ${expected}`,
  );
}

/** True when a fresh TCP connection to the port is refused. */
function isPortClosed(port: number): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolveCheck(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolveCheck(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolveCheck(true);
    });
  });
}

/** Poll until the port cannot be connected to, failing if it still accepts. */
async function waitForPortRelease(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortClosed(port)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`port ${port} still accepts connections after the server was stopped`);
}

/**
 * True while the child's process group still has a live (non-zombie) member.
 *
 * `kill(-pgid, 0)` also succeeds for an unreaped zombie. In a CI container PID 1
 * does not always reap orphans, so the server killed by SIGTERM can linger as a
 * zombie and make that probe report a live group forever. On Linux, confirm
 * through `/proc` that at least one member is not in state `Z`; the check
 * mirrors `isProcessGroupAlive` in `scripts/install-playwright-ci.mjs`.
 */
function isProcessGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
  } catch (error) {
    // ESRCH means the group is gone. EPERM means it still exists but we may not
    // signal it, so fall through to the /proc check instead of guessing.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux') {
    return true;
  }

  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      } catch {
        // The process exited between listing /proc and reading its stat.
        continue;
      }
      const commEnd = stat.lastIndexOf(')');
      if (commEnd === -1) {
        continue;
      }
      // /proc/<pid>/stat: after the parenthesised comm come state, ppid, pgrp.
      const fields = stat.slice(commEnd + 2).split(' ');
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === groupId && state !== undefined && state !== 'Z') {
        return true;
      }
    }
    return false;
  } catch {
    // If /proc is unreadable, keep the conservative kill(0) answer.
    return true;
  }
}

/** Resolve once no live (non-zombie) process remains in the child's group. */
async function waitForProcessGroupGone(
  groupId: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(groupId)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`process group ${groupId} still has live members after SIGTERM`);
}

// npm does not forward SIGTERM to the tsx process it starts, so the process
// tests rely on POSIX process groups to stop and verify the whole tree.
describe.skipIf(process.platform === 'win32')('room server entry point', () => {
  it('starts through npm run server:room and stops its whole process group', async () => {
    const port = await freePort();
    const child = spawnRoomProcess(NPM, ['run', 'server:room'], { PORT: String(port) });
    const output = captureOutput(child);

    try {
      const response = await waitForHealth(child, output, port);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      await waitForListeningLine(child, output, port);

      expect(child.exitCode).toBeNull();
      // Signal the detached group, not just npm: the wrapper and the tsx/node
      // server both have to go for the port to be released.
      signalProcessGroup(child, 'SIGTERM');
      await waitForExit(child, 15_000);

      await waitForPortRelease(port);
      expect(child.pid).toBeTypeOf('number');
      await waitForProcessGroupGone(child.pid as number);
    } finally {
      await stopChild(child);
    }
  }, 60_000);

  it('runs the entry directly and exits cleanly with code 0 on SIGTERM', async () => {
    const port = await freePort();
    const child = spawnRoomProcess(
      process.execPath,
      ['--import', 'tsx', 'server/room/main.ts'],
      { PORT: String(port) },
    );
    const output = captureOutput(child);

    try {
      const response = await waitForHealth(child, output, port);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      await waitForListeningLine(child, output, port);

      expect(child.exitCode).toBeNull();
      child.kill('SIGTERM');

      const exit = await waitForExit(child, 15_000);
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(0);
      await waitForPortRelease(port);
    } finally {
      await stopChild(child);
    }
  }, 60_000);

  it('runs the entry directly and exits cleanly with code 0 on SIGINT', async () => {
    const port = await freePort();
    const child = spawnRoomProcess(
      process.execPath,
      ['--import', 'tsx', 'server/room/main.ts'],
      { PORT: String(port) },
    );
    const output = captureOutput(child);

    try {
      const response = await waitForHealth(child, output, port);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      await waitForListeningLine(child, output, port);

      expect(child.exitCode).toBeNull();
      child.kill('SIGINT');

      const exit = await waitForExit(child, 15_000);
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(0);
      await waitForPortRelease(port);
    } finally {
      await stopChild(child);
    }
  }, 60_000);

  it.each(['abc', '70000'])(
    'prints a readable error and exits non-zero for PORT=%s',
    async (rawPort) => {
      const child = spawnRoomProcess(
        process.execPath,
        ['--import', 'tsx', 'server/room/main.ts'],
        { PORT: rawPort },
      );
      const output = captureOutput(child);

      try {
        const exit = await waitForExit(child, 15_000);
        await output.closed;
        expect(exit.signal).toBeNull();
        expect(exit.code).toBe(1);
        expect(output.stderr()).toContain(`Invalid PORT "${rawPort}"`);
        expect(output.stderr()).toContain('0 and 65535');
      } finally {
        await stopChild(child);
      }
    },
    30_000,
  );
});

describe.skipIf(process.platform === 'win32')('process group liveness probe', () => {
  it('reports a group with a live member as still alive', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      detached: true,
      stdio: 'ignore',
    });

    try {
      const pid = child.pid;
      if (pid === undefined) {
        throw new Error('failed to spawn the process-group liveness fixture');
      }
      await expect(waitForProcessGroupGone(pid, 500)).rejects.toThrow(
        `process group ${pid} still has live members after SIGTERM`,
      );
    } finally {
      await stopChild(child);
    }
  }, 15_000);
});
