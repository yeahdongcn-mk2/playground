import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
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
  captureTargetForScript,
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
  it('maps WebKit targets to DPR 2 and everything else to desktop DPR 1', () => {
    expect(captureTargetForScript('screenshots:webkit')).toBe('webkit');
    expect(captureTargetForScript('screenshots:minesweeper:webkit-narrow')).toBe(
      'webkit',
    );
    expect(captureTargetForScript('screenshots:snake:webkit')).toBe('webkit');
    expect(captureTargetForScript('screenshots')).toBe('desktop');
    expect(captureTargetForScript('screenshots:minesweeper')).toBe('desktop');
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

  it('declares desktop DPR 1 for the Chromium screenshot target', () => {
    const args = buildDockerRunArgs({
      target: 'screenshots',
      repoRoot: '/repo',
      image,
      containerImage: localCaptureImageName(),
      previewPort: null,
      env: {},
    });
    const envArgs = envArgsOf(args);
    expect(envArgs).toContain('CAPTURE_TARGET=desktop');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=1');
    expect(envArgs.some((value) => value.startsWith('PREVIEW_PORT='))).toBe(false);
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
