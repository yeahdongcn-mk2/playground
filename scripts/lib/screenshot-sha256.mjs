import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  CAPTURE_FONT_PACKAGES,
  CAPTURE_PLATFORM,
  CAPTURE_TARGET_DPRS,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from './capture-env.mjs';

/**
 * Reusable verifier for the fixed-environment screenshot evidence (Issue #199).
 *
 * Evidence is recorded per capture target: the WebKit manifest stays at
 * `docs/screenshots/capture-sha256-manifest.json`, while the Chromium desktop
 * and mobile blank evidence lives in the matching
 * `docs/screenshots/capture-sha256-manifest-<target>.json` file. Each manifest
 * records the committed evidence that is byte-for-byte reproducible inside the
 * pinned Playwright container: the file name, expected sha256, capture command
 * and provenance (container image and capture commit), plus the expected
 * capture environment fingerprint (image tag / digest, platform, EGL
 * variables, target DPR and font package versions recorded from the container).
 *
 * The hash check only reads committed files. Passing a capture log additionally
 * verifies the environment fingerprint printed by the capture runtime, and the
 * failure classes stay separate: a changed PNG is a hash mismatch, a different
 * image / platform / EGL / DPR / font stack is an environment mismatch, and a
 * malformed manifest or capture-env log line is invalid input for the CLI to
 * reject. A platform difference is also returned separately because the same
 * multi-arch image digest resolves to another browser build on the wrong CPU
 * architecture.
 */

export const DEFAULT_SCREENSHOT_DIR = 'docs/screenshots';
export const DEFAULT_MANIFEST_PATH = 'docs/screenshots/capture-sha256-manifest.json';
/** Directory the per-target sha256 manifest set is discovered in. */
export const DEFAULT_MANIFEST_DIR = 'docs/screenshots';
/**
 * File name of one sha256 manifest in {@link DEFAULT_MANIFEST_DIR}.
 *
 * The WebKit manifest is `capture-sha256-manifest.json`; a target-split
 * manifest appends the target, for example
 * `capture-sha256-manifest-desktop.json`. Every other JSON file in the
 * directory (fixtures, `ci-webkit-narrow-manifest.json`, ...) is ignored.
 */
export const MANIFEST_FILE_PATTERN =
  /^capture-sha256-manifest(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.json$/;

/** A PNG sha256 as lower-case hex, exactly 64 characters. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** An OCI image digest as `sha256:` plus 64 lower-case hex characters. */
export const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** A git capture commit: the repository records full 40-character objects. */
export const CAPTURE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
/** A plain PNG file name: no separators, control characters or `..` segments. */
export const FILE_NAME_PATTERN = /^[^\p{Cc}/\\]+\.png$/u;
/**
 * A Docker-style capture platform: `<os>/<architecture>` with an optional
 * variant, for example `linux/amd64` or `linux/arm64/v8`.
 */
export const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;

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
  if (
    typeof environment.dpr !== 'number' ||
    !Number.isFinite(environment.dpr) ||
    environment.dpr <= 0
  ) {
    throw new ScreenshotSha256Error(
      `${source}: environment.dpr must be a positive number, got ${String(environment.dpr)}`,
    );
  }

  const platform = requireNonEmptyString(
    environment.platform,
    `${source}: environment.platform`,
  );
  if (!PLATFORM_PATTERN.test(platform)) {
    throw new ScreenshotSha256Error(
      `${source}: environment.platform must be "<os>/<arch>" with an optional variant ` +
        `(for example "linux/amd64"), got "${platform}"`,
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
    platform,
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
  if (!FILE_NAME_PATTERN.test(file) || file === '..' || file === '.') {
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
    // Case / Unicode aliases would resolve to the same file on case-insensitive
    // filesystems, so they count as a duplicate even on Linux.
    const key = capture.file.normalize('NFC').toLowerCase();
    if (seen.has(key)) {
      throw new ScreenshotSha256Error(`${source}: duplicate capture file "${capture.file}"`);
    }
    seen.add(key);
    return capture;
  });

  return { environment, captures };
}

/**
 * Compare the manifest environment with the fixed capture contract.
 *
 * The manifest is data, so a test and the CLI both re-check that its image tag
 * / digest, platform, EGL variables, target DPR, font package names,
 * per-capture `provenance.container` and recapture `command` still match
 * `scripts/lib/capture-env.mjs` (the t1 contract). Font versions are recorded
 * values from the container and are not compared here.
 *
 * The platform message is also available through
 * {@link manifestPlatformMismatch}; the CLI reports it as its own failure
 * class (the sha256s were recorded on another CPU architecture) instead of a
 * generic invalid-manifest problem.
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

  if (environment.platform !== CAPTURE_PLATFORM) {
    problems.push(manifestPlatformMessage(environment.platform));
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
    const expectedCommand = expectedRecaptureCommand(capture.file);
    if (capture.command !== expectedCommand) {
      problems.push(
        `captures[${index}] command is "${capture.command}", expected "${expectedCommand}"`,
      );
    }
  });

  return problems;
}

function manifestPlatformMessage(actual) {
  return `environment.platform is "${actual}", expected "${CAPTURE_PLATFORM}"`;
}

/**
 * Describe a manifest platform that differs from the fixed capture contract.
 *
 * The manifest records the CPU architecture the committed PNG bytes were
 * captured on. The pinned image digest is a multi-arch manifest list, so a
 * manifest recorded on another platform (for example `linux/arm64`) explains a
 * hash or rendering difference instead of silently passing as a valid
 * contract. The CLI reports this separately from other environment drift and
 * exits 1 because the evidence is not from the fixed environment.
 *
 * @returns {{
 *   source: 'manifest',
 *   expected: string,
 *   actual: string,
 *   image: { repository: string, tag: string, digest: string },
 *   message: string,
 * } | null} `null` when the manifest platform matches `CAPTURE_PLATFORM`.
 */
export function manifestPlatformMismatch(manifest) {
  const { environment } = manifest;
  if (environment.platform === CAPTURE_PLATFORM) {
    return null;
  }
  return {
    source: 'manifest',
    expected: CAPTURE_PLATFORM,
    actual: environment.platform,
    image: environment.image,
    message: manifestPlatformMessage(environment.platform),
  };
}

/**
 * The fixed-container recapture command for a committed evidence file.
 *
 * WebKit evidence uses the game-specific scripts derived from the file prefix,
 * and every other WebKit file belongs to the generic `screenshots:webkit`
 * capture. The Chromium blank evidence for the desktop and mobile targets is
 * written by the unfiltered `screenshots` command, which also rewrites the hub
 * images; the caller restores those before committing. Comparing the whole
 * command (not just its prefix) stops a stale or shell-extended command from
 * being printed as the recapture hint.
 */
export function expectedRecaptureCommand(file) {
  if (file === 'after-blank-desktop.png' || file === 'after-blank-mobile.png') {
    return 'npm run screenshots:container -- screenshots';
  }
  if (file.startsWith('after-2048-')) {
    return 'npm run screenshots:container -- screenshots:2048:webkit';
  }
  if (file.startsWith('after-breakout-')) {
    return 'npm run screenshots:container -- screenshots:breakout:webkit';
  }
  if (file.startsWith('after-minesweeper-')) {
    if (file.includes('-webkit-narrow-')) {
      return 'npm run screenshots:container -- screenshots:minesweeper:webkit-narrow';
    }
    if (file.includes('-scores-webkit')) {
      return 'npm run screenshots:container -- screenshots:minesweeper:scores:webkit';
    }
    if (file.endsWith('-webkit.png')) {
      return 'npm run screenshots:container -- screenshots:minesweeper:webkit';
    }
    return 'npm run screenshots:container -- screenshots:minesweeper';
  }
  if (file.startsWith('after-snake-')) {
    return 'npm run screenshots:container -- screenshots:snake:webkit';
  }
  return 'npm run screenshots:container -- screenshots:webkit';
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
 * The exact fields printed by `formatCaptureEnvironmentFingerprint`. A line
 * with duplicate or unknown fields is malformed input, not environment drift.
 */
const CAPTURE_ENV_FIELDS = new Set([
  'source',
  'target',
  'dpr',
  'platform',
  'image',
  'node',
  'playwright',
  'browser',
  'fonts',
  'env',
]);

/** The capture runtime's legitimate "fingerprint unavailable" fallback line. */
const CAPTURE_ENV_UNAVAILABLE_PATTERN = /^capture-env:\s*unavailable\b/;

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
  if (CAPTURE_ENV_UNAVAILABLE_PATTERN.test(trimmed)) {
    throw new ScreenshotSha256Error(
      `capture environment fingerprint is unavailable: "${trimmed}"`,
    );
  }

  const fields = new Map();
  for (const token of trimmed.slice(prefix.length).trim().split(/\s+/)) {
    if (token === '') continue;
    const equals = token.indexOf('=');
    if (equals <= 0) {
      throw new ScreenshotSha256Error(`capture-env field "${token}" is not key=value`);
    }
    const key = token.slice(0, equals);
    if (!CAPTURE_ENV_FIELDS.has(key)) {
      throw new ScreenshotSha256Error(
        `capture-env field "${key}" is not part of the fixed fingerprint`,
      );
    }
    if (fields.has(key)) {
      throw new ScreenshotSha256Error(`capture-env field "${key}" appears more than once`);
    }
    fields.set(key, token.slice(equals + 1));
  }

  for (const key of CAPTURE_ENV_FIELDS) {
    if (!fields.has(key)) {
      throw new ScreenshotSha256Error(`capture-env line is missing "${key}"`);
    }
  }

  const rawDpr = fields.get('dpr') ?? '';
  // The fixed contract has both integer and fractional targets (`mobile-touch`
  // is DPR 2.625), so the log may record a fraction. Keep the canonical decimal
  // form: `2.625` is valid, while `2.0`, `2.` and `+2` still are not.
  if (!/^[1-9][0-9]*(?:\.[0-9]*[1-9])?$/.test(rawDpr)) {
    throw new ScreenshotSha256Error(
      `capture-env dpr is "${rawDpr}", expected a positive decimal number`,
    );
  }
  const dpr = Number(rawDpr);

  const browser = fields.get('browser');
  return {
    source: fields.get('source'),
    target: fields.get('target'),
    dpr,
    platform: fields.get('platform'),
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
    // The runtime logs this when a probe fails; it is not a fingerprint and
    // must surface as an unavailable environment, not as malformed input.
    if (CAPTURE_ENV_UNAVAILABLE_PATTERN.test(line)) continue;
    fingerprints.push(parseCaptureEnvironmentFingerprintLine(line));
  }
  return fingerprints;
}

/**
 * The marker in the sha256 drift checklist printed by
 * `manifestHashDriftChecklist` in `capture-runtime.mjs`.
 *
 * The checklist is written after the PNG is already on disk, so the capture
 * does not fail. Its `captured sha256` is the only evidence in the log that
 * proves which bytes that run produced.
 */
const CAPTURE_LOG_HASH_HEADER_MARKER =
  ' inside the fixed capture environment, but its sha256 differs from ';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CAPTURE_LOG_HASH_HEADER_PATTERN = new RegExp(
  `^Wrote (?<path>.+)${escapeRegExp(CAPTURE_LOG_HASH_HEADER_MARKER)}(?<manifest>.+):$`,
);
const CAPTURE_LOG_HASH_FIELD_PATTERN = /^(?<field>manifest|captured) sha256: (?<value>.*)$/;

/**
 * Parse the sha256 drift checklist(s) printed by the capture runtime.
 *
 * A fixed-environment capture writes a PNG first and then logs a checklist
 * when its bytes do not match the manifest. The header names the written path
 * and the manifest; the next non-empty lines record the capture-time
 * `manifest sha256` and the `captured sha256`. Records are associated with the
 * manifest by the header path's basename, so a log captured inside the
 * container still matches the repository file name.
 *
 * The checklist format is stable, so a header without its fields, a duplicate
 * field, or a sha256 that is not 64 lower-case hex characters is invalid input
 * rather than `[]`. A log with no checklist at all returns `[]`; that keeps
 * older logs, which never recorded the captured bytes, compatible.
 *
 * @returns {Array<{
 *   file: string,
 *   path: string,
 *   manifestSha256: string,
 *   capturedSha256: string,
 * }>}
 */
export function parseCaptureLogHashRecords(text) {
  const lines = String(text).split(/\r?\n/);
  const records = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('Wrote ') || !line.includes(CAPTURE_LOG_HASH_HEADER_MARKER)) {
      continue;
    }

    const header = CAPTURE_LOG_HASH_HEADER_PATTERN.exec(line);
    if (header === null) {
      throw new ScreenshotSha256Error(
        `malformed capture-log sha256 drift header: "${line}"`,
      );
    }
    const filePath = header.groups?.path ?? '';
    const file = filePath.split(/[\\/]/).pop() ?? '';
    if (file === '') {
      throw new ScreenshotSha256Error(
        `capture-log sha256 drift header does not name a file: "${line}"`,
      );
    }

    const values = { manifest: undefined, captured: undefined };
    let cursor = index + 1;
    while (cursor < lines.length) {
      const entry = lines[cursor].trim();
      if (entry === '') {
        cursor += 1;
        continue;
      }
      const field = CAPTURE_LOG_HASH_FIELD_PATTERN.exec(entry);
      if (field === null) break;
      const name = field.groups?.field;
      if (name !== 'manifest' && name !== 'captured') break;
      if (values[name] !== undefined) {
        throw new ScreenshotSha256Error(
          `capture-log sha256 drift record for "${file}" repeats "${name} sha256"`,
        );
      }
      values[name] = (field.groups?.value ?? '').trim();
      cursor += 1;
    }

    for (const name of ['manifest', 'captured']) {
      const value = values[name];
      if (value === undefined) {
        throw new ScreenshotSha256Error(
          `capture-log sha256 drift record for "${file}" is missing "${name} sha256"`,
        );
      }
      if (!SHA256_PATTERN.test(value)) {
        throw new ScreenshotSha256Error(
          `capture-log ${name} sha256 for "${file}" must be 64 lower-case hex ` +
            `characters, got "${value}"`,
        );
      }
    }

    records.push({
      file,
      path: filePath,
      manifestSha256: values.manifest,
      capturedSha256: values.captured,
    });
    index = cursor - 1;
  }

  return records;
}

/**
 * Compare the log's `captured sha256` records with the current manifest.
 *
 * The log's `manifest sha256` is the baseline at capture time and is not
 * compared: when the manifest is later updated to the captured value, the
 * record still proves that run produced the committed bytes. Every record for
 * the same file must equal the manifest. A file that the log captured but the
 * manifest does not list is a log hash problem (exit 1), not something to
 * ignore. A log with no drift checklist keeps the previous behaviour: nothing
 * is checked and the result is `ok`.
 *
 * @returns {{
 *   checked: boolean,
 *   invalid: boolean,
 *   invalidMessage: string | null,
 *   ok: boolean,
 *   problems: Array<{
 *     file: string,
 *     expected: string | null,
 *     actual: string,
 *     message: string,
 *   }>,
 *   records: ReturnType<typeof parseCaptureLogHashRecords>,
 * }}
 */
export function verifyCaptureLogHashes({ logText, manifest } = {}) {
  if (manifest === undefined) {
    throw new ScreenshotSha256Error('verifyCaptureLogHashes needs a parsed manifest');
  }
  if (logText === undefined || logText === null) {
    return {
      checked: false,
      invalid: false,
      invalidMessage: null,
      ok: true,
      problems: [],
      records: [],
    };
  }

  let records;
  try {
    records = parseCaptureLogHashRecords(logText);
  } catch (error) {
    return {
      checked: true,
      invalid: true,
      invalidMessage: error instanceof Error ? error.message : String(error),
      ok: false,
      // Invalid input is reported through `invalidMessage`; `problems` stays
      // the structured list of drift mismatches.
      problems: [],
      records: [],
    };
  }

  const problems = [];
  for (const record of records) {
    const capture = findSha256ManifestCapture(manifest, record.file);
    if (capture === null) {
      problems.push({
        file: record.file,
        expected: null,
        actual: record.capturedSha256,
        message: 'captured by the log but not recorded in the manifest',
      });
      continue;
    }
    if (record.capturedSha256 !== capture.sha256) {
      problems.push({
        file: capture.file,
        expected: capture.sha256,
        actual: record.capturedSha256,
        message: 'captured sha256 differs from the manifest',
      });
    }
  }

  return {
    checked: true,
    invalid: false,
    invalidMessage: null,
    ok: problems.length === 0,
    problems,
    records,
  };
}

function formatFonts(fonts) {
  if (fonts === null || fonts === 'unavailable') {
    return 'unavailable';
  }
  return fonts.map(({ name, version }) => `${name}@${version}`).join(',');
}

/**
 * Render the manifest environment as the expected fingerprint line.
 *
 * The manifest does not record the Node / Playwright / browser versions (they
 * are not part of the reproducible environment contract), so the returned line
 * keeps the same fields the manifest does record: source, target, DPR,
 * platform, image reference, font package versions and EGL variables. It is
 * used by the write-time guard to print "expected" next to the actual
 * `formatCaptureEnvironmentFingerprint()` line.
 */
export function formatManifestCaptureEnvironment(environment) {
  return [
    'capture-env:',
    `source=${environment.source}`,
    `target=${environment.target}`,
    `dpr=${environment.dpr}`,
    `platform=${environment.platform}`,
    `image=${imageReference(environment.image)}`,
    `fonts=${formatFonts(environment.fonts)}`,
    `env=${CAPTURE_EGL_VARS.map(
      (name) => `${name}=${environment.egl[name] ?? ''}`,
    ).join(',')}`,
  ].join(' ');
}

/**
 * Compare one capture environment fingerprint with the manifest environment.
 *
 * Every field the manifest records is compared: source, target, DPR, platform,
 * pinned image reference, EGL variables and the exact font package versions.
 * The Node / Playwright / browser versions are not compared because the
 * manifest does not record them. Platform drift is returned both in `problems`
 * and as a structured `platformMismatches` entry, matching the log verifier so
 * the CLI keeps reporting it as its own failure class.
 *
 * @returns {{
 *   problems: string[],
 *   platformMismatches: Array<{
 *     source: 'manifest',
 *     expected: string,
 *     actual: string,
 *     image: { repository: string, tag: string, digest: string },
 *     actualImage: { repository: string, tag: string, digest: string } | null,
 *     message: string,
 *   }>,
 * }}
 */
export function compareCaptureEnvironmentFingerprint(
  fingerprint,
  environment,
  { source = 'manifest' } = {},
) {
  const problems = [];
  const platformMismatches = [];

  if (fingerprint.source !== environment.source) {
    problems.push(
      `capture environment source is "${fingerprint.source}", expected "${environment.source}"`,
    );
  }
  if (fingerprint.target !== environment.target) {
    problems.push(
      `capture environment target is "${fingerprint.target}", expected "${environment.target}"`,
    );
  }
  if (fingerprint.dpr !== environment.dpr) {
    problems.push(`capture environment dpr is ${fingerprint.dpr}, expected ${environment.dpr}`);
  }

  if (fingerprint.source === 'container' && fingerprint.platform !== environment.platform) {
    const message =
      `capture environment platform is "${fingerprint.platform}", ` +
      `expected "${environment.platform}"`;
    platformMismatches.push({
      source,
      expected: environment.platform,
      actual: fingerprint.platform,
      image: environment.image,
      actualImage: fingerprint.image,
      message,
    });
    // Keep the message in the flat list as well: callers that only consume
    // `problems` still see the drift, while `platformMismatches` gives the CLI
    // the structured expected / actual values.
    problems.push(message);
  }

  const expectedReference = imageReference(environment.image);
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
    problems.push(`capture environment fonts are "${actualFonts}", expected "${expectedFonts}"`);
  }

  return { problems, platformMismatches };
}

/**
 * Find the manifest entry for one screenshot file name.
 *
 * Matching is exact: `parseSha256Manifest` already rejects case / Unicode
 * aliases as duplicate files, so the committed name is the only one the guard
 * needs to recognise. A file that is not recorded returns `null`; its write
 * keeps the pre-guard behaviour.
 */
export function findSha256ManifestCapture(manifest, file) {
  if (manifest === null || manifest === undefined) {
    return null;
  }
  return manifest.captures.find((capture) => capture.file === file) ?? null;
}

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * List manifest file names in a directory, ignoring every non-manifest entry.
 *
 * A missing directory is not an error: the write-time guard treats it as "no
 * evidence recorded", so the capture keeps its pre-guard behaviour. Any other
 * directory error is a {@link ScreenshotSha256Error} because it would silently
 * hide the evidence contract.
 */
function readManifestFileNames(readDir, dir) {
  let names;
  try {
    names = Array.from(readDir(dir));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      return [];
    }
    throw new ScreenshotSha256Error(
      `cannot read screenshot manifest directory ${dir}: ${errorDetail(error)}`,
    );
  }
  return names.filter(
    (name) => typeof name === 'string' && MANIFEST_FILE_PATTERN.test(name),
  );
}

/**
 * Discover the per-target sha256 manifests below the screenshot directory.
 *
 * The files are returned as full `<dir>/<name>` paths and sorted by file name,
 * so a verification run reports the same order on every host. Only files that
 * match {@link MANIFEST_FILE_PATTERN} are considered; other JSON files in the
 * directory do not describe committed evidence and are ignored.
 *
 * @param {{
 *   dir?: string,
 *   readDir?: (dir: string) => readonly string[],
 * }} [options]
 * @returns {string[]}
 */
export function discoverSha256ManifestPaths({
  dir = DEFAULT_MANIFEST_DIR,
  readDir = readdirSync,
} = {}) {
  return readManifestFileNames(readDir, dir)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => join(dir, name));
}

/**
 * Load and validate every sha256 manifest below the screenshot directory.
 *
 * The result keeps the manifest path so a failure can name the file that owns
 * a capture, and it is sorted by file name for a stable report order. The
 * per-manifest parser already rejects duplicate files inside one manifest;
 * this loader additionally rejects a file recorded by more than one manifest,
 * because a screenshot would then have two competing environments.
 *
 * @param {{
 *   dir?: string,
 *   readDir?: (dir: string) => readonly string[],
 *   readFile?: (path: string) => string | Buffer,
 * }} [options]
 * @returns {Array<{path: string, manifest: ReturnType<typeof parseSha256Manifest>}>}
 */
export function loadSha256Manifests({
  dir = DEFAULT_MANIFEST_DIR,
  readDir = readdirSync,
  readFile = readFileSync,
} = {}) {
  const manifests = discoverSha256ManifestPaths({ dir, readDir }).map((path) => {
    let text;
    try {
      text = readFile(path);
    } catch (error) {
      throw new ScreenshotSha256Error(
        `cannot read screenshot manifest ${path}: ${errorDetail(error)}`,
      );
    }
    return { path, manifest: parseSha256Manifest(text, { source: path }) };
  });

  const owners = new Map();
  for (const { path, manifest } of manifests) {
    for (const capture of manifest.captures) {
      // Match the per-manifest duplicate rule: case / Unicode aliases resolve
      // to the same file on case-insensitive filesystems.
      const key = capture.file.normalize('NFC').toLowerCase();
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new ScreenshotSha256Error(
          `duplicate capture file "${capture.file}" is recorded in both ${owner} and ${path}`,
        );
      }
      owners.set(key, path);
    }
  }

  return manifests;
}

/**
 * Find the manifest that owns one screenshot file.
 *
 * @param {Array<{path: string, manifest: ReturnType<typeof parseSha256Manifest>}> | null | undefined} manifests
 * @param {string} file
 * @returns {{
 *   path: string,
 *   manifest: ReturnType<typeof parseSha256Manifest>,
 *   capture: ReturnType<typeof findSha256ManifestCapture>,
 * } | null} `null` when no loaded manifest records the file.
 */
export function findSha256ManifestCaptureInSet(manifests, file) {
  if (!Array.isArray(manifests)) {
    return null;
  }
  for (const { path, manifest } of manifests) {
    const capture = findSha256ManifestCapture(manifest, file);
    if (capture !== null) {
      return { path, manifest, capture };
    }
  }
  return null;
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
 * A platform difference is also returned in `platformMismatches` (and remains
 * in `problems`), so the CLI can print the expected / actual platform with the
 * pinned image separately from DPR / EGL / font drift.
 *
 * @returns {{
 *   checked: boolean,
 *   invalid: boolean,
 *   ok: boolean,
 *   problems: string[],
 *   platformMismatches: Array<{
 *     source: 'log',
 *     expected: string,
 *     actual: string,
 *     image: { repository: string, tag: string, digest: string },
 *     actualImage: { repository: string, tag: string, digest: string } | null,
 *     message: string,
 *   }>,
 *   fingerprints: ReturnType<typeof parseCaptureEnvironmentFingerprintLine>[],
 * }}
 */
export function verifyCaptureEnvironment({ logText, environment } = {}) {
  if (logText === undefined || logText === null) {
    return {
      checked: false,
      invalid: false,
      ok: true,
      problems: [],
      platformMismatches: [],
      fingerprints: [],
    };
  }

  const problems = [];
  const platformMismatches = [];
  let fingerprints;
  try {
    fingerprints = parseCaptureLogFingerprints(logText);
  } catch (error) {
    return {
      checked: true,
      invalid: true,
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
      platformMismatches: [],
      fingerprints: [],
    };
  }

  if (fingerprints.length === 0) {
    const unavailable = String(logText)
      .split(/\r?\n/)
      .some((rawLine) => CAPTURE_ENV_UNAVAILABLE_PATTERN.test(rawLine.trim()));
    return {
      checked: true,
      invalid: false,
      ok: false,
      problems: [
        unavailable
          ? 'capture environment fingerprint is unavailable (the capture runtime could not probe it)'
          : 'capture log has no "capture-env:" fingerprint line',
      ],
      platformMismatches: [],
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

  for (const fingerprint of matching) {
    const compared = compareCaptureEnvironmentFingerprint(fingerprint, environment, {
      source: 'log',
    });
    problems.push(...compared.problems);
    platformMismatches.push(...compared.platformMismatches);
  }

  return {
    checked: true,
    invalid: false,
    ok: problems.length === 0,
    problems,
    platformMismatches,
    fingerprints: matching,
  };
}

/**
 * Verify the committed evidence against the manifest.
 *
 * Every entry must exist and hash to its expected sha256. When `logText` is
 * supplied the capture environment is checked as a separate problem class, and
 * any sha256 drift checklist records are compared with the current manifest
 * captures. The three failure classes stay independent: `hashProblems` is
 * about the committed PNGs, `logHashes.problems` is about the bytes a logged
 * capture wrote, and `environment.problems` is about the capture environment.
 *
 * @returns {{
 *   entries: number,
 *   hashProblems: Array<{file: string, expected: string, actual: string | null, message: string}>,
 *   logHashes: ReturnType<typeof verifyCaptureLogHashes>,
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
    logHashes: verifyCaptureLogHashes({ logText, manifest }),
    environment: verifyCaptureEnvironment({ logText, environment: manifest.environment }),
  };
}
