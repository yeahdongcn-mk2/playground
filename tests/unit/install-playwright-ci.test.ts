import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = join(ROOT, 'scripts', 'install-playwright-ci.mjs');
const INSTALL_ARGS = 'playwright install --with-deps chromium webkit';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeNpx {
  root: string;
  home: string;
  binDir: string;
  argsPath: string;
  countPath: string;
}

interface WrapperResult {
  status: number | null;
  output: string;
  durationMs: number;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Put a fake `npx` first on PATH. It records its arguments and call count and
 * runs `body` with the 1-based `count` shell variable in scope, so a test can
 * fail the first attempt and succeed on the retry (or hang forever).
 */
function createFakeNpx(body: string): FakeNpx {
  const root = makeTempDir('playwright-install-');
  const binDir = join(root, 'bin');
  const home = join(root, 'home');
  const argsPath = join(root, 'args.log');
  const countPath = join(root, 'count');

  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(home, '.cache', 'ms-playwright', 'chromium-1200'), { recursive: true });
  mkdirSync(join(home, '.cache', 'ms-playwright', 'webkit-2200'), { recursive: true });
  writeFileSync(argsPath, '');
  writeFileSync(countPath, '0');

  const npxPath = join(binDir, 'npx');
  writeFileSync(
    npxPath,
    [
      '#!/bin/sh',
      'echo "$*" >> "$FAKE_ARGS"',
      'count=$(cat "$FAKE_COUNT")',
      'count=$((count + 1))',
      'echo "$count" > "$FAKE_COUNT"',
      body,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(npxPath, 0o755);

  return { root, home, binDir, argsPath, countPath };
}

function wrapperEnv(fake: FakeNpx, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fake.binDir}:${process.env.PATH ?? ''}`,
    HOME: fake.home,
    PLAYWRIGHT_INSTALL_TIMEOUT_MS: '60000',
    PLAYWRIGHT_INSTALL_RETRY_DELAY_MS: '10',
    PLAYWRIGHT_INSTALL_KILL_GRACE_MS: '200',
    // Tests run as an ordinary developer, not the passwordless-sudo CI runner.
    PLAYWRIGHT_INSTALL_SUDO_KILL: '0',
    FAKE_ARGS: fake.argsPath,
    FAKE_COUNT: fake.countPath,
    ...extra,
  };
}

function runWrapper(env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<WrapperResult> {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [WRAPPER], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let forceKill: NodeJS.Timeout | undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    const guard = setTimeout(() => {
      // Give the wrapper's SIGTERM handler a chance to clean up its detached
      // npx/apt process group before the test gives up on it.
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
      rejectRun(new Error(`install wrapper did not exit within ${timeoutMs}ms:\n${output}`));
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(guard);
      clearTimeout(forceKill);
      rejectRun(error);
    });
    child.once('close', (status) => {
      clearTimeout(guard);
      clearTimeout(forceKill);
      resolveRun({ status, output, durationMs: Date.now() - startedAt });
    });
  });
}

function attemptCount(fake: FakeNpx): number {
  return Number(readFileSync(fake.countPath, 'utf8').trim());
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids: number[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  expect(pids.filter((pid) => isProcessAlive(pid)), 'process group members still alive').toEqual([]);
}

describe.skipIf(process.platform === 'win32')('install-playwright-ci wrapper', () => {
  it('retries once after a transient apt failure and then succeeds', async () => {
    const fake = createFakeNpx(
      [
        'if [ "$count" -eq 1 ]; then',
        '  echo "E: Temporary failure resolving \'security.ubuntu.com\'" >&2',
        '  exit 1',
        'fi',
        'echo "browser installed"',
        'exit 0',
      ].join('\n'),
    );

    const result = await runWrapper(wrapperEnv(fake));

    expect(result.status).toBe(0);
    expect(attemptCount(fake)).toBe(2);
    expect(result.output).toContain('attempt 1/2');
    expect(result.output).toContain('attempt 2/2');
    expect(result.output).toContain('Temporary failure resolving');
    expect(result.output).toContain('hint: apt/DNS');
    expect(result.output).toContain('installed successfully');
    expect(readLines(fake.argsPath)).toEqual([INSTALL_ARGS, INSTALL_ARGS]);
  });

  it('retries after an apt mirror 404 with exit code 100 and surfaces a hint', async () => {
    const fake = createFakeNpx(
      [
        'if [ "$count" -eq 1 ]; then',
        '  echo "E: Failed to fetch http://azure.archive.ubuntu.com/libsoup-3.0-common.deb  404  Not Found" >&2',
        '  echo "E: Some packages could not be installed." >&2',
        '  exit 100',
        'fi',
        'echo "browser installed"',
        'exit 0',
      ].join('\n'),
    );

    const result = await runWrapper(wrapperEnv(fake));

    expect(result.status).toBe(0);
    expect(attemptCount(fake)).toBe(2);
    expect(result.output).toContain('exited with status 100');
    expect(result.output).toContain('404  Not Found');
    expect(result.output).toContain('hint: apt/DNS');
    expect(result.output).toContain('ms-playwright');
  });

  it('kills a hung install after its per-attempt timeout and exits non-zero', async () => {
    const fake = createFakeNpx(
      [
        // Both the fake shell and its long-lived child ignore SIGTERM, so only
        // a SIGKILL to the whole process group can end them. The child's
        // 120-second sleep outlives the test if the wrapper kills only the
        // direct child.
        "trap '' TERM",
        'echo "$$" >> "$FAKE_PIDS"',
        "sh -c 'trap \"\" TERM; sleep 120' &",
        'echo "$!" >> "$FAKE_PIDS"',
        'wait',
      ].join('\n'),
    );
    const pidPath = join(fake.root, 'pids.log');
    writeFileSync(pidPath, '');

    const result = await runWrapper(
      wrapperEnv(fake, {
        PLAYWRIGHT_INSTALL_TIMEOUT_MS: '400',
        PLAYWRIGHT_INSTALL_RETRY_DELAY_MS: '10',
        PLAYWRIGHT_INSTALL_KILL_GRACE_MS: '300',
        PLAYWRIGHT_INSTALL_GROUP_SETTLE_MS: '100',
        FAKE_PIDS: pidPath,
      }),
    );

    expect(result.status).toBe(124);
    // Each attempt times out after 400ms and gets 300ms of SIGTERM grace; the
    // whole two-attempt run must stay in that neighbourhood (not stall for
    // seconds per attempt).
    expect(result.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(result.durationMs).toBeLessThan(6_000);

    const sigtermAt = result.output.indexOf('sending SIGTERM');
    const sigkillAt = result.output.indexOf('sending SIGKILL');
    expect(sigtermAt).toBeGreaterThanOrEqual(0);
    expect(sigkillAt, 'SIGKILL should be sent only after SIGTERM').toBeGreaterThan(sigtermAt);
    expect(result.output).toContain('timed out after');
    expect(result.output).toContain(`node ${process.version}`);
    expect(result.output).toContain(join(fake.home, '.cache', 'ms-playwright'));
    expect(result.output).toContain('FAILED after 2 attempts');
    expect(attemptCount(fake)).toBe(2);

    const pids = readLines(pidPath).map((line) => Number(line));
    expect(pids.length).toBeGreaterThanOrEqual(2);
    await waitForExit(pids);
  });

  it('forwards SIGTERM to the detached process group when the wrapper is cancelled', async () => {
    const fake = createFakeNpx(
      [
        "trap '' TERM",
        'echo "$$" >> "$FAKE_PIDS"',
        "sh -c 'trap \"\" TERM; sleep 120' &",
        'echo "$!" >> "$FAKE_PIDS"',
        'wait',
      ].join('\n'),
    );
    const pidPath = join(fake.root, 'pids.log');
    writeFileSync(pidPath, '');

    const child = spawn(process.execPath, [WRAPPER], {
      cwd: ROOT,
      env: wrapperEnv(fake, {
        PLAYWRIGHT_INSTALL_TIMEOUT_MS: '60000',
        PLAYWRIGHT_INSTALL_KILL_GRACE_MS: '300',
        PLAYWRIGHT_INSTALL_RETRY_DELAY_MS: '10',
        FAKE_PIDS: pidPath,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000 && readLines(pidPath).length < 2) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    expect(readLines(pidPath).length).toBeGreaterThanOrEqual(2);

    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolveExit) => {
      child.once('close', (exitCode) => resolveExit(exitCode));
    });

    expect(code).toBe(143);
    expect(output).toContain('received SIGTERM');
    expect(output).toContain('sending SIGKILL to the process group');
    await waitForExit(readLines(pidPath).map((line) => Number(line)));
  });

  it('exits non-zero after both attempts fail and reports versions and cache contents', async () => {
    const fake = createFakeNpx(['echo "E: install failed for test" >&2', 'exit 1'].join('\n'));

    const result = await runWrapper(wrapperEnv(fake));

    expect(result.status).toBe(1);
    expect(attemptCount(fake)).toBe(2);
    expect(result.output).toContain('FAILED after 2 attempts');
    expect(result.output).toContain(`node ${process.version}`);
    expect(result.output).toContain('Playwright @playwright/test');
    expect(result.output).toContain('ms-playwright: 2 entries:');
    expect(result.output).toContain('next steps: re-run the CI job');
  });
});
