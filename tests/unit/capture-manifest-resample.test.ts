import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_CAPTURE_ATTEMPTS,
  captureManifestedScreenshot,
  expectedCaptureSha256,
} from '../../scripts/lib/capture-runtime.mjs';
import type { ScreenshotSha256Manifest } from '../../scripts/lib/screenshot-sha256.mjs';

const NAME = 'after-2048-gameover-webkit.png';
const EXPECTED = sha256('canonical png bytes');

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesFor(label: string): Buffer {
  return Buffer.from(label);
}

function manifestWith(sha: string): ScreenshotSha256Manifest {
  return {
    environment: {
      source: 'container',
      target: 'webkit',
      dpr: 2,
      platform: 'docker',
      image: {
        repository: 'mcr.microsoft.com/playwright',
        tag: 'v1.64.1-noble',
        digest: 'sha256:' + 'a'.repeat(64),
      },
      egl: { EGL_PLATFORM: 'surfaceless' },
      fonts: [],
    },
    captures: [
      {
        file: NAME,
        sha256: sha,
        command: 'npm run screenshots:container -- screenshots:2048:webkit',
        provenance: {
          container: 'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:' + 'a'.repeat(64),
          captureCommit: 'b'.repeat(40),
        },
      },
    ],
  } as ScreenshotSha256Manifest;
}

interface SamplePage {
  page: Page;
  close: ReturnType<typeof vi.fn>;
}

/** A page double the helper only closes; the capture seams are injected. */
function samplePage(): SamplePage {
  const close = vi.fn(async () => {});
  return { page: { close } as unknown as Page, close };
}

/** Collect the pages a resample run opens, in order. */
function pageFactory(): { openPage: () => Promise<Page>; pages: SamplePage[] } {
  const pages: SamplePage[] = [];
  return {
    pages,
    openPage: async () => {
      const created = samplePage();
      pages.push(created);
      return created.page;
    },
  };
}

describe('expectedCaptureSha256', () => {
  it('returns the sha256 recorded for the file', () => {
    expect(expectedCaptureSha256(NAME, { manifest: manifestWith(EXPECTED) })).toBe(
      EXPECTED,
    );
  });

  it('returns null for an unrecorded file and a missing manifest', () => {
    expect(
      expectedCaptureSha256('after-hub-webkit.png', {
        manifest: manifestWith(EXPECTED),
      }),
    ).toBeNull();
    expect(expectedCaptureSha256(NAME, { manifest: null })).toBeNull();
  });
});

describe('captureManifestedScreenshot', () => {
  it('writes the first sample that matches the recorded sha256', async () => {
    const page = pageFactory();
    const prepare = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const captureBytes = vi
      .fn()
      .mockResolvedValueOnce(bytesFor('wrong header variant'))
      .mockResolvedValueOnce(bytesFor('wrong overlay variant'))
      .mockResolvedValueOnce(bytesFor('canonical png bytes'));
    const log = { warn: vi.fn() };

    await captureManifestedScreenshot({
      name: NAME,
      engine: 'webkit',
      openPage: page.openPage,
      prepare,
      captureBytes,
      write,
      expectedSha256: EXPECTED,
      log,
    });

    // Two wrong variants were discarded, one fresh page each, and only the
    // matched bytes reached the writer.
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(captureBytes).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      page.pages[2]?.page,
      bytesFor('canonical png bytes'),
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
    // Every sampled page is closed, including the matching one after writing.
    for (const created of page.pages) {
      expect(created.close).toHaveBeenCalledTimes(1);
    }
  });

  it('returns without opening another page when the first sample matches', async () => {
    const page = pageFactory();
    const write = vi.fn(async () => {});

    await captureManifestedScreenshot({
      name: NAME,
      engine: 'webkit',
      openPage: page.openPage,
      prepare: async () => {},
      captureBytes: async () => bytesFor('canonical png bytes'),
      write,
      expectedSha256: EXPECTED,
    });

    expect(page.pages).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('fails after the budget with the observed hashes and writes nothing', async () => {
    const page = pageFactory();
    const write = vi.fn(async () => {});
    const captureBytes = vi.fn(async () => bytesFor('wrong but stable raster'));

    await expect(
      captureManifestedScreenshot({
        name: NAME,
        engine: 'webkit',
        openPage: page.openPage,
        prepare: async () => {},
        captureBytes,
        write,
        attempts: 3,
        expectedSha256: EXPECTED,
        log: { warn: vi.fn() },
      }),
    ).rejects.toThrow(
      new RegExp(
        `did not reproduce the recorded ${NAME} sha256 ${EXPECTED} in 3 fresh pages \\(observed: ` +
          `${sha256('wrong but stable raster')}, `,
      ),
    );

    expect(captureBytes).toHaveBeenCalledTimes(3);
    expect(page.pages).toHaveLength(3);
    expect(write).not.toHaveBeenCalled();
    for (const created of page.pages) {
      expect(created.close).toHaveBeenCalledTimes(1);
    }
  });

  it('samples once and writes unconditionally with allowNewBytes', async () => {
    const page = pageFactory();
    const write = vi.fn(async () => {});

    await captureManifestedScreenshot({
      name: NAME,
      engine: 'webkit',
      openPage: page.openPage,
      prepare: async () => {},
      captureBytes: async () => bytesFor('intentional new UI'),
      write,
      allowNewBytes: true,
      expectedSha256: EXPECTED,
    });

    expect(page.pages).toHaveLength(1);
    expect(write).toHaveBeenCalledWith(page.pages[0]?.page, bytesFor('intentional new UI'));
  });

  it('defaults to a fullPage screenshot with animations disabled', async () => {
    const screenshot = vi.fn(async () => bytesFor('canonical png bytes'));
    const close = vi.fn(async () => {});
    const page = { close, screenshot } as unknown as Page;
    const write = vi.fn(async () => {});

    await captureManifestedScreenshot({
      name: NAME,
      engine: 'webkit',
      fullPage: true,
      openPage: async () => page,
      prepare: async () => {},
      write,
      expectedSha256: EXPECTED,
    });

    // The capture scripts omit captureBytes, so this default is the production
    // screenshot path for every resampled 2048 / minesweeper state.
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledWith({
      fullPage: true,
      animations: 'disabled',
    });
    expect(write).toHaveBeenCalledWith(page, bytesFor('canonical png bytes'));
  });

  it('samples once for an unrecorded file', async () => {
    const page = pageFactory();
    const write = vi.fn(async () => {});

    await captureManifestedScreenshot({
      name: NAME,
      engine: 'webkit',
      openPage: page.openPage,
      prepare: async () => {},
      captureBytes: async () => bytesFor('new evidence'),
      write,
      expectedSha256: null,
    });

    expect(page.pages).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('spends another sample when a page never produces a stable frame', async () => {
    const page = pageFactory();
    const write = vi.fn(async () => {});
    const captureBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error('screenshot did not produce 2 identical frames'))
      .mockResolvedValueOnce(bytesFor('canonical png bytes'));

    await captureManifestedScreenshot({
      name: NAME,
      engine: 'webkit',
      openPage: page.openPage,
      prepare: async () => {},
      captureBytes,
      write,
      expectedSha256: EXPECTED,
      log: { warn: vi.fn() },
    });

    expect(page.pages).toHaveLength(2);
    expect(write).toHaveBeenCalledWith(
      page.pages[1]?.page,
      bytesFor('canonical png bytes'),
    );
  });

  it('rethrows the last unstable-frame error instead of writing', async () => {
    const page = pageFactory();
    const write = vi.fn(async () => {});

    await expect(
      captureManifestedScreenshot({
        name: NAME,
        engine: 'webkit',
        openPage: page.openPage,
        prepare: async () => {},
        captureBytes: async () => {
          throw new Error('screenshot did not produce 2 identical frames');
        },
        write,
        attempts: 2,
        expectedSha256: EXPECTED,
        log: { warn: vi.fn() },
      }),
    ).rejects.toThrow('did not produce 2 identical frames');

    expect(page.pages).toHaveLength(2);
    expect(write).not.toHaveBeenCalled();
  });

  it('runs the environment preflight only on the first sample', async () => {
    const page = pageFactory();
    const calls: string[] = [];
    const checkEnvironment = vi.fn(async () => {
      calls.push('check');
    });
    const prepare = vi.fn(async () => {
      calls.push('prepare');
    });

    await captureManifestedScreenshot({
      name: NAME,
      engine: 'webkit',
      openPage: page.openPage,
      prepare,
      captureBytes: async () =>
        page.pages.length === 1 ? bytesFor('wrong') : bytesFor('canonical png bytes'),
      write: async () => {},
      checkEnvironment,
      expectedSha256: EXPECTED,
      log: { warn: vi.fn() },
    });

    expect(checkEnvironment).toHaveBeenCalledTimes(1);
    expect(page.pages).toHaveLength(2);
    // The preflight runs before the first state setup, then a retry prepares
    // another page without repeating the environment check.
    expect(calls).toEqual(['check', 'prepare', 'prepare']);
    expect(checkEnvironment).toHaveBeenCalledWith(page.pages[0]?.page);
  });

  it('propagates a preflight failure without preparing a page or writing', async () => {
    const page = pageFactory();
    const prepare = vi.fn(async () => {});

    await expect(
      captureManifestedScreenshot({
        name: NAME,
        engine: 'webkit',
        openPage: page.openPage,
        prepare,
        captureBytes: async () => bytesFor('canonical png bytes'),
        write: async () => {},
        checkEnvironment: async () => {
          throw new Error('host environment mismatch');
        },
        expectedSha256: EXPECTED,
      }),
    ).rejects.toThrow('host environment mismatch');

    expect(prepare).not.toHaveBeenCalled();
    expect(page.pages[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-positive attempt budget', async () => {
    await expect(
      captureManifestedScreenshot({
        name: NAME,
        engine: 'webkit',
        openPage: pageFactory().openPage,
        prepare: async () => {},
        write: async () => {},
        attempts: 0,
        expectedSha256: EXPECTED,
      }),
    ).rejects.toThrow(/positive integer attempts/);
  });

  it('defaults the sample budget to the documented constant', () => {
    expect(MANIFEST_CAPTURE_ATTEMPTS).toBe(20);
  });
});
