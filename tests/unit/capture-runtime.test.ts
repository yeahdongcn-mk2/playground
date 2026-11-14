import { devices, type Browser } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from '../../scripts/lib/capture-env.mjs';
import {
  TOUCH_MOBILE_DEVICE,
  createDesktopContext,
  createMobileContext,
  createPhoneContext,
  createTouchMobileContext,
  logCaptureEnvironment,
} from '../../scripts/lib/capture-runtime.mjs';

const BROWSER_VERSION = '144.0.1';

/** Environment the container entry injects for a Chromium desktop + phone run. */
function containerEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CAPTURE_CONTAINER: '1',
    CAPTURE_IMAGE_TAG: PLAYWRIGHT_IMAGE_PIN.tag,
    CAPTURE_IMAGE_DIGEST: PLAYWRIGHT_IMAGE_PIN.digest,
    CAPTURE_TARGET: 'desktop,mobile',
    CAPTURE_TARGET_DPR: '1,2',
    EGL_PLATFORM: 'surfaceless',
    LIBGL_ALWAYS_SOFTWARE: '1',
    __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json',
    ...overrides,
  };
}

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
  vi.stubEnv('CAPTURE_TARGET', '');
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

  it('creates the Pixel 7 touch context and records target=mobile-touch dpr=2.625', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = fakeBrowser();
    // `screen` is present in the runtime Pixel 7 descriptor but not in
    // Playwright's DeviceDescriptor type; the helper must pass it through so
    // the capture keeps the committed framing.
    const device = devices['Pixel 7'] as (typeof devices)['Pixel 7'] & {
      screen: { width: number; height: number };
    };
    expect(TOUCH_MOBILE_DEVICE).toBe('Pixel 7');

    const context = await createTouchMobileContext(browser, {
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });

    expect(context).toEqual({ close: expect.any(Function) });
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: device.viewport,
      screen: device.screen,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      userAgent: device.userAgent,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    expect(device.deviceScaleFactor).toBe(2.625);
    expect(loggedLines(log)).toEqual([
      'capture-env: source=host target=mobile-touch dpr=2.625 image=unavailable ' +
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
    const env = containerEnv();

    logCaptureEnvironment('mobile', fakeBrowser(), {
      env,
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

  it('records the injected mobile-touch fingerprint at DPR 2.625', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logCaptureEnvironment('mobile-touch', fakeBrowser(), {
      env: containerEnv({
        CAPTURE_TARGET: 'desktop,mobile,mobile-touch',
        CAPTURE_TARGET_DPR: '1,2,2.625',
      }),
      run: { fontPackages: 'unavailable' },
    });

    const [line] = loggedLines(log);
    expect(line).toContain('source=container target=mobile-touch dpr=2.625');
  });
});

describe('container runtime target assertion', () => {
  it('records a webkit target when CAPTURE_TARGET declares it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logCaptureEnvironment('webkit', fakeBrowser('27.2'), {
      env: containerEnv({ CAPTURE_TARGET: 'webkit', CAPTURE_TARGET_DPR: '2' }),
      run: { fontPackages: 'unavailable' },
    });

    expect(warn).not.toHaveBeenCalled();
    const lines = loggedLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('source=container target=webkit dpr=2');
  });

  it('fails a WebKit context whose target is missing from CAPTURE_TARGET', async () => {
    vi.stubEnv('CAPTURE_CONTAINER', '1');
    vi.stubEnv('CAPTURE_TARGET', 'desktop,mobile');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(createPhoneContext(fakeBrowser('27.2'), 'webkit')).rejects.toThrow(
      /Capture target "webkit" was recorded but is not listed in CAPTURE_TARGET="desktop,mobile".*npm run screenshots:container/s,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('fails a mobile-touch context whose target is missing from CAPTURE_TARGET', async () => {
    vi.stubEnv('CAPTURE_CONTAINER', '1');
    vi.stubEnv('CAPTURE_TARGET', 'desktop,mobile');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(createTouchMobileContext(fakeBrowser())).rejects.toThrow(
      /Capture target "mobile-touch" was recorded but is not listed in CAPTURE_TARGET="desktop,mobile".*npm run screenshots:container/s,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('fails recording a target missing from CAPTURE_TARGET without writing a fingerprint', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() =>
      logCaptureEnvironment('webkit', fakeBrowser(), {
        env: containerEnv(),
        run: { fontPackages: 'unavailable' },
      }),
    ).toThrow(
      /Capture target "webkit" was recorded but is not listed in CAPTURE_TARGET="desktop,mobile".*npm run screenshots:container/s,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps host fingerprint-only behaviour without CAPTURE_TARGET', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createDesktopContext(fakeBrowser());

    const [line] = loggedLines(log);
    expect(line).toContain('source=host target=desktop dpr=1');
  });

  it('logs each declared target once per browser in the container', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const browser = fakeBrowser();
    const env = containerEnv();
    const run = { fontPackages: 'unavailable' as const };

    logCaptureEnvironment('desktop', browser, { env, run });
    logCaptureEnvironment('desktop', browser, { env, run });
    logCaptureEnvironment('mobile', browser, { env, run });
    logCaptureEnvironment('mobile', browser, { env, run });

    expect(loggedLines(log).map((line) => line.split(' ')[2])).toEqual([
      'target=desktop',
      'target=mobile',
    ]);
  });
});
