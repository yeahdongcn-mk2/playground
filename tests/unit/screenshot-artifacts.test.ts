import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ScreenshotArtifactError,
  WEBKIT_DEVICE_SCALE_FACTOR,
  WEBKIT_SCREENSHOT_ARTIFACTS,
  checkArtifactName,
  expectedPixelSize,
  parsePng,
  verifyCaptureLog,
  verifyScreenshotArtifacts,
} from '../../scripts/lib/screenshot-artifacts.mjs';
import type { ScreenshotArtifact } from '../../scripts/lib/screenshot-artifacts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');
const CLI = join(ROOT, 'scripts', 'verify-screenshot-artifacts.mjs');
const HUB = 'after-hub-webkit.png';
const NARROW = 'after-minesweeper-webkit-narrow-360x640.png';
const SCORES = 'after-minesweeper-scores-webkit.png';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'screenshot-artifacts-'));
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

function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, name);
}

function pngBytes(name: string): Buffer {
  return readFileSync(screenshotPath(name));
}

function artifactByFile(name: string): ScreenshotArtifact {
  const artifact = WEBKIT_SCREENSHOT_ARTIFACTS.find((entry) => entry.file === name);
  if (artifact === undefined) {
    throw new Error(`the manifest is missing ${name}`);
  }
  return artifact;
}

/** Build the capture log the scripts print after writing each artifact. */
function captureLog(manifest: readonly ScreenshotArtifact[], engine = 'webkit'): string {
  return (
    manifest
      .map(
        ({ file, viewport }) =>
          `${file}: engine=${engine}, viewport=${viewport.width}x${viewport.height}, ` +
          'theme=dark, reducedMotion=reduce',
      )
      .join('\n') + '\n'
  );
}

function writeManifest(dir: string, manifest: readonly ScreenshotArtifact[]): string {
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  return file;
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

describe('parsePng', () => {
  it('reads the signature and IHDR size of committed WebKit captures', () => {
    expect(parsePng(pngBytes(HUB))).toEqual({ width: 750, height: 1334 });
    expect(parsePng(pngBytes(NARROW))).toEqual({ width: 720, height: 1280 });
    expect(parsePng(pngBytes(SCORES))).toEqual({ width: 640, height: 4146 });
  });

  it('rejects a PNG truncated after a valid IHDR chunk', () => {
    const truncated = pngBytes(HUB).subarray(0, 200);

    expect(() => parsePng(truncated)).toThrow(ScreenshotArtifactError);
    expect(() => parsePng(truncated)).toThrow(/truncated PNG/);
  });

  it('rejects a file that does not start with the PNG signature', () => {
    expect(() => parsePng(Buffer.from(`${HUB} is not an image`))).toThrow(/not a PNG/);
  });
});

describe('WebKit artifact manifest', () => {
  it('lists every committed WebKit screenshot exactly once', () => {
    const committed = readdirSync(SCREENSHOT_DIR)
      .filter((name) => name.includes('-webkit') && name.endsWith('.png'))
      .sort();
    const listed = WEBKIT_SCREENSHOT_ARTIFACTS.map((artifact) => artifact.file).sort();

    expect(committed.length).toBeGreaterThan(0);
    expect(listed).toEqual(committed);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('derives pixel dimensions from the CSS viewport at DPR 2', () => {
    expect(expectedPixelSize(artifactByFile(HUB))).toEqual({ width: 750, height: 1334 });
    expect(expectedPixelSize(artifactByFile(NARROW))).toEqual({ width: 720, height: 1280 });
    expect(expectedPixelSize(artifactByFile('after-minesweeper-webkit-narrow-412x839.png'))).toEqual(
      { width: 824, height: 1678 },
    );
    // The scores panel is a full-page capture: the width follows the 320x640
    // viewport, while the committed full-page height is pinned.
    expect(expectedPixelSize(artifactByFile(SCORES))).toEqual({ width: 640, height: 4146 });
    expect(WEBKIT_DEVICE_SCALE_FACTOR).toBe(2);
  });

  it('requires the file name to encode the engine and narrow viewport', () => {
    expect(checkArtifactName(artifactByFile(HUB))).toBeNull();
    expect(checkArtifactName(artifactByFile(NARROW))).toBeNull();
    expect(
      checkArtifactName({ file: 'after-hub.png', viewport: { width: 375, height: 667 } }),
    ).toMatch(/-webkit\.png/);
    expect(
      checkArtifactName({
        file: NARROW,
        viewport: { width: 375, height: 667 },
        narrow: true,
      }),
    ).toMatch(/375x667/);
  });
});

describe('verifyScreenshotArtifacts', () => {
  it('passes for the committed WebKit screenshots', () => {
    const { artifacts, problems } = verifyScreenshotArtifacts({ dir: SCREENSHOT_DIR });

    expect(artifacts).toBe(WEBKIT_SCREENSHOT_ARTIFACTS.length);
    expect(problems).toEqual([]);
  });

  it('reports a missing file with its expected path', () => {
    const dir = makeTempDir();
    const { problems } = verifyScreenshotArtifacts({
      dir,
      manifest: [artifactByFile(HUB)],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe(HUB);
    expect(problems[0]?.message).toContain('missing file');
    expect(problems[0]?.message).toContain(join(dir, HUB));
  });

  it('reports truncated and non-PNG files separately', () => {
    const dir = makeTempDir();
    const text = 'after-blank-webkit.png';
    writeFileSync(join(dir, HUB), pngBytes(HUB).subarray(0, 200));
    writeFileSync(join(dir, text), 'not a png');

    const { problems } = verifyScreenshotArtifacts({
      dir,
      manifest: [artifactByFile(HUB), artifactByFile(text)],
    });

    expect(problems).toHaveLength(2);
    expect(problems.map((problem) => problem.file)).toEqual([HUB, text]);
    expect(problems[0]?.message).toMatch(/truncated PNG/);
    expect(problems[1]?.message).toMatch(/not a PNG/);
  });

  it('reports a size mismatch with expected and actual pixels', () => {
    const dir = makeTempDir();
    copyFileSync(screenshotPath(HUB), join(dir, HUB));

    const { problems } = verifyScreenshotArtifacts({
      dir,
      manifest: [{ file: HUB, viewport: { width: 100, height: 100 } }],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('expected 200x200 pixels');
    expect(problems[0]?.message).toContain('got 750x1334');
    expect(problems[0]?.message).toContain(join(dir, HUB));
  });

  it('accepts a capture log with one engine=webkit record per artifact', () => {
    const logText = captureLog(WEBKIT_SCREENSHOT_ARTIFACTS);

    expect(verifyCaptureLog(logText)).toEqual([]);
    expect(verifyScreenshotArtifacts({ dir: SCREENSHOT_DIR, logText }).problems).toEqual([]);
  });

  it('reports a missing capture log record for a named artifact', () => {
    const missing = 'after-minesweeper-ready-webkit.png';
    const logText = captureLog(
      WEBKIT_SCREENSHOT_ARTIFACTS.filter((artifact) => artifact.file !== missing),
    );

    const problems = verifyCaptureLog(logText);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe(missing);
    expect(problems[0]?.message).toContain('missing capture log record');
    expect(problems[0]?.message).toContain('engine=webkit');
  });

  it('reports a capture record from another engine or viewport', () => {
    const hub = artifactByFile(HUB);
    const chromium = `${HUB}: engine=chromium, viewport=375x667, theme=dark, reducedMotion=reduce`;
    const wrongViewport = `${HUB}: engine=webkit, viewport=320x640, theme=dark, reducedMotion=reduce`;

    expect(verifyCaptureLog(chromium, [hub])[0]?.message).toContain('engine=chromium');
    expect(verifyCaptureLog(wrongViewport, [hub])[0]?.message).toContain('viewport=320x640');
  });
});

describe('verify-screenshot-artifacts CLI', () => {
  it('exits 0 for the committed WebKit screenshots', () => {
    const { status, stdout, stderr } = runCli([]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain(
      `OK: ${WEBKIT_SCREENSHOT_ARTIFACTS.length} WebKit screenshot artifacts verified`,
    );
  });

  it('exits 0 when every capture log record matches', () => {
    const dir = makeTempDir();
    const log = join(dir, 'capture.log');
    writeFileSync(log, captureLog(WEBKIT_SCREENSHOT_ARTIFACTS));

    const { status, stdout, stderr } = runCli(['--log', log]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('capture log records verified');
  });

  it('exits non-zero and names a missing artifact', () => {
    const dir = makeTempDir();
    const manifest = writeManifest(dir, [artifactByFile(HUB)]);

    const { status, stderr } = runCli(['--dir', dir, '--manifest', manifest]);

    expect(status).toBe(1);
    expect(stderr).toContain(HUB);
    expect(stderr).toContain(join(dir, HUB));
    expect(stderr).toContain('missing file');
  });

  it('exits non-zero and names both sizes for a wrong expectation', () => {
    const dir = makeTempDir();
    copyFileSync(screenshotPath(HUB), join(dir, HUB));
    const manifest = writeManifest(dir, [
      { file: HUB, viewport: { width: 100, height: 100 } },
    ]);

    const { status, stderr } = runCli(['--dir', dir, '--manifest', manifest]);

    expect(status).toBe(1);
    expect(stderr).toContain('expected 200x200 pixels');
    expect(stderr).toContain('got 750x1334');
  });

  it('exits non-zero when a capture log record is missing', () => {
    const dir = makeTempDir();
    const missing = 'after-minesweeper-lost-webkit.png';
    const log = join(dir, 'capture.log');
    writeFileSync(
      log,
      captureLog(WEBKIT_SCREENSHOT_ARTIFACTS.filter((artifact) => artifact.file !== missing)),
    );

    const { status, stderr } = runCli(['--log', log]);

    expect(status).toBe(1);
    expect(stderr).toContain(missing);
    expect(stderr).toContain('missing capture log record');
  });
});
