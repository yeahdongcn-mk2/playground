import { describe, expect, it } from 'vitest';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  CAPTURE_FONT_PACKAGES,
  CAPTURE_TARGETS,
  PLAYWRIGHT_IMAGE_REPOSITORY,
  PLAYWRIGHT_IMAGE_PIN,
  assertContainerCaptureEnvironment,
  assertImageTagMatchesPlaywrightVersion,
  captureEnvironmentFingerprint,
  dprForCaptureTarget,
  formatCaptureEnvironmentFingerprint,
  imageTagForPlaywrightVersion,
  normalizeCaptureTargets,
  probeFontPackages,
  readPlaywrightVersion,
  resolveCaptureImage,
} from '../../scripts/lib/capture-env.mjs';

type Env = Record<string, string | undefined>;

const CONTAINER_ENV: Env = {
  CAPTURE_CONTAINER: '1',
  CAPTURE_IMAGE_TAG: PLAYWRIGHT_IMAGE_PIN.tag,
  CAPTURE_IMAGE_DIGEST: PLAYWRIGHT_IMAGE_PIN.digest,
  CAPTURE_TARGET: 'webkit',
  CAPTURE_TARGET_DPR: '2',
  ...CAPTURE_EGL_ENV,
};

const FINGERPRINT_FIELDS = [
  'source',
  'target',
  'dpr',
  'image',
  'node',
  'playwright',
  'browser',
  'fonts',
  'env',
];

describe('capture image pin', () => {
  it('derives the image tag from the installed Playwright version', () => {
    expect(imageTagForPlaywrightVersion('1.64.1')).toBe('v1.64.1-noble');
    expect(readPlaywrightVersion()).toBe(PLAYWRIGHT_IMAGE_PIN.version);
    expect(PLAYWRIGHT_IMAGE_PIN.tag).toBe(imageTagForPlaywrightVersion('1.64.1'));
    expect(PLAYWRIGHT_IMAGE_PIN.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('resolves the pinned image reference', () => {
    const image = resolveCaptureImage({ version: '1.64.1' });
    expect(image).toEqual({
      repository: PLAYWRIGHT_IMAGE_REPOSITORY,
      tag: PLAYWRIGHT_IMAGE_PIN.tag,
      digest: PLAYWRIGHT_IMAGE_PIN.digest,
      version: '1.64.1',
      reference: `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
    });
  });

  it('rejects a lockfile Playwright version that has no pinned image', () => {
    expect(() => resolveCaptureImage({ version: '1.65.0' })).toThrow(
      /v1\.64\.1-noble.*1\.65\.0|does not match/,
    );
    expect(() =>
      assertImageTagMatchesPlaywrightVersion('v1.64.0-noble', '1.64.1'),
    ).toThrow(/v1\.64\.0-noble.*v1\.64\.1-noble/);
  });

  it('reads the lockfile version and names a missing entry', () => {
    const lockfile = JSON.stringify({
      packages: { 'node_modules/@playwright/test': { version: '1.64.1' } },
    });
    expect(
      readPlaywrightVersion({ lockfilePath: '/fake/package-lock.json', readFile: () => lockfile }),
    ).toBe('1.64.1');
    expect(() => readPlaywrightVersion({ readFile: () => '{}' })).toThrow(
      /does not record node_modules\/@playwright\/test/,
    );
  });
});

describe('capture target DPR contract', () => {
  it('records desktop DPR 1, mobile / WebKit DPR 2 and mobile-touch DPR 2.625', () => {
    expect(dprForCaptureTarget('desktop')).toBe(1);
    expect(dprForCaptureTarget('mobile')).toBe(2);
    expect(dprForCaptureTarget('mobile-touch')).toBe(2.625);
    expect(dprForCaptureTarget('webkit')).toBe(2);
    expect(CAPTURE_TARGETS).toEqual(['desktop', 'mobile', 'mobile-touch', 'webkit']);
    expect(() => dprForCaptureTarget('tablet')).toThrow(/Unknown capture target "tablet"/);
  });

  it('normalizes comma-separated and array target declarations', () => {
    expect(normalizeCaptureTargets(' desktop, mobile, mobile-touch ')).toEqual([
      'desktop',
      'mobile',
      'mobile-touch',
    ]);
    expect(normalizeCaptureTargets(['desktop', 'mobile', 'mobile-touch'])).toEqual([
      'desktop',
      'mobile',
      'mobile-touch',
    ]);
    expect(normalizeCaptureTargets('webkit')).toEqual(['webkit']);
    expect(normalizeCaptureTargets('mobile-touch')).toEqual(['mobile-touch']);
    expect(normalizeCaptureTargets('')).toBeNull();
    expect(normalizeCaptureTargets(undefined)).toBeNull();
  });

  it('rejects an unknown target inside a declared list', () => {
    expect(() => normalizeCaptureTargets('desktop,tablet')).toThrow(
      /Unknown capture target "tablet"/,
    );
  });
});

describe('font package probe', () => {
  it('returns only the fixed font packages, in contract order, with versions', () => {
    const output = [
      'installed\tfonts-wqy-zenhei\t0.9.45-8',
      'installed\tfontconfig\t2.15.0',
      'installed\tfonts-freefont-ttf\t20211204+svn4273-2',
      'deinstall ok config-files\tfonts-unifont\t1:15.1.01-1build1',
    ].join('\n');

    expect(probeFontPackages({ execFile: () => output })).toEqual([
      { name: 'fonts-freefont-ttf', version: '20211204+svn4273-2' },
      { name: 'fonts-wqy-zenhei', version: '0.9.45-8' },
    ]);
    expect(CAPTURE_FONT_PACKAGES).toContain('fonts-noto-color-emoji');
  });

  it('reports unavailable when the probe cannot run or finds no package', () => {
    expect(
      probeFontPackages({
        execFile: () => {
          throw Object.assign(new Error('dpkg-query: not found'), { code: 'ENOENT' });
        },
      }),
    ).toBe('unavailable');
    expect(probeFontPackages({ execFile: () => '' })).toBe('unavailable');
    expect(probeFontPackages({ execFile: () => 'installed\tfontconfig\t1.0\n' })).toBe(
      'unavailable',
    );
  });
});

describe('captureEnvironmentFingerprint', () => {
  it('keeps a stable field order and marks host runs without throwing', () => {
    const fingerprint = captureEnvironmentFingerprint({
      target: 'desktop',
      run: {
        browserVersion: '144.0.1',
        nodeVersion: 'v24.22.0',
        playwrightVersion: '1.64.1',
      },
      env: {},
    });

    expect(Object.keys(fingerprint)).toEqual(FINGERPRINT_FIELDS);
    expect(fingerprint).toEqual({
      source: 'host',
      target: 'desktop',
      dpr: 1,
      image: null,
      node: 'v24.22.0',
      playwright: '1.64.1',
      browser: '144.0.1',
      fonts: null,
      env: null,
    });
    expect(formatCaptureEnvironmentFingerprint(fingerprint)).toBe(
      'capture-env: source=host target=desktop dpr=1 image=unavailable ' +
        'node=v24.22.0 playwright=1.64.1 browser=144.0.1 fonts=unavailable env=unavailable',
    );
  });

  it('never throws on a host without fonts or EGL variables', () => {
    expect(() =>
      captureEnvironmentFingerprint({
        target: 'mobile',
        run: { browserVersion: '1.0', playwrightVersion: '1.64.1' },
        env: {},
      }),
    ).not.toThrow();
  });

  it('records the mobile-touch target at the fractional Pixel 7 DPR', () => {
    const run = {
      browserVersion: '144.0.1',
      nodeVersion: 'v24.22.0',
      playwrightVersion: '1.64.1',
    };
    const host = captureEnvironmentFingerprint({
      target: 'mobile-touch',
      run,
      env: {},
    });
    expect(host.source).toBe('host');
    expect(host.target).toBe('mobile-touch');
    expect(host.dpr).toBe(2.625);
    expect(formatCaptureEnvironmentFingerprint(host)).toContain(
      'target=mobile-touch dpr=2.625',
    );

    const container = captureEnvironmentFingerprint({
      target: 'mobile-touch',
      run: { ...run, fontPackages: 'unavailable' },
      env: {
        ...CONTAINER_ENV,
        CAPTURE_TARGET: 'mobile-touch',
        CAPTURE_TARGET_DPR: '2.625',
      },
    });
    expect(container.source).toBe('container');
    expect(container.dpr).toBe(2.625);
  });

  it('records the container image, fonts, EGL variables and target DPR', () => {
    const fingerprint = captureEnvironmentFingerprint({
      target: 'webkit',
      run: {
        browserVersion: '26.0',
        nodeVersion: 'v26.13.0',
        playwrightVersion: '1.64.1',
        fontPackages: [{ name: 'fonts-unifont', version: '1:15.1.01-1build1' }],
      },
      env: CONTAINER_ENV,
    });

    expect(Object.keys(fingerprint)).toEqual(FINGERPRINT_FIELDS);
    expect(fingerprint.source).toBe('container');
    expect(fingerprint.dpr).toBe(2);
    expect(fingerprint.image).toEqual({
      repository: PLAYWRIGHT_IMAGE_REPOSITORY,
      tag: PLAYWRIGHT_IMAGE_PIN.tag,
      digest: PLAYWRIGHT_IMAGE_PIN.digest,
    });
    expect(fingerprint.fonts).toEqual([
      { name: 'fonts-unifont', version: '1:15.1.01-1build1' },
    ]);
    expect(fingerprint.env).toEqual(CAPTURE_EGL_ENV);
    expect(fingerprint.env).not.toBe(CAPTURE_EGL_ENV);

    const line = formatCaptureEnvironmentFingerprint(fingerprint);
    expect(line).toContain(
      `image=${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`,
    );
    expect(line).toContain('fonts=fonts-unifont@1:15.1.01-1build1');
    expect(line).toContain(
      'env=EGL_PLATFORM=surfaceless,LIBGL_ALWAYS_SOFTWARE=1,' +
        '__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json',
    );
  });
});

describe('assertContainerCaptureEnvironment', () => {
  it('accepts the injected container contract', () => {
    expect(
      assertContainerCaptureEnvironment({
        env: CONTAINER_ENV,
        targets: ['webkit'],
        version: '1.64.1',
      }),
    ).toEqual({
      targets: ['webkit'],
      dprs: [2],
      imageTag: PLAYWRIGHT_IMAGE_PIN.tag,
      version: '1.64.1',
    });
  });

  it('accepts a mixed desktop / mobile target list with matching DPRs', () => {
    expect(
      assertContainerCaptureEnvironment({
        env: {
          ...CONTAINER_ENV,
          CAPTURE_TARGET: 'desktop,mobile',
          CAPTURE_TARGET_DPR: '1,2',
        },
        targets: ['desktop', 'mobile'],
        version: '1.64.1',
      }),
    ).toEqual({
      targets: ['desktop', 'mobile'],
      dprs: [1, 2],
      imageTag: PLAYWRIGHT_IMAGE_PIN.tag,
      version: '1.64.1',
    });
  });

  it('accepts the fractional mobile-touch DPR 2.625', () => {
    expect(
      assertContainerCaptureEnvironment({
        env: {
          ...CONTAINER_ENV,
          CAPTURE_TARGET: 'desktop,mobile,mobile-touch',
          CAPTURE_TARGET_DPR: '1,2,2.625',
        },
        targets: ['desktop', 'mobile', 'mobile-touch'],
        version: '1.64.1',
      }),
    ).toEqual({
      targets: ['desktop', 'mobile', 'mobile-touch'],
      dprs: [1, 2, 2.625],
      imageTag: PLAYWRIGHT_IMAGE_PIN.tag,
      version: '1.64.1',
    });
  });

  it('rejects a wrong fractional DPR and a malformed decimal list', () => {
    expect(() =>
      assertContainerCaptureEnvironment({
        env: {
          ...CONTAINER_ENV,
          CAPTURE_TARGET: 'mobile-touch',
          CAPTURE_TARGET_DPR: '2.62',
        },
        target: 'mobile-touch',
        version: '1.64.1',
      }),
    ).toThrow(/Capture DPR 2\.62 does not match target "mobile-touch": expected 2\.625/);

    for (const dpr of ['2.625.0', '2.', '.625']) {
      expect(() =>
        assertContainerCaptureEnvironment({
          env: {
            ...CONTAINER_ENV,
            CAPTURE_TARGET: 'mobile-touch',
            CAPTURE_TARGET_DPR: dpr,
          },
          target: 'mobile-touch',
          version: '1.64.1',
        }),
      ).toThrow(/CAPTURE_TARGET_DPR/);
    }
  });

  it('names each missing EGL variable', () => {
    for (const name of CAPTURE_EGL_VARS) {
      const env: Env = { ...CONTAINER_ENV };
      delete env[name];
      expect(() =>
        assertContainerCaptureEnvironment({ env, target: 'webkit', version: '1.64.1' }),
      ).toThrow(new RegExp(name));
    }
  });

  it('names a mismatched EGL variable and its expected value', () => {
    expect(() =>
      assertContainerCaptureEnvironment({
        env: { ...CONTAINER_ENV, LIBGL_ALWAYS_SOFTWARE: '0' },
        target: 'webkit',
        version: '1.64.1',
      }),
    ).toThrow(/"LIBGL_ALWAYS_SOFTWARE" is "0": expected "1"/);
  });

  it('rejects a missing container marker', () => {
    const env: Env = { ...CONTAINER_ENV };
    delete env.CAPTURE_CONTAINER;
    expect(() =>
      assertContainerCaptureEnvironment({ env, target: 'webkit', version: '1.64.1' }),
    ).toThrow(/CAPTURE_CONTAINER/);
  });

  it('rejects a target DPR that contradicts the target', () => {
    expect(() =>
      assertContainerCaptureEnvironment({
        env: { ...CONTAINER_ENV, CAPTURE_TARGET_DPR: '1' },
        target: 'webkit',
        version: '1.64.1',
      }),
    ).toThrow(/Capture DPR 1 does not match target "webkit": expected 2/);
    expect(() =>
      assertContainerCaptureEnvironment({
        env: { ...CONTAINER_ENV, CAPTURE_TARGET_DPR: '' },
        target: 'webkit',
        version: '1.64.1',
      }),
    ).toThrow(/CAPTURE_TARGET_DPR/);
  });

  it('rejects a target / DPR list that does not describe the same targets', () => {
    expect(() =>
      assertContainerCaptureEnvironment({
        env: {
          ...CONTAINER_ENV,
          CAPTURE_TARGET: 'desktop,mobile',
          CAPTURE_TARGET_DPR: '1',
        },
        targets: ['desktop', 'mobile'],
        version: '1.64.1',
      }),
    ).toThrow(/does not match CAPTURE_TARGET="desktop,mobile"/);
    expect(() =>
      assertContainerCaptureEnvironment({
        env: {
          ...CONTAINER_ENV,
          CAPTURE_TARGET: 'desktop,mobile',
          CAPTURE_TARGET_DPR: '1,1',
        },
        targets: ['desktop', 'mobile'],
        version: '1.64.1',
      }),
    ).toThrow(/Capture DPR 1 does not match target "mobile": expected 2/);
  });

  it('rejects an image tag that does not match the lockfile version', () => {
    expect(() =>
      assertContainerCaptureEnvironment({
        env: { ...CONTAINER_ENV, CAPTURE_IMAGE_TAG: 'v1.64.0-noble' },
        target: 'webkit',
        version: '1.64.1',
      }),
    ).toThrow(/v1\.64\.0-noble/);
  });

  it('rejects a target argument that contradicts CAPTURE_TARGET', () => {
    expect(() =>
      assertContainerCaptureEnvironment({
        env: CONTAINER_ENV,
        target: 'desktop',
        version: '1.64.1',
      }),
    ).toThrow(/Capture target "desktop" does not match CAPTURE_TARGET="webkit"/);
  });
});
