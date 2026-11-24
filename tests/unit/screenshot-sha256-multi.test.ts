import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_EGL_VARS,
  CAPTURE_TARGET_DPRS,
} from '../../scripts/lib/capture-env.mjs';
import { DEFAULT_MANIFEST_PATH } from '../../scripts/lib/screenshot-sha256.mjs';
import type {
  ScreenshotSha256Capture,
  ScreenshotSha256Environment,
  ScreenshotSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'verify-screenshot-sha256.mjs');
const BASE_MANIFEST = JSON.parse(
  readFileSync(join(ROOT, DEFAULT_MANIFEST_PATH), 'utf8'),
) as ScreenshotSha256Manifest;
const TEMPLATE_CAPTURE = BASE_MANIFEST.captures[0] as ScreenshotSha256Capture;

const DESKTOP_FILE = 'after-blank-desktop.png';
const MOBILE_FILE = 'after-blank-mobile.png';
const DESKTOP_MANIFEST = 'capture-sha256-manifest-desktop.json';
const MOBILE_MANIFEST = 'capture-sha256-manifest-mobile.json';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'screenshot-sha256-multi-'));
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

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A minimal PNG-like payload; the verifier only hashes the bytes. */
function pngBytes(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(marker, 'utf8'),
  ]);
}

function environmentFor(
  target: 'desktop' | 'mobile',
): ScreenshotSha256Environment {
  // Deep-copy the environment: the tests mutate fields such as
  // environment.image.tag to build invalid fixtures, and the shared base
  // object must not leak that mutation into later tests.
  const environment = structuredClone(BASE_MANIFEST.environment);
  environment.target = target;
  environment.dpr = CAPTURE_TARGET_DPRS[target] ?? environment.dpr;
  return environment;
}

function manifestFor(
  file: string,
  target: 'desktop' | 'mobile',
  bytes: Buffer,
): ScreenshotSha256Manifest {
  return {
    environment: environmentFor(target),
    captures: [
      {
        ...TEMPLATE_CAPTURE,
        file,
        sha256: sha256(bytes),
        // Both blank evidence files are written by the unfiltered Chromium
        // capture, which is also the expected recapture command for desktop
        // and mobile captures.
        command: 'npm run screenshots:container -- screenshots',
      },
    ],
  };
}

function writeManifest(
  manifestsDir: string,
  name: string,
  manifest: ScreenshotSha256Manifest,
): string {
  const file = join(manifestsDir, name);
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

/** The `capture-env:` line the capture runtime prints for one target. */
function fingerprintLine(
  environment: ScreenshotSha256Environment,
): string {
  const fonts = environment.fonts
    .map(({ name, version }) => `${name}@${version}`)
    .join(',');
  const egl = CAPTURE_EGL_VARS.map(
    (name) => `${name}=${environment.egl[name] ?? ''}`,
  ).join(',');
  return [
    'capture-env:',
    `source=${environment.source}`,
    `target=${environment.target}`,
    `dpr=${environment.dpr}`,
    `platform=${environment.platform}`,
    `image=${environment.image.repository}:${environment.image.tag}@${environment.image.digest}`,
    'node=v26.13.0',
    'playwright=1.64.1',
    'browser=156.0.8080.0',
    `fonts=${fonts}`,
    `env=${egl}`,
  ].join(' ');
}

/** The write-time sha256 drift checklist printed by `capture-runtime.mjs`. */
function driftRecord(file: string, capturedSha256: string): string {
  return [
    `Wrote /workspace/docs/screenshots/${file} inside the fixed capture environment, ` +
      `but its sha256 differs from ${DEFAULT_MANIFEST_PATH}:`,
    `  manifest sha256: ${'1'.repeat(64)}`,
    `  captured sha256: ${capturedSha256}`,
  ].join('\n');
}

function runCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${
      result.error === undefined ? '' : String(result.error)
    }`,
  };
}

interface Fixture {
  shots: string;
  manifests: string;
  desktopBytes: Buffer;
  mobileBytes: Buffer;
  desktopManifestPath: string;
  mobileManifestPath: string;
}

/** Write the desktop and mobile manifests and their committed PNG bytes. */
function prepareDesktopAndMobile(): Fixture {
  const root = makeTempDir();
  const shots = join(root, 'shots');
  const manifests = join(root, 'manifests');
  mkdirSync(shots);
  mkdirSync(manifests);

  const desktopBytes = pngBytes('desktop');
  const mobileBytes = pngBytes('mobile');
  writeFileSync(join(shots, DESKTOP_FILE), desktopBytes);
  writeFileSync(join(shots, MOBILE_FILE), mobileBytes);

  return {
    shots,
    manifests,
    desktopBytes,
    mobileBytes,
    desktopManifestPath: writeManifest(
      manifests,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', desktopBytes),
    ),
    mobileManifestPath: writeManifest(
      manifests,
      MOBILE_MANIFEST,
      manifestFor(MOBILE_FILE, 'mobile', mobileBytes),
    ),
  };
}

describe('verify-screenshot-sha256 multi-manifest default', () => {
  it('verifies desktop and mobile manifests together and selects the log fingerprint by target', () => {
    const fixture = prepareDesktopAndMobile();
    const logPath = join(fixture.manifests, 'capture.log');
    writeFileSync(
      logPath,
      [
        fingerprintLine(environmentFor('desktop')),
        driftRecord(DESKTOP_FILE, sha256(fixture.desktopBytes)),
        fingerprintLine(environmentFor('mobile')),
        driftRecord(MOBILE_FILE, sha256(fixture.mobileBytes)),
      ].join('\n'),
    );

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
      '--log',
      logPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      `OK: 2 screenshot sha256 entries verified across 2 manifests in ${fixture.shots}`,
    );
    expect(result.stdout).toContain('capture environment fingerprint verified');
    expect(result.stdout).toContain(
      'capture-log captured sha256 verified (2 record(s))',
    );
    // Each manifest selected its own target's fingerprint and owned record:
    // a run that compared both fingerprints against one environment would
    // fail with target / DPR drift, and a run that did not filter records by
    // ownership would report the other manifest's record as unrecorded.
    expect(result.stdout).toContain(fixture.desktopManifestPath);
    expect(result.stdout).toContain(fixture.mobileManifestPath);
    expect(result.stderr).not.toContain('not recorded in the manifest');
  });

  it('exits 1 and names the file and its owning manifest when one PNG drifts', () => {
    const fixture = prepareDesktopAndMobile();
    writeFileSync(
      join(fixture.shots, DESKTOP_FILE),
      Buffer.concat([fixture.desktopBytes, Buffer.from('drift')]),
    );

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `FAIL: 1 screenshot sha256 problem(s) across 1 entries in ${fixture.shots} ` +
        `(manifest: ${fixture.desktopManifestPath}):`,
    );
    expect(result.stderr).toContain(
      `${DESKTOP_FILE} (manifest: ${fixture.desktopManifestPath})`,
    );
    expect(result.stderr).toContain(
      `FAIL: 1 screenshot sha256 problem(s) across 2 manifests in ${fixture.shots}.`,
    );
    // The passing mobile manifest is not blamed for the desktop failure.
    expect(result.stderr).not.toContain(
      `${MOBILE_FILE} (manifest: ${fixture.mobileManifestPath})`,
    );
  });

  it('exits 1 and attributes a capture-log captured sha256 drift to its owning manifest', () => {
    const fixture = prepareDesktopAndMobile();
    const captured = sha256(Buffer.concat([fixture.desktopBytes, Buffer.from('log')]));
    const logPath = join(fixture.manifests, 'capture.log');
    writeFileSync(
      logPath,
      [
        fingerprintLine(environmentFor('desktop')),
        driftRecord(DESKTOP_FILE, captured),
        fingerprintLine(environmentFor('mobile')),
        driftRecord(MOBILE_FILE, sha256(fixture.mobileBytes)),
      ].join('\n'),
    );

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
      '--log',
      logPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `FAIL: 1 capture-log captured sha256 problem(s) in ${fixture.desktopManifestPath}:`,
    );
    expect(result.stderr).toContain(`  ${DESKTOP_FILE}: `);
    expect(result.stderr).toContain(`captured sha256: ${captured}`);
    expect(result.stderr).toContain(
      `FAIL: 1 capture-log captured sha256 problem(s) across 2 manifests in ${fixture.shots}.`,
    );
    expect(result.stderr).not.toContain(
      `${MOBILE_FILE}: captured by the log but not recorded in the manifest`,
    );
  });

  it('reports a logged file no manifest records once, without blaming a manifest', () => {
    const fixture = prepareDesktopAndMobile();
    const logPath = join(fixture.manifests, 'capture.log');
    writeFileSync(
      logPath,
      [
        fingerprintLine(environmentFor('desktop')),
        driftRecord(DESKTOP_FILE, sha256(fixture.desktopBytes)),
        fingerprintLine(environmentFor('mobile')),
        driftRecord(MOBILE_FILE, sha256(fixture.mobileBytes)),
        driftRecord('after-blank-orphan.png', sha256(Buffer.from('orphan'))),
      ].join('\n'),
    );

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
      '--log',
      logPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: 1 capture-log captured sha256 problem(s):',
    );
    expect(result.stderr).toContain(
      'after-blank-orphan.png: captured by the log but not recorded in the manifest',
    );
    // The unowned record is global, so it must not be attributed to the first
    // discovered manifest.
    expect(result.stderr).not.toContain(
      `capture-log captured sha256 problem(s) in ${fixture.desktopManifestPath}`,
    );
    expect(result.stderr).toContain(
      `FAIL: 1 capture-log captured sha256 problem(s) across 2 manifests in ${fixture.shots}.`,
    );
  });

  it('lists the per-manifest recapture commands for environment drift', () => {
    const fixture = prepareDesktopAndMobile();
    const drifted = environmentFor('desktop');
    const firstFont = drifted.fonts[0];
    if (firstFont === undefined) {
      throw new Error('the committed manifest records no font packages');
    }
    firstFont.version = `${firstFont.version}-drift`;
    const logPath = join(fixture.manifests, 'capture.log');
    writeFileSync(
      logPath,
      [
        fingerprintLine(drifted),
        fingerprintLine(environmentFor('mobile')),
      ].join('\n'),
    );

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
      '--log',
      logPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Environment fingerprint mismatch (${logPath}) for ${fixture.desktopManifestPath}:`,
    );
    expect(result.stderr).toContain(
      `Recapture in the fixed container after an explicit evidence refresh ` +
        `(manifest: ${fixture.desktopManifestPath}):`,
    );
    expect(result.stderr).toContain(
      `${DESKTOP_FILE}: npm run screenshots:container -- screenshots`,
    );
    expect(result.stderr).not.toContain(
      `Environment fingerprint mismatch (${logPath}) for ${fixture.mobileManifestPath}:`,
    );
  });

  it('exits 2 when one discovered manifest is invalid', () => {
    const fixture = prepareDesktopAndMobile();
    const broken = join(fixture.manifests, 'capture-sha256-manifest-broken.json');
    writeFileSync(broken, '{}');

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('error: invalid sha256 manifest set:');
    expect(result.stderr).toContain(broken);
    expect(result.stderr).toContain(
      '"captures" must be a non-empty array of screenshot entries',
    );
  });

  it('exits 2 when two manifests record the same capture file', () => {
    const root = makeTempDir();
    const shots = join(root, 'shots');
    const manifests = join(root, 'manifests');
    mkdirSync(shots);
    mkdirSync(manifests);
    const bytes = pngBytes('duplicate');
    writeFileSync(join(shots, DESKTOP_FILE), bytes);

    const desktopPath = writeManifest(
      manifests,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', bytes),
    );
    const mobilePath = writeManifest(
      manifests,
      MOBILE_MANIFEST,
      manifestFor(DESKTOP_FILE, 'mobile', bytes),
    );

    const result = runCli([
      '--dir',
      shots,
      '--manifest-dir',
      manifests,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `duplicate capture file "${DESKTOP_FILE}"`,
    );
    expect(result.stderr).toContain(desktopPath);
    expect(result.stderr).toContain(mobilePath);
  });

  it('gives an invalid manifest precedence over a hash failure in another manifest', () => {
    const fixture = prepareDesktopAndMobile();
    writeFileSync(
      join(fixture.shots, DESKTOP_FILE),
      Buffer.concat([fixture.desktopBytes, Buffer.from('drift')]),
    );
    const mobile = manifestFor(MOBILE_FILE, 'mobile', fixture.mobileBytes);
    mobile.environment.image.tag = 'v0.0.0-invalid';
    writeManifest(fixture.manifests, MOBILE_MANIFEST, mobile);

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `error: sha256 manifest ${fixture.mobileManifestPath} does not match the fixed capture environment:`,
    );
    expect(result.stderr).toContain(
      'FAIL: 1 screenshot sha256 problem(s) across 1 entries',
    );
    expect(result.stderr).toContain(
      'error: 1 sha256 manifest(s) do not match the fixed capture environment contract.',
    );
  });

  it('exits 2 when the shared --log has a malformed capture-env line', () => {
    const fixture = prepareDesktopAndMobile();
    const logPath = join(fixture.manifests, 'capture.log');
    writeFileSync(logPath, 'capture-env: target=desktop\n');

    const result = runCli([
      '--dir',
      fixture.shots,
      '--manifest-dir',
      fixture.manifests,
      '--log',
      logPath,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`error: invalid capture log ${logPath}:`);
    expect(result.stderr).toContain('capture-env');
  });

  it('exits 2 when the manifest directory has no manifests', () => {
    const root = makeTempDir();
    const shots = join(root, 'shots');
    const manifests = join(root, 'manifests');
    mkdirSync(shots);
    mkdirSync(manifests);

    const result = runCli([
      '--dir',
      shots,
      '--manifest-dir',
      manifests,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `error: no sha256 manifests found in ${manifests}`,
    );
  });

  it('keeps --manifest single-manifest output and exit codes unchanged', () => {
    const root = makeTempDir();
    const shots = join(root, 'shots');
    mkdirSync(shots);
    const bytes = pngBytes('single');
    writeFileSync(join(shots, DESKTOP_FILE), bytes);
    const singlePath = join(root, 'single-manifest.json');
    writeFileSync(
      singlePath,
      JSON.stringify(manifestFor(DESKTOP_FILE, 'desktop', bytes)),
    );

    const passed = runCli([
      '--dir',
      shots,
      '--manifest',
      singlePath,
    ]);
    expect(passed.status).toBe(0);
    expect(passed.stderr).toBe('');
    expect(passed.stdout).toBe(
      `OK: 1 screenshot sha256 entries verified in ${shots}\n`,
    );
    expect(passed.stdout).not.toContain('manifests');

    writeFileSync(
      join(shots, DESKTOP_FILE),
      Buffer.concat([bytes, Buffer.from('drift')]),
    );
    const drifted = runCli([
      '--dir',
      shots,
      '--manifest',
      singlePath,
    ]);
    expect(drifted.status).toBe(1);
    // The single-manifest header has no owning-manifest suffix.
    expect(drifted.stderr).toContain(
      `FAIL: 1 screenshot sha256 problem(s) across 1 entries in ${shots}:`,
    );
    expect(drifted.stderr).not.toContain('(manifest:');
  });

  it('rejects combining --manifest with --manifest-dir', () => {
    const result = runCli([
      '--manifest',
      DEFAULT_MANIFEST_PATH,
      '--manifest-dir',
      'docs/screenshots',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '--manifest and --manifest-dir cannot be combined',
    );
  });
});
