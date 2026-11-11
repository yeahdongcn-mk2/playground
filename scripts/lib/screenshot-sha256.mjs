import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  CAPTURE_FONT_PACKAGES,
  CAPTURE_TARGET_DPRS,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from './capture-env.mjs';

/**
 * Reusable verifier for the fixed-environment screenshot evidence (Issue #199).
 *
 * `docs/screenshots/capture-sha256-manifest.json` records the committed WebKit
 * evidence that is byte-for-byte reproducible inside the pinned Playwright
 * container: the file name, expected sha256, capture command and provenance
 * (container image and capture commit), plus the expected capture environment
 * fingerprint (image tag / digest, EGL variables, target DPR and font package
 * versions recorded from the container).
 *
 * The hash check only reads committed files. Passing a capture log additionally
 * verifies the environment fingerprint printed by the capture runtime, and the
 * failure classes stay separate: a changed PNG is a hash mismatch, a different
 * image / EGL / DPR / font stack is an environment mismatch, and a malformed
 * manifest or capture-env log line is invalid input for the CLI to reject.
 */

export const DEFAULT_SCREENSHOT_DIR = 'docs/screenshots';
export const DEFAULT_MANIFEST_PATH = 'docs/screenshots/capture-sha256-manifest.json';

/** A PNG sha256 as lower-case hex, exactly 64 characters. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** An OCI image digest as `sha256:` plus 64 lower-case hex characters. */
export const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** A git capture commit: the repository records full 40-character objects. */
export const CAPTURE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const IMAGE_REFERENCE_PATTERN = /^(?<repository>.+):(?<tag>[^:@]+)@(?<digest>sha256:[0-9a-f]{64})$/;

/** Raised when a manifest or capture log cannot be parsed as expected. */
export class ScreenshotSha256Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenshotSha256Error';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScreenshotSha256Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseEnvironment(source, environment) {
  if (!isPlainObject(environment)) {
    throw new ScreenshotSha256Error(`${source}: "environment" must be an object`);
  }

  const kind = requireNonEmptyString(environment.source, `${source}: environment.source`);
  if (kind !== 'container' && kind !== 'host') {
    throw new ScreenshotSha256Error(
      `${source}: environment.source must be "container" or "host", got "${kind}"`,
    );
  }

  const target = requireNonEmptyString(environment.target, `${source}: environment.target`);
  if (!Number.isInteger(environment.dpr) || environment.dpr <= 0) {
    throw new ScreenshotSha256Error(
      `${source}: environment.dpr must be a positive integer, got ${String(environment.dpr)}`,
    );
  }

  if (!isPlainObject(environment.image)) {
    throw new ScreenshotSha256Error(`${source}: environment.image must be an object`);
  }
  const repository = requireNonEmptyString(
    environment.image.repository,
    `${source}: environment.image.repository`,
  );
  const tag = requireNonEmptyString(environment.image.tag, `${source}: environment.image.tag`);
  const digest = requireNonEmptyString(
    environment.image.digest,
    `${source}: environment.image.digest`,
  );
  if (!IMAGE_DIGEST_PATTERN.test(digest)) {
    throw new ScreenshotSha256Error(
      `${source}: environment.image.digest must be "sha256:" plus 64 lower-case hex characters, ` +
        `got "${digest}"`,
    );
  }

  if (!isPlainObject(environment.egl)) {
    throw new ScreenshotSha256Error(`${source}: environment.egl must be an object`);
  }
  const egl = {};
  for (const [name, value] of Object.entries(environment.egl)) {
    if (typeof value !== 'string' || value === '') {
      throw new ScreenshotSha256Error(
        `${source}: environment.egl.${name} must be a non-empty string`,
      );
    }
    egl[name] = value;
  }

  if (!Array.isArray(environment.fonts) || environment.fonts.length === 0) {
    throw new ScreenshotSha256Error(
      `${source}: environment.fonts must be a non-empty array of font packages`,
    );
  }
  const fontNames = new Set();
  const fonts = environment.fonts.map((font, index) => {
    const label = `${source}: environment.fonts[${index}]`;
    if (!isPlainObject(font)) {
      throw new ScreenshotSha256Error(`${label} must be an object`);
    }
    const name = requireNonEmptyString(font.name, `${label}.name`);
    const version = requireNonEmptyString(font.version, `${label}.version`);
    if (fontNames.has(name)) {
      throw new ScreenshotSha256Error(`${source}: duplicate font package "${name}"`);
    }
    fontNames.add(name);
    return { name, version };
  });

  if (!CAPTURE_EGL_VARS.every((name) => name in egl)) {
    throw new ScreenshotSha256Error(
      `${source}: environment.egl is missing one of ${CAPTURE_EGL_VARS.join(', ')}`,
    );
  }

  return {
    source: kind,
    target,
    dpr: environment.dpr,
    image: { repository, tag, digest },
    egl,
    fonts,
  };
}

function parseCapture(entry, index, source) {
  const label = `${source}: captures[${index}]`;
  if (!isPlainObject(entry)) {
    throw new ScreenshotSha256Error(`${label} must be an object`);
  }

  const file = requireNonEmptyString(entry.file, `${label}.file`);
  if (!file.endsWith('.png')) {
    throw new ScreenshotSha256Error(`${label}.file must be a .png file name, got "${file}"`);
  }
  if (file.includes('/') || file.includes('\\') || file === '..' || file === '.') {
    throw new ScreenshotSha256Error(
      `${label}.file must be a plain file name below the screenshot directory, got "${file}"`,
    );
  }

  const sha256 = requireNonEmptyString(entry.sha256, `${label}.sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new ScreenshotSha256Error(
      `${label}.sha256 must be 64 lower-case hex characters, got "${sha256}"`,
    );
  }

  const command = requireNonEmptyString(entry.command, `${label}.command`);

  if (!isPlainObject(entry.provenance)) {
    throw new ScreenshotSha256Error(`${label}.provenance must be an object`);
  }
  const container = requireNonEmptyString(
    entry.provenance.container,
    `${label}.provenance.container`,
  );
  if (IMAGE_REFERENCE_PATTERN.exec(container) === null) {
    throw new ScreenshotSha256Error(
      `${label}.provenance.container must be "<repository>:<tag>@sha256:<digest>", ` +
        `got "${container}"`,
    );
  }
  const captureCommit = requireNonEmptyString(
    entry.provenance.captureCommit,
    `${label}.provenance.captureCommit`,
  );
  if (!CAPTURE_COMMIT_PATTERN.test(captureCommit)) {
    throw new ScreenshotSha256Error(
      `${label}.provenance.captureCommit must be a git commit hash, got "${captureCommit}"`,
    );
  }

  return {
    file,
    sha256,
    command,
    provenance: { container, captureCommit },
  };
}

/**
 * Parse and validate a sha256 manifest.
 *
 * Structural problems (invalid entries, a duplicate file, a sha256 that is not
 * 64 lower-case hex characters, ...) throw {@link ScreenshotSha256Error}; the
 * CLI maps those to exit code 2. The environment contract against
 * `capture-env.mjs` is checked separately by
 * {@link manifestEnvironmentMismatches}.
 */
export function parseSha256Manifest(text, { source = 'manifest' } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScreenshotSha256Error(`${source}: not valid JSON (${detail})`);
  }

  if (!isPlainObject(parsed)) {
    throw new ScreenshotSha256Error(`${source}: top level must be an object`);
  }
  if (!Array.isArray(parsed.captures) || parsed.captures.length === 0) {
    throw new ScreenshotSha256Error(
      `${source}: "captures" must be a non-empty array of screenshot entries`,
    );
  }

  const environment = parseEnvironment(source, parsed.environment);

  const seen = new Set();
  const captures = parsed.captures.map((entry, index) => {
    const capture = parseCapture(entry, index, source);
    if (seen.has(capture.file)) {
      throw new ScreenshotSha256Error(`${source}: duplicate capture file "${capture.file}"`);
    }
    seen.add(capture.file);
    return capture;
  });

  return { environment, captures };
}

/**
 * Compare the manifest environment with the fixed capture contract.
 *
 * The manifest is data, so a test and the CLI both re-check that its image tag
 * / digest, EGL variables, target DPR, font package names, per-capture
 * `provenance.container` and recapture `command` still match
 * `scripts/lib/capture-env.mjs` (the t1 contract). Font versions are recorded
 * values from the container and are not compared here.
 *
 * @returns {string[]} one message per mismatch; empty when the manifest follows
 *   the fixed contract.
 */
export function manifestEnvironmentMismatches(manifest) {
  const { environment } = manifest;
  const problems = [];

  if (environment.source !== 'container') {
    problems.push(
      `environment.source is "${environment.source}", expected "container" for fixed-environment evidence`,
    );
  }

  const expectedDpr = CAPTURE_TARGET_DPRS[environment.target];
  if (expectedDpr === undefined) {
    problems.push(
      `environment.target "${environment.target}" is not a capture target ` +
        `(${Object.keys(CAPTURE_TARGET_DPRS).join(', ')})`,
    );
  } else if (environment.dpr !== expectedDpr) {
    problems.push(
      `environment.dpr is ${environment.dpr} for target "${environment.target}", expected ${expectedDpr}`,
    );
  }

  const expectedImage = {
    repository: PLAYWRIGHT_IMAGE_REPOSITORY,
    tag: PLAYWRIGHT_IMAGE_PIN.tag,
    digest: PLAYWRIGHT_IMAGE_PIN.digest,
  };
  for (const field of ['repository', 'tag', 'digest']) {
    if (environment.image[field] !== expectedImage[field]) {
      problems.push(
        `environment.image.${field} is "${environment.image[field]}", ` +
          `expected "${expectedImage[field]}"`,
      );
    }
  }

  for (const name of CAPTURE_EGL_VARS) {
    if (environment.egl[name] !== CAPTURE_EGL_ENV[name]) {
      problems.push(
        `environment.egl.${name} is "${environment.egl[name] ?? ''}", ` +
          `expected "${CAPTURE_EGL_ENV[name]}"`,
      );
    }
  }
  const unexpectedEgl = Object.keys(environment.egl).filter(
    (name) => !CAPTURE_EGL_VARS.includes(name),
  );
  if (unexpectedEgl.length > 0) {
    problems.push(
      `environment.egl has unexpected variable(s): ${unexpectedEgl.join(', ')}; ` +
        `the fixed contract records only ${CAPTURE_EGL_VARS.join(', ')}`,
    );
  }

  const expectedFonts = [...CAPTURE_FONT_PACKAGES];
  const recordedFonts = environment.fonts.map((font) => font.name);
  if (
    recordedFonts.length !== expectedFonts.length ||
    recordedFonts.some((name, index) => name !== expectedFonts[index])
  ) {
    problems.push(
      `environment.fonts list is "${recordedFonts.join(',')}", ` +
        `expected "${expectedFonts.join(',')}"`,
    );
  }

  const expectedReference = imageReference(expectedImage);
  manifest.captures.forEach((capture, index) => {
    if (capture.provenance.container !== expectedReference) {
      problems.push(
        `captures[${index}] provenance.container is "${capture.provenance.container}", ` +
          `expected "${expectedReference}"`,
      );
    }
    if (!capture.command.startsWith('npm run screenshots:container -- ')) {
      problems.push(
        `captures[${index}] command is "${capture.command}", expected a ` +
          '"npm run screenshots:container -- <target>" recapture command',
      );
    }
  });

  return problems;
}

/** Render a manifest image as the reference the capture log prints. */
export function imageReference(image) {
  return `${image.repository}:${image.tag}@${image.digest}`;
}

/** Parse the `repo:tag@sha256:...` reference printed in the capture log. */
export function parseImageReference(value) {
  if (value === 'unavailable') {
    return null;
  }
  const groups = IMAGE_REFERENCE_PATTERN.exec(value)?.groups;
  if (groups === undefined) {
    throw new ScreenshotSha256Error(`invalid capture-env image reference "${value}"`);
  }
  return {
    repository: groups.repository,
    tag: groups.tag,
    digest: groups.digest,
  };
}

function parseFontList(value) {
  if (value === 'unavailable') {
    return 'unavailable';
  }
  return value
    .split(',')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const at = entry.lastIndexOf('@');
      if (at <= 0 || at === entry.length - 1) {
        throw new ScreenshotSha256Error(`invalid capture-env font entry "${entry}"`);
      }
      return { name: entry.slice(0, at), version: entry.slice(at + 1) };
    });
}

function parseEglList(value) {
  if (value === 'unavailable') {
    return null;
  }
  const env = {};
  for (const entry of value.split(',')) {
    if (entry === '') continue;
    const equals = entry.indexOf('=');
    if (equals <= 0) {
      throw new ScreenshotSha256Error(`invalid capture-env variable entry "${entry}"`);
    }
    env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env;
}

/**
 * Parse one `capture-env:` line printed by the capture runtime.
 *
 * The format is stable (see `formatCaptureEnvironmentFingerprint` in
 * `capture-env.mjs`), so a malformed line is an error rather than `null`.
 */
export function parseCaptureEnvironmentFingerprintLine(line) {
  const trimmed = String(line).trim();
  const prefix = 'capture-env:';
  if (!trimmed.startsWith(prefix)) {
    throw new ScreenshotSha256Error(`not a capture-env fingerprint line: "${trimmed}"`);
  }

  const fields = new Map();
  for (const token of trimmed.slice(prefix.length).trim().split(/\s+/)) {
    if (token === '') continue;
    const equals = token.indexOf('=');
    if (equals <= 0) {
      throw new ScreenshotSha256Error(`capture-env field "${token}" is not key=value`);
    }
    fields.set(token.slice(0, equals), token.slice(equals + 1));
  }

  for (const key of [
    'source',
    'target',
    'dpr',
    'image',
    'node',
    'playwright',
    'browser',
    'fonts',
    'env',
  ]) {
    if (!fields.has(key)) {
      throw new ScreenshotSha256Error(`capture-env line is missing "${key}"`);
    }
  }

  const dpr = Number(fields.get('dpr'));
  if (!Number.isInteger(dpr) || dpr <= 0) {
    throw new ScreenshotSha256Error(
      `capture-env dpr is "${fields.get('dpr')}", expected a positive integer`,
    );
  }

  const browser = fields.get('browser');
  return {
    source: fields.get('source'),
    target: fields.get('target'),
    dpr,
    image: parseImageReference(fields.get('image')),
    node: fields.get('node'),
    playwright: fields.get('playwright'),
    browser: browser === 'unavailable' ? null : browser,
    fonts: parseFontList(fields.get('fonts')),
    env: parseEglList(fields.get('env')),
    line: trimmed,
  };
}

/** Parse every `capture-env:` line in a capture log. */
export function parseCaptureLogFingerprints(text) {
  const fingerprints = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('capture-env:')) continue;
    fingerprints.push(parseCaptureEnvironmentFingerprintLine(line));
  }
  return fingerprints;
}

function formatFonts(fonts) {
  if (fonts === null || fonts === 'unavailable') {
    return 'unavailable';
  }
  return fonts.map(({ name, version }) => `${name}@${version}`).join(',');
}

/**
 * Verify the capture environment fingerprint against the manifest expectation.
 *
 * A capture log can hold several fingerprint lines (a Chromium run records one
 * for desktop and one for mobile). Only lines for the manifest's target are
 * compared; every such line must match, so a log with two WebKit runs verifies
 * both. The result keeps the parsed fingerprints so the CLI can print the
 * actual environment next to a hash mismatch. A line that starts with
 * `capture-env:` but cannot be parsed sets `invalid` instead of being reported
 * as environment drift, so the CLI can reject malformed input.
 *
 * @returns {{
 *   checked: boolean,
 *   invalid: boolean,
 *   ok: boolean,
 *   problems: string[],
 *   fingerprints: ReturnType<typeof parseCaptureEnvironmentFingerprintLine>[],
 * }}
 */
export function verifyCaptureEnvironment({ logText, environment } = {}) {
  if (logText === undefined || logText === null) {
    return { checked: false, invalid: false, ok: true, problems: [], fingerprints: [] };
  }

  const problems = [];
  let fingerprints;
  try {
    fingerprints = parseCaptureLogFingerprints(logText);
  } catch (error) {
    return {
      checked: true,
      invalid: true,
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
      fingerprints: [],
    };
  }

  if (fingerprints.length === 0) {
    return {
      checked: true,
      invalid: false,
      ok: false,
      problems: ['capture log has no "capture-env:" fingerprint line'],
      fingerprints: [],
    };
  }

  const matching = fingerprints.filter((entry) => entry.target === environment.target);
  if (matching.length === 0) {
    const targets = [...new Set(fingerprints.map((entry) => entry.target))].join(', ');
    problems.push(
      `capture log has no fingerprint for target "${environment.target}" ` +
        `(logged targets: ${targets})`,
    );
  }

  const expectedReference = imageReference(environment.image);
  for (const fingerprint of matching) {
    if (fingerprint.source !== environment.source) {
      problems.push(
        `capture environment source is "${fingerprint.source}", expected "${environment.source}"`,
      );
    }
    if (fingerprint.dpr !== environment.dpr) {
      problems.push(
        `capture environment dpr is ${fingerprint.dpr}, expected ${environment.dpr}`,
      );
    }

    if (fingerprint.image === null) {
      problems.push('capture environment image is unavailable, expected the pinned container image');
    } else {
      const actualReference = imageReference(fingerprint.image);
      if (actualReference !== expectedReference) {
        problems.push(
          `capture environment image is "${actualReference}", expected "${expectedReference}"`,
        );
      }
    }

    if (fingerprint.env === null) {
      problems.push('capture environment EGL variables are unavailable');
    } else {
      for (const name of CAPTURE_EGL_VARS) {
        if (fingerprint.env[name] !== environment.egl[name]) {
          problems.push(
            `capture environment ${name} is "${fingerprint.env[name] ?? ''}", ` +
              `expected "${environment.egl[name]}"`,
          );
        }
      }
    }

    const actualFonts = formatFonts(fingerprint.fonts);
    const expectedFonts = formatFonts(environment.fonts);
    if (actualFonts !== expectedFonts) {
      problems.push(
        `capture environment fonts are "${actualFonts}", expected "${expectedFonts}"`,
      );
    }
  }

  return {
    checked: true,
    invalid: false,
    ok: problems.length === 0,
    problems,
    fingerprints: matching,
  };
}

/**
 * Verify the committed evidence against the manifest.
 *
 * Every entry must exist and hash to its expected sha256. When `logText` is
 * supplied the capture environment is checked as a separate problem class.
 *
 * @returns {{
 *   entries: number,
 *   hashProblems: Array<{file: string, expected: string, actual: string | null, message: string}>,
 *   environment: ReturnType<typeof verifyCaptureEnvironment>,
 * }}
 */
export function verifyScreenshotSha256({
  dir = DEFAULT_SCREENSHOT_DIR,
  manifest,
  logText,
  readFile = readFileSync,
} = {}) {
  if (manifest === undefined) {
    throw new ScreenshotSha256Error('verifyScreenshotSha256 needs a parsed manifest');
  }

  const hashProblems = [];
  for (const capture of manifest.captures) {
    const filePath = join(dir, capture.file);
    let bytes;
    try {
      bytes = readFile(filePath);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      hashProblems.push({
        file: capture.file,
        expected: capture.sha256,
        actual: null,
        message: code === 'ENOENT' ? `missing file: ${filePath}` : `${filePath}: ${detail}`,
      });
      continue;
    }

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== capture.sha256) {
      hashProblems.push({
        file: capture.file,
        expected: capture.sha256,
        actual,
        message: `${filePath}: sha256 mismatch`,
      });
    }
  }

  return {
    entries: manifest.captures.length,
    hashProblems,
    environment: verifyCaptureEnvironment({ logText, environment: manifest.environment }),
  };
}
