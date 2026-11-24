import { createHash } from 'node:crypto';
import {
  mkdirSync,
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
  verifyScreenshotSha256,
  type ScreenshotSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';
import {
  captureScreenshot,
  createDesktopContext,
  expectedCaptureSha256,
  resetRecordedCaptureTargets,
} from '../../scripts/lib/capture-runtime.mjs';

const ROOT = process.cwd();
const FILE = 'after-blank-webkit.png';
const RECAPTURE = 'npm run screenshots:container -- screenshots:webkit';
const DESKTOP_FILE = 'after-blank-desktop.png';
const MOBILE_FILE = 'after-blank-mobile.png';
const DESKTOP_MANIFEST = 'capture-sha256-manifest-desktop.json';
const MOBILE_MANIFEST = 'capture-sha256-manifest-mobile.json';
const CHROMIUM_RECAPTURE = 'npm run screenshots:container -- screenshots';
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

/** A one-capture manifest for one capture target. */
function manifestFor(
  file: string,
  target: string,
  dpr: number,
  overrides: { sha256?: string; command?: string } = {},
): ScreenshotSha256Manifest {
  return {
    environment: {
      source: 'container',
      target,
      dpr,
      platform: CAPTURE_PLATFORM,
      image: IMAGE,
      egl: { ...CAPTURE_EGL_ENV },
      fonts: FONTS,
    },
    captures: [
      {
        file,
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

function sampleManifest(overrides: { sha256?: string; command?: string } = {}): ScreenshotSha256Manifest {
  return manifestFor(FILE, 'webkit', 2, overrides);
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

/** A container / host fingerprint for one target, keeping every other field. */
function targetFingerprint(
  target: string,
  dpr: number,
  source: 'container' | 'host' = 'container',
): Record<string, unknown> {
  const fingerprint = source === 'container' ? containerFingerprint() : hostFingerprint();
  return { ...fingerprint, target, dpr };
}

/** Write one manifest into a temp directory the guard discovers. */
function writeManifest(
  dir: string,
  name: string,
  manifest: ScreenshotSha256Manifest,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
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

  it('writes caller-validated bytes without taking another screenshot', async () => {
    // The scores retry compares a stale-host-load frame against the manifest
    // before it writes. The matched bytes must then go through the same guard
    // and atomic write, without a third screenshot that could be a different
    // raster again.
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    const bytes = Buffer.from('validated png bytes');
    const manifest = sampleManifest({ sha256: sha256(bytes) });
    const { page, screenshotSpy } = fakePage({
      screenshot: async () => {
        throw new Error('capturedBytes must not take another screenshot');
      },
    });
    const log = { warn: vi.fn() };

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest,
      fingerprint: containerFingerprint() as never,
      // capturedBytes takes precedence over the stable-frame opt-ins: the
      // caller already validated this frame, so no second frame is taken.
      capturedBytes: bytes,
      stable: true,
      stableFrames: 4,
      log,
    });

    expect(readFileSync(target)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual([FILE]);
    expect(screenshotSpy).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads the expected sha256 and treats an unrecorded file as null', () => {
    const dir = tempScreenshotDir();
    const bytes = Buffer.from('manifest lookup bytes');
    const manifest = sampleManifest({ sha256: sha256(bytes) });

    expect(expectedCaptureSha256(FILE, { manifest })).toBe(sha256(bytes));
    expect(expectedCaptureSha256('not-in-manifest.png', { manifest })).toBeNull();
    expect(expectedCaptureSha256(FILE, { manifest: null })).toBeNull();
    // A missing manifest (trimmed checkout) reads as unrecorded, not an error.
    expect(
      expectedCaptureSha256(FILE, {
        manifestPath: join(dir, 'missing-manifest.json'),
      }),
    ).toBeNull();
  });

  it('rejects capturedBytes when the environment fingerprint does not match', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    writeFileSync(target, 'old committed bytes');
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
        capturedBytes: Buffer.from('validated png bytes'),
      }),
    ).rejects.toThrow(/Refusing to write .*before writing any bytes/);

    expect(readFileSync(target, 'utf8')).toBe('old committed bytes');
    expect(readdirSync(dir)).toEqual([FILE]);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('writes capturedBytes for an unrecorded file without a screenshot', async () => {
    const dir = tempScreenshotDir();
    const target = join(dir, FILE);
    const bytes = Buffer.from('unrecorded png bytes');
    const { page, screenshotSpy } = fakePage({
      screenshot: async () => {
        throw new Error('capturedBytes must not take another screenshot');
      },
    });

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest: null,
      capturedBytes: bytes,
    });

    expect(readFileSync(target)).toEqual(bytes);
    expect(screenshotSpy).not.toHaveBeenCalled();
    expect(expectedCaptureSha256(FILE, { manifest: null })).toBeNull();
  });

  it('validates the environment without writing for checkOnly', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest: sampleManifest(),
      fingerprint: containerFingerprint() as never,
      checkOnly: true,
    });

    expect(readdirSync(dir)).toEqual([]);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('returns immediately for checkOnly on an unrecorded file', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest: null,
      checkOnly: true,
    });

    expect(readdirSync(dir)).toEqual([]);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('fails checkOnly with requireRecorded when the file is unrecorded', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: null,
        checkOnly: true,
        requireRecorded: true,
      }),
    ).rejects.toThrow(/not tracked by .*requireRecorded/);

    expect(readdirSync(dir)).toEqual([]);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('passes checkOnly with requireRecorded for a manifested file without writing', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifest: sampleManifest(),
      fingerprint: containerFingerprint() as never,
      checkOnly: true,
      requireRecorded: true,
    });

    expect(readdirSync(dir)).toEqual([]);
    expect(screenshotSpy).not.toHaveBeenCalled();
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

  it('rejects a host capture of after-blank-desktop.png before writing and names the container command', async () => {
    const dir = tempScreenshotDir();
    const targetPath = join(dir, DESKTOP_FILE);
    writeFileSync(targetPath, 'old committed bytes');
    const manifestDir = tempScreenshotDir();
    const manifestPath = writeManifest(
      manifestDir,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', 1, { command: CHROMIUM_RECAPTURE }),
    );
    const { page, screenshotSpy } = fakePage();

    let message = '';
    try {
      await captureScreenshot(page, DESKTOP_FILE, {
        engine: 'chromium',
        outputDir: dir,
        manifestDir,
        fingerprint: targetFingerprint('desktop', 1, 'host') as never,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      `Refusing to write ${join(dir, DESKTOP_FILE)} before writing any bytes`,
    );
    expect(message).toContain(DESKTOP_FILE);
    expect(message).toContain(manifestPath);
    expect(message).toContain('capture environment source is "host", expected "container"');
    expect(message).toContain(CHROMIUM_RECAPTURE);
    expect(message).toContain('The target PNG was not created or replaced.');
    expect(readFileSync(targetPath, 'utf8')).toBe('old committed bytes');
    expect(readdirSync(dir)).toEqual([DESKTOP_FILE]);
    assertNoTempFiles(dir);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('writes the desktop and mobile blank evidence atomically when their fingerprints match', async () => {
    const manifestDir = tempScreenshotDir();
    writeManifest(
      manifestDir,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', 1, { command: CHROMIUM_RECAPTURE }),
    );
    writeManifest(
      manifestDir,
      MOBILE_MANIFEST,
      manifestFor(MOBILE_FILE, 'mobile', 2, { command: CHROMIUM_RECAPTURE }),
    );

    for (const [file, target, dpr] of [
      [DESKTOP_FILE, 'desktop', 1],
      [MOBILE_FILE, 'mobile', 2],
    ] as const) {
      const dir = tempScreenshotDir();
      const targetPath = join(dir, file);
      writeFileSync(targetPath, 'old committed bytes');
      const log = { warn: vi.fn() };
      const { page, screenshotSpy } = fakePage();

      await captureScreenshot(page, file, {
        engine: 'chromium',
        outputDir: dir,
        manifestDir,
        fingerprint: targetFingerprint(target, dpr) as never,
        log,
      });

      expect(readFileSync(targetPath, 'utf8')).toBe('captured png bytes');
      expect(readdirSync(dir)).toEqual([file]);
      expect(screenshotSpy).toHaveBeenCalledWith({
        fullPage: false,
        animations: 'disabled',
      });
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

  it('compares a file against the environment of its owning manifest, not another target', async () => {
    const dir = tempScreenshotDir();
    const manifestDir = tempScreenshotDir();
    writeManifest(
      manifestDir,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', 1),
    );
    writeManifest(
      manifestDir,
      MOBILE_MANIFEST,
      manifestFor(MOBILE_FILE, 'mobile', 2),
    );
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, MOBILE_FILE, {
        engine: 'chromium',
        outputDir: dir,
        manifestDir,
        // The WebKit fingerprint is valid for the base manifest but must not
        // satisfy the mobile manifest that owns this file.
        fingerprint: containerFingerprint() as never,
      }),
    ).rejects.toThrow(/capture environment target is "webkit", expected "mobile"/s);

    expect(readdirSync(dir)).toEqual([]);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('fails closed before writing when two manifests record the same file', async () => {
    const dir = tempScreenshotDir();
    const targetPath = join(dir, DESKTOP_FILE);
    writeFileSync(targetPath, 'old committed bytes');
    const manifestDir = tempScreenshotDir();
    writeManifest(
      manifestDir,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', 1),
    );
    writeManifest(
      manifestDir,
      MOBILE_MANIFEST,
      manifestFor(DESKTOP_FILE, 'mobile', 2),
    );
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, DESKTOP_FILE, {
        engine: 'chromium',
        outputDir: dir,
        manifestDir,
        fingerprint: targetFingerprint('desktop', 1) as never,
      }),
    ).rejects.toThrow(/duplicate capture file "after-blank-desktop\.png"/s);

    expect(readFileSync(targetPath, 'utf8')).toBe('old committed bytes');
    expect(readdirSync(dir)).toEqual([DESKTOP_FILE]);
    assertNoTempFiles(dir);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('fails closed before writing when a discovered manifest is invalid', async () => {
    const dir = tempScreenshotDir();
    const targetPath = join(dir, DESKTOP_FILE);
    writeFileSync(targetPath, 'old committed bytes');
    const manifestDir = tempScreenshotDir();
    writeFileSync(join(manifestDir, DESKTOP_MANIFEST), '{"captures": []}');
    const { page, screenshotSpy } = fakePage();

    await expect(
      captureScreenshot(page, DESKTOP_FILE, {
        engine: 'chromium',
        outputDir: dir,
        manifestDir,
      }),
    ).rejects.toThrow(
      /Cannot load the screenshot sha256 manifest set in .*capture-sha256-manifest-desktop\.json/s,
    );

    expect(readFileSync(targetPath, 'utf8')).toBe('old committed bytes');
    expect(readdirSync(dir)).toEqual([DESKTOP_FILE]);
    assertNoTempFiles(dir);
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('treats a missing manifest directory as unrecorded evidence', async () => {
    const dir = tempScreenshotDir();
    // The parent exists but not the manifest directory itself.
    const manifestDir = join(tempScreenshotDir(), 'missing');
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifestDir,
      fingerprint: hostFingerprint() as never,
    });

    expect(screenshotSpy).toHaveBeenCalledWith({
      path: join(dir, FILE),
      fullPage: false,
      animations: 'disabled',
    });
    expect(readFileSync(join(dir, FILE), 'utf8')).toBe('captured png bytes');
  });

  it('keeps the previous write path for an unrecorded Chromium desktop image in the committed set', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();

    // after-hub-desktop.png is not in any committed manifest; the default set
    // must not turn it into a guarded capture. This asserts the committed set
    // on purpose: if a later manifest starts recording this file, pick another
    // still-unrecorded name for this test.
    await captureScreenshot(page, 'after-hub-desktop.png', {
      engine: 'chromium',
      outputDir: dir,
      fingerprint: hostFingerprint() as never,
    });

    expect(screenshotSpy).toHaveBeenCalledWith({
      path: join(dir, 'after-hub-desktop.png'),
      fullPage: false,
      animations: 'disabled',
    });
    expect(readFileSync(join(dir, 'after-hub-desktop.png'), 'utf8')).toBe(
      'captured png bytes',
    );
  });

  it('keeps an injected single manifest authoritative over the discovered set', async () => {
    const dir = tempScreenshotDir();
    const manifestDir = tempScreenshotDir();
    // A broken discovered set would fail closed if it were read; the injected
    // single manifest stays the compatibility entry point and wins.
    writeFileSync(join(manifestDir, DESKTOP_MANIFEST), 'not json');
    const { page, screenshotSpy } = fakePage();

    await captureScreenshot(page, FILE, {
      engine: 'webkit',
      outputDir: dir,
      manifestDir,
      manifest: sampleManifest(),
      fingerprint: containerFingerprint() as never,
    });

    expect(readFileSync(join(dir, FILE), 'utf8')).toBe('captured png bytes');
    expect(readdirSync(dir)).toEqual([FILE]);
    expect(screenshotSpy).toHaveBeenCalledWith({
      fullPage: false,
      animations: 'disabled',
    });
  });

  it('finds the expected sha256 in the owning manifest of the set', () => {
    const manifestDir = tempScreenshotDir();
    const desktopSha = sha256('desktop png bytes');
    writeManifest(
      manifestDir,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', 1, { sha256: desktopSha }),
    );
    writeManifest(
      manifestDir,
      MOBILE_MANIFEST,
      manifestFor(MOBILE_FILE, 'mobile', 2),
    );

    expect(expectedCaptureSha256(DESKTOP_FILE, { manifestDir })).toBe(desktopSha);
    expect(expectedCaptureSha256(FILE, { manifestDir })).toBeNull();
  });

  it('names the owning manifest and its command in the hash-drift checklist', async () => {
    const dir = tempScreenshotDir();
    const manifestDir = tempScreenshotDir();
    const oldSha = sha256('old desktop evidence');
    const newBytes = Buffer.from('new desktop evidence');
    const newSha = sha256(newBytes);
    const manifestPath = writeManifest(
      manifestDir,
      DESKTOP_MANIFEST,
      manifestFor(DESKTOP_FILE, 'desktop', 1, {
        sha256: oldSha,
        command: CHROMIUM_RECAPTURE,
      }),
    );
    const committedManifest = readFileSync(manifestPath, 'utf8');
    const log = { warn: vi.fn() };
    const { page } = fakePage({ bytes: newBytes });

    await captureScreenshot(page, DESKTOP_FILE, {
      engine: 'chromium',
      outputDir: dir,
      manifestDir,
      fingerprint: targetFingerprint('desktop', 1) as never,
      log,
    });

    expect(readFileSync(join(dir, DESKTOP_FILE))).toEqual(newBytes);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const checklist = String(log.warn.mock.calls[0]?.[0]);
    expect(checklist).toContain(`differs from ${manifestPath}`);
    expect(checklist).toContain(`- ${manifestPath}: captures[0].sha256 -> ${newSha}`);
    expect(checklist).toContain(
      `npm run verify:screenshots:sha256 -- --manifest ${manifestPath}`,
    );
    expect(checklist).toContain(`Re-capture with: ${CHROMIUM_RECAPTURE}`);
    // The owning manifest on disk was not silently rewritten.
    expect(readFileSync(manifestPath, 'utf8')).toBe(committedManifest);
  });

  it('uses an explicit manifestPath as the label of an injected manifest', async () => {
    const dir = tempScreenshotDir();
    const manifestPath = join(tempScreenshotDir(), DESKTOP_MANIFEST);
    const { page } = fakePage();

    let message = '';
    try {
      await captureScreenshot(page, FILE, {
        engine: 'webkit',
        outputDir: dir,
        manifest: sampleManifest(),
        manifestPath,
        fingerprint: hostFingerprint() as never,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(`tracked by ${manifestPath}`);
    expect(readdirSync(dir)).toEqual([]);
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

    // The checklist captured from the real capture runtime must be recognized
    // by the log verifier, not just contain the expected substrings. A wording
    // or logger-prefix change would otherwise silently fall back to "no
    // records" and stop checking the captured bytes.
    const drifted = verifyScreenshotSha256({ dir, manifest, logText: checklist });
    expect(drifted.logHashes.records).toHaveLength(1);
    expect(drifted.logHashes.records[0]).toMatchObject({
      file: FILE,
      manifestSha256: oldSha,
      capturedSha256: newSha,
    });
    expect(drifted.logHashes.problems).toEqual([
      {
        file: FILE,
        expected: oldSha,
        actual: newSha,
        message: 'captured sha256 differs from the manifest',
      },
    ]);

    // After the explicit manifest refresh the same record passes: the logged
    // `manifest sha256` is a capture-time baseline, not a required match.
    const refreshed = {
      ...manifest,
      captures: [{ ...manifest.captures[0]!, sha256: newSha }],
    };
    const afterRefresh = verifyScreenshotSha256({
      dir,
      manifest: refreshed,
      logText: checklist,
    });
    expect(afterRefresh.hashProblems).toEqual([]);
    expect(afterRefresh.logHashes.ok).toBe(true);
    expect(afterRefresh.logHashes.problems).toEqual([]);
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

  it('uses the committed manifest set when no manifest is passed', async () => {
    const dir = tempScreenshotDir();
    const { page, screenshotSpy } = fakePage();
    // The committed set is parseable and tracks the file; a host capture must
    // be refused without touching the committed PNG. Injecting an empty env
    // keeps the host fingerprint independent of the caller's environment.
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
