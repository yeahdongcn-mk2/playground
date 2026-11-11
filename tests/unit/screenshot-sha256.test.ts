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
  CAPTURE_FONT_PACKAGES,
  CAPTURE_TARGET_DPRS,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from '../../scripts/lib/capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SCREENSHOT_DIR,
  ScreenshotSha256Error,
  manifestEnvironmentMismatches,
  parseCaptureLogFingerprints,
  parseSha256Manifest,
  verifyCaptureEnvironment,
  verifyScreenshotSha256,
} from '../../scripts/lib/screenshot-sha256.mjs';
import type { ScreenshotSha256Manifest } from '../../scripts/lib/screenshot-sha256.mjs';

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

/** One real container log line from docs/screenshots/README.md. */
const CONTAINER_LOG_LINE =
  'capture-env: source=container target=webkit dpr=2 ' +
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
  'capture-env: source=host target=webkit dpr=2 image=unavailable ' +
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
  it('lists exactly the four fixed-environment WebKit captures with committed hashes', () => {
    const manifest = committedManifest();
    expect(manifest.captures.map((capture) => capture.file)).toEqual(EXPECTED_FILES);
    expect(new Set(manifest.captures.map((capture) => capture.file)).size).toBe(4);

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
              : 'screenshots:webkit'
        }`,
      );
      expect(capture.provenance.container).toBe(
        `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
      );
      expect(capture.provenance.captureCommit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('keeps the image tag / digest, EGL variables and webkit DPR aligned with t1 constants', () => {
    const manifest = committedManifest();

    expect(manifestEnvironmentMismatches(manifest)).toEqual([]);
    expect(manifest.environment.source).toBe('container');
    expect(manifest.environment.target).toBe('webkit');
    expect(manifest.environment.dpr).toBe(2);
    expect(manifest.environment.dpr).toBe(CAPTURE_TARGET_DPRS['webkit']);
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
    expect(problems.some((problem) => problem.includes('EGL_PLATFORM'))).toBe(true);
    expect(problems.some((problem) => problem.includes('unexpected variable'))).toBe(true);
    expect(problems.some((problem) => problem.includes('environment.fonts'))).toBe(true);
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

  it('rejects stale provenance and non-container recapture commands', () => {
    const manifest = committedManifest();
    if (manifest.captures[0]) {
      manifest.captures[0].provenance.container = `mcr.microsoft.com/playwright:v9.9.9-noble@sha256:${'0'.repeat(64)}`;
      manifest.captures[0].command = 'echo fake';
    }

    const problems = manifestEnvironmentMismatches(manifest);
    expect(
      problems.some((problem) => problem.includes('provenance.container')),
    ).toBe(true);
    expect(problems.some((problem) => problem.includes('command'))).toBe(true);
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

    const duplicate = clone();
    const first = duplicate.captures[0];
    if (first) duplicate.captures.push({ ...first });
    expect(() => parseSha256Manifest(JSON.stringify(duplicate))).toThrow(
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

    expect(() => parseSha256Manifest('{not json}')).toThrow(/not valid JSON/);
  });
});

describe('capture environment fingerprint', () => {
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
    writeFileSync(logPath, 'capture-env: source=container target=webkit dpr=2\n');

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
      expect(result.status).toBe(2);
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
});
