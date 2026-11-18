import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  CAPTURE_FONT_PACKAGES,
  CAPTURE_PLATFORM,
  CAPTURE_TARGET_DPRS,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from '../../scripts/lib/capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SCREENSHOT_DIR,
  ScreenshotSha256Error,
  expectedRecaptureCommand,
  manifestEnvironmentMismatches,
  manifestPlatformMismatch,
  parseCaptureEnvironmentFingerprintLine,
  parseCaptureLogFingerprints,
  parseSha256Manifest,
  verifyCaptureEnvironment,
  verifyScreenshotSha256,
} from '../../scripts/lib/screenshot-sha256.mjs';
import type {
  ScreenshotSha256Capture,
  ScreenshotSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = join(ROOT, DEFAULT_MANIFEST_PATH);
const SCREENSHOT_DIR = join(ROOT, DEFAULT_SCREENSHOT_DIR);
const CLI = join(ROOT, 'scripts', 'verify-screenshot-sha256.mjs');
const MANIFEST_TEXT = readFileSync(MANIFEST, 'utf8');

const EXPECTED_FILES = [
  'after-blank-webkit.png',
  'after-2048-playing-webkit.png',
  'after-2048-gameover-webkit.png',
  'after-breakout-playing-webkit.png',
  'after-minesweeper-scores-webkit.png',
];

/** Font versions recorded by the t1 container run (docs/screenshots/README.md). */
const EXPECTED_FONT_VERSIONS = [
  { name: 'fonts-freefont-ttf', version: '20211204+svn4273-2' },
  { name: 'fonts-ipafont-gothic', version: '00303-21ubuntu1' },
  { name: 'fonts-liberation', version: '1:2.1.5-3' },
  { name: 'fonts-noto-color-emoji', version: '2.047-0ubuntu0.24.04.1' },
  { name: 'fonts-tlwg-loma-otf', version: '1:0.7.3-1' },
  { name: 'fonts-unifont', version: '1:15.1.01-1build1' },
  { name: 'fonts-wqy-zenhei', version: '0.9.45-8' },
];

/** The recorded container font list, as the fingerprint line formats it. */
const EXPECTED_FONT_LIST = EXPECTED_FONT_VERSIONS.map(
  ({ name, version }) => `${name}@${version}`,
).join(',');

/** A container-format fingerprint fixture; the browser version is synthetic. */
const CONTAINER_LOG_LINE =
  'capture-env: source=container target=webkit dpr=2 platform=linux/amd64 ' +
  `image=${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest} ` +
  'node=v26.13.0 playwright=1.64.1 browser=27.2 ' +
  `fonts=${EXPECTED_FONT_LIST} ` +
  'env=EGL_PLATFORM=surfaceless,LIBGL_ALWAYS_SOFTWARE=1,' +
  '__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json';

/**
 * A host fingerprint: on the host the image, font versions and EGL variables
 * are unavailable by design, and the source is not the fixed container.
 */
const HOST_LOG_LINE =
  'capture-env: source=host target=webkit dpr=2 platform=unavailable image=unavailable ' +
  'node=v26.13.0 playwright=1.64.1 browser=unavailable fonts=unavailable env=unavailable';

/** Manifest environment drifts that must be rejected and exit 2 through the CLI. */
const MANIFEST_ENVIRONMENT_DRIFT_CASES: Array<{
  label: string;
  problem: string;
  drift: (manifest: ScreenshotSha256Manifest) => void;
}> = [
  {
    label: 'a host environment source',
    drift: (manifest) => {
      manifest.environment.source = 'host';
    },
    problem: 'environment.source is "host", expected "container"',
  },
  {
    label: 'an unknown capture target',
    drift: (manifest) => {
      manifest.environment.target = 'tablet';
    },
    problem: 'environment.target "tablet" is not a capture target',
  },
  {
    label: 'a drifted image repository',
    drift: (manifest) => {
      manifest.environment.image.repository = 'ghcr.io/example/playwright';
    },
    problem:
      'environment.image.repository is "ghcr.io/example/playwright", ' +
      `expected "${PLAYWRIGHT_IMAGE_REPOSITORY}"`,
  },
  {
    label: 'a drifted image tag',
    drift: (manifest) => {
      manifest.environment.image.tag = 'v9.9.9-noble';
    },
    problem: `environment.image.tag is "v9.9.9-noble", expected "${PLAYWRIGHT_IMAGE_PIN.tag}"`,
  },
  {
    // Only the value changes: adding an unknown variable would also produce an
    // "unexpected variable(s)" message, so this case pins the value comparison.
    label: 'a drifted EGL variable value',
    drift: (manifest) => {
      manifest.environment.egl.EGL_PLATFORM = 'x11';
    },
    problem: `environment.egl.EGL_PLATFORM is "x11", expected "${CAPTURE_EGL_ENV.EGL_PLATFORM}"`,
  },
  {
    label: 'a stale capture provenance container',
    drift: (manifest) => {
      const first = manifest.captures[0];
      if (first) {
        first.provenance.container = `mcr.microsoft.com/playwright:v9.9.9-noble@sha256:${'0'.repeat(64)}`;
      }
    },
    problem: 'provenance.container is',
  },
  {
    label: 'a non-container recapture command',
    drift: (manifest) => {
      const first = manifest.captures[0];
      if (first) first.command = 'echo fake';
    },
    problem: 'command is "echo fake"',
  },
];

/** Capture image references whose tag or digest drifted from the fixed pin. */
const IMAGE_DRIFT_CASES: Array<{ label: string; logLine: string; actual: string }> = [
  {
    label: 'tag',
    logLine: CONTAINER_LOG_LINE.replace(
      `:${PLAYWRIGHT_IMAGE_PIN.tag}@`,
      ':v9.9.9-noble@',
    ),
    actual: `${PLAYWRIGHT_IMAGE_REPOSITORY}:v9.9.9-noble@${PLAYWRIGHT_IMAGE_PIN.digest}`,
  },
  {
    label: 'digest',
    logLine: CONTAINER_LOG_LINE.replace(
      PLAYWRIGHT_IMAGE_PIN.digest,
      `sha256:${'0'.repeat(64)}`,
    ),
    actual: `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@sha256:${'0'.repeat(64)}`,
  },
];

/**
 * Log lines with a malformed field token or a malformed `env` / `fonts` /
 * `image` subfield. These are invalid input (exit 2), never environment drift
 * (exit 1) and never an uncaught TypeError from the parser.
 */
const MALFORMED_CAPTURE_ENV_FIELD_CASES: Array<{
  label: string;
  logLine: string;
  message: string;
}> = [
  {
    // Pins the token-level `key=value` guard, which runs before field lookup.
    label: 'a field token without "="',
    logLine: CONTAINER_LOG_LINE.replace('source=container', 'sourceX'),
    message: 'capture-env field "sourceX" is not key=value',
  },
  {
    // Pins the `equals === 0` half of the guard (an empty field key).
    label: 'a field token with an empty key',
    logLine: CONTAINER_LOG_LINE.replace('source=container', '=container'),
    message: 'capture-env field "=container" is not key=value',
  },
  {
    label: 'an EGL variable entry without "="',
    logLine: CONTAINER_LOG_LINE.replace('EGL_PLATFORM=surfaceless', 'BAD'),
    message: 'invalid capture-env variable entry "BAD"',
  },
  {
    // Pins the `equals === 0` half of the guard (an empty variable name).
    label: 'an EGL variable entry with an empty name',
    logLine: CONTAINER_LOG_LINE.replace('EGL_PLATFORM=surfaceless', '=value'),
    message: 'invalid capture-env variable entry "=value"',
  },
  {
    label: 'a font entry without "@"',
    logLine: CONTAINER_LOG_LINE.replace(`fonts=${EXPECTED_FONT_LIST}`, 'fonts=garbage'),
    message: 'invalid capture-env font entry "garbage"',
  },
  {
    // Pins the `at === entry.length - 1` half of the guard (empty version).
    label: 'a font entry with an empty version',
    logLine: CONTAINER_LOG_LINE.replace(
      `fonts=${EXPECTED_FONT_LIST}`,
      'fonts=fonts-liberation@',
    ),
    message: 'invalid capture-env font entry "fonts-liberation@"',
  },
  {
    // Pins the `at === 0` half of the guard (an empty package name).
    label: 'a font entry with an empty package name',
    logLine: CONTAINER_LOG_LINE.replace(
      `fonts=${EXPECTED_FONT_LIST}`,
      'fonts=@1.2',
    ),
    message: 'invalid capture-env font entry "@1.2"',
  },
  {
    label: 'a line without the platform field',
    logLine: CONTAINER_LOG_LINE.replace(' platform=linux/amd64', ''),
    message: 'capture-env line is missing "platform"',
  },
  {
    label: 'an image reference that is not repo:tag@digest',
    logLine: CONTAINER_LOG_LINE.replace(/image=\S+/, 'image=garbage'),
    message: 'invalid capture-env image reference "garbage"',
  },
];

/** A structurally mutated manifest, as an untyped JSON value. */
type MutatedManifest = Record<string, unknown>;

function withEnvironment(
  base: ScreenshotSha256Manifest,
  patch: Record<string, unknown>,
): MutatedManifest {
  return { ...base, environment: { ...base.environment, ...patch } };
}

function withFirstCapture(
  base: ScreenshotSha256Manifest,
  patch: (capture: ScreenshotSha256Capture) => Record<string, unknown>,
): MutatedManifest {
  const [first, ...rest] = base.captures;
  if (first === undefined) {
    throw new Error('the committed manifest has no captures');
  }
  return { ...base, captures: [{ ...first, ...patch(first) }, ...rest] };
}

/**
 * Structurally invalid manifests: each missing / malformed structural field is
 * invalid input (exit 2), never a valid empty manifest or an uncaught error.
 * These cases pin the structural field guards in `parseSha256Manifest`, so
 * deleting one of those guards makes a test fail instead of silently accepting
 * the manifest. Value-format guards (sha256 hex, plain file name, capture
 * commit, DPR, duplicate files, invalid JSON) stay pinned by the entry-level
 * tests below.
 */
const STRUCTURAL_INVALID_MANIFEST_CASES: Array<{
  label: string;
  message: string;
  build: (base: ScreenshotSha256Manifest) => unknown;
}> = [
  // The top-level document itself.
  {
    label: 'a top-level null manifest',
    message: 'top level must be an object',
    build: () => null,
  },
  {
    label: 'a top-level array manifest',
    message: 'top level must be an object',
    build: () => [],
  },
  // `captures`.
  {
    label: 'an empty captures list',
    message: '"captures" must be a non-empty array of screenshot entries',
    build: (base) => ({ ...base, captures: [] }),
  },
  {
    label: 'a non-array captures value',
    message: '"captures" must be a non-empty array of screenshot entries',
    build: (base) => ({ ...base, captures: {} }),
  },
  {
    label: 'a null capture entry',
    message: 'captures[0] must be an object',
    build: (base) => ({ ...base, captures: [null] }),
  },
  {
    label: 'a non-object capture entry',
    message: 'captures[0] must be an object',
    build: (base) => ({ ...base, captures: [['after-blank-webkit.png']] }),
  },
  {
    label: 'a primitive capture entry',
    message: 'captures[0] must be an object',
    build: (base) => ({ ...base, captures: ['after-blank-webkit.png'] }),
  },
  // `environment`.
  {
    label: 'a manifest without environment',
    message: '"environment" must be an object',
    build: (base) => {
      const copy: MutatedManifest = { ...base };
      delete copy.environment;
      return copy;
    },
  },
  {
    label: 'an environment that is null',
    message: '"environment" must be an object',
    build: (base) => ({ ...base, environment: null }),
  },
  {
    label: 'a missing environment source',
    message: 'environment.source must be a non-empty string',
    build: (base) => withEnvironment(base, { source: '' }),
  },
  {
    label: 'an unknown environment source',
    message: 'environment.source must be "container" or "host", got "desktop"',
    build: (base) => withEnvironment(base, { source: 'desktop' }),
  },
  {
    // The platform is recorded evidence: omitting it must reject the manifest
    // instead of silently verifying against a platform-less contract.
    label: 'a manifest without environment.platform',
    message: 'environment.platform must be a non-empty string',
    build: (base) => withEnvironment(base, { platform: undefined }),
  },
  {
    label: 'an environment.platform without an architecture',
    message:
      'environment.platform must be "<os>/<arch>" with an optional variant ' +
      '(for example "linux/amd64"), got "linux"',
    build: (base) => withEnvironment(base, { platform: 'linux' }),
  },
  {
    // `unavailable` is the host fingerprint marker, never a manifest platform.
    label: 'an unavailable environment.platform',
    message:
      'environment.platform must be "<os>/<arch>" with an optional variant ' +
      '(for example "linux/amd64"), got "unavailable"',
    build: (base) => withEnvironment(base, { platform: 'unavailable' }),
  },
  {
    label: 'a missing environment target',
    message: 'environment.target must be a non-empty string',
    build: (base) => withEnvironment(base, { target: '' }),
  },
  {
    label: 'a non-string environment target',
    message: 'environment.target must be a non-empty string',
    build: (base) => withEnvironment(base, { target: 42 }),
  },
  {
    label: 'a whitespace-only environment target',
    message: 'environment.target must be a non-empty string',
    build: (base) => withEnvironment(base, { target: '   ' }),
  },
  // `environment.image`.
  {
    label: 'an environment image that is null',
    message: 'environment.image must be an object',
    build: (base) => withEnvironment(base, { image: null }),
  },
  {
    label: 'a missing image repository',
    message: 'environment.image.repository must be a non-empty string',
    build: (base) =>
      withEnvironment(base, {
        image: { ...base.environment.image, repository: '' },
      }),
  },
  {
    label: 'a missing image tag',
    message: 'environment.image.tag must be a non-empty string',
    build: (base) =>
      withEnvironment(base, {
        image: { ...base.environment.image, tag: '' },
      }),
  },
  {
    label: 'a missing image digest',
    message: 'environment.image.digest must be a non-empty string',
    build: (base) =>
      withEnvironment(base, {
        image: { ...base.environment.image, digest: '' },
      }),
  },
  {
    label: 'a malformed image digest',
    message:
      'environment.image.digest must be "sha256:" plus 64 lower-case hex ' +
      'characters, got "sha256:nope"',
    build: (base) =>
      withEnvironment(base, {
        image: { ...base.environment.image, digest: 'sha256:nope' },
      }),
  },
  // `environment.egl`.
  {
    label: 'an environment egl that is null',
    message: 'environment.egl must be an object',
    build: (base) => withEnvironment(base, { egl: null }),
  },
  {
    label: 'an empty EGL variable',
    message: 'environment.egl.EGL_PLATFORM must be a non-empty string',
    build: (base) =>
      withEnvironment(base, {
        egl: { ...base.environment.egl, EGL_PLATFORM: '' },
      }),
  },
  {
    label: 'a non-string EGL variable',
    message: 'environment.egl.EGL_PLATFORM must be a non-empty string',
    build: (base) =>
      withEnvironment(base, {
        egl: { ...base.environment.egl, EGL_PLATFORM: 7 },
      }),
  },
  {
    label: 'an EGL environment missing a fixed variable',
    message: `environment.egl is missing one of ${CAPTURE_EGL_VARS.join(', ')}`,
    build: (base) => {
      const egl = { ...base.environment.egl };
      delete egl.EGL_PLATFORM;
      return withEnvironment(base, { egl });
    },
  },
  // `environment.fonts`.
  {
    label: 'an empty font package list',
    message: 'environment.fonts must be a non-empty array of font packages',
    build: (base) => withEnvironment(base, { fonts: [] }),
  },
  {
    label: 'a non-array font package list',
    message: 'environment.fonts must be a non-empty array of font packages',
    build: (base) => withEnvironment(base, { fonts: {} }),
  },
  {
    label: 'a non-object font entry',
    message: 'environment.fonts[0] must be an object',
    build: (base) => withEnvironment(base, { fonts: [null] }),
  },
  {
    label: 'a font entry without a name',
    message: 'environment.fonts[0].name must be a non-empty string',
    build: (base) =>
      withEnvironment(base, {
        fonts: base.environment.fonts.map((font, index) =>
          index === 0 ? { ...font, name: '' } : font,
        ),
      }),
  },
  {
    label: 'a font entry without a version',
    message: 'environment.fonts[0].version must be a non-empty string',
    build: (base) =>
      withEnvironment(base, {
        fonts: base.environment.fonts.map((font, index) =>
          index === 0 ? { ...font, version: '' } : font,
        ),
      }),
  },
  {
    label: 'a duplicate font package',
    message: 'duplicate font package "fonts-freefont-ttf"',
    build: (base) => {
      const [first] = base.environment.fonts;
      if (first === undefined) {
        throw new Error('the committed manifest has no fonts');
      }
      return withEnvironment(base, {
        fonts: [...base.environment.fonts, { ...first }],
      });
    },
  },
  // Per-capture fields.
  {
    label: 'a capture without a file name',
    message: 'captures[0].file must be a non-empty string',
    build: (base) => withFirstCapture(base, () => ({ file: '' })),
  },
  {
    label: 'a capture file without the .png suffix',
    message: 'captures[0].file must be a .png file name, got "after-blank-webkit.jpg"',
    build: (base) =>
      withFirstCapture(base, () => ({ file: 'after-blank-webkit.jpg' })),
  },
  {
    label: 'a capture file with a backslash separator',
    message:
      'captures[0].file must be a plain file name below the screenshot directory, ' +
      'got "nested\\after-blank-webkit.png"',
    build: (base) =>
      withFirstCapture(base, () => ({ file: 'nested\\after-blank-webkit.png' })),
  },
  {
    label: 'a Unicode-normalized duplicate capture file',
    message: 'duplicate capture file "café.png"',
    build: (base) => {
      const [first] = base.captures;
      if (first === undefined) {
        throw new Error('the committed manifest has no captures');
      }
      return {
        ...base,
        captures: [
          { ...first, file: 'cafe\u0301.png' },
          { ...first, file: 'café.png' },
        ],
      };
    },
  },
  {
    label: 'a capture without a sha256',
    message: 'captures[0].sha256 must be a non-empty string',
    build: (base) => withFirstCapture(base, () => ({ sha256: '' })),
  },
  {
    label: 'a capture without a recapture command',
    message: 'captures[0].command must be a non-empty string',
    build: (base) => withFirstCapture(base, () => ({ command: '' })),
  },
  // `provenance`.
  {
    label: 'a capture without a provenance object',
    message: 'captures[0].provenance must be an object',
    build: (base) => ({
      ...base,
      captures: base.captures.map((capture) => {
        const copy: MutatedManifest = { ...capture };
        delete copy.provenance;
        return copy;
      }),
    }),
  },
  {
    label: 'a capture without a provenance container',
    message: 'captures[0].provenance.container must be a non-empty string',
    build: (base) =>
      withFirstCapture(base, (capture) => ({
        provenance: { ...capture.provenance, container: '' },
      })),
  },
  {
    label: 'a malformed provenance container',
    message:
      'captures[0].provenance.container must be ' +
      '"<repository>:<tag>@sha256:<digest>", got "not-a-ref"',
    build: (base) =>
      withFirstCapture(base, (capture) => ({
        provenance: { ...capture.provenance, container: 'not-a-ref' },
      })),
  },
  {
    label: 'a capture without a provenance commit',
    message: 'captures[0].provenance.captureCommit must be a non-empty string',
    build: (base) =>
      withFirstCapture(base, (capture) => ({
        provenance: { ...capture.provenance, captureCommit: '' },
      })),
  },
];

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'screenshot-sha256-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** Build a minimal valid 1x1 RGBA PNG. */
function makePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(5))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function committedManifest(): ScreenshotSha256Manifest {
  return parseSha256Manifest(MANIFEST_TEXT, { source: MANIFEST });
}

/** A one-entry manifest whose environment and command match the fixed contract. */
function fixtureManifest(bytes: Buffer): ScreenshotSha256Manifest {
  const manifest = committedManifest();
  return {
    environment: manifest.environment,
    captures: [
      {
        file: EXPECTED_FILES[0] as string,
        sha256: sha256(bytes),
        command: 'npm run screenshots:container -- screenshots:webkit',
        provenance: manifest.captures[0]?.provenance ?? {
          container: `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
          captureCommit: 'f5b87c05b3c55694c3605530de4bcf8e20097a80',
        },
      },
    ],
  };
}

function writeManifest(
  dir: string,
  manifest: unknown,
  name = 'manifest.json',
): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function writePng(dir: string, file: string, bytes: Buffer): void {
  writeFileSync(join(dir, file), bytes);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`,
  };
}

describe('capture sha256 manifest', () => {
  it('lists exactly the five fixed-environment WebKit captures with committed hashes', () => {
    const manifest = committedManifest();
    expect(manifest.captures.map((capture) => capture.file)).toEqual(EXPECTED_FILES);

    for (const capture of manifest.captures) {
      const filePath = join(SCREENSHOT_DIR, capture.file);
      expect(existsSync(filePath), `missing committed ${capture.file}`).toBe(true);
      expect(capture.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(readFileSync(filePath))).toBe(capture.sha256);
      expect(capture.command).toBe(
        `npm run screenshots:container -- ${
          capture.file.startsWith('after-2048')
            ? 'screenshots:2048:webkit'
            : capture.file.startsWith('after-breakout')
              ? 'screenshots:breakout:webkit'
              : capture.file.startsWith('after-minesweeper-scores-')
                ? 'screenshots:minesweeper:scores:webkit'
                : 'screenshots:webkit'
        }`,
      );
      expect(capture.provenance.container).toBe(
        `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
      );
      expect(capture.provenance.captureCommit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('keeps the image tag / digest, platform, EGL variables and webkit DPR aligned with t1 constants', () => {
    const manifest = committedManifest();

    expect(manifestEnvironmentMismatches(manifest)).toEqual([]);
    expect(manifestPlatformMismatch(manifest)).toBeNull();
    expect(manifest.environment.source).toBe('container');
    expect(manifest.environment.target).toBe('webkit');
    expect(manifest.environment.dpr).toBe(2);
    expect(manifest.environment.dpr).toBe(CAPTURE_TARGET_DPRS['webkit']);
    expect(manifest.environment.platform).toBe(CAPTURE_PLATFORM);
    expect(manifest.environment.platform).toBe('linux/amd64');
    expect(manifest.environment.image).toEqual({
      repository: PLAYWRIGHT_IMAGE_REPOSITORY,
      tag: PLAYWRIGHT_IMAGE_PIN.tag,
      digest: PLAYWRIGHT_IMAGE_PIN.digest,
    });
    expect(manifest.environment.egl).toEqual(CAPTURE_EGL_ENV);
    expect(manifest.environment.fonts.map((font) => font.name)).toEqual([
      ...CAPTURE_FONT_PACKAGES,
    ]);
    expect(manifest.environment.fonts).toEqual(EXPECTED_FONT_VERSIONS);
  });

  it('accepts the fractional DPR of a mobile-touch manifest environment', () => {
    const manifest = committedManifest();
    manifest.environment.target = 'mobile-touch';
    manifest.environment.dpr = CAPTURE_TARGET_DPRS['mobile-touch'] as number;

    const parsed = parseSha256Manifest(JSON.stringify(manifest));

    expect(parsed.environment.dpr).toBe(2.625);
    expect(manifestEnvironmentMismatches(parsed)).toEqual([]);
  });

  it('keeps the documented container fingerprint sample aligned with the fixed environment', () => {
    const readme = readFileSync(
      join(ROOT, 'docs', 'screenshots', 'README.md'),
      'utf8',
    );
    const documentedLine = readme
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(
        (entry) => entry.startsWith('capture-env:') && entry.includes('source=container'),
      );
    expect(documentedLine, 'README lacks a container capture-env sample').toBeDefined();

    const fingerprint = parseCaptureEnvironmentFingerprintLine(
      documentedLine as string,
    );
    const manifest = committedManifest();
    // The README sample may demonstrate another fixed target (for example the
    // Pixel 7 touch context, DPR 2.625), so compare the shared environment and
    // require the sample's DPR to match its declared target.
    expect(Object.keys(CAPTURE_TARGET_DPRS)).toContain(fingerprint.target);
    expect(fingerprint.dpr).toBe(CAPTURE_TARGET_DPRS[fingerprint.target]);
    expect(fingerprint.source).toBe(manifest.environment.source);
    expect(fingerprint.platform).toBe(CAPTURE_PLATFORM);
    expect(fingerprint.platform).toBe(manifest.environment.platform);
    expect(fingerprint.image).toEqual(manifest.environment.image);
    expect(fingerprint.env).toEqual(manifest.environment.egl);
    expect(fingerprint.fonts).toEqual(manifest.environment.fonts);
  });

  it('detects image, EGL, DPR and font drift against the fixed contract', () => {
    const manifest = committedManifest();

    manifest.environment.image.digest = `sha256:${'0'.repeat(64)}`;
    manifest.environment.dpr = 1;
    manifest.environment.egl.EGL_PLATFORM = 'x11';
    manifest.environment.egl.EXTRA_EGL_VAR = '1';
    manifest.environment.fonts[0] = { name: 'fonts-extra', version: '1.0' };

    const problems = manifestEnvironmentMismatches(manifest);
    expect(problems.some((problem) => problem.includes('image.digest'))).toBe(true);
    expect(problems.some((problem) => problem.includes('environment.dpr'))).toBe(true);
    // Exact message while an unexpected variable is present as well; the
    // dedicated drift case below pins the value comparison on its own.
    expect(problems).toContain(
      `environment.egl.EGL_PLATFORM is "x11", expected "${CAPTURE_EGL_ENV.EGL_PLATFORM}"`,
    );
    expect(problems.some((problem) => problem.includes('unexpected variable'))).toBe(true);
    expect(problems.some((problem) => problem.includes('environment.fonts'))).toBe(true);
  });

  it('compares the manifest platform against the fixed capture contract', () => {
    const manifest = committedManifest();
    manifest.environment.platform = 'linux/arm64';

    expect(manifestEnvironmentMismatches(manifest)).toContain(
      'environment.platform is "linux/arm64", expected "linux/amd64"',
    );
    expect(manifestPlatformMismatch(manifest)).toEqual({
      source: 'manifest',
      expected: 'linux/amd64',
      actual: 'linux/arm64',
      image: manifest.environment.image,
      message: 'environment.platform is "linux/arm64", expected "linux/amd64"',
    });
  });

  it('accepts a platform variant and still reports it as a platform difference', () => {
    const manifest = committedManifest();
    manifest.environment.platform = 'linux/arm64/v8';
    const parsed = parseSha256Manifest(JSON.stringify(manifest));

    expect(parsed.environment.platform).toBe('linux/arm64/v8');
    expect(manifestPlatformMismatch(parsed)?.actual).toBe('linux/arm64/v8');
  });

  it.each(MANIFEST_ENVIRONMENT_DRIFT_CASES)(
    'rejects $label in the manifest and exits 2 through the CLI',
    ({ drift, problem }) => {
      const manifest = committedManifest();
      drift(manifest);
      expect(
        manifestEnvironmentMismatches(manifest).some((entry) =>
          entry.includes(problem),
        ),
      ).toBe(true);

      const dir = makeTempDir();
      const bytes = makePng();
      writePng(dir, EXPECTED_FILES[0] as string, bytes);
      const result = runCli([
        '--dir',
        dir,
        '--manifest',
        writeManifest(dir, manifest),
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('does not match the fixed capture environment');
      expect(result.stderr).toContain(problem);
    },
  );

  it('requires the exact per-file recapture command', () => {
    const manifest = committedManifest();
    if (manifest.captures[0]) {
      manifest.captures[0].provenance.container = `mcr.microsoft.com/playwright:v9.9.9-noble@sha256:${'0'.repeat(64)}`;
    }
    const problems = manifestEnvironmentMismatches(manifest);
    expect(
      problems.some((problem) => problem.includes('provenance.container')),
    ).toBe(true);

    for (const command of [
      'npm run screenshots:container -- screenshots',
      'npm run screenshots:container -- screenshots:webkit; rm -rf /tmp/x',
      'npm run screenshots:container -- screenshots:2048:webkit',
    ]) {
      const mutated = committedManifest();
      const first = mutated.captures[0];
      if (first) first.command = command;
      expect(
        manifestEnvironmentMismatches(mutated).some((problem) =>
          problem.includes('command is'),
        ),
        command,
      ).toBe(true);
    }

    expect(expectedRecaptureCommand('after-blank-webkit.png')).toBe(
      'npm run screenshots:container -- screenshots:webkit',
    );
    expect(expectedRecaptureCommand('after-2048-ready-webkit.png')).toBe(
      'npm run screenshots:container -- screenshots:2048:webkit',
    );
    expect(expectedRecaptureCommand('after-breakout-playing-webkit.png')).toBe(
      'npm run screenshots:container -- screenshots:breakout:webkit',
    );
    expect(expectedRecaptureCommand('after-minesweeper-scores-webkit.png')).toBe(
      'npm run screenshots:container -- screenshots:minesweeper:scores:webkit',
    );
  });

  it('rejects invalid entries, duplicate files and non-64-hex sha256', () => {
    const base = committedManifest();
    const clone = (): ScreenshotSha256Manifest => JSON.parse(JSON.stringify(base));

    const withBlankFile = clone();
    if (withBlankFile.captures[0]) withBlankFile.captures[0].file = '';
    expect(() => parseSha256Manifest(JSON.stringify(withBlankFile))).toThrow(
      ScreenshotSha256Error,
    );

    const withPath = clone();
    if (withPath.captures[0]) withPath.captures[0].file = 'nested/after-blank-webkit.png';
    expect(() => parseSha256Manifest(JSON.stringify(withPath))).toThrow(/plain file name/);

    const withControlChar = clone();
    if (withControlChar.captures[0]) {
      withControlChar.captures[0].file = 'after-blank-webkit.png\u0000.png';
    }
    expect(() => parseSha256Manifest(JSON.stringify(withControlChar))).toThrow(
      /plain file name/,
    );

    const duplicate = clone();
    const first = duplicate.captures[0];
    if (first) duplicate.captures.push({ ...first });
    expect(() => parseSha256Manifest(JSON.stringify(duplicate))).toThrow(
      /duplicate capture file/,
    );

    // Case aliases resolve to the same file on case-insensitive filesystems.
    const caseAlias = clone();
    const caseFirst = caseAlias.captures[0];
    if (caseFirst) {
      caseAlias.captures.push({ ...caseFirst, file: 'AFTER-BLANK-WEBKIT.png' });
    }
    expect(() => parseSha256Manifest(JSON.stringify(caseAlias))).toThrow(
      /duplicate capture file/,
    );

    for (const badHash of ['abc', 'A'.repeat(64), 'g'.repeat(64)]) {
      const invalid = clone();
      if (invalid.captures[0]) invalid.captures[0].sha256 = badHash;
      expect(() => parseSha256Manifest(JSON.stringify(invalid))).toThrow(
        /64 lower-case hex/,
      );
    }

    const invalidCommit = clone();
    if (invalidCommit.captures[0]) {
      invalidCommit.captures[0].provenance.captureCommit = 'not-a-commit';
    }
    expect(() => parseSha256Manifest(JSON.stringify(invalidCommit))).toThrow(
      /captureCommit/,
    );

    // The environment DPR was relaxed from an integer to a positive number for
    // fractional targets, but every non-number / non-positive value is still
    // invalid input. JSON has no Infinity, so `1e400` parses to Infinity and is
    // covered through a raw manifest edit below.
    for (const badDpr of [0, -1, '2', null]) {
      const invalid = clone();
      invalid.environment.dpr = badDpr as number;
      expect(
        () => parseSha256Manifest(JSON.stringify(invalid)),
        String(badDpr),
      ).toThrow(/environment.dpr/);
    }
    expect(() =>
      parseSha256Manifest(MANIFEST_TEXT.replace('"dpr": 2', '"dpr": 1e400')),
    ).toThrow(/environment.dpr/);

    expect(() => parseSha256Manifest('{not json}')).toThrow(/not valid JSON/);
  });

  it.each(STRUCTURAL_INVALID_MANIFEST_CASES)(
    'rejects $label as invalid manifest input and exits 2 through the CLI',
    ({ message, build }) => {
      const invalidText = JSON.stringify(build(committedManifest()));

      expect(() => parseSha256Manifest(invalidText)).toThrow(ScreenshotSha256Error);
      expect(() => parseSha256Manifest(invalidText)).toThrow(message);

      const dir = makeTempDir();
      const manifestPath = join(dir, 'invalid-manifest.json');
      writeFileSync(manifestPath, invalidText);
      const result = runCli(['--manifest', manifestPath]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('error: invalid sha256 manifest:');
      expect(result.stderr).toContain(message);
      // A rejected manifest must be reported as invalid input, not as an
      // uncaught TypeError whose stack trace exits 1.
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toMatch(/^\s+at /m);
    },
  );
});

describe('capture environment fingerprint', () => {
  it('parses the fixed container platform and the host unavailable marker', () => {
    expect(parseCaptureEnvironmentFingerprintLine(CONTAINER_LOG_LINE).platform).toBe(
      CAPTURE_PLATFORM,
    );
    expect(parseCaptureEnvironmentFingerprintLine(HOST_LOG_LINE).platform).toBe(
      'unavailable',
    );
  });

  it('reports a container platform drift against the fixed contract', () => {
    const manifest = committedManifest();
    const drifted = CONTAINER_LOG_LINE.replace(
      'platform=linux/amd64',
      'platform=linux/arm64',
    );
    const verification = verifyCaptureEnvironment({
      logText: `${drifted}\n`,
      environment: manifest.environment,
    });

    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain(
      'capture environment platform is "linux/arm64", expected "linux/amd64"',
    );
    expect(verification.platformMismatches).toEqual([
      {
        source: 'log',
        expected: 'linux/amd64',
        actual: 'linux/arm64',
        image: manifest.environment.image,
        actualImage: manifest.environment.image,
        message: 'capture environment platform is "linux/arm64", expected "linux/amd64"',
      },
    ]);
  });

  it('compares the log platform with the manifest platform, not the global constant', () => {
    const manifest = committedManifest();
    manifest.environment.platform = 'linux/arm64';
    const verification = verifyCaptureEnvironment({
      logText: `${CONTAINER_LOG_LINE.replace(
        'platform=linux/amd64',
        'platform=linux/arm64',
      )}\n`,
      environment: manifest.environment,
    });

    expect(verification.platformMismatches).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  it('verifies the container image, EGL variables, DPR and recorded fonts', () => {
    const manifest = committedManifest();
    const verification = verifyCaptureEnvironment({
      logText: `${CONTAINER_LOG_LINE}\n`,
      environment: manifest.environment,
    });

    expect(verification.checked).toBe(true);
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.fingerprints).toHaveLength(1);
  });

  it('selects the webkit fingerprint from a multi-target capture log', () => {
    const manifest = committedManifest();
    const desktopLine = CONTAINER_LOG_LINE.replaceAll(
      'target=webkit dpr=2',
      'target=desktop dpr=1',
    );
    const logText = `${desktopLine}\n${CONTAINER_LOG_LINE}\n`;
    const fingerprints = parseCaptureLogFingerprints(logText);
    expect(fingerprints.map((entry) => entry.target)).toEqual(['desktop', 'webkit']);

    const verification = verifyCaptureEnvironment({
      logText,
      environment: manifest.environment,
    });
    expect(verification.ok).toBe(true);
    expect(verification.fingerprints).toHaveLength(1);
    expect(verification.fingerprints[0]?.target).toBe('webkit');
  });

  it('verifies every webkit fingerprint line in a multi-run log', () => {
    const manifest = committedManifest();
    const driftedSecond = CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=1');
    const verification = verifyCaptureEnvironment({
      logText: `${CONTAINER_LOG_LINE}\n${driftedSecond}\n`,
      environment: manifest.environment,
    });

    expect(verification.fingerprints).toHaveLength(2);
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('dpr'))).toBe(true);
  });

  it('treats the runtime unavailable fallback as an unavailable environment', () => {
    const manifest = committedManifest();
    const verification = verifyCaptureEnvironment({
      logText: 'capture-env: unavailable (fonts probe failed)\n',
      environment: manifest.environment,
    });

    expect(verification.checked).toBe(true);
    expect(verification.invalid).toBe(false);
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain(
      'capture environment fingerprint is unavailable (the capture runtime could not probe it)',
    );
  });

  it('rejects malformed capture-env fields as invalid input', () => {
    const manifest = committedManifest();
    const malformed = [
      `${CONTAINER_LOG_LINE} source=container`,
      `${CONTAINER_LOG_LINE} extra=1`,
      CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=2.0'),
      CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=+2'),
      CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=2.'),
      CONTAINER_LOG_LINE.replace(' playwright=1.64.1', ''),
    ];

    for (const logText of malformed) {
      const verification = verifyCaptureEnvironment({
        logText: `${logText}\n`,
        environment: manifest.environment,
      });
      expect(verification.invalid, logText).toBe(true);
      expect(verification.problems.length, logText).toBeGreaterThan(0);
    }
  });

  it.each(MALFORMED_CAPTURE_ENV_FIELD_CASES)(
    'rejects $label as invalid capture-env input and exits 2 through the CLI',
    ({ logLine, message }) => {
      const manifest = committedManifest();

      // The library classifies the line as malformed input, not drift.
      const verification = verifyCaptureEnvironment({
        logText: `${logLine}\n`,
        environment: manifest.environment,
      });
      expect(verification.invalid).toBe(true);
      expect(verification.ok).toBe(false);
      expect(verification.problems).toEqual([message]);

      // The parser itself throws the documented error type, not a TypeError.
      expect(() => parseCaptureEnvironmentFingerprintLine(logLine)).toThrow(
        ScreenshotSha256Error,
      );
      expect(() => parseCaptureEnvironmentFingerprintLine(logLine)).toThrow(message);

      // Through the CLI this is invalid input: exit 2 with a readable message.
      const dir = makeTempDir();
      const bytes = makePng();
      writePng(dir, EXPECTED_FILES[0] as string, bytes);
      const manifestPath = writeManifest(dir, fixtureManifest(bytes));
      const logPath = join(dir, 'capture.log');
      writeFileSync(logPath, `${logLine}\n`);
      const result = runCli([
        '--dir',
        dir,
        '--manifest',
        manifestPath,
        '--log',
        logPath,
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid capture log');
      expect(result.stderr).toContain(message);
      // The image parser's TypeError message would not contain "TypeError", so
      // also reject its actual wording.
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Cannot read properties of undefined');
    },
  );

  it('accepts the fractional DPR used by the mobile-touch target', () => {
    const fingerprint = parseCaptureEnvironmentFingerprintLine(
      CONTAINER_LOG_LINE.replace('target=webkit dpr=2', 'target=mobile-touch dpr=2.625'),
    );

    expect(fingerprint.target).toBe('mobile-touch');
    expect(fingerprint.dpr).toBe(CAPTURE_TARGET_DPRS['mobile-touch']);
  });

  it('reports environment drift separately from the hash check', () => {
    const manifest = committedManifest();
    const drifted = CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=1').replace(
      'EGL_PLATFORM=surfaceless',
      'EGL_PLATFORM=x11',
    );
    const verification = verifyCaptureEnvironment({
      logText: `${drifted}\n`,
      environment: manifest.environment,
    });

    expect(verification.ok).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('dpr'))).toBe(true);
    expect(
      verification.problems.some((problem) => problem.includes('EGL_PLATFORM')),
    ).toBe(true);
  });

  it('reports a missing fingerprint line instead of silently passing', () => {
    const manifest = committedManifest();
    const verification = verifyCaptureEnvironment({
      logText: 'some unrelated capture log output\n',
      environment: manifest.environment,
    });

    expect(verification.checked).toBe(true);
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain(
      'capture log has no "capture-env:" fingerprint line',
    );
  });

  it('reports a log whose only fingerprint is for another target', () => {
    const manifest = committedManifest();
    const desktopLine = CONTAINER_LOG_LINE.replaceAll(
      'target=webkit dpr=2',
      'target=desktop dpr=1',
    );
    const verification = verifyCaptureEnvironment({
      logText: `${desktopLine}\n`,
      environment: manifest.environment,
    });

    expect(verification.ok).toBe(false);
    expect(verification.fingerprints).toEqual([]);
    expect(verification.problems).toContain(
      'capture log has no fingerprint for target "webkit" (logged targets: desktop)',
    );
  });

  it('reports host fingerprints as a container environment mismatch', () => {
    const manifest = committedManifest();
    const verification = verifyCaptureEnvironment({
      logText: `${HOST_LOG_LINE}\n`,
      environment: manifest.environment,
    });

    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain(
      'capture environment source is "host", expected "container"',
    );
    expect(verification.problems).toContain(
      'capture environment image is unavailable, expected the pinned container image',
    );
    expect(verification.problems).toContain(
      'capture environment EGL variables are unavailable',
    );
    expect(verification.problems).toContain(
      `capture environment fonts are "unavailable", expected "${EXPECTED_FONT_LIST}"`,
    );
  });

  it.each(IMAGE_DRIFT_CASES)('reports a drifted capture image $label', ({ logLine, actual }) => {
    const manifest = committedManifest();
    const verification = verifyCaptureEnvironment({
      logText: `${logLine}\n`,
      environment: manifest.environment,
    });

    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain(
      `capture environment image is "${actual}", ` +
        `expected "${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}"`,
    );
  });

  it('reports a drifted font package version', () => {
    const firstFont = EXPECTED_FONT_VERSIONS[0] as { name: string; version: string };
    const driftedFont = `${firstFont.name}@${firstFont.version}-drift`;
    const driftedLine = CONTAINER_LOG_LINE.replace(
      `${firstFont.name}@${firstFont.version}`,
      driftedFont,
    );
    const manifest = committedManifest();
    const verification = verifyCaptureEnvironment({
      logText: `${driftedLine}\n`,
      environment: manifest.environment,
    });

    const actualFonts = EXPECTED_FONT_LIST.replace(
      `${firstFont.name}@${firstFont.version}`,
      driftedFont,
    );
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain(
      `capture environment fonts are "${actualFonts}", expected "${EXPECTED_FONT_LIST}"`,
    );
  });
});

describe('verifyScreenshotSha256', () => {
  it('exits 0 when every file matches and the log environment matches', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));

    writeFileSync(join(dir, 'capture.log'), `${CONTAINER_LOG_LINE}\n`);
    const verified = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      join(dir, 'capture.log'),
    ]);

    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain('OK: 1 screenshot sha256 entries verified');
    expect(verified.stdout).toContain('capture environment fingerprint verified');
  });

  it('verifies a temporary directory without a capture log', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));

    const result = runCli(['--dir', dir, '--manifest', manifestPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: 1 screenshot sha256 entries verified');
    expect(result.stdout).not.toContain('environment');
  });

  it('exits 1 and names the expected / actual hash and recapture command on drift', () => {
    const dir = makeTempDir();
    const expected = makePng();
    const actual = Buffer.concat([makePng(), Buffer.from('drift')]);
    writePng(dir, EXPECTED_FILES[0] as string, actual);
    const manifestPath = writeManifest(dir, fixtureManifest(expected));

    const result = runCli(['--dir', dir, '--manifest', manifestPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`expected sha256: ${sha256(expected)}`);
    expect(result.stderr).toContain(`actual sha256:   ${sha256(actual)}`);
    expect(result.stderr).toContain(
      'recapture in fixed container: npm run screenshots:container -- screenshots:webkit',
    );
    expect(result.stderr).toContain('Actual capture environment:');
    expect(result.stderr).toContain('unavailable (no --log supplied)');
  });

  it('exits 1 and reports a missing file', () => {
    const dir = makeTempDir();
    const manifestPath = writeManifest(dir, fixtureManifest(makePng()));

    const result = runCli(['--dir', dir, '--manifest', manifestPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing file:');
    expect(result.stderr).toContain('actual sha256:   unavailable');
    expect(result.stderr).toContain(
      'recapture in fixed container: npm run screenshots:container -- screenshots:webkit',
    );
  });

  it('keeps environment drift separate from a matching hash', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));
    const logPath = join(dir, 'capture.log');
    writeFileSync(logPath, `${CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=1')}\n`);

    const result = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      logPath,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Environment fingerprint mismatch');
    expect(result.stderr).toContain('dpr');
    expect(result.stderr).not.toContain('screenshot sha256 problem');
    expect(result.stderr).toContain('committed PNG hashes still match the manifest');
    expect(result.stderr).toContain('Recapture in the fixed container');
    expect(result.stderr).toContain(
      'npm run screenshots:container -- screenshots:webkit',
    );
    expect(result.stderr).toContain(CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=1'));
  });

  it('exits 1 for a manifest platform drift even though every PNG hash matches', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifest = fixtureManifest(bytes);
    manifest.environment.platform = 'linux/arm64';
    const manifestPath = writeManifest(dir, manifest);

    // The committed bytes still hash to the manifest value; only the platform
    // the evidence was captured on is outside the fixed contract.
    expect(verifyScreenshotSha256({ dir, manifest }).hashProblems).toEqual([]);

    const result = runCli(['--dir', dir, '--manifest', manifestPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Platform mismatch (1)');
    expect(result.stderr).toContain('source:            sha256 manifest');
    expect(result.stderr).toContain('expected platform: linux/amd64');
    expect(result.stderr).toContain('actual platform:   linux/arm64');
    expect(result.stderr).toContain(
      `expected image:    ${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
    );
    expect(result.stderr).toContain(
      'after-blank-webkit.png: npm run screenshots:container -- screenshots:webkit',
    );
    expect(result.stderr).not.toContain('does not match the fixed capture environment');
  });

  it('reports a log platform drift as its own section and exits 1', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));
    const logPath = join(dir, 'capture.log');
    writeFileSync(
      logPath,
      `${CONTAINER_LOG_LINE.replace('platform=linux/amd64', 'platform=linux/arm64')}\n`,
    );

    const result = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      logPath,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Platform mismatch (1)');
    expect(result.stderr).toContain('source:            capture log fingerprint');
    expect(result.stderr).toContain('expected platform: linux/amd64');
    expect(result.stderr).toContain('actual platform:   linux/arm64');
    expect(result.stderr).toContain(
      `expected image:    ${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
    );
    expect(result.stderr).toContain(
      'after-blank-webkit.png: npm run screenshots:container -- screenshots:webkit',
    );
    // Platform drift is not repeated in the generic environment block.
    expect(result.stderr).not.toContain('Environment fingerprint mismatch');
    expect(result.stderr).toContain('committed PNG hashes still match the manifest');
  });

  it('exits 1 and reports hash drift together with environment drift', () => {
    const dir = makeTempDir();
    const expected = makePng();
    const actual = Buffer.concat([makePng(), Buffer.from('drift')]);
    writePng(dir, EXPECTED_FILES[0] as string, actual);
    const manifestPath = writeManifest(dir, fixtureManifest(expected));
    const logPath = join(dir, 'capture.log');
    writeFileSync(logPath, `${CONTAINER_LOG_LINE.replace('dpr=2', 'dpr=1')}\n`);

    const result = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      logPath,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('screenshot sha256 problem');
    expect(result.stderr).toContain(`expected sha256: ${sha256(expected)}`);
    expect(result.stderr).toContain(`actual sha256:   ${sha256(actual)}`);
    expect(result.stderr).toContain('Environment fingerprint mismatch');
    expect(result.stderr).toContain('dpr');
    expect(result.stderr).not.toContain('committed PNG hashes still match');
  });

  it('exits 1 when the log has no fingerprint for the manifest target', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));
    const logPath = join(dir, 'capture.log');
    const desktopLine = CONTAINER_LOG_LINE.replaceAll(
      'target=webkit dpr=2',
      'target=desktop dpr=1',
    );
    writeFileSync(logPath, `${desktopLine}\n`);

    const result = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      logPath,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Environment fingerprint mismatch');
    expect(result.stderr).toContain(
      'capture log has no fingerprint for target "webkit"',
    );
    expect(result.stderr).toContain('logged targets: desktop');
    expect(result.stderr).toContain('committed PNG hashes still match the manifest');
  });

  it('exits 1 and explains a host capture log against the container contract', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));
    const logPath = join(dir, 'capture.log');
    writeFileSync(logPath, `${HOST_LOG_LINE}\n`);

    const result = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      logPath,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Environment fingerprint mismatch');
    expect(result.stderr).toContain(
      'capture environment source is "host", expected "container"',
    );
    expect(result.stderr).toContain('capture environment image is unavailable');
    expect(result.stderr).toContain(
      'capture environment EGL variables are unavailable',
    );
    expect(result.stderr).toContain('capture environment fonts are "unavailable"');
    expect(result.stderr).toContain('committed PNG hashes still match the manifest');
  });

  it('exits 2 for a malformed capture-env log instead of reporting drift', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));
    const logPath = join(dir, 'capture.log');
    writeFileSync(
      logPath,
      'capture-env: source=container target=webkit dpr=2 platform=linux/amd64\n',
    );

    const result = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      logPath,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid capture log');
    expect(result.stderr).toContain('missing "image"');
  });

  it('returns readable problems from the library for a hash mismatch', () => {
    const dir = makeTempDir();
    const expected = makePng();
    const actual = Buffer.concat([makePng(), Buffer.from('drift')]);
    writePng(dir, EXPECTED_FILES[0] as string, actual);
    const manifest = fixtureManifest(expected);

    const result = verifyScreenshotSha256({ dir, manifest });
    expect(result.entries).toBe(1);
    expect(result.hashProblems).toEqual([
      {
        file: EXPECTED_FILES[0],
        expected: sha256(expected),
        actual: sha256(actual),
        message: `${join(dir, EXPECTED_FILES[0] as string)}: sha256 mismatch`,
      },
    ]);
    expect(result.environment.checked).toBe(false);
  });

  it('exits 2 for an invalid manifest, duplicate files or a bad sha256', () => {
    const dir = makeTempDir();
    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifest = fixtureManifest(bytes);

    const duplicate = JSON.parse(JSON.stringify(manifest)) as ScreenshotSha256Manifest;
    const first = duplicate.captures[0];
    if (first) duplicate.captures.push({ ...first });

    const badHash = JSON.parse(JSON.stringify(manifest)) as ScreenshotSha256Manifest;
    if (badHash.captures[0]) badHash.captures[0].sha256 = 'not-a-hash';

    const invalidJson = join(dir, 'invalid.json');
    writeFileSync(invalidJson, '{not json}');

    for (const manifestPath of [
      writeManifest(dir, duplicate, 'duplicate.json'),
      writeManifest(dir, badHash, 'bad-hash.json'),
      invalidJson,
    ]) {
      const result = runCli(['--dir', dir, '--manifest', manifestPath]);
      expect(result.status, manifestPath).toBe(2);
    }

    const unknownOption = runCli(['--unknown']);
    expect(unknownOption.status).toBe(2);
    expect(unknownOption.stderr).toContain('unknown option');

    const driftedEnvironment = JSON.parse(
      JSON.stringify(manifest),
    ) as ScreenshotSha256Manifest;
    driftedEnvironment.environment.image.digest = `sha256:${'0'.repeat(64)}`;
    const driftedResult = runCli([
      '--dir',
      dir,
      '--manifest',
      writeManifest(dir, driftedEnvironment),
    ]);
    expect(driftedResult.status).toBe(2);
    expect(driftedResult.stderr).toContain(
      'does not match the fixed capture environment',
    );
    expect(driftedResult.stderr).toContain(
      'hint: update docs/screenshots/README.md',
    );
  });

  it('returns the documented exit codes for help, usage errors and unreadable inputs', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/verify-screenshot-sha256.mjs');
    expect(help.stderr).toBe('');

    const missingDirValue = runCli(['--dir']);
    expect(missingDirValue.status).toBe(2);
    expect(missingDirValue.stderr).toContain('--dir needs a value');
    expect(missingDirValue.stderr).toContain(
      'Usage: node scripts/verify-screenshot-sha256.mjs',
    );

    // A following flag is not accepted as the option's value: it would
    // otherwise be treated as a path. For --dir that turns the usage error into
    // an exit-1 hash failure; for --manifest/--log it becomes a confusing read
    // error (still exit 2), so the exact message below pins the guard.
    for (const option of ['--dir', '--manifest', '--log']) {
      const flagValue = runCli([option, '--help']);
      expect(flagValue.status, option).toBe(2);
      expect(flagValue.stderr, option).toContain(`${option} needs a value`);
      expect(flagValue.stderr, option).toContain(
        'Usage: node scripts/verify-screenshot-sha256.mjs',
      );
    }

    const dir = makeTempDir();
    const unreadableManifest = runCli([
      '--manifest',
      join(dir, 'missing-manifest.json'),
    ]);
    expect(unreadableManifest.status).toBe(2);
    expect(unreadableManifest.stderr).toContain('cannot read manifest');

    const bytes = makePng();
    writePng(dir, EXPECTED_FILES[0] as string, bytes);
    const manifestPath = writeManifest(dir, fixtureManifest(bytes));
    const unreadableLog = runCli([
      '--dir',
      dir,
      '--manifest',
      manifestPath,
      '--log',
      join(dir, 'missing-capture.log'),
    ]);
    expect(unreadableLog.status).toBe(2);
    expect(unreadableLog.stderr).toContain('cannot read capture log');
  });
});
