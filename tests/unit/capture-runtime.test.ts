import type { Browser } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from '../../scripts/lib/capture-env.mjs';
import {
  createDesktopContext,
  createMobileContext,
  createPhoneContext,
  logCaptureEnvironment,
} from '../../scripts/lib/capture-runtime.mjs';

const BROWSER_VERSION = '144.0.1';

function fakeBrowser(version = BROWSER_VERSION): Browser {
  return {
    version: () => version,
    newContext: vi.fn(async () => ({ close: async () => {} })),
  } as unknown as Browser;
}

function loggedLines(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls.map(([line]) => String(line));
}

beforeEach(() => {
  vi.stubEnv('CAPTURE_CONTAINER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('capture environment fingerprint in the capture runtime', () => {
  it('records a desktop context as the real target=desktop dpr=1 log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = fakeBrowser();

    await createDesktopContext(browser, {
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });

    expect(loggedLines(log)).toEqual([
      'capture-env: source=host target=desktop dpr=1 image=unavailable ' +
        `node=${process.version} playwright=${PLAYWRIGHT_IMAGE_PIN.version} ` +
        `browser=${BROWSER_VERSION} fonts=unavailable env=unavailable`,
    ]);
  });

  it('records a Chromium phone context as the real target=mobile dpr=2 log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = fakeBrowser();

    const context = await createMobileContext(browser, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    expect(context).toEqual({ close: expect.any(Function) });
    expect(loggedLines(log)).toEqual([
      'capture-env: source=host target=mobile dpr=2 image=unavailable ' +
        `node=${process.version} playwright=${PLAYWRIGHT_IMAGE_PIN.version} ` +
        `browser=${BROWSER_VERSION} fonts=unavailable env=unavailable`,
    ]);
  });

  it('records WebKit phone contexts as target=webkit dpr=2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPhoneContext(fakeBrowser('27.2'), 'webkit');

    const [line] = loggedLines(log);
    expect(line).toContain('target=webkit dpr=2');
    expect(line).toContain('browser=27.2');
  });

  it('logs each target once per browser even with several contexts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = fakeBrowser();

    await createDesktopContext(browser);
    await createDesktopContext(browser);
    await createMobileContext(browser);
    await createMobileContext(browser);

    expect(loggedLines(log).map((line) => line.split(' ')[2])).toEqual([
      'target=desktop',
      'target=mobile',
    ]);
  });

  it('records the injected container fingerprint for a phone target', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const containerEnv = {
      CAPTURE_CONTAINER: '1',
      CAPTURE_IMAGE_TAG: PLAYWRIGHT_IMAGE_PIN.tag,
      CAPTURE_IMAGE_DIGEST: PLAYWRIGHT_IMAGE_PIN.digest,
      CAPTURE_TARGET: 'desktop,mobile',
      CAPTURE_TARGET_DPR: '1,2',
      EGL_PLATFORM: 'surfaceless',
      LIBGL_ALWAYS_SOFTWARE: '1',
      __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json',
    };

    logCaptureEnvironment('mobile', fakeBrowser(), {
      env: containerEnv,
      run: { fontPackages: 'unavailable' },
    });

    const [line] = loggedLines(log);
    expect(line).toContain('source=container target=mobile dpr=2');
    expect(line).toContain(
      `image=${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
    );
    expect(line).toContain('fonts=unavailable');
    expect(line).toContain('env=EGL_PLATFORM=surfaceless');
  });
});
