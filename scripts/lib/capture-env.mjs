import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fixed screenshot capture environment contract (Issue #199).
 *
 * The committed screenshots are only comparable byte-for-byte when the browser
 * build, system fonts, DPR and EGL / software-rendering stack are fixed. This
 * module is the single source of truth for that contract:
 *
 * - the Playwright container image tag and digest,
 * - the Mesa EGL environment variables WebKit needs on Linux,
 * - the device-pixel ratio per capture target,
 * - the font package list shipped by the official image (never extended here),
 * - the environment fingerprint written to the capture log.
 *
 * Strict validation lives in the container entry (`run-container-capture.mjs`).
 * Host runs only log a fingerprint and never fail because a font / EGL probe is
 * unavailable, so the existing `npm run screenshots:*` commands behave as before.
 */

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root, used to read `package-lock.json` from any capture script. */
export const CAPTURE_REPO_ROOT = resolve(LIB_DIR, '..', '..');

export const PLAYWRIGHT_IMAGE_REPOSITORY = 'mcr.microsoft.com/playwright';

/**
 * The image that defines the fixed capture environment.
 *
 * `version` must match the installed `@playwright/test` version in
 * `package-lock.json`: the tag is derived from that lockfile version, while the
 * digest pins the exact multi-arch image. Bumping Playwright requires a new
 * digest here (see docs/screenshots/README.md, fixed capture environment).
 */
export const PLAYWRIGHT_IMAGE_PIN = Object.freeze({
  version: '1.64.1',
  tag: 'v1.64.1-noble',
  digest: 'sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f',
});

/** Container marker set by the container entry before it runs a capture. */
export const CAPTURE_CONTAINER_FLAG = 'CAPTURE_CONTAINER';
export const CAPTURE_IMAGE_TAG_VAR = 'CAPTURE_IMAGE_TAG';
export const CAPTURE_IMAGE_DIGEST_VAR = 'CAPTURE_IMAGE_DIGEST';
/**
 * Comma-separated list of every capture target the run records. A Chromium run
 * can capture desktop, phone and Pixel 7 touch evidence, so a single target
 * would misdescribe it.
 */
export const CAPTURE_TARGET_VAR = 'CAPTURE_TARGET';
/** Comma-separated DPRs, in the same order as {@link CAPTURE_TARGET_VAR}. */
export const CAPTURE_TARGET_DPR_VAR = 'CAPTURE_TARGET_DPR';

/**
 * Mesa / GL environment WebKit needs to start on a headless Linux host without
 * a GPU. Without these the WebKit launch fails with
 * `Could not create surfaceless EGL display` (Issue #137).
 */
export const CAPTURE_EGL_ENV = Object.freeze({
  EGL_PLATFORM: 'surfaceless',
  LIBGL_ALWAYS_SOFTWARE: '1',
  __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json',
});

export const CAPTURE_EGL_VARS = Object.freeze(Object.keys(CAPTURE_EGL_ENV));

/**
 * Device-pixel ratio per capture target. Desktop evidence is DPR 1, the
 * custom 390x844 phone and WebKit device emulation are DPR 2, and the Pixel 7
 * touch evidence keeps the device descriptor's fractional DPR 2.625. Kept per
 * target instead of a global constant so a new target must state its own
 * ratio.
 */
export const CAPTURE_TARGET_DPRS = Object.freeze({
  desktop: 1,
  mobile: 2,
  'mobile-touch': 2.625,
  webkit: 2,
});

/**
 * Every capture target in declaration order: `desktop`, `mobile`,
 * `mobile-touch` and `webkit`. `mobile-touch` is the Pixel 7 touch context used
 * by the minesweeper touch evidence; it stays separate from `mobile` because
 * its DPR 2.625 would otherwise be folded into the DPR-2 phone fingerprint.
 */
export const CAPTURE_TARGETS = Object.freeze(Object.keys(CAPTURE_TARGET_DPRS));

/**
 * Font packages installed by the official Playwright image.
 *
 * The fixed contract keeps exactly these fonts and never installs additional
 * fonts: extra font packages would change WebKit / Chromium text rasterisation
 * and therefore the committed PNG bytes. Versions are recorded, not pinned:
 * the image digest already fixes them, and a mismatch is reported as an
 * environment difference instead of an unexplained pixel diff.
 */
export const CAPTURE_FONT_PACKAGES = Object.freeze([
  'fonts-freefont-ttf',
  'fonts-ipafont-gothic',
  'fonts-liberation',
  'fonts-noto-color-emoji',
  'fonts-tlwg-loma-otf',
  'fonts-unifont',
  'fonts-wqy-zenhei',
]);

/** The tag the pinned Playwright version must use. */
export function imageTagForPlaywrightVersion(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(
      'Cannot build the capture image tag: the @playwright/test version is missing.',
    );
  }
  return `v${version.trim()}-noble`;
}

/**
 * Read the installed `@playwright/test` version from `package-lock.json`.
 *
 * The lockfile is the contract the container's `npm ci` installs, so it is the
 * right source for both the image tag and the logged Playwright version.
 */
export function readPlaywrightVersion({
  lockfilePath = resolve(CAPTURE_REPO_ROOT, 'package-lock.json'),
  readFile = readFileSync,
} = {}) {
  let text;
  try {
    text = readFile(lockfilePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read package-lock.json for the capture image: ${detail}`);
  }

  let lockfile;
  try {
    lockfile = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`package-lock.json is not valid JSON: ${detail}`);
  }

  const version = lockfile?.packages?.['node_modules/@playwright/test']?.version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(
      'package-lock.json does not record node_modules/@playwright/test; ' +
        'run npm install before capturing screenshots.',
    );
  }
  return version;
}

/**
 * Fail with a readable message when an image tag does not match the installed
 * Playwright version. A tag built for another version can silently change the
 * browser build and therefore every PNG byte.
 */
export function assertImageTagMatchesPlaywrightVersion(imageTag, version) {
  const expected = imageTagForPlaywrightVersion(version);
  if (imageTag !== expected) {
    throw new Error(
      `Capture image tag "${imageTag}" does not match @playwright/test ${version}: ` +
        `expected "${expected}". Update PLAYWRIGHT_IMAGE_PIN after bumping Playwright.`,
    );
  }
}

/**
 * Resolve the pinned capture image and verify it matches the lockfile.
 *
 * The digest is only known for the pinned tag, so an override to another tag is
 * rejected instead of running an unpinned image.
 */
export function resolveCaptureImage({
  version,
  lockfilePath,
  readFile,
  imageTag = PLAYWRIGHT_IMAGE_PIN.tag,
  digest = PLAYWRIGHT_IMAGE_PIN.digest,
} = {}) {
  const playwrightVersion =
    version ?? readPlaywrightVersion({ lockfilePath, readFile });
  assertImageTagMatchesPlaywrightVersion(imageTag, playwrightVersion);

  if (imageTag !== PLAYWRIGHT_IMAGE_PIN.tag) {
    throw new Error(
      `Capture image tag "${imageTag}" has no pinned digest: the repository pins ` +
        `"${PLAYWRIGHT_IMAGE_PIN.tag}"@${PLAYWRIGHT_IMAGE_PIN.digest}.`,
    );
  }

  return {
    repository: PLAYWRIGHT_IMAGE_REPOSITORY,
    tag: imageTag,
    digest,
    version: playwrightVersion,
    reference: `${PLAYWRIGHT_IMAGE_REPOSITORY}:${imageTag}@${digest}`,
  };
}

/** Resolve the DPR declared for one capture target. */
export function dprForCaptureTarget(target) {
  const dpr = CAPTURE_TARGET_DPRS[target];
  if (dpr === undefined) {
    throw new Error(
      `Unknown capture target "${String(target)}": expected one of ${CAPTURE_TARGETS.join(', ')}.`,
    );
  }
  return dpr;
}

/**
 * Normalize a declared capture-target list.
 *
 * A capture run can record more than one target (a Chromium minesweeper run
 * captures desktop, phone and Pixel 7 touch evidence), so the container
 * contract stores the targets and their DPRs as comma-separated lists. Accepts
 * an array, a single target or the comma-separated string form; returns `null`
 * for an absent declaration and rejects any unknown target.
 */
export function normalizeCaptureTargets(targets) {
  if (targets === undefined || targets === null) {
    return null;
  }
  const list = Array.isArray(targets) ? targets : [targets];
  const normalized = list
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (normalized.length === 0) {
    return null;
  }
  for (const target of normalized) {
    dprForCaptureTarget(target);
  }
  return normalized;
}

/**
 * Parse the comma-separated DPR list injected by the container entry.
 *
 * DPRs are non-negative decimals, not only integers: the Pixel 7 touch target
 * keeps the device's 2.625 ratio. Anything else (`2.`, `.5`, `2.625.0`, a
 * non-numeric token) is rejected so a malformed list never reaches the
 * comparison below.
 */
function parseDprList(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    return null;
  }
  return parts.map(Number);
}

/**
 * Probe installed font package versions inside the fixed image.
 *
 * `dpkg-query` is only expected inside the container. A missing command, a
 * non-zero exit or a package that is not installed makes the probe return
 * `'unavailable'`; callers record that instead of failing the capture.
 * Only the fixed {@link CAPTURE_FONT_PACKAGES} list is reported, in that order.
 */
export function probeFontPackages({
  execFile = (file, args) => execFileSync(file, args, { encoding: 'utf8' }),
} = {}) {
  const format =
    '${db:Status-Status}\\t${Package}\\t${Version}\\n';
  let output;
  try {
    output = execFile('dpkg-query', ['-W', `-f=${format}`, ...CAPTURE_FONT_PACKAGES]);
  } catch {
    return 'unavailable';
  }

  const versions = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const [status, name, version] = line.split('\t');
    if (status !== 'installed' || name === undefined || version === undefined) {
      continue;
    }
    versions.set(name, version);
  }

  const packages = CAPTURE_FONT_PACKAGES.filter((name) => versions.has(name)).map(
    (name) => ({ name, version: versions.get(name) }),
  );
  return packages.length === 0 ? 'unavailable' : packages;
}

/**
 * Build the environment fingerprint for one capture run.
 *
 * On the host (`source=host`) nothing is available to probe: the image, font
 * package versions and EGL variables are reported as unavailable and no error
 * is raised. Inside the container (`CAPTURE_CONTAINER=1`) the fingerprint
 * records the pinned image, Node / Playwright / browser versions, the installed
 * font package versions, the EGL variables and the target DPR.
 */
export function captureEnvironmentFingerprint({
  target = 'desktop',
  run = {},
  env = process.env,
  lockfilePath,
  readFile,
} = {}) {
  const dpr = dprForCaptureTarget(target);
  const source = env[CAPTURE_CONTAINER_FLAG] === '1' ? 'container' : 'host';
  const playwrightVersion =
    run.playwrightVersion ?? readPlaywrightVersion({ lockfilePath, readFile });

  const fontPackages =
    source !== 'container'
      ? null
      : run.fontPackages !== undefined
        ? run.fontPackages
        : probeFontPackages();

  const fingerprint = {
    source,
    target,
    dpr,
    image:
      source === 'container'
        ? {
            repository: PLAYWRIGHT_IMAGE_REPOSITORY,
            tag: env[CAPTURE_IMAGE_TAG_VAR] ?? PLAYWRIGHT_IMAGE_PIN.tag,
            digest: env[CAPTURE_IMAGE_DIGEST_VAR] ?? PLAYWRIGHT_IMAGE_PIN.digest,
          }
        : null,
    node: run.nodeVersion ?? process.version,
    playwright: playwrightVersion,
    browser: run.browserVersion ?? null,
    fonts: source === 'container' ? fontPackages : null,
    env:
      source === 'container'
        ? Object.fromEntries(
            CAPTURE_EGL_VARS.map((name) => [name, env[name] ?? null]),
          )
        : null,
  };

  return fingerprint;
}

/** Format the fingerprint as one stable, human-readable capture log line. */
export function formatCaptureEnvironmentFingerprint(fingerprint) {
  const image =
    fingerprint.image === null
      ? 'unavailable'
      : `${fingerprint.image.repository}:${fingerprint.image.tag}@${fingerprint.image.digest}`;
  const fonts =
    fingerprint.fonts === null || fingerprint.fonts === 'unavailable'
      ? 'unavailable'
      : fingerprint.fonts.map(({ name, version }) => `${name}@${version}`).join(',');
  const environment =
    fingerprint.env === null
      ? 'unavailable'
      : CAPTURE_EGL_VARS.map(
          (name) => `${name}=${fingerprint.env[name] ?? ''}`,
        ).join(',');

  return [
    'capture-env:',
    `source=${fingerprint.source}`,
    `target=${fingerprint.target}`,
    `dpr=${fingerprint.dpr}`,
    `image=${image}`,
    `node=${fingerprint.node}`,
    `playwright=${fingerprint.playwright}`,
    `browser=${fingerprint.browser ?? 'unavailable'}`,
    `fonts=${fonts}`,
    `env=${environment}`,
  ].join(' ');
}

/**
 * Strict environment validation for the container entry.
 *
 * The host entry sets the marker, image tag, target and target DPR before
 * `docker run`; the same script then re-validates them inside the container.
 * Missing or mismatched variables name the exact variable so a misconfigured
 * container fails before it writes a single PNG.
 */
export function assertContainerCaptureEnvironment({
  env = process.env,
  target,
  targets,
  version,
  lockfilePath,
  readFile,
} = {}) {
  if (env[CAPTURE_CONTAINER_FLAG] !== '1') {
    throw new Error(
      `Not running in the capture container: ${CAPTURE_CONTAINER_FLAG} must be "1" ` +
        '(run captures through npm run screenshots:container).',
    );
  }

  for (const name of CAPTURE_EGL_VARS) {
    const expected = CAPTURE_EGL_ENV[name];
    const actual = env[name];
    if (actual === undefined || actual === '') {
      throw new Error(
        `Missing required capture environment variable "${name}": expected "${expected}".`,
      );
    }
    if (actual !== expected) {
      throw new Error(
        `Capture environment variable "${name}" is "${actual}": expected "${expected}".`,
      );
    }
  }

  const envTargets = normalizeCaptureTargets(env[CAPTURE_TARGET_VAR]);
  if (envTargets === null) {
    throw new Error(
      `Missing required capture environment variable "${CAPTURE_TARGET_VAR}": ` +
        `expected one or more of ${CAPTURE_TARGETS.join(', ')}.`,
    );
  }
  const expectedTargets = normalizeCaptureTargets(targets ?? target);
  if (
    expectedTargets !== null &&
    (expectedTargets.length !== envTargets.length ||
      expectedTargets.some((value, index) => value !== envTargets[index]))
  ) {
    const plural = expectedTargets.length === 1 ? '' : 's';
    const verb = expectedTargets.length === 1 ? 'does' : 'do';
    throw new Error(
      `Capture target${plural} "${expectedTargets.join(',')}" ${verb} not match ` +
        `${CAPTURE_TARGET_VAR}="${envTargets.join(',')}".`,
    );
  }

  const expectedDprs = envTargets.map((value) => dprForCaptureTarget(value));
  const actualDprs = parseDprList(env[CAPTURE_TARGET_DPR_VAR]);
  if (actualDprs === null) {
    throw new Error(
      `Missing or invalid capture environment variable "${CAPTURE_TARGET_DPR_VAR}": ` +
        `expected "${expectedDprs.join(',')}" for targets "${envTargets.join(',')}".`,
    );
  }
  if (actualDprs.length !== envTargets.length) {
    throw new Error(
      `Capture DPR list "${actualDprs.join(',')}" does not match ` +
        `${CAPTURE_TARGET_VAR}="${envTargets.join(',')}".`,
    );
  }
  envTargets.forEach((value, index) => {
    if (actualDprs[index] !== expectedDprs[index]) {
      throw new Error(
        `Capture DPR ${actualDprs[index]} does not match target "${value}": ` +
          `expected ${expectedDprs[index]}.`,
      );
    }
  });

  const imageTag = env[CAPTURE_IMAGE_TAG_VAR];
  if (imageTag === undefined || imageTag === '') {
    throw new Error(
      `Missing required capture environment variable "${CAPTURE_IMAGE_TAG_VAR}": ` +
        `expected "${PLAYWRIGHT_IMAGE_PIN.tag}".`,
    );
  }
  const playwrightVersion =
    version ?? readPlaywrightVersion({ lockfilePath, readFile });
  assertImageTagMatchesPlaywrightVersion(imageTag, playwrightVersion);

  return {
    targets: envTargets,
    dprs: actualDprs,
    imageTag,
    version: playwrightVersion,
  };
}
