import { createHash } from 'node:crypto';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
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
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_FONT_PACKAGES,
  CAPTURE_PLATFORM,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from '../../scripts/lib/capture-env.mjs';
import {
  captureCommandArgs,
  DEFAULT_LOAD_COUNT,
  deriveReproPlans,
  loadWorkerArgs,
  MAX_LOAD_COUNT,
  normalizeLoadCount,
  normalizeRunCount,
  parseCaptureTarget,
  reproArtifactPath,
  reproLogPath,
  runScreenshotRepro,
  ScreenshotReproError,
  selectReproPlans,
  sha256VerifierArgs,
  spawnContainerCapture,
  startCpuLoad,
  validateCaptureTarget,
} from '../../scripts/lib/screenshot-repro.mjs';
import type {
  ReproLoadController,
  ReproLoadSummary,
  ReproRunCaptureOptions,
  ReproSpawn,
  ReproVerification,
} from '../../scripts/lib/screenshot-repro.mjs';
import type { ScreenshotSha256Manifest } from '../../scripts/lib/screenshot-sha256.mjs';
import { main, parseArgs } from '../../scripts/verify-screenshot-repro.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPRO_SCRIPT = join(ROOT, 'scripts', 'verify-screenshot-repro.mjs');
const REAL_MANIFEST = join(ROOT, 'docs', 'screenshots', 'capture-sha256-manifest.json');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface CaptureSpec {
  file: string;
  command: string;
  content: string;
}

const WEBKIT_COMMAND = 'npm run screenshots:container -- screenshots:webkit';
const GAME_COMMAND = 'npm run screenshots:container -- screenshots:2048:webkit';

const CAPTURES: CaptureSpec[] = [
  { file: 'after-blank-webkit.png', command: WEBKIT_COMMAND, content: 'blank-v1' },
  { file: 'after-2048-playing-webkit.png', command: GAME_COMMAND, content: 'playing-v1' },
  { file: 'after-2048-gameover-webkit.png', command: GAME_COMMAND, content: 'gameover-v1' },
];

/** A manifest that passes `manifestEnvironmentMismatches`. */
function manifestFor(captures: CaptureSpec[]): ScreenshotSha256Manifest {
  return {
    environment: {
      source: 'container',
      target: 'webkit',
      dpr: 2,
      platform: CAPTURE_PLATFORM,
      image: {
        repository: PLAYWRIGHT_IMAGE_REPOSITORY,
        tag: PLAYWRIGHT_IMAGE_PIN.tag,
        digest: PLAYWRIGHT_IMAGE_PIN.digest,
      },
      egl: { ...CAPTURE_EGL_ENV },
      fonts: CAPTURE_FONT_PACKAGES.map((name) => ({ name, version: 'fixture-1' })),
    },
    captures: captures.map((capture) => ({
      file: capture.file,
      sha256: sha256(capture.content),
      command: capture.command,
      provenance: {
        container: `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
        captureCommit: 'a'.repeat(40),
      },
    })),
  };
}

function fingerprint(platform = CAPTURE_PLATFORM): string {
  return (
    'capture-env: source=container target=webkit dpr=2 ' +
    `platform=${platform} ` +
    `image=${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest} ` +
    'node=v24 playwright=1.64.1 browser=27.2 ' +
    `fonts=${CAPTURE_FONT_PACKAGES.map((name) => `${name}@fixture-1`).join(',')} ` +
    'env=EGL_PLATFORM=surfaceless,LIBGL_ALWAYS_SOFTWARE=1,' +
    '__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json'
  );
}

interface Fixture {
  root: string;
  dir: string;
  logDir: string;
  manifestPath: string;
}

function fixture(
  captures: CaptureSpec[] = CAPTURES,
  { prewrite = 'none' }: { prewrite?: 'none' | 'manifest' } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-repro-'));
  tempDirs.push(root);
  const dir = join(root, 'docs', 'screenshots');
  const logDir = join(root, 'test-results', 'screenshot-repro');
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'capture-sha256-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifestFor(captures), null, 2)}\n`);
  if (prewrite === 'manifest') {
    // Simulate committed evidence that already matches the manifest, as the
    // write guard leaves it when it skips a frozen historical file.
    for (const capture of captures) {
      writeFileSync(join(dir, capture.file), capture.content);
    }
  }
  return { root, dir, logDir, manifestPath };
}

/**
 * Put a fake `npm` executable on PATH. It prints to both streams and exits
 * with `code`, so the real spawn path can be exercised without Docker.
 */
function fakeNpmBin(code: number): NodeJS.ProcessEnv {
  const binDir = mkdtempSync(join(tmpdir(), 'screenshot-repro-npm-'));
  tempDirs.push(binDir);
  const npmPath = join(binDir, 'npm');
  writeFileSync(
    npmPath,
    `#!/bin/sh\necho "fake npm stdout $*"\necho "fake npm stderr $*" >&2\nexit ${code}\n`,
  );
  chmodSync(npmPath, 0o755);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = nodeSpawnSync(process.execPath, [REPRO_SCRIPT, ...args], {
    cwd: ROOT,
    // The real CI step exports a summary file; keep these direct-entry tests
    // from appending their synthetic failures to the job summary.
    env: { ...process.env, ...env, GITHUB_STEP_SUMMARY: '' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough };

/** A cross-platform child_process.spawn seam for the default capture runner. */
function fakeChildSpawn({
  exitCode = 9,
  closeDelayMs = 0,
  calls,
}: {
  exitCode?: number;
  closeDelayMs?: number;
  calls?: string[][];
} = {}): ReproSpawn {
  return ((command: string, args: readonly string[]) => {
    calls?.push([command, ...args]);
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setTimeout(() => {
      child.stdout.write('injected stdout\n');
      child.stderr.write('injected stderr\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', exitCode);
    }, closeDelayMs);
    return child;
  }) as unknown as ReproSpawn;
}

interface FakeLoadChild extends EventEmitter {
  pid: number | undefined;
  killed: NodeJS.Signals[];
  closed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
}

interface FakeLoadSpawn {
  spawn: ReproSpawn;
  calls: string[][];
  children: FakeLoadChild[];
  closedCount: () => number;
}

/**
 * A fake `spawn` for the CPU load workers. `kill` closes after a short delay so
 * a test can tell whether `stop()` actually waited for the children.
 *
 * `ignoreSigterm` / `ignoreSignals` model a worker that keeps burning CPU after
 * a signal, and `exitAfterMs` models one that the OS or the OOM killer reaps
 * before `stop()` runs. `errorOnCall` models the asynchronous `'error'` Node
 * emits for a failed spawn (ENOENT / EAGAIN / EMFILE), which never throws from
 * `spawn()` itself; `errorWithPid` models an error on an already-started child.
 * A failed spawn intentionally emits no `'close'` here (real Node sends one
 * right after the error), so stop() must rely on the error handler to mark the
 * worker closed.
 */
function fakeLoadSpawn({
  closeDelayMs = 5,
  failOnCall,
  errorOnCall,
  errorMessage = 'spawn EMFILE',
  errorWithPid = false,
  order,
  ignoreSigterm = false,
  ignoreSignals = false,
  exitAfterMs,
}: {
  closeDelayMs?: number;
  /** 1-based spawn call that throws instead of returning a child. */
  failOnCall?: number;
  /** 1-based spawn call whose child emits `'error'` on a later tick. */
  errorOnCall?: number;
  /** Message carried by the injected `'error'` event. */
  errorMessage?: string;
  /** Give the child of a matching `errorOnCall` a pid, modelling an error after a real start. */
  errorWithPid?: boolean;
  /** Shared event log proving load starts and stops around the captures. */
  order?: string[];
  /** Record SIGTERM but keep running until SIGKILL. */
  ignoreSigterm?: boolean;
  /** Record every signal but never exit, so `stop()` hits its hard timeout. */
  ignoreSignals?: boolean;
  /** Emit `exit`/`close` this many ms after spawn, before `stop()` runs. */
  exitAfterMs?: number;
} = {}): FakeLoadSpawn {
  const calls: string[][] = [];
  const children: FakeLoadChild[] = [];
  const spawn = ((command: string, args: readonly string[]) => {
    const call = calls.length + 1;
    calls.push([command, ...args]);
    if (call === failOnCall) {
      throw new Error('spawn EAGAIN');
    }
    const failedSpawn = call === errorOnCall && !errorWithPid;
    if (!failedSpawn) order?.push('load:start');
    const child = new EventEmitter() as FakeLoadChild;
    // A failed spawn has no pid; Node reports it through a later 'error'.
    child.pid = failedSpawn ? undefined : 42_000 + children.length;
    child.killed = [];
    child.closed = false;
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      if (child.pid === undefined) {
        // A failed spawn has no process handle: Node's kill() returns false
        // and emits nothing. Record the attempt so a test can tell that
        // stop() tried to signal a worker that never started.
        child.killed.push(signal);
        return false;
      }
      child.killed.push(signal);
      if (ignoreSignals) return true;
      if (signal === 'SIGTERM' && ignoreSigterm) return true;
      setTimeout(() => {
        if (child.closed) return;
        child.closed = true;
        order?.push('load:stop');
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      }, closeDelayMs);
      return true;
    };
    if (call === errorOnCall) {
      setTimeout(() => child.emit('error', new Error(errorMessage)), 0);
    }
    if (exitAfterMs !== undefined) {
      setTimeout(() => {
        if (child.closed) return;
        child.closed = true;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }, exitAfterMs);
    }
    children.push(child);
    return child;
  }) as unknown as ReproSpawn;
  return {
    spawn,
    calls,
    children,
    closedCount: () => children.filter((child) => child.closed).length,
  };
}

interface RunnerOptions {
  dir: string;
  captures: CaptureSpec[];
  order?: string[];
  /** Per file and run override of the bytes the capture "writes". */
  writes?: Record<string, Partial<Record<number, string>>>;
  /** When false, the capture exits 0 but never writes a manifested file. */
  writeFiles?: boolean;
  /** Runs that exit 0 without writing a manifested file. */
  skipWriteRuns?: number[];
  exitCodes?: Record<string, number>;
  platforms?: Record<number, string>;
}

function fakeRunner({
  dir,
  captures,
  order,
  writes = {},
  writeFiles = true,
  skipWriteRuns = [],
  exitCodes = {},
  platforms = {},
}: RunnerOptions) {
  const byTarget = new Map<string, CaptureSpec[]>();
  for (const capture of captures) {
    const target = parseCaptureTarget(capture.command);
    const list = byTarget.get(target) ?? [];
    list.push(capture);
    byTarget.set(target, list);
  }
  return async ({ target, run, logPath }: ReproRunCaptureOptions): Promise<number> => {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${target} run ${run}\n${fingerprint(platforms[run])}\n`);
    order?.push(`${target}:${run}`);
    if (writeFiles && !skipWriteRuns.includes(run)) {
      for (const capture of byTarget.get(target) ?? []) {
        const content = writes[capture.file]?.[run] ?? capture.content;
        writeFileSync(join(dir, capture.file), content);
      }
    }
    return exitCodes[`${target}:${run}`] ?? 0;
  };
}

const verifyOk = async (): Promise<ReproVerification> => ({
  code: 0,
  stdout: 'OK: fixture verified',
  stderr: '',
});

const verifyFail = async (): Promise<ReproVerification> => ({
  code: 1,
  stdout: '',
  stderr: 'Environment fingerprint mismatch (fixture)',
});

describe('screenshot repro target derivation', () => {
  it('parses the container capture target out of a manifest command', () => {
    expect(parseCaptureTarget(WEBKIT_COMMAND)).toBe('screenshots:webkit');
    expect(parseCaptureTarget(`  ${GAME_COMMAND}  `)).toBe('screenshots:2048:webkit');
  });

  it('rejects commands that are not a plain screenshots container invocation', () => {
    for (const command of [
      'node scripts/capture-screenshots.mjs',
      'npm run screenshots:container --',
      'npm run screenshots:container -- screenshots:webkit --allow-historical-overwrite',
      'npm run screenshots:container -- ../../evil',
      'npm run screenshots:container -- screenshots:webkit; rm -rf /',
    ]) {
      expect(() => parseCaptureTarget(command), command).toThrow(ScreenshotReproError);
    }
  });

  it('groups captures by target in manifest order instead of capturing twice', () => {
    const manifest = manifestFor(CAPTURES);
    const plans = deriveReproPlans(manifest);
    expect(plans.map((plan) => plan.target)).toEqual([
      'screenshots:webkit',
      'screenshots:2048:webkit',
    ]);
    expect(plans.map((plan) => plan.captures.length)).toEqual([1, 2]);
    expect(plans.flatMap((plan) => plan.captures.map((entry) => entry.file))).toEqual(
      CAPTURES.map((capture) => capture.file),
    );
  });

  it('pins the real npm capture argv and the verifier --log argv', () => {
    expect(captureCommandArgs('screenshots:2048:webkit')).toEqual([
      'run',
      'screenshots:container',
      '--',
      'screenshots:2048:webkit',
    ]);
    expect(
      sha256VerifierArgs({
        logPath: '/tmp/run1.log',
        dir: '/tmp/docs/screenshots',
        manifestPath: '/tmp/capture-sha256-manifest.json',
        repoRoot: '/repo',
      }),
    ).toEqual([
      resolve('/repo', 'scripts/verify-screenshot-sha256.mjs'),
      '--dir',
      '/tmp/docs/screenshots',
      '--manifest',
      '/tmp/capture-sha256-manifest.json',
      '--log',
      '/tmp/run1.log',
    ]);
  });

  it('names one log per target and run below the ignored log directory', () => {
    expect(reproLogPath('/tmp/logs', 'screenshots:2048:webkit', 1)).toBe(
      '/tmp/logs/screenshots-2048-webkit-run1.log',
    );
    expect(reproLogPath('/tmp/logs', 'screenshots:webkit', 2)).toBe(
      '/tmp/logs/screenshots-webkit-run2.log',
    );
  });

  it('keeps each run PNG copy in its own directory below the log directory', () => {
    expect(reproArtifactPath('/tmp/logs', 'screenshots:2048:webkit', 3, 'a.png')).toBe(
      '/tmp/logs/screenshots-2048-webkit-run3-png/a.png',
    );
  });

  it('validates a --target value as a screenshots npm script', () => {
    expect(validateCaptureTarget(' screenshots:breakout:webkit ')).toBe(
      'screenshots:breakout:webkit',
    );
    for (const target of ['', 'breakout:webkit', 'screenshots', 'screenshots:a b', '../x']) {
      expect(() => validateCaptureTarget(target), target).toThrow(ScreenshotReproError);
    }
  });

  it('normalizes --runs to a positive integer', () => {
    expect(normalizeRunCount(4)).toBe(4);
    expect(normalizeRunCount('8')).toBe(8);
    for (const value of [0, -2, 2.5, 'x', '']) {
      expect(() => normalizeRunCount(value), String(value)).toThrow(/positive integer/);
    }
  });

  it('selects requested targets in manifest order and rejects unknown ones', () => {
    const plans = deriveReproPlans(manifestFor(CAPTURES));

    expect(selectReproPlans(plans, [])).toEqual(plans);
    expect(
      selectReproPlans(plans, ['screenshots:2048:webkit', 'screenshots:webkit']).map(
        (plan) => plan.target,
      ),
    ).toEqual(['screenshots:webkit', 'screenshots:2048:webkit']);
    expect(
      selectReproPlans(plans, ['screenshots:webkit', 'screenshots:webkit']).map(
        (plan) => plan.target,
      ),
    ).toEqual(['screenshots:webkit']);
    expect(() => selectReproPlans(plans, ['screenshots:breakout:webkit'])).toThrow(
      /unknown repro target\(s\): screenshots:breakout:webkit/,
    );
  });
});

describe('screenshot repro two-run check', () => {
  it('passes when both runs match the manifest and each log verifies', async () => {
    const setup = fixture();
    // The fixture only writes the manifest: the manifested files must come from
    // the capture runner, otherwise this success case could not tell a real
    // re-capture from a run that never wrote anything.
    expect(() => readFileSync(join(setup.dir, 'after-blank-webkit.png'))).toThrow();

    const order: string[] = [];
    // The fake spawn records every attempted worker start: with the default
    // --load 0, a regression that starts a worker anyway fails this test.
    const loadSpawn = fakeLoadSpawn();
    const result = await runScreenshotRepro({
      ...setup,
      spawnLoadWorker: loadSpawn.spawn,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES, order }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(true);
    for (const capture of CAPTURES) {
      expect(readFileSync(join(setup.dir, capture.file), 'utf8')).toBe(capture.content);
    }
    expect(result.report).toContain('OK: screenshot repro passed');
    expect(result.report).toContain('3 file(s) matched');
    // No --load means no load line and no extra process, exactly as before.
    expect(result.load.requested).toBe(0);
    expect(loadSpawn.calls).toHaveLength(0);
    expect(result.report).not.toContain('load:');
    expect(result.runs.map((run) => `${run.target}:${run.run}`)).toEqual([
      'screenshots:webkit:1',
      'screenshots:webkit:2',
      'screenshots:2048:webkit:1',
      'screenshots:2048:webkit:2',
    ]);
    // The two runs of one target must be consecutive: run 1 has to be hashed
    // before run 2 overwrites the same committed evidence paths.
    expect(order).toEqual([
      'screenshots:webkit:1',
      'screenshots:webkit:2',
      'screenshots:2048:webkit:1',
      'screenshots:2048:webkit:2',
    ]);
    for (const run of result.runs) {
      expect(readFileSync(run.logPath, 'utf8')).toContain(`run ${run.run}`);
    }
  });

  it('fails with expected / actual sha256, both logs, fingerprint and recapture steps on drift', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        writes: { 'after-2048-playing-webkit.png': { 2: 'playing-v2' } },
      }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.differences).toHaveLength(1);
    const difference = result.differences[0];
    expect(difference?.file).toBe('after-2048-playing-webkit.png');
    expect(difference?.expected).toBe(sha256('playing-v1'));
    expect(difference?.run1).toBe(sha256('playing-v1'));
    expect(difference?.run2).toBe(sha256('playing-v2'));

    const report = result.report;
    expect(report).toContain('FAIL: screenshot repro failed');
    expect(report).toContain('after-2048-playing-webkit.png');
    expect(report).toContain(`expected sha256: ${sha256('playing-v1')}`);
    expect(report).toContain(`run 1 sha256: ${sha256('playing-v1')}`);
    expect(report).toContain(`run 2 sha256: ${sha256('playing-v2')}`);
    expect(report).toContain('run 1 log: ');
    expect(report).toContain('run 2 log: ');
    expect(report).toContain('capture-env: source=container');
    expect(report).toContain(
      'npm run screenshots:container -- screenshots:2048:webkit',
    );
    expect(report).toContain('Recapture steps:');
    expect(report).toContain('verify-screenshot-sha256.mjs --log');
    expect(report).toContain('capture-sha256-manifest.json');
    expect(report).not.toContain('Load:');
  });

  it('distinguishes a stale manifest from an unstable fixed environment', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        writes: {
          'after-2048-playing-webkit.png': { 1: 'playing-v2', 2: 'playing-v2' },
        },
      }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.report).toContain(
      'all runs agree with each other but not with the manifest',
    );
  });

  it('fails and lists both fingerprints when the two runs report different environments', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        platforms: { 1: CAPTURE_PLATFORM, 2: 'linux/arm64' },
      }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.environmentMismatches).toHaveLength(2);
    expect(result.report).toContain('Environment fingerprint differences:');
    expect(result.report).toContain(`platform=${CAPTURE_PLATFORM}`);
    expect(result.report).toContain('platform=linux/arm64');
  });

  it('fails when a capture log does not pass the sha256 verifier', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
      verifyLog: verifyFail,
    });

    expect(result.ok).toBe(false);
    expect(result.verifyFailures).toHaveLength(4);
    expect(result.report).toContain('Log verification failures:');
    expect(result.report).toContain('Environment fingerprint mismatch (fixture)');
  });

  it('fails when a successful capture never writes and the committed bytes already match', async () => {
    // The write guard skips frozen historical files, leaving the committed
    // bytes in place. If the capture exits 0 without rewriting them, the entry
    // must not pass by hashing stale evidence: the pre-run removal turns the
    // missing write into an unavailable hash.
    const setup = fixture(CAPTURES, { prewrite: 'manifest' });
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES, writeFiles: false }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.differences).toHaveLength(3);
    for (const difference of result.differences) {
      expect(difference.run1).toBeNull();
      expect(difference.run2).toBeNull();
    }
    expect(result.report).toContain('did not produce the file');
    expect(result.report).toContain('run 1 sha256: unavailable');
  });

  it('removes manifested files before the second run so it cannot reuse run 1 bytes', async () => {
    // Without a per-run removal, a capture that writes run 1 and silently
    // skips run 2 would hash run 1's bytes twice and pass.
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        skipWriteRuns: [2],
      }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.differences).toHaveLength(3);
    for (const difference of result.differences) {
      expect(difference.run1).not.toBeNull();
      expect(difference.run2).toBeNull();
    }
    expect(result.report).toContain('run 2 sha256: unavailable');
  });

  it('fails the run instead of hashing stale bytes when the pre-run removal fails', async () => {
    const setup = fixture(CAPTURES, { prewrite: 'manifest' });
    const result = await runScreenshotRepro({
      ...setup,
      removeFile: () => {
        throw new Error('EACCES: permission denied');
      },
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.captureFailures).toHaveLength(4);
    expect(result.captureFailures[0]?.exitCode).toBe(1);
    expect(result.captureFailures[0]?.failureReason).toContain(
      'cannot remove stale evidence',
    );
    expect(result.report).toContain('screenshots:webkit run 1: exit 1: cannot remove stale evidence');
    expect(result.report).toContain('EACCES');
  });

  it('fails and names the run when a capture command exits non-zero', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        exitCodes: { 'screenshots:webkit:2': 1 },
      }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.captureFailures).toEqual([
      expect.objectContaining({ target: 'screenshots:webkit', run: 2, exitCode: 1 }),
    ]);
    expect(result.report).toContain('Capture failures:');
    expect(result.report).toContain('screenshots:webkit run 2: exit 1');
  });

  it('normalizes a non-finite capture exit code to a failure', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: async () => Number.NaN,
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.captureFailures).toHaveLength(4);
    expect(result.captureFailures[0]?.exitCode).toBe(1);
    expect(result.report).not.toContain('exit NaN');
  });

  it('rejects a manifest that drifts from the fixed capture environment', async () => {
    const setup = fixture();
    const manifest = manifestFor(CAPTURES);
    manifest.environment.source = 'host';
    writeFileSync(setup.manifestPath, JSON.stringify(manifest));

    await expect(
      runScreenshotRepro({
        ...setup,
        runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
        verifyLog: verifyOk,
      }),
    ).rejects.toThrow(/does not match the fixed capture environment/);
  });

  it('runs only the selected target for --runs and retains every run PNG copy', async () => {
    const setup = fixture();
    const order: string[] = [];
    const progress: string[] = [];
    const result = await runScreenshotRepro({
      ...setup,
      targets: ['screenshots:2048:webkit'],
      runs: 3,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES, order }),
      verifyLog: verifyOk,
      progress: (line) => progress.push(line),
    });

    expect(result.ok).toBe(true);
    expect(result.runsPerTarget).toBe(3);
    expect(result.plans.map((plan) => plan.target)).toEqual(['screenshots:2048:webkit']);
    expect(order).toEqual([
      'screenshots:2048:webkit:1',
      'screenshots:2048:webkit:2',
      'screenshots:2048:webkit:3',
    ]);
    expect(result.runs).toHaveLength(3);
    expect(result.report).toContain('1 target(s) x 3 runs');
    expect(result.report).toContain('2 file(s) matched the manifest and each other');
    expect(result.report).toContain('Per-run sha256:');
    expect(result.report).toContain('Per-file summary:');
    for (const run of result.runs) {
      for (const capture of CAPTURES.filter((entry) => entry.command === GAME_COMMAND)) {
        const copyPath = reproArtifactPath(
          setup.logDir,
          'screenshots:2048:webkit',
          run.run,
          capture.file,
        );
        expect(
          run.hashes.find((entry) => entry.file === capture.file)?.copyPath,
        ).toBe(copyPath);
        expect(readFileSync(copyPath, 'utf8')).toBe(capture.content);
      }
    }
    expect(progress.join('\n')).toContain(
      'screenshots:2048:webkit run 3: after-2048-playing-webkit.png',
    );
    expect(progress.join('\n')).toContain(`sha256 ${sha256('playing-v1')}`);
  });

  it('names the drifting run and keeps its bytes on a --runs 3 mismatch', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      targets: ['screenshots:2048:webkit'],
      runs: 3,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        writes: { 'after-2048-playing-webkit.png': { 2: 'playing-v2' } },
      }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    const difference = result.differences.find(
      (entry) => entry.file === 'after-2048-playing-webkit.png',
    );
    expect(difference?.runHashes.map((entry) => entry.sha256)).toEqual([
      sha256('playing-v1'),
      sha256('playing-v2'),
      sha256('playing-v1'),
    ]);
    const report = result.report;
    expect(report).toContain(`run 2 sha256: ${sha256('playing-v2')}`);
    expect(report).toContain(`run 3 sha256: ${sha256('playing-v1')}`);
    expect(report).toContain('1 of 3 run(s) disagree with the manifest (run 2)');
    const drifted = difference?.runHashes.find((entry) => entry.run === 2);
    expect(readFileSync(drifted?.copyPath ?? '', 'utf8')).toBe('playing-v2');
  });

  it('clears the previous per-run PNG copy before a run that no longer writes it', async () => {
    // A repeated invocation reuses the same log directory. If this run fails to
    // write a file, its copy slot must not keep the previous invocation's bytes,
    // which a human comparing drift runs could mistake for this run's evidence.
    const setup = fixture();
    const target = 'screenshots:2048:webkit';
    const first = await runScreenshotRepro({
      ...setup,
      targets: [target],
      runs: 1,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
      verifyLog: verifyOk,
    });
    expect(first.ok).toBe(true);
    const stalePath = reproArtifactPath(
      setup.logDir,
      target,
      1,
      'after-2048-playing-webkit.png',
    );
    expect(readFileSync(stalePath, 'utf8')).toBe('playing-v1');

    const second = await runScreenshotRepro({
      ...setup,
      targets: [target],
      runs: 1,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        skipWriteRuns: [1],
      }),
      verifyLog: verifyOk,
    });

    expect(second.ok).toBe(false);
    expect(second.artifactFailures).toEqual([]);
    expect(existsSync(stalePath)).toBe(false);
    expect(second.report).toContain('run 1 png: not retained');
  });

  it('fails when a per-run PNG copy cannot be retained', async () => {
    const setup = fixture();
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
      verifyLog: verifyOk,
      copyFile: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.artifactFailures.length).toBeGreaterThan(0);
    expect(result.report).toContain('Per-run PNG copy failures:');
    expect(result.report).toContain('ENOSPC');
  });

  it('rejects an unknown --target before running any capture', async () => {
    const setup = fixture();
    let called = false;
    await expect(
      runScreenshotRepro({
        ...setup,
        targets: ['screenshots:breakout:webkit'],
        runCapture: async () => {
          called = true;
          return 0;
        },
        verifyLog: verifyOk,
      }),
    ).rejects.toThrow(/unknown repro target\(s\): screenshots:breakout:webkit/);
    expect(called).toBe(false);
  });
});

describe('screenshot repro CPU load injection', () => {
  it('normalizes --load to a bounded non-negative integer and defaults to 0', () => {
    expect(DEFAULT_LOAD_COUNT).toBe(0);
    expect(MAX_LOAD_COUNT).toBe(256);
    expect(normalizeLoadCount(0)).toBe(0);
    expect(normalizeLoadCount('0')).toBe(0);
    expect(normalizeLoadCount(3)).toBe(3);
    expect(normalizeLoadCount(' 4 ')).toBe(4);
    expect(normalizeLoadCount(MAX_LOAD_COUNT)).toBe(MAX_LOAD_COUNT);
    expect(() => normalizeLoadCount(MAX_LOAD_COUNT + 1)).toThrow(
      new RegExp(`at most ${MAX_LOAD_COUNT}`),
    );
    expect(() => normalizeLoadCount('9007199254740992')).toThrow(/too large/);
    for (const value of [-1, 2.5, 'x', '01', '1e3', '']) {
      expect(() => normalizeLoadCount(value as number | string), String(value)).toThrow(
        /non-negative integer/,
      );
    }
  });

  it('runs each load worker as an inline node CPU loop', () => {
    const [flag, source] = loadWorkerArgs();
    expect(flag).toBe('-e');
    expect(source).toContain('for (;;)');
    expect(source).toContain('Math.sqrt');
  });

  it('starts N workers and waits for every one to exit on stop', async () => {
    const fake = fakeLoadSpawn({ closeDelayMs: 10 });
    const controller: ReproLoadController = startCpuLoad({
      count: 3,
      spawn: fake.spawn,
    });

    expect(controller.started).toBe(3);
    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) {
      expect(call[0]).toBe(process.execPath);
      expect(call.slice(1)).toEqual(loadWorkerArgs());
    }
    expect(controller.pids).toHaveLength(3);

    const summary = await controller.stop();
    expect(summary).toEqual({
      requested: 3,
      started: 3,
      stopped: 3,
      exitedEarly: 0,
      active: 0,
      failures: [],
    });
    for (const child of fake.children) {
      expect(child.killed).toEqual(['SIGTERM']);
    }
    // stop() is idempotent and keeps the completed state.
    expect(await controller.stop()).toEqual(summary);
  });

  it('escalates to SIGKILL when a worker ignores SIGTERM', async () => {
    const fake = fakeLoadSpawn({ ignoreSigterm: true, closeDelayMs: 1 });
    const logged: string[] = [];
    const controller: ReproLoadController = startCpuLoad({
      count: 1,
      spawn: fake.spawn,
      // Leave a wide margin before stop()'s killGraceMs * 2 hard deadline, so
      // a late timer pass on a loaded CI host cannot turn this into a
      // wrong-reason stop failure.
      killGraceMs: 50,
      logger: {
        log: () => {},
        error: (line: unknown) => {
          logged.push(String(line));
        },
      },
    });

    const summary = await controller.stop();

    expect(fake.children[0]?.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(logged).toEqual([
      'load worker 1 did not exit after SIGTERM; sending SIGKILL',
    ]);
    expect(summary).toEqual({
      requested: 1,
      started: 1,
      stopped: 1,
      exitedEarly: 0,
      active: 0,
      failures: [],
    });
  });

  it('records a stop failure when a worker ignores SIGKILL too', async () => {
    const fake = fakeLoadSpawn({ ignoreSignals: true });
    const controller: ReproLoadController = startCpuLoad({
      count: 1,
      spawn: fake.spawn,
      killGraceMs: 5,
      logger: { log: () => {}, error: () => {} },
    });

    const summary = await controller.stop();

    expect(fake.children[0]?.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(summary).toEqual({
      requested: 1,
      started: 1,
      stopped: 0,
      exitedEarly: 0,
      active: 1,
      failures: [
        { index: 1, phase: 'stop', message: 'did not exit within 10ms' },
      ],
    });
  });

  it('records a worker that exits before stop and still stops the others', async () => {
    const fake = fakeLoadSpawn();
    const controller: ReproLoadController = startCpuLoad({
      count: 2,
      spawn: fake.spawn,
    });

    fake.children[0]?.emit('exit', 0, null);

    const summary = await controller.stop();

    expect(summary).toEqual({
      requested: 2,
      started: 2,
      stopped: 2,
      exitedEarly: 1,
      active: 0,
      failures: [
        {
          index: 1,
          phase: 'runtime',
          message: 'exited before stop (code 0, signal null)',
        },
      ],
    });
    expect(fake.children[0]?.killed).toEqual([]);
    expect(fake.children[1]?.killed).toEqual(['SIGTERM']);
  });

  it('records a worker that cannot start and still stops the others', async () => {
    const fake = fakeLoadSpawn({ failOnCall: 2 });
    const controller: ReproLoadController = startCpuLoad({
      count: 3,
      spawn: fake.spawn,
    });

    expect(controller.started).toBe(2);
    expect(fake.calls).toHaveLength(3);

    const summary = await controller.stop();
    expect(summary).toMatchObject({
      requested: 3,
      started: 2,
      stopped: 2,
      active: 0,
    });
    expect(summary.failures).toEqual([
      { index: 2, phase: 'start', message: 'spawn EAGAIN' },
    ]);
    for (const child of fake.children) {
      expect(child.killed).toEqual(['SIGTERM']);
    }
  });

  it('records an asynchronous spawn failure and never signals its missing process', async () => {
    // ENOENT / EAGAIN / EMFILE do not throw from spawn(); Node emits 'error'
    // on a later tick while child.pid is still undefined.
    const fake = fakeLoadSpawn({ errorOnCall: 2 });
    const controller: ReproLoadController = startCpuLoad({
      count: 3,
      spawn: fake.spawn,
      // Keep a wrong "signal the failed spawn" path short and explicit
      // instead of letting it trip the test runner's timeout.
      killGraceMs: 10,
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(fake.calls).toHaveLength(3);
    expect(controller.started).toBe(2);
    expect(controller.pids).toHaveLength(2);

    // The error handler marks the failed spawn closed. Without it, stop()
    // would try to signal a pid-less child, whose fake kill() emits no
    // exit/close: the summary below (and the killed assertion) then fails.
    const summary = await controller.stop();
    expect(summary).toEqual({
      requested: 3,
      started: 2,
      stopped: 2,
      exitedEarly: 0,
      active: 0,
      failures: [{ index: 2, phase: 'start', message: 'spawn EMFILE' }],
    });
    expect(fake.children[0]?.killed).toEqual(['SIGTERM']);
    expect(fake.children[1]?.killed).toEqual([]);
    expect(fake.children[2]?.killed).toEqual(['SIGTERM']);
  });

  it('still stops a started worker after an asynchronous runtime error', async () => {
    const fake = fakeLoadSpawn({
      errorOnCall: 1,
      errorWithPid: true,
      errorMessage: 'kill EPERM',
    });
    const controller: ReproLoadController = startCpuLoad({
      count: 1,
      spawn: fake.spawn,
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(controller.started).toBe(1);
    const summary = await controller.stop();
    expect(summary).toEqual({
      requested: 1,
      started: 1,
      stopped: 1,
      exitedEarly: 0,
      active: 0,
      failures: [{ index: 1, phase: 'runtime', message: 'kill EPERM' }],
    });
    expect(fake.children[0]?.killed).toEqual(['SIGTERM']);
  });

  it.skipIf(process.platform === 'win32')(
    'starts and reaps real CPU worker processes',
    async () => {
      const controller = startCpuLoad({ count: 2 });
      let summary: ReproLoadSummary | undefined;
      try {
        expect(controller.started).toBe(2);
        expect(controller.pids).toHaveLength(2);
        for (const pid of controller.pids) {
          expect(() => process.kill(pid, 0)).not.toThrow();
        }
      } finally {
        // A failed assertion must not leave two 100% CPU node processes behind.
        summary = await controller.stop();
      }
      expect(summary).toMatchObject({
        requested: 2,
        started: 2,
        stopped: 2,
        exitedEarly: 0,
        active: 0,
        failures: [],
      });
      for (const pid of controller.pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    },
  );

  it('keeps the load alive across every run and reports its start/stop state', async () => {
    const setup = fixture();
    const order: string[] = [];
    const fake = fakeLoadSpawn({ order });

    const result = await runScreenshotRepro({
      ...setup,
      load: 2,
      spawnLoadWorker: fake.spawn,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES, order }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(true);
    expect(order.slice(0, 2)).toEqual(['load:start', 'load:start']);
    expect(order.at(-1)).toBe('load:stop');
    expect(result.load).toEqual({
      requested: 2,
      started: 2,
      stopped: 2,
      exitedEarly: 0,
      active: 0,
      failures: [],
    });
    expect(result.report).toContain(
      'load: 2/2 CPU worker process(es) started, 2 stopped (all exited)',
    );
  });

  it('combines --load with --target and --runs for all selected runs', async () => {
    const setup = fixture();
    const order: string[] = [];
    const fake = fakeLoadSpawn({ order });

    const result = await runScreenshotRepro({
      ...setup,
      targets: ['screenshots:2048:webkit'],
      runs: 3,
      load: 2,
      spawnLoadWorker: fake.spawn,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES, order }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(true);
    expect(result.runsPerTarget).toBe(3);
    expect(order.filter((event) => !event.startsWith('load:'))).toEqual([
      'screenshots:2048:webkit:1',
      'screenshots:2048:webkit:2',
      'screenshots:2048:webkit:3',
    ]);
    expect(order.slice(0, 2)).toEqual(['load:start', 'load:start']);
    expect(order.at(-1)).toBe('load:stop');
    expect(result.report).toContain('1 target(s) x 3 runs');
    expect(result.report).toContain('load: 2/2');
  });

  it('stops every load worker after a failed capture and keeps the failure details', async () => {
    const setup = fixture();
    const fake = fakeLoadSpawn();

    const result = await runScreenshotRepro({
      ...setup,
      load: 3,
      spawnLoadWorker: fake.spawn,
      runCapture: fakeRunner({
        dir: setup.dir,
        captures: CAPTURES,
        exitCodes: { 'screenshots:webkit:1': 1 },
      }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.captureFailures).toHaveLength(1);
    expect(fake.closedCount()).toBe(3);
    expect(result.load).toMatchObject({
      requested: 3,
      started: 3,
      stopped: 3,
      active: 0,
    });
    expect(result.report).toContain('FAIL: screenshot repro failed');
    expect(result.report).toContain('Capture failures:');
    expect(result.report).toContain('Load: 3/3 CPU worker process(es) started, 3 stopped');
  });

  it('reclaims the load when the repro throws mid-run', async () => {
    const setup = fixture();
    const fake = fakeLoadSpawn();

    await expect(
      runScreenshotRepro({
        ...setup,
        load: 2,
        spawnLoadWorker: fake.spawn,
        runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
        verifyLog: verifyOk,
        progress: () => {
          throw new Error('progress boom');
        },
      }),
    ).rejects.toThrow('progress boom');

    expect(fake.children).toHaveLength(2);
    expect(fake.closedCount()).toBe(2);
    for (const child of fake.children) {
      expect(child.killed).toEqual(['SIGTERM']);
    }
  });

  it('fails the repro and lists the worker when a load worker cannot start', async () => {
    const setup = fixture();
    const fake = fakeLoadSpawn({ failOnCall: 2 });

    const result = await runScreenshotRepro({
      ...setup,
      load: 3,
      spawnLoadWorker: fake.spawn,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
      verifyLog: verifyOk,
    });

    // The captures themselves pass, so only the failed start can turn ok false.
    expect(result.captureFailures).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.load).toMatchObject({
      requested: 3,
      started: 2,
      stopped: 2,
      exitedEarly: 0,
      active: 0,
    });
    expect(result.load.failures).toEqual([
      { index: 2, phase: 'start', message: 'spawn EAGAIN' },
    ]);
    expect(result.report).toContain('FAIL: screenshot repro failed');
    expect(result.report).toContain(
      'Load: 2/3 CPU worker process(es) started, 2 stopped (all exited), 1 failure(s).',
    );
    expect(result.report).toContain('worker 2 (start): spawn EAGAIN');
  });

  it('fails the repro when a load worker emits an asynchronous spawn error', async () => {
    const setup = fixture();
    const fake = fakeLoadSpawn({ errorOnCall: 2, errorMessage: 'spawn EMFILE' });
    const runner = fakeRunner({ dir: setup.dir, captures: CAPTURES });

    const result = await runScreenshotRepro({
      ...setup,
      load: 3,
      spawnLoadWorker: fake.spawn,
      // Keep a wrong "signal the failed spawn" path short and explicit
      // instead of letting it trip the test runner's timeout.
      killGraceMs: 10,
      // The error timer is queued during startCpuLoad, before this capture
      // delay, so it fires first; the delay only guarantees stop() runs after
      // the error has landed.
      runCapture: async (options) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
        return runner(options);
      },
      verifyLog: verifyOk,
    });

    expect(result.captureFailures).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.load).toMatchObject({
      requested: 3,
      started: 2,
      stopped: 2,
      exitedEarly: 0,
      active: 0,
    });
    expect(result.load.failures).toEqual([
      { index: 2, phase: 'start', message: 'spawn EMFILE' },
    ]);
    expect(result.report).toContain('FAIL: screenshot repro failed');
    expect(result.report).toContain(
      'Load: 2/3 CPU worker process(es) started, 2 stopped (all exited), 1 failure(s).',
    );
    expect(result.report).toContain('worker 2 (start): spawn EMFILE');
    // The failed spawn is not a process, so stop() must not signal it. This
    // assertion fails if the error handler stops marking the failed worker
    // closed.
    expect(fake.children[1]?.killed).toEqual([]);
  });

  it('fails the repro when a load worker cannot be stopped', async () => {
    const setup = fixture();
    const fake = fakeLoadSpawn({ ignoreSignals: true });

    const result = await runScreenshotRepro({
      ...setup,
      load: 1,
      spawnLoadWorker: fake.spawn,
      killGraceMs: 5,
      logger: { log: () => {}, error: () => {} },
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.load).toEqual({
      requested: 1,
      started: 1,
      stopped: 0,
      exitedEarly: 0,
      active: 1,
      failures: [
        { index: 1, phase: 'stop', message: 'did not exit within 10ms' },
      ],
    });
    expect(result.report).toContain('FAIL: screenshot repro failed');
    expect(result.report).toContain(
      'Load: 1/1 CPU worker process(es) started, 0 stopped, 1 still active, 1 failure(s).',
    );
    expect(result.report).toContain('worker 1 (stop): did not exit within 10ms');
  });

  it('fails the repro when a load worker exits before stop', async () => {
    const setup = fixture();
    const fake = fakeLoadSpawn({ exitAfterMs: 1 });
    const runner = fakeRunner({ dir: setup.dir, captures: CAPTURES });

    const result = await runScreenshotRepro({
      ...setup,
      targets: ['screenshots:webkit'],
      runs: 1,
      load: 1,
      spawnLoadWorker: fake.spawn,
      // Wait long enough for the worker's pre-stop exit to land.
      runCapture: async (options) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        return runner(options);
      },
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(false);
    expect(result.load).toMatchObject({
      requested: 1,
      started: 1,
      stopped: 1,
      exitedEarly: 1,
      active: 0,
    });
    expect(result.load.failures).toEqual([
      {
        index: 1,
        phase: 'runtime',
        message: 'exited before stop (code 0, signal null)',
      },
    ]);
    expect(result.report).toContain('FAIL: screenshot repro failed');
    expect(result.report).toContain(
      'worker 1 (runtime): exited before stop (code 0, signal null)',
    );
  });

  it('returns 1 from main when a load worker fails to start', async () => {
    const setup = fixture();
    const fake = fakeLoadSpawn({ failOnCall: 1 });
    const summaryPath = join(setup.root, 'summary.md');
    const log = logger();

    const code = await main([], {
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      logger: log,
      runRepro: (options) =>
        runScreenshotRepro({
          ...options,
          load: 1,
          spawnLoadWorker: fake.spawn,
          runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
          verifyLog: verifyOk,
        }),
      appendFile: appendFileSync,
      repoRoot: setup.root,
    });

    expect(code).toBe(1);
    expect(log.lines.join('\n')).toContain('worker 1 (start): spawn EAGAIN');
    expect(readFileSync(summaryPath, 'utf8')).toContain(
      'worker 1 (start): spawn EAGAIN',
    );
  });
});

describe('screenshot repro subprocess wiring', () => {
  it('writes both child streams from an injected spawn and maps its exit code', async () => {
    const setup = fixture();
    const logPath = join(setup.logDir, 'injected.log');
    const calls: string[][] = [];

    const code = await spawnContainerCapture({
      target: 'screenshots:webkit',
      logPath,
      repoRoot: setup.root,
      env: {},
      spawn: fakeChildSpawn({ calls }),
    });

    expect(code).toBe(9);
    expect(calls).toEqual([
      [
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        'run',
        'screenshots:container',
        '--',
        'screenshots:webkit',
      ],
    ]);
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('injected stdout');
    expect(log).toContain('injected stderr');
  });

  it('forwards the injected spawn through the default capture runner', async () => {
    const setup = fixture();
    const calls: string[][] = [];

    const result = await runScreenshotRepro({
      ...setup,
      repoRoot: setup.root,
      spawn: fakeChildSpawn({ exitCode: 0, calls }),
      verifyLog: verifyOk,
    });

    expect(calls).toHaveLength(4);
    expect(result.captureFailures).toEqual([]);
    expect(result.runs).toHaveLength(4);
    for (const run of result.runs) {
      expect(run.exitCode).toBe(0);
      expect(readFileSync(run.logPath, 'utf8')).toContain('injected stdout');
    }
  });

  it('waits for the capture to close when the log stream fails', async () => {
    const setup = fixture();

    const code = await spawnContainerCapture({
      target: 'screenshots:webkit',
      // A directory path makes createWriteStream emit EISDIR asynchronously.
      logPath: setup.dir,
      repoRoot: setup.root,
      env: {},
      spawn: fakeChildSpawn({ closeDelayMs: 25 }),
    });

    expect(code).toBe(9);
  });

  it.skipIf(process.platform === 'win32')(
    'streams the real child stdout/stderr into the per-run log and returns its exit code',
    async () => {
      const setup = fixture();
      const env = fakeNpmBin(7);
      const logPath = join(setup.logDir, 'capture.log');

      const code = await spawnContainerCapture({
        target: 'screenshots:webkit',
        logPath,
        repoRoot: setup.root,
        env,
      });

      expect(code).toBe(7);
      const log = readFileSync(logPath, 'utf8');
      expect(log).toContain(
        'fake npm stdout run screenshots:container -- screenshots:webkit',
      );
      expect(log).toContain(
        'fake npm stderr run screenshots:container -- screenshots:webkit',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'maps a real non-zero capture exit into captureFailures',
    async () => {
      const setup = fixture();
      const env = fakeNpmBin(7);

      const result = await runScreenshotRepro({
        ...setup,
        repoRoot: setup.root,
        env,
        verifyLog: verifyOk,
      });

      expect(result.ok).toBe(false);
      expect(result.captureFailures).toHaveLength(4);
      for (const failure of result.captureFailures) {
        expect(failure.exitCode).toBe(7);
        expect(readFileSync(failure.logPath, 'utf8')).toContain('fake npm stderr');
      }
      expect(result.report).toContain('4 capture failure(s)');
    },
  );

  it('maps a non-zero verifier exit from the default verifyLog into verifyFailures', async () => {
    const setup = fixture();
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: unknown;
    }> = [];
    const fakeSpawnSync = ((
      command: string,
      args: readonly string[],
      options: unknown,
    ) => {
      calls.push({ command, args: [...args], options });
      return {
        pid: -1,
        output: [],
        stdout: 'verifier stdout\n',
        stderr: 'verifier stderr\n',
        status: 3,
        signal: null,
      };
    }) as unknown as typeof nodeSpawnSync;

    const result = await runScreenshotRepro({
      ...setup,
      repoRoot: setup.root,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
      spawnSync: fakeSpawnSync,
    });

    expect(result.ok).toBe(false);
    expect(result.verifyFailures).toHaveLength(4);
    expect(result.verifyFailures[0]?.exitCode).toBe(3);
    expect(result.report).toContain('verifier stderr');
    expect(calls).toHaveLength(4);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args).toContain(
      resolve(setup.root, 'scripts', 'verify-screenshot-sha256.mjs'),
    );
    expect(calls[0]?.args).toContain('--log');
    expect(calls[0]?.args).toContain(result.runs[0]?.logPath);
    expect(calls[0]?.options).toMatchObject({ cwd: setup.root });
  });
});

describe('verify-screenshot-repro direct entry', () => {
  it('exits 0 for --help through the real invokedDirectly branch', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: node scripts/verify-screenshot-repro.mjs');
    // Pin the documented --load range, not just the generic usage banner.
    expect(result.stdout).toContain('--load <N>');
    expect(result.stdout).toContain(`0-${MAX_LOAD_COUNT}`);
  });

  it('exits 2 for a usage error and for an invalid manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'screenshot-repro-cli-'));
    tempDirs.push(root);

    const usage = runCli(['--bogus']);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('unknown option: --bogus');

    const invalidManifest = join(root, 'invalid-manifest.json');
    writeFileSync(invalidManifest, '{"captures": []}\n');
    const invalid = runCli(['--manifest', invalidManifest]);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('FAIL: screenshot repro could not run');
    expect(invalid.stderr).toContain('captures');
  });

  it.skipIf(process.platform === 'win32')(
    'exits non-zero through process.exitCode when a capture fails',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'screenshot-repro-cli-fail-'));
      tempDirs.push(root);
      const manifest = JSON.parse(
        readFileSync(REAL_MANIFEST, 'utf8'),
      ) as ScreenshotSha256Manifest;
      const manifestPath = join(root, 'manifest.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          environment: manifest.environment,
          captures: [manifest.captures[0]],
        }),
      );
      const dir = join(root, 'screenshots');
      mkdirSync(dir, { recursive: true });
      const logDir = join(root, 'logs');
      const env = fakeNpmBin(7);

      const result = runCli(
        ['--manifest', manifestPath, '--dir', dir, '--log-dir', logDir, '--load', '2'],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FAIL: screenshot repro failed');
      expect(result.stderr).toContain('Capture failures:');
      expect(result.stderr).toContain('exit 7');
      expect(result.stderr).toContain(
        'Load: 2/2 CPU worker process(es) started, 2 stopped (all exited).',
      );
      // The real default verifyLog runs verify-screenshot-sha256.mjs against
      // the fake log, so a stubbed default spawnSync would drop this section.
      expect(result.stderr).toContain('Log verification failures:');
    },
  );
});

function logger() {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    },
    error: (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    },
  };
}

describe('verify-screenshot-repro CLI', () => {
  it('parses options and defaults', () => {
    expect(parseArgs([])).toEqual({
      help: false,
      manifest: 'docs/screenshots/capture-sha256-manifest.json',
      dir: 'docs/screenshots',
      logDir: 'test-results/screenshot-repro',
      targets: [],
      runs: 2,
      load: 0,
    });
    expect(
      parseArgs(['--manifest', 'm.json', '--dir', 'shots', '--log-dir', 'logs']),
    ).toEqual({
      help: false,
      manifest: 'm.json',
      dir: 'shots',
      logDir: 'logs',
      targets: [],
      runs: 2,
      load: 0,
    });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(() => parseArgs(['--wat'])).toThrow(ScreenshotReproError);
    expect(() => parseArgs(['--dir'])).toThrow(ScreenshotReproError);
  });

  it('parses repeatable --target values, a positive --runs count and --load', () => {
    expect(
      parseArgs([
        '--target',
        'screenshots:breakout:webkit',
        '--target',
        'screenshots:webkit',
        '--runs',
        '4',
      ]),
    ).toMatchObject({
      targets: ['screenshots:breakout:webkit', 'screenshots:webkit'],
      runs: 4,
    });
    expect(() => parseArgs(['--target'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--target', 'screenshots'])).toThrow(
      /invalid repro target/,
    );
    expect(() => parseArgs(['--runs'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--runs', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--runs', '2.5'])).toThrow(/positive integer/);

    expect(parseArgs(['--load', '3']).load).toBe(3);
    expect(parseArgs(['--load', '0']).load).toBe(0);
    expect(() => parseArgs(['--load'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--load', '-1'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--load', '2.5'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['--load', 'x'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['--load', String(MAX_LOAD_COUNT + 1)])).toThrow(
      new RegExp(`at most ${MAX_LOAD_COUNT}`),
    );
  });

  it('writes the real failure report to the logger and GITHUB_STEP_SUMMARY with exit 1', async () => {
    const setup = fixture();
    const summaryPath = join(setup.root, 'summary.md');
    const log = logger();

    const code = await main([], {
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      logger: log,
      runRepro: (options) =>
        runScreenshotRepro({
          ...options,
          runCapture: fakeRunner({
            dir: setup.dir,
            captures: CAPTURES,
            writes: { 'after-2048-playing-webkit.png': { 2: 'playing-v2' } },
          }),
          verifyLog: verifyOk,
        }),
      appendFile: appendFileSync,
      repoRoot: setup.root,
    });

    expect(code).toBe(1);
    const output = log.lines.join('\n');
    expect(output).toContain('FAIL: screenshot repro failed');
    expect(output).toContain('expected sha256:');
    expect(output).toContain('Recapture steps:');
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('FAIL: screenshot repro failed');
    expect(summary).toContain('expected sha256:');
    expect(summary).toContain('Recapture steps:');
  });

  it('returns 0 and appends the real passing report to the step summary', async () => {
    const setup = fixture();
    const summaryPath = join(setup.root, 'summary.md');
    const log = logger();

    const code = await main([], {
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      logger: log,
      runRepro: (options) =>
        runScreenshotRepro({
          ...options,
          runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES }),
          verifyLog: verifyOk,
        }),
      appendFile: appendFileSync,
      repoRoot: setup.root,
    });

    expect(code).toBe(0);
    expect(log.lines.join('\n')).toContain('OK: screenshot repro passed');
    expect(readFileSync(summaryPath, 'utf8')).toContain('OK: screenshot repro passed');
  });

  it('forwards --target / --runs / --load and live progress to the repro runner', async () => {
    const setup = fixture();
    const calls: Array<{
      targets?: string[];
      runs?: number;
      load?: number;
      repoRoot?: string;
    }> = [];
    const log = logger();

    const code = await main(
      ['--target', 'screenshots:webkit', '--runs', '4', '--load', '2'],
      {
        env: {},
        logger: log,
        runRepro: async (options) => {
          calls.push({
            targets: options.targets,
            runs: options.runs,
            load: options.load,
            repoRoot: options.repoRoot,
          });
          options.progress?.('  screenshots:webkit run 1: a.png sha256 abc');
          return { ok: true, report: 'OK: forwarded' } as Awaited<
            ReturnType<typeof runScreenshotRepro>
          >;
        },
        appendFile: appendFileSync,
        repoRoot: setup.root,
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        targets: ['screenshots:webkit'],
        runs: 4,
        load: 2,
        repoRoot: setup.root,
      },
    ]);
    expect(log.lines.join('\n')).toContain(
      'screenshots:webkit run 1: a.png sha256 abc',
    );
    expect(log.lines.join('\n')).toContain('OK: forwarded');
  });

  it('returns 2 for usage errors and for an invalid manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repro-cli-'));
    tempDirs.push(root);
    const summaryPath = join(root, 'summary.md');
    const usage = await main(['--nope'], {
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      logger: logger(),
      runRepro: async () => {
        throw new Error('must not run');
      },
      appendFile: appendFileSync,
    });
    expect(usage).toBe(2);

    const invalid = await main([], {
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      logger: logger(),
      runRepro: async () => {
        throw new ScreenshotReproError('bad manifest');
      },
      appendFile: appendFileSync,
    });
    expect(invalid).toBe(2);
    expect(readFileSync(summaryPath, 'utf8')).toContain('bad manifest');
  });

  it('returns 0 and prints usage for --help', async () => {
    const log = logger();
    const code = await main(['--help'], {
      env: {},
      logger: log,
      runRepro: async () => {
        throw new Error('must not run');
      },
    });
    expect(code).toBe(0);
    const output = log.lines.join('\n');
    expect(output).toContain('Usage: node scripts/verify-screenshot-repro.mjs');
    expect(output).toContain('--load <N>');
    expect(output).toContain(`0-${MAX_LOAD_COUNT}`);
  });
});
