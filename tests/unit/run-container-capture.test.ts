import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import type { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
  assertContainerCaptureEnvironment,
  resolveCaptureImage,
} from '../../scripts/lib/capture-env.mjs';
import {
  CAPTURE_IMAGE_BUILD_LABEL,
  CAPTURE_LOCK_HASH_FILE,
  buildDockerRunArgs,
  captureImageBuildInputFingerprint,
  captureTargets,
  ensureCaptureImage,
  ensureContainerDependencies,
  localCaptureImageName,
  parseCaptureScriptCommand,
  parseContainerCaptureArgs,
  preflightDocker,
  previewPortForTarget,
  readPackageScripts,
  resolveCaptureTargets,
  runContainerCapture,
  type RunContainerCaptureOptions,
} from '../../scripts/run-container-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The declaration tests spawn the real capture scripts (which import
// Playwright), so several cases together exceed the default 5s.
vi.setConfig({ testTimeout: 30_000 });
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

type FakeSpawnSyncResult = Partial<{
  error: Error & { code?: string };
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function spawnSyncResult(result: FakeSpawnSyncResult = {}) {
  return {
    error: undefined,
    status: 0,
    stdout: '',
    stderr: '',
    ...result,
  };
}

function fakeSpawnSync(result: FakeSpawnSyncResult): typeof spawnSync {
  return (() => spawnSyncResult(result)) as unknown as typeof spawnSync;
}

/**
 * Let the real capture scripts answer `--print-capture-targets` even when a
 * test uses a fake repository root for the Docker arguments; Docker commands
 * keep returning the supplied fake result.
 */
function declarationAwareSpawnSync(
  dockerResult: FakeSpawnSyncResult = {},
): typeof spawnSync {
  return ((command: string, args: readonly string[]) => {
    if (command === process.execPath) {
      const [script, ...rest] = args;
      return nodeSpawnSync(process.execPath, [join(ROOT, script!), ...rest], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    }
    return spawnSyncResult(dockerResult);
  }) as unknown as typeof spawnSync;
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
  scripts: {
    'screenshots:webkit': 'node scripts/capture-screenshots.mjs --webkit',
    'screenshots:2048:before': 'node scripts/capture-2048-screenshots.mjs --before',
    'screenshots:breakout:before': 'node scripts/capture-breakout-screenshots.mjs --before',
  },
});
const HOST_LOCKFILE = JSON.stringify({
  packages: { 'node_modules/@playwright/test': { version: '1.64.1' } },
});
const PINNED_FROM = `FROM ${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`;
const PINNED_DOCKERFILE = `${PINNED_FROM}\nENV EGL_PLATFORM=surfaceless\n`;

function fakeHostReadFile(path: string): string {
  if (path.endsWith('package-lock.json')) {
    return HOST_LOCKFILE;
  }
  if (path.endsWith('package.json')) {
    return HOST_SCRIPTS;
  }
  if (path.endsWith('docker/capture/Dockerfile')) {
    return PINNED_DOCKERFILE;
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

describe('container capture target declaration', () => {
  function expectDeclared(
    target: string,
    passthrough: string[],
    expected: string[],
  ): void {
    expect(
      resolveCaptureTargets(target, passthrough, { scripts: SCRIPTS }).targets,
    ).toEqual(expected);
  }

  it('maps every screenshot script to the targets it actually records', () => {
    expectDeclared('screenshots:webkit', [], ['webkit']);
    expectDeclared('screenshots:minesweeper:webkit-narrow', [], ['webkit']);
    expectDeclared('screenshots:snake:webkit', [], ['webkit']);
    expectDeclared('screenshots', [], ['desktop', 'mobile']);
    // The shared hub capture moved to the generic script, so the After run no
    // longer creates a 390x844 `mobile` context.
    expectDeclared('screenshots:minesweeper', [], ['desktop', 'mobile-touch']);
    expectDeclared('screenshots:minesweeper:scores', [], ['desktop', 'mobile']);
    // The Before variants capture the same desktop + phone pair.
    expectDeclared('screenshots:2048:before', [], ['desktop', 'mobile']);
    expectDeclared('screenshots:breakout:before', [], ['desktop', 'mobile']);
    expectDeclared('screenshots:minesweeper:scores-before', [], [
      'desktop',
      'mobile',
    ]);
    expectDeclared('screenshots:minesweeper:scores-clear', [], [
      'desktop',
      'mobile',
    ]);
    // These modes only create Chromium phone contexts, so a run captured them
    // at DPR 2 and never wrote a desktop image.
    expectDeclared('screenshots:minesweeper:narrow', [], ['mobile']);
    expectDeclared('screenshots:minesweeper:min-before', [], ['mobile']);
    expectDeclared('screenshots:minesweeper:short', [], ['mobile']);
    expectDeclared('screenshots:minesweeper:large', [], ['mobile']);
    // The touch-before mode creates the Pixel 7 context at its fractional DPR
    // and no desktop / DPR-2 phone context.
    expectDeclared('screenshots:minesweeper:touch-before', [], ['mobile-touch']);
  });

  it('folds the passthrough flags into the declaration the script prints', () => {
    expectDeclared('screenshots', ['--webkit'], ['webkit']);
    expectDeclared('screenshots:minesweeper', ['--webkit'], ['webkit']);
    expectDeclared('screenshots:2048', ['--webkit'], ['webkit']);
    expectDeclared('screenshots', ['--webkit-narrow'], ['webkit']);
    expectDeclared('screenshots', ['--webkit-narrow-before'], ['webkit']);
    // WebKit wins over the Chromium-only phone modes.
    expectDeclared('screenshots:minesweeper', ['--touch-before', '--webkit'], [
      'webkit',
    ]);

    const minesweeperPhoneFlags = [
      '--narrow',
      '--narrow-before',
      '--min',
      '--min-before',
      '--restart',
      '--restart-before',
      '--short',
      '--short-before',
      '--large',
      '--large-before',
    ];
    for (const flag of minesweeperPhoneFlags) {
      expectDeclared('screenshots:minesweeper', [flag], ['mobile']);
    }
    expectDeclared('screenshots:minesweeper', ['--touch-before'], [
      'mobile-touch',
    ]);
    // The script's MODE resolution prefers the narrow-family modes, so a
    // combined invocation still records the DPR-2 mobile target.
    expectDeclared(
      'screenshots:minesweeper',
      ['--narrow', '--touch-before'],
      ['mobile'],
    );
    // The touch-before script's built-in flag does not override a
    // narrow-family flag passed through by the container entry.
    expectDeclared(
      'screenshots:minesweeper:touch-before',
      ['--narrow'],
      ['mobile'],
    );

    // The script's own npm arguments are part of the declaration.
    expectDeclared('screenshots:minesweeper:webkit-before', [], ['webkit']);
    expectDeclared(
      'screenshots:minesweeper:webkit-before',
      ['--touch-before'],
      ['webkit'],
    );

    // Other scripts ignore those flags, so their declared targets stay unchanged.
    expectDeclared('screenshots:2048', ['--touch-before'], [
      'desktop',
      'mobile',
    ]);
    expectDeclared('screenshots', ['--narrow'], ['desktop', 'mobile']);
    expectDeclared('screenshots:minesweeper:scores', ['--touch-before'], [
      'desktop',
      'mobile',
    ]);

    // These flags never change the target set.
    expectDeclared(
      'screenshots:2048',
      ['--before', '--allow-historical-overwrite'],
      ['desktop', 'mobile'],
    );
    expectDeclared('screenshots:minesweeper:scores', ['--clear'], [
      'desktop',
      'mobile',
    ]);
  });

  it('parses the node invocation out of npm screenshot commands', () => {
    expect(parseCaptureScriptCommand('node scripts/capture-screenshots.mjs')).toEqual({
      script: 'scripts/capture-screenshots.mjs',
      args: [],
    });
    expect(
      parseCaptureScriptCommand(
        'npm run build && node scripts/capture-2048-screenshots.mjs --before',
      ),
    ).toEqual({
      script: 'scripts/capture-2048-screenshots.mjs',
      args: ['--before'],
    });
    expect(
      parseCaptureScriptCommand(
        'node scripts/capture-minesweeper-screenshots.mjs --webkit --touch-before',
      ),
    ).toEqual({
      script: 'scripts/capture-minesweeper-screenshots.mjs',
      args: ['--webkit', '--touch-before'],
    });
    expect(() => parseCaptureScriptCommand('echo nope', 'screenshots:bad')).toThrow(
      /does not invoke a node capture script/,
    );
  });

  it('runs the npm script args plus passthrough, then --print-capture-targets', () => {
    const calls: string[][] = [];
    const declarationSpawnSync = ((
      command: string,
      args: readonly string[],
    ) => {
      calls.push([command, ...args]);
      return spawnSyncResult({
        stdout: JSON.stringify({
          script: args[0],
          targets: ['webkit'],
        }),
      });
    }) as unknown as typeof spawnSync;

    expect(
      resolveCaptureTargets('screenshots:2048:before', ['--webkit'], {
        scripts: SCRIPTS,
        spawnSync: declarationSpawnSync,
        repoRoot: '/repo',
      }),
    ).toEqual({ script: 'scripts/capture-2048-screenshots.mjs', targets: ['webkit'] });
    expect(calls).toEqual([
      [
        process.execPath,
        'scripts/capture-2048-screenshots.mjs',
        '--before',
        '--webkit',
        '--print-capture-targets',
      ],
    ]);
  });

  it('fails readably when the target command has no node script', () => {
    expect(() =>
      resolveCaptureTargets('screenshots:bad', [], {
        scripts: { 'screenshots:bad': 'echo nope' },
        repoRoot: '/repo',
      }),
    ).toThrow(/Cannot resolve capture targets for "screenshots:bad".*node capture script/);
  });

  it('fails readably when the declaration process cannot start', () => {
    expect(() =>
      resolveCaptureTargets('screenshots:webkit', [], {
        scripts: SCRIPTS,
        spawnSync: fakeSpawnSync({
          error: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }),
          status: null,
        }),
        repoRoot: '/repo',
      }),
    ).toThrow(/Cannot resolve capture targets for "screenshots:webkit".*ENOENT/);
  });

  it('fails readably when the declaration exits non-zero', () => {
    expect(() =>
      resolveCaptureTargets('screenshots:webkit', [], {
        scripts: SCRIPTS,
        spawnSync: fakeSpawnSync({ status: 2, stderr: 'boom' }),
        repoRoot: '/repo',
      }),
    ).toThrow(/exited with code 2: boom/);
  });

  it('fails readably when the declaration is not one JSON object', () => {
    expect(() =>
      resolveCaptureTargets('screenshots:webkit', [], {
        scripts: SCRIPTS,
        spawnSync: fakeSpawnSync({ status: 0, stdout: 'not json' }),
        repoRoot: '/repo',
      }),
    ).toThrow(/did not print one JSON capture-target declaration \(not json\)/);
  });

  it('fails readably when the declaration is empty or names another script', () => {
    const script = 'scripts/capture-screenshots.mjs';
    expect(() =>
      resolveCaptureTargets('screenshots:webkit', [], {
        scripts: SCRIPTS,
        spawnSync: fakeSpawnSync({
          status: 0,
          stdout: JSON.stringify({ script, targets: [] }),
        }),
        repoRoot: '/repo',
      }),
    ).toThrow(/declared no capture targets/);
    expect(() =>
      resolveCaptureTargets('screenshots:webkit', [], {
        scripts: SCRIPTS,
        spawnSync: fakeSpawnSync({
          status: 0,
          stdout: JSON.stringify({ script: 'scripts/other.mjs', targets: ['webkit'] }),
        }),
        repoRoot: '/repo',
      }),
    ).toThrow(/declaration names script "scripts\/other.mjs"/);
  });

  it('fails readably when the declaration names an unknown target', () => {
    expect(() =>
      resolveCaptureTargets('screenshots:webkit', [], {
        scripts: SCRIPTS,
        spawnSync: fakeSpawnSync({
          status: 0,
          stdout: JSON.stringify({
            script: 'scripts/capture-screenshots.mjs',
            targets: ['tablet'],
          }),
        }),
        repoRoot: '/repo',
      }),
    ).toThrow(/Unknown capture target "tablet"/);
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
      spawnSync: declarationAwareSpawnSync(),
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
      spawnSync: declarationAwareSpawnSync(),
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
      spawnSync: declarationAwareSpawnSync(),
      containerImage: localCaptureImageName(),
      previewPort: 4186,
      env: {},
    });
    const envArgs = envArgsOf(args);
    expect(envArgs).toContain('CAPTURE_TARGET=mobile');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=2');
  });

  it('declares desktop and mobile-touch DPRs for the minesweeper after run', () => {
    const args = buildDockerRunArgs({
      target: 'screenshots:minesweeper',
      repoRoot: '/repo',
      image,
      spawnSync: declarationAwareSpawnSync(),
      containerImage: localCaptureImageName(),
      previewPort: 4186,
      env: {},
    });
    const envArgs = envArgsOf(args);
    expect(envArgs).toContain('CAPTURE_TARGET=desktop,mobile-touch');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=1,2.625');
  });

  it('declares only the Pixel 7 mobile-touch DPR for the touch-before mode', () => {
    const args = buildDockerRunArgs({
      target: 'screenshots:minesweeper',
      passthrough: ['--touch-before'],
      repoRoot: '/repo',
      image,
      spawnSync: declarationAwareSpawnSync(),
      containerImage: localCaptureImageName(),
      previewPort: 4186,
      env: {},
    });
    const envArgs = envArgsOf(args);
    expect(envArgs).toContain('CAPTURE_TARGET=mobile-touch');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=2.625');
  });

  it.each<[string, string[], string, string]>([
    ['screenshots', ['--webkit'], 'webkit', '2'],
    ['screenshots:minesweeper', ['--webkit'], 'webkit', '2'],
    ['screenshots:minesweeper', [], 'desktop,mobile-touch', '1,2.625'],
    ['screenshots:minesweeper', ['--touch-before'], 'mobile-touch', '2.625'],
    ['screenshots:minesweeper:touch-before', [], 'mobile-touch', '2.625'],
    ['screenshots:minesweeper:touch-before', ['--narrow'], 'mobile', '2'],
    ['screenshots:minesweeper', ['--narrow'], 'mobile', '2'],
    ['screenshots:2048', ['--touch-before'], 'desktop,mobile', '1,2'],
  ])(
    'injects the passthrough-aware target contract for %s %j',
    (target, passthrough, expectedTargets, expectedDprs) => {
      const args = buildDockerRunArgs({
        target,
        passthrough,
        repoRoot: '/repo',
        image,
        spawnSync: declarationAwareSpawnSync(),
        containerImage: localCaptureImageName(),
        previewPort: null,
        env: {},
      });
      const envArgs = envArgsOf(args);
      expect(envArgs).toContain(`CAPTURE_TARGET=${expectedTargets}`);
      expect(envArgs).toContain(`CAPTURE_TARGET_DPR=${expectedDprs}`);
      expect(args.slice(-(passthrough.length + 2))).toEqual([
        localCaptureImageName(),
        target,
        ...passthrough,
      ]);

      // The injected variables must satisfy the container-side assertion that
      // re-derives the targets from the same target + passthrough pair.
      const env = Object.fromEntries(
        envArgs.map((entry) => {
          const separator = entry.indexOf('=');
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      );
      expect(() =>
        assertContainerCaptureEnvironment({
          env,
          targets: expectedTargets.split(','),
          version: image.version,
        }),
      ).not.toThrow();
    },
  );
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
});

describe('capture image build input', () => {
  const DOCKERFILE_PATH = '/repo/docker/capture/Dockerfile';

  function readDockerfile(dockerfile = PINNED_DOCKERFILE) {
    return (path: string): string => {
      if (path === DOCKERFILE_PATH) {
        return dockerfile;
      }
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    };
  }

  function recordingSpawnSync(results: FakeSpawnSyncResult[] = []) {
    const calls: string[][] = [];
    const spawnSyncFake = ((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return spawnSyncResult(results[calls.length - 1]);
    }) as unknown as typeof spawnSync;
    return { calls, spawnSync: spawnSyncFake };
  }

  function fingerprintOf(
    dockerfile = PINNED_DOCKERFILE,
    tag = PLAYWRIGHT_IMAGE_PIN.tag,
    digest = PLAYWRIGHT_IMAGE_PIN.digest,
  ): string {
    return captureImageBuildInputFingerprint({ tag, digest, dockerfile });
  }

  function inspectCall(localImage = localCaptureImageName()): string[] {
    return [
      'docker',
      'image',
      'inspect',
      '--format',
      `{{ index .Config.Labels "${CAPTURE_IMAGE_BUILD_LABEL}" }}`,
      localImage,
    ];
  }

  function buildCall(
    fingerprint: string,
    localImage = localCaptureImageName(),
  ): string[] {
    return [
      'docker',
      'build',
      '--label',
      `${CAPTURE_IMAGE_BUILD_LABEL}=${fingerprint}`,
      '--file',
      DOCKERFILE_PATH,
      '--tag',
      localImage,
      '/repo/docker/capture',
    ];
  }

  it('fingerprints the pin and the whole Dockerfile, stable for equal inputs', () => {
    const base = fingerprintOf();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf()).toBe(base);

    // Every build input is part of the fingerprint on its own.
    expect(fingerprintOf(`${PINNED_DOCKERFILE}LABEL changed=1\n`)).not.toBe(base);
    expect(
      captureImageBuildInputFingerprint({
        tag: 'v1.65.0-noble',
        digest: PLAYWRIGHT_IMAGE_PIN.digest,
        dockerfile: PINNED_DOCKERFILE,
      }),
    ).not.toBe(base);
    expect(
      captureImageBuildInputFingerprint({
        tag: PLAYWRIGHT_IMAGE_PIN.tag,
        digest: `sha256:${'0'.repeat(64)}`,
        dockerfile: PINNED_DOCKERFILE,
      }),
    ).not.toBe(base);
  });

  it('builds with the fingerprint label when the image is missing', () => {
    const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync([
      { status: 1, stderr: 'No such image' },
      { status: 0 },
    ]);

    expect(
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile(),
        repoRoot: '/repo',
      }),
    ).toBe(localCaptureImageName());
    expect(calls).toEqual([
      inspectCall(),
      buildCall(fingerprintOf()),
    ]);
  });

  it('reuses the image only when its build label matches the fingerprint', () => {
    const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync([
      { status: 0, stdout: `${fingerprintOf()}\n` },
    ]);

    expect(
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile(),
        repoRoot: '/repo',
      }),
    ).toBe(localCaptureImageName());
    expect(calls).toEqual([inspectCall()]);
  });

  it('validates the runtime (last) FROM of a multi-stage Dockerfile', () => {
    const multiStageDockerfile = `FROM busybox:1 AS build\n${PINNED_FROM}\n`;
    const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync([
      { status: 0, stdout: `${fingerprintOf(multiStageDockerfile)}\n` },
    ]);

    expect(
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile(multiStageDockerfile),
        repoRoot: '/repo',
      }),
    ).toBe(localCaptureImageName());
    expect(calls).toEqual([inspectCall()]);
  });

  it('rebuilds when the pinned tag/digest changes', () => {
    const changedTag = 'v1.65.0-noble';
    const changedDigest = `sha256:${'a'.repeat(64)}`;
    const changedDockerfile = `FROM ${PLAYWRIGHT_IMAGE_REPOSITORY}:${changedTag}@${changedDigest}\n`;
    const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync([
      { status: 0, stdout: `${fingerprintOf()}\n` },
      { status: 0 },
    ]);

    expect(
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile(changedDockerfile),
        repoRoot: '/repo',
        tag: changedTag,
        digest: changedDigest,
      }),
    ).toBe(localCaptureImageName(changedTag));
    const changedImage = localCaptureImageName(changedTag);
    expect(calls).toEqual([
      inspectCall(changedImage),
      buildCall(
        fingerprintOf(changedDockerfile, changedTag, changedDigest),
        changedImage,
      ),
    ]);
  });

  it('rebuilds when only the Dockerfile contents change', () => {
    const changedDockerfile = `${PINNED_DOCKERFILE}LABEL rebuild-check=1\n`;
    const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync([
      { status: 0, stdout: `${fingerprintOf()}\n` },
      { status: 0 },
    ]);

    expect(
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile(changedDockerfile),
        repoRoot: '/repo',
      }),
    ).toBe(localCaptureImageName());
    expect(calls).toEqual([inspectCall(), buildCall(fingerprintOf(changedDockerfile))]);
  });

  it.each(['', '<no value>\n'])(
    'rebuilds an image built before the label existed (%j)',
    (stdout) => {
      const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync([
        { status: 0, stdout },
        { status: 0 },
      ]);

      expect(
        ensureCaptureImage({
          spawnSync: spawnSyncFake,
          readFile: readDockerfile(),
          repoRoot: '/repo',
        }),
      ).toBe(localCaptureImageName());
      expect(calls).toEqual([inspectCall(), buildCall(fingerprintOf())]);
    },
  );

  it('fails with the expected and actual FROM when the Dockerfile drifts from the pin', () => {
    const driftedDigest = `sha256:${'b'.repeat(64)}`;
    const driftedDockerfile = PINNED_DOCKERFILE.replace(
      PLAYWRIGHT_IMAGE_PIN.digest,
      driftedDigest,
    );
    const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync();

    expect(() =>
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile(driftedDockerfile),
        repoRoot: '/repo',
      }),
    ).toThrow(
      `Capture image base mismatch in ${DOCKERFILE_PATH}: ` +
        `expected FROM ${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}, ` +
        `found FROM ${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${driftedDigest}.`,
    );
    // The mismatch fails before Docker is touched, so no stale image can run.
    expect(calls).toEqual([]);
  });

  it('fails with a readable error when the Dockerfile has no FROM', () => {
    const { spawnSync: spawnSyncFake } = recordingSpawnSync();

    expect(() =>
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile('# no FROM here\n'),
        repoRoot: '/repo',
      }),
    ).toThrow(`${DOCKERFILE_PATH} has no FROM instruction`);
  });

  it('reports an unreadable Dockerfile with the image context', () => {
    const { calls, spawnSync: spawnSyncFake } = recordingSpawnSync();
    const detail = 'ENOENT: no such file or directory, open /repo/docker/capture/Dockerfile';

    expect(() =>
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: () => {
          throw new Error(detail);
        },
        repoRoot: '/repo',
      }),
    ).toThrow(`Cannot read ${DOCKERFILE_PATH} for ${localCaptureImageName()}: ${detail}`);
    // Reading fails before Docker is touched, so no inspect/build runs; the
    // error is wrapped with path + image instead of being rethrown raw.
    expect(calls).toEqual([]);
  });

  it('keeps the readable error when docker build fails', () => {
    const { spawnSync: spawnSyncFake } = recordingSpawnSync([
      { status: 1, stderr: 'No such image' },
      { status: 1, stderr: 'base image pull failed' },
    ]);

    expect(() =>
      ensureCaptureImage({
        spawnSync: spawnSyncFake,
        readFile: readDockerfile(),
        repoRoot: '/repo',
      }),
    ).toThrow(
      `Docker build for ${localCaptureImageName()} failed (exit 1): base image pull failed`,
    );
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

  it('validates the targets derived from the passthrough flags', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const code = await runContainerCapture({
      argv: ['screenshots', '--webkit'],
      env: CONTAINER_ENV,
      spawn: fakeSpawn((command, args) => calls.push({ command, args: [...args] })),
      ensureDependencies: async () => false,
      logger: { log: () => {} },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { command: 'npm', args: ['run', 'screenshots', '--', '--webkit'] },
    ]);
  });

  it('rejects a CAPTURE_TARGET list that ignores the passthrough flags', async () => {
    const calls: string[] = [];
    await expect(
      runContainerCapture({
        argv: ['screenshots', '--webkit'],
        env: {
          ...CONTAINER_ENV,
          CAPTURE_TARGET: 'desktop,mobile',
          CAPTURE_TARGET_DPR: '1,2',
        },
        spawn: fakeSpawn((command) => calls.push(command)),
        ensureDependencies: async () => false,
        logger: { log: () => {} },
      }),
    ).rejects.toThrow(
      /Capture target "webkit" does not match CAPTURE_TARGET="desktop,mobile"/,
    );
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
    target = 'screenshots:webkit',
    passthrough = [],
    checkPort = vi.fn(async () => {}),
  }: {
    exitCode?: number;
    env?: Env;
    target?: string;
    passthrough?: string[];
    checkPort?: (port: number, host?: string) => Promise<void>;
  } = {}) {
    const argv = [target, ...passthrough];
    const logDir = mkdtempSync(join(tmpdir(), 'capture-container-'));
    tempDirs.push(logDir);
    const now = '2026-11-12T00-00-00-000Z';
    const safeTarget = target.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const logPath = join(logDir, `${safeTarget}-${now}.log`);
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
      spawnSync: declarationAwareSpawnSync(),
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

  it('injects the passthrough-derived capture targets on the host path', async () => {
    const harness = hostHarness({
      target: 'screenshots:2048:before',
      passthrough: ['--webkit'],
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runContainerCapture(harness.options)).resolves.toBe(0);

    expect(harness.calls).toHaveLength(1);
    const envArgs = envArgsOf(harness.calls[0]?.args ?? []);
    expect(envArgs).toContain('CAPTURE_TARGET=webkit');
    expect(envArgs).toContain('CAPTURE_TARGET_DPR=2');
    expect(harness.calls[0]?.args.slice(-2)).toEqual([
      'screenshots:2048:before',
      '--webkit',
    ]);
    await vi.waitFor(
      () => {
        expect(readFileSync(harness.logPath, 'utf8')).toContain('container stdout\n');
      },
      { timeout: 5000 },
    );
  });

  it('skips the host port probe when BASE_URL points at an external preview', async () => {
    const checkPort = vi.fn(async () => {
      throw new Error('port 4174 is already in use');
    });
    const harness = hostHarness({
      env: { BASE_URL: 'http://127.0.0.1:5189' },
      checkPort,
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runContainerCapture(harness.options)).resolves.toBe(0);

    expect(checkPort).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(1);
    const envArgs = envArgsOf(harness.calls[0]?.args ?? []);
    expect(envArgs).toContain('BASE_URL=http://127.0.0.1:5189');
    expect(envArgs).toContain('PREVIEW_PORT=4174');
    expect(harness.calls[0]?.args.slice(-1)).toEqual(['screenshots:webkit']);
    await vi.waitFor(
      () => {
        expect(readFileSync(harness.logPath, 'utf8')).toContain('container stdout\n');
      },
      { timeout: 5000 },
    );
  });

  it.each(['screenshots:2048:before', 'screenshots:breakout:before'])(
    'accepts %s when its default host port is busy and BASE_URL is set',
    async (target) => {
      const checkPort = vi.fn(async () => {
        throw new Error(`port for ${target} is already in use`);
      });
      const harness = hostHarness({
        target,
        env: { BASE_URL: 'http://127.0.0.1:5189' },
        checkPort,
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await expect(runContainerCapture(harness.options)).resolves.toBe(0);

      expect(checkPort).not.toHaveBeenCalled();
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]?.args.slice(-1)).toEqual([target]);
      expect(envArgsOf(harness.calls[0]?.args ?? [])).toContain(
        'BASE_URL=http://127.0.0.1:5189',
      );
      await vi.waitFor(
        () => {
          expect(readFileSync(harness.logPath, 'utf8')).toContain('container stdout\n');
        },
        { timeout: 5000 },
      );
    },
  );

  it('still probes the default host port when BASE_URL is an empty string', async () => {
    const harness = hostHarness({ env: { BASE_URL: '' } });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runContainerCapture(harness.options)).resolves.toBe(0);

    expect(harness.checkPort).toHaveBeenCalledWith(4174);
    const envArgs = envArgsOf(harness.calls[0]?.args ?? []);
    expect(envArgs).toContain('PREVIEW_PORT=4174');
    expect(envArgs.some((value) => value.startsWith('BASE_URL='))).toBe(false);
    await vi.waitFor(
      () => {
        expect(readFileSync(harness.logPath, 'utf8')).toContain('container stdout\n');
      },
      { timeout: 5000 },
    );
  });

  it.each<[string, Env]>([
    ['unset', {}],
    ['an empty string', { BASE_URL: '' }],
  ])(
    'wraps a preview-port failure with the capture target name when BASE_URL is %s',
    async (_label, env) => {
      const checkPort = vi.fn(async () => {
        throw new Error('port 4174 is already in use');
      });
      const harness = hostHarness({ checkPort, env });

      await expect(runContainerCapture(harness.options)).rejects.toThrow(
        'Cannot run container capture "screenshots:webkit": port 4174 is already in use',
      );
      expect(checkPort).toHaveBeenCalledWith(4174);
      expect(harness.spawn).not.toHaveBeenCalled();
      expect(harness.logger.log).not.toHaveBeenCalled();
    },
  );

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
