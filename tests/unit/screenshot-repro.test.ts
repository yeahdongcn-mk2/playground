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
  deriveReproPlans,
  normalizeRunCount,
  parseCaptureTarget,
  reproArtifactPath,
  reproLogPath,
  runScreenshotRepro,
  ScreenshotReproError,
  selectReproPlans,
  sha256VerifierArgs,
  spawnContainerCapture,
  validateCaptureTarget,
} from '../../scripts/lib/screenshot-repro.mjs';
import type {
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
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES, order }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(true);
    for (const capture of CAPTURES) {
      expect(readFileSync(join(setup.dir, capture.file), 'utf8')).toBe(capture.content);
    }
    expect(result.report).toContain('OK: screenshot repro passed');
    expect(result.report).toContain('3 file(s) matched');
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
        ['--manifest', manifestPath, '--dir', dir, '--log-dir', logDir],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FAIL: screenshot repro failed');
      expect(result.stderr).toContain('Capture failures:');
      expect(result.stderr).toContain('exit 7');
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
    });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(() => parseArgs(['--wat'])).toThrow(ScreenshotReproError);
    expect(() => parseArgs(['--dir'])).toThrow(ScreenshotReproError);
  });

  it('parses repeatable --target values and a positive --runs count', () => {
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

  it('forwards --target / --runs and live progress to the repro runner', async () => {
    const setup = fixture();
    const calls: Array<{ targets?: string[]; runs?: number; repoRoot?: string }> = [];
    const log = logger();

    const code = await main(['--target', 'screenshots:webkit', '--runs', '4'], {
      env: {},
      logger: log,
      runRepro: async (options) => {
        calls.push({
          targets: options.targets,
          runs: options.runs,
          repoRoot: options.repoRoot,
        });
        options.progress?.('  screenshots:webkit run 1: a.png sha256 abc');
        return { ok: true, report: 'OK: forwarded' } as Awaited<
          ReturnType<typeof runScreenshotRepro>
        >;
      },
      appendFile: appendFileSync,
      repoRoot: setup.root,
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { targets: ['screenshots:webkit'], runs: 4, repoRoot: setup.root },
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
    expect(log.lines.join('\n')).toContain('Usage: node scripts/verify-screenshot-repro.mjs');
  });
});
