#!/usr/bin/env node
import { spawn, spawnSync as defaultSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync as defaultExistsSync,
  mkdirSync,
  readFileSync as defaultReadFile,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CAPTURE_CONTAINER_FLAG,
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  CAPTURE_IMAGE_DIGEST_VAR,
  CAPTURE_IMAGE_TAG_VAR,
  CAPTURE_REPO_ROOT,
  CAPTURE_TARGET_DPR_VAR,
  CAPTURE_TARGET_VAR,
  PLAYWRIGHT_IMAGE_PIN,
  assertContainerCaptureEnvironment,
  dprForCaptureTarget,
  resolveCaptureImage,
} from './lib/capture-env.mjs';
import { assertPortAvailable, parsePreviewPort } from './lib/preview-port.mjs';

/**
 * Containerised screenshot capture entry (Issue #199).
 *
 * Host side:
 *   npm run screenshots:container -- <target> [passthrough...]
 *
 * It preflights Docker, the pinned image tag against package-lock.json, the
 * target whitelist and the target's preview port, builds the local capture
 * image from docker/capture/Dockerfile when needed, then runs the existing
 * `npm run <target>` command inside the fixed Playwright container. The
 * repository is mounted at /work, so the PNGs and the build output are written
 * back to the host; the combined output is also saved under
 * test-results/capture-container/.
 *
 * Container side (the same script, CAPTURE_CONTAINER=1):
 *   It re-validates the image tag, EGL variables and target DPR, installs
 *   dependencies on demand (`npm ci`) and runs the capture command. The shared
 *   capture runtime logs the environment fingerprint once the browser launches.
 *   Font versions are recorded only; nothing pins an unknown font version or
 *   installs extra fonts.
 */

export const CONTAINER_WORKDIR = '/work';
export const CONTAINER_CAPTURE_IMAGE = 'playground-capture';
export const CONTAINER_LOG_DIR = 'test-results/capture-container';
export const CAPTURE_LOCK_HASH_FILE = 'node_modules/.capture-package-lock-hash';

/** npm scripts that can be run through the container entry. */
const EXCLUDED_TARGETS = new Set(['screenshots:container', 'screenshots:baseline']);

/** Preview ports the target capture scripts start by default. */
const PREVIEW_PORT_FALLBACKS = Object.freeze([
  [/^screenshots:minesweeper:scores/, 4192],
  [/^screenshots:minesweeper/, 4186],
  [/^screenshots:snake/, 5188],
  [/^screenshots:2048/, 4183],
  [/^screenshots:breakout/, 4185],
  [/^screenshots$|^screenshots:webkit$/, 4174],
]);

export function readPackageScripts({
  packagePath = resolve(CAPTURE_REPO_ROOT, 'package.json'),
  readFile = defaultReadFile,
} = {}) {
  const parsed = JSON.parse(readFile(packagePath, 'utf8'));
  return parsed?.scripts ?? {};
}

/** Sorted list of screenshot targets the container entry accepts. */
export function captureTargets(scripts) {
  return Object.keys(scripts)
    .filter(
      (name) =>
        (name === 'screenshots' || name.startsWith('screenshots:')) &&
        !EXCLUDED_TARGETS.has(name),
    )
    .sort();
}

/**
 * The capture targets (DPR contract) a screenshot npm script records.
 *
 * WebKit scripts only capture the WebKit phone target. Chromium screenshot
 * scripts capture desktop and phone evidence in the same run, while the
 * dedicated minesweeper narrow / short / large modes and the Chromium
 * touch-before baseline only capture phone evidence.
 */
const MOBILE_ONLY_CAPTURE_TARGETS = [
  /^screenshots:minesweeper:(narrow|min|restart|short|large)(-before)?$/,
  /^screenshots:minesweeper:touch-before$/,
];

export function captureTargetsForScript(script) {
  if (script.includes('webkit')) {
    return ['webkit'];
  }
  if (MOBILE_ONLY_CAPTURE_TARGETS.some((pattern) => pattern.test(script))) {
    return ['mobile'];
  }
  return ['desktop', 'mobile'];
}

/** The preview port a target starts, or null when it does not start one. */
export function previewPortForTarget(target, value = process.env.PREVIEW_PORT) {
  const match = PREVIEW_PORT_FALLBACKS.find(([pattern]) => pattern.test(target));
  if (match === undefined) {
    return null;
  }
  return parsePreviewPort(value, match[1]);
}

/** Parse `<target> [passthrough...]` from the npm wrapper. */
export function parseContainerCaptureArgs(
  argv = process.argv.slice(2),
  { scripts = readPackageScripts() } = {},
) {
  const allowed = captureTargets(scripts);
  const [target, ...passthrough] = argv;
  if (target === undefined || target === '') {
    throw new Error(
      'Usage: npm run screenshots:container -- <target> [passthrough...]. ' +
        `Available targets: ${allowed.join(', ')}.`,
    );
  }
  if (!allowed.includes(target)) {
    throw new Error(
      `Unknown container capture target "${target}". ` +
        `Available targets: ${allowed.join(', ')}.`,
    );
  }
  return { target, passthrough };
}

/** Fail with a readable error when the Docker CLI or daemon is missing. */
export function preflightDocker({ spawnSync = defaultSpawnSync } = {}) {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  });
  if (result?.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        'Docker CLI was not found: install Docker to use npm run screenshots:container.',
      );
    }
    throw new Error(`Docker is not available: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim() || 'no detail';
    throw new Error(
      `Docker daemon is not reachable (docker info exited with ${result.status}): ${detail}`,
    );
  }
}

/** Local image name that wraps the pinned Playwright base image. */
export function localCaptureImageName(tag = PLAYWRIGHT_IMAGE_PIN.tag) {
  return `${CONTAINER_CAPTURE_IMAGE}:${tag}`;
}

/** Build the local capture image when it is not present yet. */
export function ensureCaptureImage({
  spawnSync = defaultSpawnSync,
  repoRoot = CAPTURE_REPO_ROOT,
  tag = PLAYWRIGHT_IMAGE_PIN.tag,
} = {}) {
  const localImage = localCaptureImageName(tag);
  const inspect = spawnSync('docker', ['image', 'inspect', localImage], {
    encoding: 'utf8',
  });
  if (!inspect?.error && inspect.status === 0) {
    return localImage;
  }

  // The Dockerfile has no COPY, so the small docker/capture directory is
  // enough of a build context: node_modules and screenshots never get sent.
  const built = spawnSync(
    'docker',
    [
      'build',
      '--file',
      resolve(repoRoot, 'docker/capture/Dockerfile'),
      '--tag',
      localImage,
      resolve(repoRoot, 'docker/capture'),
    ],
    { encoding: 'utf8' },
  );
  if (built?.error) {
    throw new Error(`Cannot build ${localImage}: ${built.error.message}`);
  }
  if (built.status !== 0) {
    const detail = String(built.stderr ?? '').trim() || 'no detail';
    throw new Error(
      `Docker build for ${localImage} failed (exit ${built.status}): ${detail}`,
    );
  }
  return localImage;
}

/** Host-side `docker run` arguments for one capture target. */
export function buildDockerRunArgs({
  target,
  passthrough = [],
  repoRoot = CAPTURE_REPO_ROOT,
  image,
  containerImage = image?.reference,
  imageTag = image?.tag ?? PLAYWRIGHT_IMAGE_PIN.tag,
  imageDigest = image?.digest ?? PLAYWRIGHT_IMAGE_PIN.digest,
  uid = typeof process.getuid === 'function' ? process.getuid() : 1000,
  gid = typeof process.getgid === 'function' ? process.getgid() : 1000,
  previewPort = null,
  env = process.env,
} = {}) {
  if (image === undefined || containerImage === undefined) {
    throw new Error('buildDockerRunArgs needs the resolved capture image.');
  }
  const captureTargets = captureTargetsForScript(target);
  const args = [
    'run',
    '--rm',
    '--init',
    '--ipc',
    'host',
    '--network',
    'host',
    '--user',
    `${uid}:${gid}`,
    '--workdir',
    CONTAINER_WORKDIR,
    '--volume',
    `${repoRoot}:${CONTAINER_WORKDIR}`,
    '--env',
    'HOME=/tmp',
    '--env',
    `${CAPTURE_CONTAINER_FLAG}=1`,
    '--env',
    `${CAPTURE_IMAGE_TAG_VAR}=${imageTag}`,
    '--env',
    `${CAPTURE_IMAGE_DIGEST_VAR}=${imageDigest}`,
    '--env',
    `${CAPTURE_TARGET_VAR}=${captureTargets.join(',')}`,
    '--env',
    `${CAPTURE_TARGET_DPR_VAR}=${captureTargets.map((captureTarget) => dprForCaptureTarget(captureTarget)).join(',')}`,
  ];

  for (const name of CAPTURE_EGL_VARS) {
    args.push('--env', `${name}=${CAPTURE_EGL_ENV[name]}`);
  }
  if (previewPort !== null) {
    args.push('--env', `PREVIEW_PORT=${previewPort}`);
  }
  if (env.BASE_URL !== undefined && env.BASE_URL !== '') {
    args.push('--env', `BASE_URL=${env.BASE_URL}`);
  }

  args.push(containerImage, target, ...passthrough);
  return args;
}

function waitForChild(child, command) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

function runCommand({ spawn: spawnImpl = spawn, command, args, env, stdio = 'inherit' }) {
  return waitForChild(spawnImpl(command, args, { stdio, env }), command);
}

function lockfileHash({
  repoRoot = CAPTURE_REPO_ROOT,
  readFile = defaultReadFile,
} = {}) {
  return createHash('sha256')
    .update(readFile(resolve(repoRoot, 'package-lock.json')))
    .digest('hex');
}

/**
 * Install dependencies inside the container only when node_modules is missing
 * or was built from a different package-lock.json.
 */
export async function ensureContainerDependencies({
  repoRoot = CAPTURE_REPO_ROOT,
  env = process.env,
  spawn: spawnImpl = spawn,
  readFile = defaultReadFile,
  existsSync = defaultExistsSync,
  writeFile = writeFileSync,
} = {}) {
  const hash = lockfileHash({ repoRoot, readFile });
  const marker = resolve(repoRoot, CAPTURE_LOCK_HASH_FILE);
  let current = null;
  try {
    current = readFile(marker, 'utf8').trim();
  } catch {
    current = null;
  }
  if (current === hash && existsSync(resolve(repoRoot, 'node_modules'))) {
    return false;
  }

  const { code } = await runCommand({
    spawn: spawnImpl,
    command: 'npm',
    args: ['ci', '--no-audit', '--no-fund'],
    env,
  });
  if (code !== 0) {
    throw new Error(`npm ci inside the capture container failed (exit ${code}).`);
  }

  writeFile(marker, `${hash}\n`);
  return true;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Run one screenshot target through the fixed capture container, or (inside
 * that container) run it directly after validating the injected environment.
 */
export async function runContainerCapture({
  argv = process.argv.slice(2),
  env = process.env,
  spawn: spawnImpl = spawn,
  spawnSync = defaultSpawnSync,
  readFile = defaultReadFile,
  existsSync = defaultExistsSync,
  repoRoot = CAPTURE_REPO_ROOT,
  packagePath = resolve(repoRoot, 'package.json'),
  lockfilePath = resolve(repoRoot, 'package-lock.json'),
  logDir = resolve(repoRoot, CONTAINER_LOG_DIR),
  ensureDependencies = ensureContainerDependencies,
  checkPort = assertPortAvailable,
  logger = console,
  now = timestamp,
  uid = typeof process.getuid === 'function' ? process.getuid() : 1000,
  gid = typeof process.getgid === 'function' ? process.getgid() : 1000,
} = {}) {
  const scripts = readPackageScripts({ packagePath, readFile });
  const { target, passthrough } = parseContainerCaptureArgs(argv, { scripts });
  const image = resolveCaptureImage({ readFile, lockfilePath });

  if (env[CAPTURE_CONTAINER_FLAG] === '1') {
    assertContainerCaptureEnvironment({
      env,
      targets: captureTargetsForScript(target),
      version: image.version,
    });
    await ensureDependencies({ repoRoot, env, readFile, existsSync });

    const { code, signal } = await runCommand({
      spawn: spawnImpl,
      command: 'npm',
      args: ['run', target, ...(passthrough.length > 0 ? ['--', ...passthrough] : [])],
      env,
    });
    if (code !== 0) {
      throw new Error(
        `Capture command "npm run ${target}" failed` +
          `${signal === null || signal === undefined ? ` (exit ${code})` : ` (signal ${signal})`}.`,
      );
    }
    return code;
  }

  preflightDocker({ spawnSync });
  const previewPort = previewPortForTarget(target, env.PREVIEW_PORT);
  // A non-empty BASE_URL points the capture at an external preview, so the
  // target never starts its own port (the `before` modes). Probing that port
  // would reject a shared host because of an unrelated listener.
  const usesExternalPreview = env.BASE_URL !== undefined && env.BASE_URL !== '';
  if (previewPort !== null && !usesExternalPreview) {
    try {
      await checkPort(previewPort);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot run container capture "${target}": ${detail}`);
    }
  }

  const localImage = ensureCaptureImage({ spawnSync, repoRoot, tag: image.tag });
  const args = buildDockerRunArgs({
    target,
    passthrough,
    repoRoot,
    image,
    containerImage: localImage,
    imageTag: image.tag,
    imageDigest: image.digest,
    previewPort,
    env,
    uid,
    gid,
  });

  mkdirSync(logDir, { recursive: true });
  const safeTarget = target.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const logPath = join(logDir, `${safeTarget}-${now()}.log`);
  const stream = createWriteStream(logPath);

  logger.log(`capture image: ${localImage} (${image.reference})`);
  logger.log(`capture log: ${logPath}`);
  logger.log(`docker ${args.join(' ')}`);

  let child;
  try {
    child = spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    stream.end();
    throw new Error(
      `Cannot start the capture container: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const forward = (chunk, sink) => {
    sink.write(chunk);
    stream.write(chunk);
  };
  child.stdout?.on('data', (chunk) => forward(chunk, process.stdout));
  child.stderr?.on('data', (chunk) => forward(chunk, process.stderr));

  try {
    const { code, signal } = await waitForChild(child, 'docker run');
    if (code !== 0) {
      throw new Error(
        `Container capture "${target}" failed` +
          `${signal === null || signal === undefined ? ` (exit ${code})` : ` (signal ${signal})`}. ` +
          `See ${logPath}.`,
      );
    }
    return code;
  } finally {
    stream.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runContainerCapture()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      console.error(
        `screenshots:container: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
