import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  parseCaptureTarget,
  reproLogPath,
  runScreenshotRepro,
  ScreenshotReproError,
  sha256VerifierArgs,
} from '../../scripts/lib/screenshot-repro.mjs';
import type {
  ReproRunCaptureOptions,
  ReproVerification,
} from '../../scripts/lib/screenshot-repro.mjs';
import type { ScreenshotSha256Manifest } from '../../scripts/lib/screenshot-sha256.mjs';
import { main, parseArgs } from '../../scripts/verify-screenshot-repro.mjs';

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

function fixture(captures: CaptureSpec[] = CAPTURES): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-repro-'));
  tempDirs.push(root);
  const dir = join(root, 'docs', 'screenshots');
  const logDir = join(root, 'test-results', 'screenshot-repro');
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'capture-sha256-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifestFor(captures), null, 2)}\n`);
  for (const capture of captures) {
    writeFileSync(join(dir, capture.file), capture.content);
  }
  return { root, dir, logDir, manifestPath };
}

interface RunnerOptions {
  dir: string;
  captures: CaptureSpec[];
  order?: string[];
  /** Per file and run override of the bytes the capture "writes". */
  writes?: Record<string, Partial<Record<number, string>>>;
  exitCodes?: Record<string, number>;
  platforms?: Record<number, string>;
}

function fakeRunner({
  dir,
  captures,
  order,
  writes = {},
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
    for (const capture of byTarget.get(target) ?? []) {
      const content = writes[capture.file]?.[run] ?? capture.content;
      writeFileSync(join(dir, capture.file), content);
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
});

describe('screenshot repro two-run check', () => {
  it('passes when both runs match the manifest and each log verifies', async () => {
    const setup = fixture();
    const order: string[] = [];
    const result = await runScreenshotRepro({
      ...setup,
      runCapture: fakeRunner({ dir: setup.dir, captures: CAPTURES, order }),
      verifyLog: verifyOk,
    });

    expect(result.ok).toBe(true);
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
      'both runs agree with each other but not with the manifest',
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
    });
    expect(
      parseArgs(['--manifest', 'm.json', '--dir', 'shots', '--log-dir', 'logs']),
    ).toEqual({ help: false, manifest: 'm.json', dir: 'shots', logDir: 'logs' });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(() => parseArgs(['--wat'])).toThrow(ScreenshotReproError);
    expect(() => parseArgs(['--dir'])).toThrow(ScreenshotReproError);
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
