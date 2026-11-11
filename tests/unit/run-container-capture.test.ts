import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
  resolveCaptureImage,
} from '../../scripts/lib/capture-env.mjs';
import {
  CAPTURE_LOCK_HASH_FILE,
  buildDockerRunArgs,
  captureTargetsForScript,
  captureTargets,
  ensureCaptureImage,
  ensureContainerDependencies,
  localCaptureImageName,
  parseContainerCaptureArgs,
  preflightDocker,
  previewPortForTarget,
  readPackageScripts,
  runContainerCapture,
  type RunContainerCaptureOptions,
} from '../../scripts/run-container-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = readPackageScripts();

type Env = Record<string, string | undefined>;

const CONTAINER_ENV: Env = {
  CAPTURE_CONTAINER: '1',
  CAPTURE_IMAGE_TAG: PLAYWRIGHT_IMAGE_PIN.tag,
  CAPTURE_IMAGE_DIGEST: PLAYWRIGHT_IMAGE_PIN.digest,
  CAPTURE_TARGET: 'webkit',
  CAPTURE_TARGET_DPR: '2',
  ...CAPTURE_EGL_ENV,
};

function fakeSpawnSync(
  result: Partial<{
    error: Error & { code?: string };
    status: number | null;
    stdout: string;
    stderr: string;
  }>,
): typeof spawnSync {
  return (() => ({
    error: undefined,
    status: 0,
    stdout: '',
    stderr: '',
    ...result,
  })) as unknown as typeof spawnSync;
}

function fakeSpawn(
  onCall: (command: string, args: readonly string[]) => void = () => {},
): NonNullable<RunContainerCaptureOptions['spawn']> {
  return vi.fn((command: string, args: readonly string[]) => {
    onCall(command, args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  }) as unknown as NonNullable<RunContainerCaptureOptions['spawn']>;
}

function envArgsOf(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (arg === '--env' ? [args[index + 1] ?? ''] : []));
}

const HOST_SCRIPTS = JSON.stringify({
  scripts: { 'screenshots:webkit': 'node scripts/capture-screenshots.mjs --webkit' },
});
const HOST_LOCKFILE = JSON.stringify({
  packages: { 'node_modules/@playwright/test': { version: '1.64.1' } },
});

function fakeHostReadFile(path: string): string {
  if (path.endsWith('package-lock.json')) {
    return HOST_LOCKFILE;
  }
  if (path.endsWith('package.json')) {
    return HOST_SCRIPTS;
  }
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

interface FakeDockerRunChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeDockerRunChild(): FakeDockerRunChild {
  const child = new EventEmitter() as FakeDockerRunChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

describe('container capture target whitelist', () => {
  it('accepts the screenshot npm scripts and rejects the entry itself', () => {
    const targets = captureTargets(SCRIPTS);
    expect(targets).toContain('screenshots');
    expect(targets).toContain('screenshots:webkit');
    expect(targets).toContain('screenshots:minesweeper:webkit-narrow');
    expect(targets).not.toContain('screenshots:container');
    expect(targets).not.toContain('screenshots:baseline');
  });

  it('parses the target and passes later arguments through', () => {
    expect(
      parseContainerCaptureArgs(
        ['screenshots:webkit', '--allow-historical-overwrite'],
        { scripts: SCRIPTS },
      ),
    ).toEqual({
      target: 'screenshots:webkit',
      passthrough: ['--allow-historical-overwrite'],
    });
  });

  it('reports a missing or unknown target with the available targets', () => {
    expect(() => parseContainerCaptureArgs([], { scripts: SCRIPTS })).toThrow(
      /Usage: npm run screenshots:container -- <target>/,
    );
    expect(() =>
      parseContainerCaptureArgs(['screenshots:unknown'], { scripts: SCRIPTS }),
    ).toThrow(/Unknown container capture target "screenshots:unknown".*screenshots:webkit/);
  });
});

describe('container capture target DPR and preview port', () => {
  it('maps every screenshot script to the targets it actually records', () => {
    expect(captureTargetsForScript('screenshots:webkit')).toEqual(['webkit']);
    expect(captureTargetsForScript('screenshots:minesweeper:webkit-narrow')).toEqual([
      'webkit',
    ]);
    expect(captureTargetsForScript('screenshots:snake:webkit')).toEqual(['webkit']);
    expect(captureTargetsForScript('screenshots')).toEqual(['desktop', 'mobile']);
    expect(captureTargetsForScript('screenshots:minesweeper')).toEqual([
      'desktop',
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:scores')).toEqual([
      'desktop',
      'mobile',
    ]);
    // The Before variants capture the same desktop + phone pair.
    expect(captureTargetsForScript('screenshots:2048:before')).toEqual([
      'desktop',
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:breakout:before')).toEqual([
      'desktop',
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:scores-before')).toEqual([
      'desktop',
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:scores-clear')).toEqual([
      'desktop',
      'mobile',
    ]);
    // These modes only create Chromium phone contexts, so a run captured them
    // at DPR 2 and never wrote a desktop image.
    expect(captureTargetsForScript('screenshots:minesweeper:narrow')).toEqual([
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:min-before')).toEqual([
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:short')).toEqual([
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:large')).toEqual([
      'mobile',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:touch-before')).toEqual([
      'mobile',
    ]);
  });

  it('uses the preview port each screenshot script starts', () => {
    expect(previewPortForTarget('screenshots', '')).toBe(4174);
    expect(previewPortForTarget('screenshots:webkit', '')).toBe(4174);
    expect(previewPortForTarget('screenshots:snake', '')).toBe(5188);
    expect(previewPortForTarget('screenshots:2048', '')).toBe(4183);
    expect(previewPortForTarget('screenshots:breakout', '')).toBe(4185);
    expect(previewPortForTarget('screenshots:minesweeper', '')).toBe(4186);
    expect(previewPortForTarget('screenshots:minesweeper:scores', '')).toBe(4192);
    expect(previewPortForTarget('screenshots:baseline', '')).toBeNull();
    expect(previewPortForTarget('screenshots:webkit', '4999')).toBe(4999);
  });
});

describe('docker run construction', () => {
  const image = resolveCaptureImage({ version: '1.64.1' });

  it('mounts the repository, injects the EGL contract and appends passthrough args', () => {
    const args = buildDockerRunArgs({
      target: 'screenshots:webkit',
      passthrough: ['--allow-historical-overwrite'],
      repoRoot: '/repo',
      image,
      containerImage: localCaptureImageName(),
      uid: 1000,
      gid: 1000,
      previewPort: 4174,
      env: { BASE_URL: 'http://127.0.0.1:5189' },
    });

    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('host');
    expect(args).toContain('--volume');
    expect(args[args.indexOf('--volume') + 1]).toBe('/repo:/work');
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');

    const envArgs = envArgsOf(args);
    expect(envArgs).toContain('HOME=/tmp');
    expect(envArgs).toContain('CAPTURE_CONTAINER=1');
    expect(envArgs).toContain(`CAPTURE_IMAGE_TAG=${PLAYWRIGHT_IMAGE_PIN.tag}`);
    expect(envArgs).toContain(`CAPTURE_IMAGE_DIGEST=${PLAYWRIGHT_IMAGE_PIN.digest}`);
    expect(envArgs).toContain('CAPTURE_TARGET=webkit');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=2');
    for (const name of CAPTURE_EGL_VARS) {
      expect(envArgs).toContain(`${name}=${CAPTURE_EGL_ENV[name]}`);
    }
    expect(envArgs).toContain('PREVIEW_PORT=4174');
    expect(envArgs).toContain('BASE_URL=http://127.0.0.1:5189');

    expect(args.slice(-3)).toEqual([
      localCaptureImageName(),
      'screenshots:webkit',
      '--allow-historical-overwrite',
    ]);
    expect(image.reference).toBe(
      `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
    );
  });

  it('declares desktop DPR 1 and mobile DPR 2 for a Chromium screenshot target', () => {
    const args = buildDockerRunArgs({
      target: 'screenshots',
      repoRoot: '/repo',
      image,
      containerImage: localCaptureImageName(),
      previewPort: null,
      env: {},
    });
    const envArgs = envArgsOf(args);
    expect(envArgs).toContain('CAPTURE_TARGET=desktop,mobile');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=1,2');
    expect(envArgs.some((value) => value.startsWith('PREVIEW_PORT='))).toBe(false);
  });

  it('declares only mobile DPR 2 for the phone-only narrow modes', () => {
    const args = buildDockerRunArgs({
      target: 'screenshots:minesweeper:narrow',
      repoRoot: '/repo',
      image,
      containerImage: localCaptureImageName(),
      previewPort: 4186,
      env: {},
    });
    const envArgs = envArgsOf(args);
    expect(envArgs).toContain('CAPTURE_TARGET=mobile');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=2');
  });
});

describe('container entry preflight', () => {
  it('reports a missing Docker CLI', () => {
    expect(() =>
      preflightDocker({
        spawnSync: fakeSpawnSync({
          error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
          status: null,
        }),
      }),
    ).toThrow(/Docker CLI was not found/);
  });

  it('reports an unreachable Docker daemon with its stderr', () => {
    expect(() =>
      preflightDocker({
        spawnSync: fakeSpawnSync({
          status: 1,
          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
        }),
      }),
    ).toThrow(/Docker daemon is not reachable[\s\S]*Cannot connect to the Docker daemon/);
  });

  it('rejects a lockfile Playwright version that has no pinned image tag', () => {
    expect(() => resolveCaptureImage({ version: '1.65.0' })).toThrow(
      /does not match.*1\.65\.0|v1\.64\.1-noble/,
    );
  });

  it('builds the local image only when it is missing', () => {
    const calls: string[][] = [];
    const spawnSyncFake = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return calls.length === 1
        ? { error: undefined, status: 1, stdout: '', stderr: 'No such image' }
        : { error: undefined, status: 0, stdout: '', stderr: '' };
    }) as unknown as typeof spawnSync;

    expect(ensureCaptureImage({ spawnSync: spawnSyncFake, repoRoot: '/repo' })).toBe(
      localCaptureImageName(),
    );
    expect(calls[1]).toEqual([
      'docker',
      'build',
      '--file',
      '/repo/docker/capture/Dockerfile',
      '--tag',
      localCaptureImageName(),
      '/repo/docker/capture',
    ]);
  });
});

describe('on-demand dependency install', () => {
  const LOCK = '{"lockfileVersion":3}\n';
  const HASH = createHash('sha256').update(LOCK).digest('hex');

  function fakeFiles(entries: Record<string, string>) {
    const files = new Map(Object.entries(entries));
    return {
      files,
      readFile: (path: string): string => {
        const value = files.get(path);
        if (value === undefined) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        }
        return value;
      },
      existsSync: (path: string): boolean => files.has(path),
      writeFile: (path: string, data: string): void => {
        files.set(path, data);
      },
    };
  }

  it('skips npm ci when the lock hash marker and node_modules are current', async () => {
    const spawn = fakeSpawn();
    const store = fakeFiles({
      '/repo/package-lock.json': LOCK,
      [`/repo/${CAPTURE_LOCK_HASH_FILE}`]: `${HASH}\n`,
      '/repo/node_modules': '',
    });

    await expect(
      ensureContainerDependencies({
        repoRoot: '/repo',
        env: {},
        spawn,
        readFile: store.readFile,
        existsSync: store.existsSync,
        writeFile: store.writeFile,
      }),
    ).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs npm ci and records the lock hash when node_modules is stale', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn = fakeSpawn((command, args) => calls.push({ command, args: [...args] }));
    const store = fakeFiles({ '/repo/package-lock.json': LOCK });

    await expect(
      ensureContainerDependencies({
        repoRoot: '/repo',
        env: {},
        spawn,
        readFile: store.readFile,
        existsSync: store.existsSync,
        writeFile: store.writeFile,
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      { command: 'npm', args: ['ci', '--no-audit', '--no-fund'] },
    ]);
    expect(store.files.get(`/repo/${CAPTURE_LOCK_HASH_FILE}`)).toBe(`${HASH}\n`);
  });
});

describe('in-container capture run', () => {
  it('validates the injected environment and runs the npm target', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const code = await runContainerCapture({
      argv: ['screenshots:webkit', '--allow-historical-overwrite'],
      env: CONTAINER_ENV,
      spawn: fakeSpawn((command, args) => calls.push({ command, args: [...args] })),
      ensureDependencies: async () => false,
      logger: { log: () => {} },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        command: 'npm',
        args: ['run', 'screenshots:webkit', '--', '--allow-historical-overwrite'],
      },
    ]);
  });

  it('fails before running npm when a required EGL variable is missing', async () => {
    const calls: string[] = [];
    const env: Env = { ...CONTAINER_ENV };
    delete env.EGL_PLATFORM;

    await expect(
      runContainerCapture({
        argv: ['screenshots:webkit'],
        env,
        spawn: fakeSpawn((command) => calls.push(command)),
        ensureDependencies: async () => false,
        logger: { log: () => {} },
      }),
    ).rejects.toThrow(/EGL_PLATFORM/);
    expect(calls).toEqual([]);
  });

  it('fails before running npm when the target DPR contradicts the target', async () => {
    const calls: string[] = [];
    await expect(
      runContainerCapture({
        argv: ['screenshots:webkit'],
        env: { ...CONTAINER_ENV, CAPTURE_TARGET_DPR: '1' },
        spawn: fakeSpawn((command) => calls.push(command)),
        ensureDependencies: async () => false,
        logger: { log: () => {} },
      }),
    ).rejects.toThrow(/Capture DPR 1 does not match target "webkit": expected 2/);
    expect(calls).toEqual([]);
  });
});

describe('host container capture run', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function hostHarness({
    exitCode = 0,
    env = {},
    checkPort = vi.fn(async () => {}),
  }: {
    exitCode?: number;
    env?: Env;
    checkPort?: (port: number, host?: string) => Promise<void>;
  } = {}) {
    const argv = ['screenshots:webkit'];
    const logDir = mkdtempSync(join(tmpdir(), 'capture-container-'));
    tempDirs.push(logDir);
    const now = '2026-11-12T00-00-00-000Z';
    const logPath = join(logDir, `screenshots-webkit-${now}.log`);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      const child = fakeDockerRunChild();
      queueMicrotask(() => {
        child.stdout.write('container stdout\n');
        child.stderr.write('container stderr\n');
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', exitCode, null);
      });
      return child;
    });
    const logger = { log: vi.fn() };
    const options: RunContainerCaptureOptions = {
      argv,
      env,
      spawn: spawn as unknown as NonNullable<RunContainerCaptureOptions['spawn']>,
      spawnSync: fakeSpawnSync({ status: 0 }),
      readFile: fakeHostReadFile,
      existsSync: () => true,
      repoRoot: '/repo',
      logDir,
      ensureDependencies: async () => false,
      checkPort,
      logger,
      now: () => now,
      uid: 1000,
      gid: 1000,
    };
    return { options, calls, spawn, logger, checkPort, logPath };
  }

  it('spawns docker run with the built args and forwards child output', async () => {
    const harness = hostHarness();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runContainerCapture(harness.options)).resolves.toBe(0);

    expect(harness.calls).toHaveLength(1);
    const [call] = harness.calls;
    expect(call?.command).toBe('docker');
    expect(call?.args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(call?.args).toContain(localCaptureImageName());
    expect(envArgsOf(call?.args ?? [])).toContain('CAPTURE_TARGET=webkit');
    expect(envArgsOf(call?.args ?? [])).toContain('CAPTURE_TARGET_DPR=2');
    expect(call?.args.slice(-1)).toEqual(['screenshots:webkit']);
    expect(harness.logger.log).toHaveBeenCalledWith(`capture log: ${harness.logPath}`);

    const written = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written(stdout)).toContain('container stdout');
    expect(written(stderr)).toContain('container stderr');
    await vi.waitFor(
      () => {
        const log = readFileSync(harness.logPath, 'utf8');
        expect(log).toContain('container stdout\n');
        expect(log).toContain('container stderr\n');
      },
      { timeout: 5000 },
    );

    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('wraps a preview-port failure with the capture target name', async () => {
    const checkPort = vi.fn(async () => {
      throw new Error('port 4174 is already in use');
    });
    const harness = hostHarness({ checkPort });

    await expect(runContainerCapture(harness.options)).rejects.toThrow(
      'Cannot run container capture "screenshots:webkit": port 4174 is already in use',
    );
    expect(checkPort).toHaveBeenCalledWith(4174);
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.logger.log).not.toHaveBeenCalled();
  });

  it('checks the host port configured through PREVIEW_PORT', async () => {
    const harness = hostHarness({ env: { PREVIEW_PORT: '4999' } });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runContainerCapture(harness.options)).resolves.toBe(0);
    expect(harness.checkPort).toHaveBeenCalledWith(4999);
    expect(envArgsOf(harness.calls[0]?.args ?? [])).toContain('PREVIEW_PORT=4999');
    await vi.waitFor(
      () => {
        expect(readFileSync(harness.logPath, 'utf8')).toContain('container stdout\n');
      },
      { timeout: 5000 },
    );
  });

  it('fails with the log path when docker exits non-zero', async () => {
    const harness = hostHarness({ exitCode: 3 });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const error = await runContainerCapture(harness.options).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'Container capture "screenshots:webkit" failed (exit 3).',
    );
    expect((error as Error).message).toContain(harness.logPath);
    await vi.waitFor(
      () => {
        expect(readFileSync(harness.logPath, 'utf8')).toContain('container stdout\n');
      },
      { timeout: 5000 },
    );
  });
});

describe('fixed capture environment deployment files', () => {
  const image = resolveCaptureImage({ version: '1.64.1' });

  it('pins the Dockerfile to the same image digest and EGL contract', () => {
    const dockerfile = readFileSync(
      join(ROOT, 'docker', 'capture', 'Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toContain(`FROM ${image.reference}`);
    expect(dockerfile).toContain('ENV EGL_PLATFORM=surfaceless');
    expect(dockerfile).toContain('ENV LIBGL_ALWAYS_SOFTWARE=1');
    expect(dockerfile).toContain(
      'ENV __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json',
    );
    // The fixed contract keeps the official fonts and installs nothing extra.
    expect(dockerfile).not.toMatch(/apt-get\s+install/);
    expect(dockerfile).toContain('fonts-wqy-zenhei');
  });

  it('exposes the container entry as an npm script', () => {
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['screenshots:container']).toBe(
      'node scripts/run-container-capture.mjs',
    );
  });
});
