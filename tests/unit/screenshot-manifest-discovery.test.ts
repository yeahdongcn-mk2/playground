import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST_DIR,
  MANIFEST_FILE_PATTERN,
  ScreenshotSha256Error,
  discoverSha256ManifestPaths,
  findSha256ManifestCaptureInSet,
  loadSha256Manifests,
} from '../../scripts/lib/screenshot-sha256.mjs';
import type {
  ScreenshotSha256Capture,
  ScreenshotSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMITTED_MANIFEST = join(
  ROOT,
  'docs',
  'screenshots',
  'capture-sha256-manifest.json',
);
const BASE_MANIFEST = JSON.parse(
  readFileSync(COMMITTED_MANIFEST, 'utf8'),
) as ScreenshotSha256Manifest;
const FIRST_CAPTURE = BASE_MANIFEST.captures[0] as ScreenshotSha256Capture;

const DESKTOP_PATH = join(
  DEFAULT_MANIFEST_DIR,
  'capture-sha256-manifest-desktop.json',
);
const MOBILE_PATH = join(
  DEFAULT_MANIFEST_DIR,
  'capture-sha256-manifest-mobile.json',
);
const BASE_PATH = join(DEFAULT_MANIFEST_DIR, 'capture-sha256-manifest.json');

/** A one-capture manifest for the given target, reusing a valid environment. */
function manifestFor(
  file: string,
  target: string,
  dpr: number,
): ScreenshotSha256Manifest {
  return {
    environment: { ...BASE_MANIFEST.environment, target, dpr },
    captures: [{ ...FIRST_CAPTURE, file }],
  };
}

/** Path -> manifest text for the injected manifest reader. */
function manifestTexts(
  entries: Array<{ path: string; manifest: ScreenshotSha256Manifest }>,
): Map<string, string> {
  return new Map(
    entries.map(({ path, manifest }) => [path, JSON.stringify(manifest)]),
  );
}

function readFileFrom(texts: Map<string, string>) {
  return (path: string): string => {
    const text = texts.get(path);
    if (text === undefined) {
      throw new Error(`unexpected manifest read: ${path}`);
    }
    return text;
  };
}

describe('screenshot sha256 manifest set', () => {
  it('discovers only manifest files in the default directory, sorted by name', () => {
    const seenDirectories: string[] = [];
    const paths = discoverSha256ManifestPaths({
      readDir: (dir) => {
        seenDirectories.push(dir);
        return [
          'capture-sha256-manifest-mobile.json',
          'ci-webkit-narrow-manifest.json',
          'capture-sha256-manifest.json',
          'capture-sha256-manifest-desktop.json',
          'README.md',
          'notes.json',
          'capture-sha256-manifest-desktop.json.bak',
        ];
      },
    });

    expect(seenDirectories).toEqual([DEFAULT_MANIFEST_DIR]);
    expect(paths).toEqual([DESKTOP_PATH, MOBILE_PATH, BASE_PATH]);
  });

  it('matches the WebKit and per-target manifest names only', () => {
    for (const name of [
      'capture-sha256-manifest.json',
      'capture-sha256-manifest-desktop.json',
      'capture-sha256-manifest-mobile.json',
      'capture-sha256-manifest-mobile-touch.json',
    ]) {
      expect(MANIFEST_FILE_PATTERN.test(name), name).toBe(true);
    }
    for (const name of [
      'ci-webkit-narrow-manifest.json',
      'capture-sha256-manifest.json.bak',
      'capture-sha256-manifest-desktop.JSON',
      'capture-sha256-manifest-.json',
      'capture-sha256-manifest_desktop.json',
    ]) {
      expect(MANIFEST_FILE_PATTERN.test(name), name).toBe(false);
    }
  });

  it('discovers the committed manifests with the real default reader', () => {
    const paths = discoverSha256ManifestPaths();

    expect(paths).toContain(BASE_PATH);
    expect(paths).not.toContain(
      join(DEFAULT_MANIFEST_DIR, 'ci-webkit-narrow-manifest.json'),
    );
    expect(paths).toEqual([...paths].sort());
    for (const path of paths) {
      expect(MANIFEST_FILE_PATTERN.test(basename(path)), path).toBe(true);
    }
  });

  it('loads every manifest sorted by name and ignores unrelated JSON', () => {
    const texts = manifestTexts([
      {
        path: MOBILE_PATH,
        manifest: manifestFor('after-blank-mobile.png', 'mobile', 2),
      },
      {
        path: DESKTOP_PATH,
        manifest: manifestFor('after-blank-desktop.png', 'desktop', 1),
      },
    ]);
    const readPaths: string[] = [];
    const manifests = loadSha256Manifests({
      readDir: () => [
        'capture-sha256-manifest-mobile.json',
        'ci-webkit-narrow-manifest.json',
        'capture-sha256-manifest-desktop.json',
      ],
      readFile: (path) => {
        readPaths.push(path);
        return readFileFrom(texts)(path);
      },
    });

    expect(manifests.map(({ path }) => path)).toEqual([
      DESKTOP_PATH,
      MOBILE_PATH,
    ]);
    expect(
      manifests.map(({ manifest }) => manifest.environment.target),
    ).toEqual(['desktop', 'mobile']);
    expect(manifests[0]?.manifest.captures[0]?.file).toBe(
      'after-blank-desktop.png',
    );
    expect(manifests[1]?.manifest.captures[0]?.file).toBe(
      'after-blank-mobile.png',
    );
    expect(readPaths).toEqual([DESKTOP_PATH, MOBILE_PATH]);
  });

  it('rejects a capture file recorded by more than one manifest', () => {
    const texts = manifestTexts([
      {
        path: DESKTOP_PATH,
        manifest: manifestFor('after-blank-desktop.png', 'desktop', 1),
      },
      {
        path: MOBILE_PATH,
        manifest: manifestFor('after-blank-desktop.png', 'mobile', 2),
      },
    ]);

    let error: unknown;
    try {
      loadSha256Manifests({
        readDir: () => [
          'capture-sha256-manifest-desktop.json',
          'capture-sha256-manifest-mobile.json',
        ],
        readFile: readFileFrom(texts),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScreenshotSha256Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain(
      'duplicate capture file "after-blank-desktop.png"',
    );
    expect(error.message).toContain(DESKTOP_PATH);
    expect(error.message).toContain(MOBILE_PATH);
  });

  it('treats a case alias across manifests as the same file', () => {
    const texts = manifestTexts([
      {
        path: DESKTOP_PATH,
        manifest: manifestFor('after-blank-desktop.png', 'desktop', 1),
      },
      {
        path: MOBILE_PATH,
        manifest: manifestFor('After-Blank-Desktop.png', 'mobile', 2),
      },
    ]);

    expect(() =>
      loadSha256Manifests({
        readDir: () => [
          'capture-sha256-manifest-desktop.json',
          'capture-sha256-manifest-mobile.json',
        ],
        readFile: readFileFrom(texts),
      }),
    ).toThrow(/duplicate capture file/);
  });

  it('treats a missing manifest directory as an empty manifest set', () => {
    const missingDir = join(ROOT, 'docs', 'screenshots', 'does-not-exist');
    const enoent = Object.assign(
      new Error(`ENOENT: no such file or directory, scandir '${missingDir}'`),
      { code: 'ENOENT' },
    );

    expect(discoverSha256ManifestPaths({ dir: missingDir })).toEqual([]);
    expect(
      discoverSha256ManifestPaths({
        dir: missingDir,
        readDir: () => {
          throw enoent;
        },
      }),
    ).toEqual([]);

    const readPaths: string[] = [];
    expect(
      loadSha256Manifests({
        dir: missingDir,
        readFile: (path) => {
          readPaths.push(path);
          return '{}';
        },
      }),
    ).toEqual([]);
    expect(readPaths).toEqual([]);
  });

  it('reports a directory error that is not a missing directory', () => {
    const denied = Object.assign(
      new Error('EACCES: permission denied, scandir'),
      { code: 'EACCES' },
    );

    expect(() =>
      discoverSha256ManifestPaths({
        readDir: () => {
          throw denied;
        },
      }),
    ).toThrow(ScreenshotSha256Error);
    expect(() =>
      discoverSha256ManifestPaths({
        readDir: () => {
          throw denied;
        },
      }),
    ).toThrow(/cannot read screenshot manifest directory/);
  });

  it('names the manifest path when a discovered manifest is invalid', () => {
    let error: unknown;
    try {
      loadSha256Manifests({
        readDir: () => ['capture-sha256-manifest-desktop.json'],
        readFile: () => '{}',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScreenshotSha256Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain(DESKTOP_PATH);
    expect(error.message).toContain(
      '"captures" must be a non-empty array of screenshot entries',
    );
  });

  it('finds the owning manifest for a capture file', () => {
    const desktop = {
      path: DESKTOP_PATH,
      manifest: manifestFor('after-blank-desktop.png', 'desktop', 1),
    };
    const mobile = {
      path: MOBILE_PATH,
      manifest: manifestFor('after-blank-mobile.png', 'mobile', 2),
    };
    const found = findSha256ManifestCaptureInSet(
      [desktop, mobile],
      'after-blank-mobile.png',
    );

    expect(found?.path).toBe(MOBILE_PATH);
    expect(found?.manifest).toBe(mobile.manifest);
    expect(found?.capture.file).toBe('after-blank-mobile.png');

    expect(
      findSha256ManifestCaptureInSet(
        [desktop, mobile],
        'after-blank-webkit.png',
      ),
    ).toBeNull();
    expect(
      findSha256ManifestCaptureInSet([], 'after-blank-desktop.png'),
    ).toBeNull();
    expect(
      findSha256ManifestCaptureInSet(null, 'after-blank-desktop.png'),
    ).toBeNull();
    expect(
      findSha256ManifestCaptureInSet(undefined, 'after-blank-desktop.png'),
    ).toBeNull();
  });
});
