import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_FONT_PACKAGES,
  CAPTURE_PLATFORM,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from '../../scripts/lib/capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  type ScreenshotSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';
import {
  captureScreenshot,
  createDesktopContext,
  resetRecordedCaptureTargets,
} from '../../scripts/lib/capture-runtime.mjs';

const ROOT = process.cwd();
const FILE = 'after-blank-webkit.png';
const RECAPTURE = 'npm run screenshots:container -- screenshots:webkit';
const IMAGE = {
  repository: PLAYWRIGHT_IMAGE_REPOSITORY,
  tag: PLAYWRIGHT_IMAGE_PIN.tag,
  digest: PLAYWRIGHT_IMAGE_PIN.digest,
};
const FONTS = CAPTURE_FONT_PACKAGES.map((name, index) => ({
  name,
  version: `1.0.${index}`,
}));

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sampleManifest(overrides: { sha256?: string; command?: string } = {}): ScreenshotSha256Manifest {
  return {
    environment: {
      source: 'container',
      target: 'webkit',
      dpr: 2,
      platform: CAPTURE_PLATFORM,
      image: IMAGE,
      egl: { ...CAPTURE_EGL_ENV },
      fonts: FONTS,
    },
    captures: [
      {
        file: FILE,
        sha256: overrides.sha256 ?? sha256('captured png bytes'),
        command: overrides.command ?? RECAPTURE,
        provenance: {
          container: `${IMAGE.repository}:${IMAGE.tag}@${IMAGE.digest}`,
          captureCommit: 'a'.repeat(40),
        },
      },
    ],
  };
}

/** A fingerprint that matches {@link sampleManifest}. */
function containerFingerprint(): Record<string, unknown> {
  return {
    source: 'container',
    target: 'webkit',
    dpr: 2,
    platform: CAPTURE_PLATFORM,
    image: IMAGE,
    node: process.version,
    playwright: PLAYWRIGHT_IMAGE_PIN.version,
    browser: '27.2',
    fonts: FONTS,
    env: { ...CAPTURE_EGL_ENV },
  };
}

function hostFingerprint(): Record<string, unknown> {
  return {
    source: 'host',
    target: 'webkit',
    dpr: 2,
    platform: 'unavailable',
    image: null,
    node: process.version,
    playwright: PLAYWRIGHT_IMAGE_PIN.version,
    browser: '27.2',
    fonts: null,
    env: null,
  };
}

interface FakePageOptions {
  bytes?: Buffer;
  context?: object;
  screenshot?: (options: Record<string, unknown>) => Promise<Buffer>;
  waitForTimeout?: (milliseconds: number) => Promise<void>;
}

function fakePage({
  bytes = Buffer.from('captured png bytes'),
  context,
  screenshot,
  waitForTimeout,
}: FakePageOptions = {}) {
  const screenshotSpy = vi.fn(
    screenshot ??
      (async (options: { path?: string }) => {
        // The pre-guard write path passes a `path`; writing it here mirrors
        // Playwright so the unrecorded-file test proves the old behaviour.
        if (options.path !== undefined) {
          writeFileSync(options.path, bytes);
        }
        return bytes;
      }),
  );
  const waitForTimeoutSpy = vi.fn(waitForTimeout ?? (async () => {}));
  return {
    page: {
      context: () => context ?? {},
      viewportSize: () => ({ width: 375, height: 667 }),
      screenshot: screenshotSpy,
      waitForTimeout: waitForTimeoutSpy,
    } as never,
    screenshotSpy,
    waitForTimeoutSpy,
  };
}

function readManifestFile(path: string): ScreenshotSha256Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ScreenshotSha256Manifest;
}

function tempScreenshotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capture-guard-'));
  tempDirs.push(dir);
  return dir;
}

const tempDirs: string[] = [];

function assertNoTempFiles(dir: string): void {
  expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
}

beforeEach(() => {
  resetRecordedCaptureTargets();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('captureScreenshot write-time environment guard', () => {
  it('writes a manifested PNG atomically when the fingerprint matches', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const log = { warn: vi.fn() };
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest: sampleManifest(),
      fingerprint: containerFingerprint() as never,
      log,
    });

    expect(readFileSync(target, 'utf8')).toBe('captured png bytes');
    expect(readdirSync(dir)).toEqual([FILE]);
    expect(screenshotSpy).toHaveBeenCalledWith({
      fullPage: false,
      animations: 'disabled',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps the committed PNG and removes the temporary sibling when the atomic rename fails', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const { page } = fakePage();
    const renameCalls: Array<[string, string]> = [];
    const renameSync = vi.fn((tempPath: string, finalPath: string) => {
      renameCalls.push([tempPath, finalPath]);
      throw new Error('simulated rename failure');
    });

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: containerFingerprint() as never,
        fileOperations: { renameSync },
      }),
    ).rejects.toThrow('simulated rename failure');

    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]?.[0]).toContain(`${target}.tmp-`);
    expect(renameCalls[0]?.[1]).toBe(target);
    // The failed rename must leave the previously committed bytes intact and
    // must not leave the temporary sibling behind.
    expect(readFileSync(target, 'utf8')).toBe('old committed bytes');
    expect(readdirSync(dir)).toEqual([FILE]);
  });

  it('refuses a mismatched fingerprint before writing and names file, both fingerprints and the recapture command', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const log = { warn: vi.fn() };
    const { page, screenshotSpy } = fakePage();
    const mismatched = containerFingerprint();
    mismatched.fonts = FONTS.map((font) =>
      font.name === 'fonts-liberation' ? { ...font, version: '9.9.9' } : font,
    );

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: mismatched as never,
        log,
      }),
    ).rejects.toThrow(
      /Refusing to write .*after-blank-webkit\.png before writing any bytes.*capture-sha256-manifest\.json/s,
    );

    let message = '';
    try {
      await captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: mismatched as never,
        log,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Expected environment fingerprint: capture-env: source=container target=webkit dpr=2');
    expect(message).toContain('Actual environment fingerprint: capture-env: source=container target=webkit dpr=2');
    expect(message).toContain('capture environment fonts are');
    expect(message).toContain(RECAPTURE);
    expect(message).toContain('The target PNG was not created or replaced.');

    expect(readFileSync(target, 'utf8')).toBe('old committed bytes');
    expect(readdirSync(dir)).toEqual([FILE]);
    expect(screenshotSpy).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('refuses a host capture of a manifested PNG without creating the file', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: hostFingerprint() as never,
      }),
    ).rejects.toThrow(/capture environment source is "host", expected "container"/s);

    expect(readdirSync(dir)).toEqual([]);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('uses the target of the context that produced the page', async () => {
    const dir = tempScreenshotDir();
    const browser = {
      version: () => '144.0.1',
      newContext: async () => ({ close: async () => {} }),
    };
    const context = await createDesktopContext(browser as never);
    const { page } = fakePage({ context });

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        env: {
          CAPTURE_CONTAINER: '1',
          CAPTURE_TARGET: 'webkit',
          CAPTURE_IMAGE_TAG: PLAYWRIGHT_IMAGE_PIN.tag,
          CAPTURE_IMAGE_DIGEST: PLAYWRIGHT_IMAGE_PIN.digest,
          CAPTURE_PLATFORM,
          ...CAPTURE_EGL_ENV,
        },
        run: { browserVersion: '27.2', fontPackages: FONTS },
      }),
    ).rejects.toThrow(/capture environment target is "desktop", expected "webkit"/s);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps the previous write path for files the manifest does not record', async () => {
    const dir = tempScreenshotDir();
    const log = { warn: vi.fn() };
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, 'after-hub-webkit.png', {
      engine: 'webkit',
      outputDir: dir,
      manifest: sampleManifest(),
      fingerprint: hostFingerprint() as never,
      log,
    });

    expect(screenshotSpy).toHaveBeenCalledWith({
      path: join(dir, 'after-hub-webkit.png'),
      fullPage: false,
      animations: 'disabled',
    });
    expect(readFileSync(join(dir, 'after-hub-webkit.png'), 'utf8')).toBe('captured png bytes');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('writes but keeps the manifest failing when the fixed environment produces a new sha256', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    const oldSha = sha256('old evidence');
    const newBytes = Buffer.from('new evidence');
    const newSha = sha256(newBytes);
    const manifest = sampleManifest({ sha256: oldSha });
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const log = { warn: vi.fn() };
    const { page } = fakePage({ bytes: newBytes });

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest,
      fingerprint: containerFingerprint() as never,
      log,
    });

    expect(readFileSync(target)).toEqual(newBytes);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const checklist = String(log.warn.mock.calls[0]?.[0]);
    expect(checklist).toContain(`manifest sha256: ${oldSha}`);
    expect(checklist).toContain(`captured sha256: ${newSha}`);
    expect(checklist).toContain(`captures[0].sha256 -> ${newSha}`);
    expect(checklist).toContain('captures[0].provenance.captureCommit');
    expect(checklist).toContain('docs/screenshots/README.md');
    expect(checklist).toContain('npm run verify:screenshots:sha256');
    expect(checklist).toContain(RECAPTURE);
    // The manifest on disk was not silently rewritten.
    expect(readManifestFile(manifestPath).captures[0]?.sha256).toBe(oldSha);

    // The committed-evidence verifier keeps failing on the stale sha256.
    const verify = spawnSync(
      process.execPath,
      ['scripts/verify-screenshot-sha256.mjs', '--dir', dir, '--manifest', manifestPath],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('sha256 mismatch');
    expect(verify.stderr).toContain(oldSha);
    expect(verify.stderr).toContain(newSha);
    expect(verify.stderr).toContain(RECAPTURE);
  });

  it('leaves the committed PNG and no temporary file when the screenshot fails', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const { page } = fakePage({
      screenshot: async () => {
        throw new Error('browser crashed before encoding');
      },
    });

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: containerFingerprint() as never,
      }),
    ).rejects.toThrow('browser crashed before encoding');

    expect(readFileSync(target, 'utf8')).toBe('old committed bytes');
    assertNoTempFiles(dir);
  });

  it('treats a missing manifest as no recorded evidence', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifestPath: join(dir, 'missing-manifest.json'),
      fingerprint: hostFingerprint() as never,
    });

    expect(screenshotSpy).toHaveBeenCalledWith({
      path: join(dir, FILE),
      fullPage: false,
      animations: 'disabled',
    });
    expect(readFileSync(join(dir, FILE), 'utf8')).toBe('captured png bytes');
  });

  it('fails closed on a malformed manifest instead of writing unguarded evidence', async () => {
    const dir = tempScreenshotDir();
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, '{"captures": []}');
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifestPath,
      }),
    ).rejects.toThrow(/Cannot parse the screenshot sha256 manifest/);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the existing manifest cannot be read', async () => {
    const dir = tempScreenshotDir();
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(sampleManifest()));
    const { page, screenshotSpy } = fakePage();
    const readFile = vi.fn((path: string): string => {
      const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifestPath,
        readFile,
      }),
    ).rejects.toThrow(/Cannot read the screenshot sha256 manifest .*EACCES/s);
    expect(readFile).toHaveBeenCalledWith(manifestPath, 'utf8');
    expect(readdirSync(dir)).toEqual(['manifest.json']);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('uses the default manifest path for the repo when none is passed', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();
    // The committed manifest is parseable and tracks the file; a host capture
    // must be refused without touching the committed PNG. Injecting an empty
    // env keeps the host fingerprint independent of the caller's environment.
    await expect(
      captureScreenshot(page, FILE, { engine: 'webkit', outputDir: dir, env: {} }),
    ).rejects.toThrow(new RegExp(`tracked by ${DEFAULT_MANIFEST_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(screenshotSpy).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('captureScreenshot whole-image stability check', () => {
  function sequencePage(frames: Buffer[]) {
    const queue = [...frames];
    return fakePage({
      screenshot: async () => {
        const frame = queue.shift();
        if (frame === undefined) {
          throw new Error('the capture read more frames than the fixture provides');
        }
        return frame;
      },
    });
  }

  it('writes only after two consecutive identical frames', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const frame = Buffer.from('stable frame');
    const log = { warn: vi.fn() };
    const { page, screenshotSpy, waitForTimeoutSpy } = sequencePage([frame, frame]);

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest: sampleManifest({ sha256: sha256(frame) }),
      fingerprint: containerFingerprint() as never,
      log,
      stableFrames: 2,
      stableIntervalMs: 250,
    });

    expect(readFileSync(target)).toEqual(frame);
    expect(screenshotSpy).toHaveBeenCalledTimes(2);
    expect(waitForTimeoutSpy).toHaveBeenCalledWith(250);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps reading through a transient frame and writes the stable pair', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const transient = Buffer.from('transient frame');
    const stable = Buffer.from('stable frame');
    const { page, screenshotSpy } = sequencePage([
      transient,
      stable,
      stable,
    ]);

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest: sampleManifest({ sha256: sha256(stable) }),
      fingerprint: containerFingerprint() as never,
      log: { warn: vi.fn() },
      stableFrames: 2,
      stableIntervalMs: 250,
    });

    expect(readFileSync(target)).toEqual(stable);
    expect(screenshotSpy).toHaveBeenCalledTimes(3);
  });

  it('refuses to write when no stable pair appears within the attempt budget', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const { page, screenshotSpy } = sequencePage([
      Buffer.from('frame-a'),
      Buffer.from('frame-b'),
      Buffer.from('frame-c'),
    ]);

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: containerFingerprint() as never,
        stableFrames: 2,
        stableIntervalMs: 250,
        stableAttempts: 2,
      }),
    ).rejects.toThrow(
      /did not produce 2 consecutive byte-identical frames .*No file was written/s,
    );

    expect(readFileSync(target, 'utf8')).toBe('old committed bytes');
    expect(readdirSync(dir)).toEqual([FILE]);
    expect(screenshotSpy).toHaveBeenCalledTimes(3);
  });

  it('rejects a non-positive stableFrames request before taking a screenshot', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: containerFingerprint() as never,
        stableFrames: 0,
      }),
    ).rejects.toThrow(/stableFrames must be a positive integer/);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });
});

describe('captureScreenshot stable frames for unrecorded files', () => {
  it('writes an unrecorded file only after two identical frames', async () => {
    const dir = tempScreenshotDir();
    const file = 'after-hub-webkit.png';
    const target = join(dir, file);
    writeFileSync(target, 'old unrecorded bytes');
    const frame = Buffer.from('stable frame');
    const queue = [frame, frame];
    const { page, screenshotSpy, waitForTimeoutSpy } = fakePage({
      screenshot: async () => queue.shift() as Buffer,
    });

    await captureScreenshot(page, file, {
      engine: 'webkit',
      outputDir: dir,
      manifest: null,
      stableFrames: 2,
      stableIntervalMs: 250,
    });

    expect(readFileSync(target)).toEqual(frame);
    expect(screenshotSpy).toHaveBeenCalledTimes(2);
    expect(waitForTimeoutSpy).toHaveBeenCalledWith(250);
    expect(readdirSync(dir)).toEqual([file]);
  });

  it('keeps an unrecorded file when no stable pair appears', async () => {
    const dir = tempScreenshotDir();
    const file = 'after-hub-webkit.png';
    const target = join(dir, file);
    writeFileSync(target, 'old unrecorded bytes');
    const queue = [Buffer.from('frame-a'), Buffer.from('frame-b')];
    const { page, screenshotSpy } = fakePage({
      screenshot: async () => queue.shift() as Buffer,
    });

    await expect(
      captureScreenshot(page, file, {
        engine: 'webkit',
        outputDir: dir,
        manifest: null,
        stableFrames: 2,
        stableIntervalMs: 250,
        stableAttempts: 1,
      }),
    ).rejects.toThrow(/did not produce 2 consecutive byte-identical frames/);

    expect(readFileSync(target, 'utf8')).toBe('old unrecorded bytes');
    expect(readdirSync(dir)).toEqual([file]);
    expect(screenshotSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a negative stableAttempts before taking a screenshot', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: containerFingerprint() as never,
        stableFrames: 2,
        stableAttempts: -1,
      }),
    ).rejects.toThrow(/stableAttempts must be a non-negative integer/);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('rejects a zero stableIntervalMs before taking a screenshot', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        fingerprint: containerFingerprint() as never,
        stableFrames: 2,
        stableIntervalMs: 0,
      }),
    ).rejects.toThrow(/stableIntervalMs must be a positive integer/);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });
});

describe('captureScreenshot stable capture (Issue #199)', () => {
  /** A page double whose screenshot always returns the same bytes. */
  function stablePage(bytes: Buffer) {
    const screenshot = vi.fn(async () => bytes);
    return {
      page: {
        context: () => ({}),
        viewportSize: () => ({ width: 375, height: 667 }),
        evaluate: vi.fn(async () => {}),
        waitForTimeout: vi.fn(async () => {}),
        screenshot,
      } as never,
      screenshot,
    };
  }

  it('waits for two identical screenshots before writing an unrecorded PNG', async () => {
    const dir = tempScreenshotDir();
    const bytes = Buffer.from('stable png bytes');
    const { page, screenshot } = stablePage(bytes);

    await captureScreenshot(page, 'after-hub-webkit.png', {
      engine: 'webkit',
      outputDir: dir,
      manifest: sampleManifest(),
      fingerprint: hostFingerprint() as never,
      stable: true,
      fullPage: true,
      animations: 'allow',
    });

    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(screenshot).toHaveBeenNthCalledWith(1, { fullPage: true, animations: 'allow' });
    expect(screenshot).toHaveBeenNthCalledWith(2, { fullPage: true, animations: 'allow' });
    expect(readFileSync(join(dir, 'after-hub-webkit.png'))).toEqual(bytes);
  });

  it('writes the stable buffer atomically for a manifested PNG', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
    const bytes = Buffer.from('captured png bytes');
    const { page, screenshot } = stablePage(bytes);
    const log = { warn: vi.fn() };

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      target: 'webkit',
      outputDir: dir,
      manifest: sampleManifest(),
      fingerprint: containerFingerprint() as never,
      stable: true,
      log,
    });

    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(readFileSync(target)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual([FILE]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
