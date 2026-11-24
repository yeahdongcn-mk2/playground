import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_EGL_ENV,
  CAPTURE_FONT_PACKAGES,
  CAPTURE_PLATFORM,
  CAPTURE_TARGET_DPRS,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
} from '../../scripts/lib/capture-env.mjs';
import {
  DEFAULT_MANIFEST_DIR,
  findSha256ManifestCaptureInSet,
  loadSha256Manifests,
  manifestEnvironmentMismatches,
} from '../../scripts/lib/screenshot-sha256.mjs';
import type { ScreenshotSha256Manifest } from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const WORKFLOW = readFileSync(
  join(ROOT, '.github', 'workflows', 'capture-repro.yml'),
  'utf8',
);
const CLI = join(ROOT, 'scripts', 'verify-screenshot-sha256.mjs');

const CHROMIUM_COMMAND = 'npm run screenshots:container -- screenshots';
const BASE_MANIFEST_PATH = join(DEFAULT_MANIFEST_DIR, 'capture-sha256-manifest.json');

interface BlankManifestCase {
  path: string;
  file: string;
  target: 'desktop' | 'mobile';
}

const BLANK_MANIFESTS: BlankManifestCase[] = [
  {
    path: join(DEFAULT_MANIFEST_DIR, 'capture-sha256-manifest-desktop.json'),
    file: 'after-blank-desktop.png',
    target: 'desktop',
  },
  {
    path: join(DEFAULT_MANIFEST_DIR, 'capture-sha256-manifest-mobile.json'),
    file: 'after-blank-mobile.png',
    target: 'mobile',
  },
];

const MANIFESTS = loadSha256Manifests();
const BY_PATH = new Map(
  MANIFESTS.map(({ path, manifest }) => [path, manifest] as const),
);

const IMAGE_REFERENCE =
  `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}` +
  `@${PLAYWRIGHT_IMAGE_PIN.digest}`;

function sha256File(file: string): string {
  return createHash('sha256')
    .update(readFileSync(join(DEFAULT_MANIFEST_DIR, file)))
    .digest('hex');
}

function requireManifest(path: string): ScreenshotSha256Manifest {
  const manifest = BY_PATH.get(path);
  if (manifest === undefined) {
    throw new Error(`missing discovered manifest ${path}`);
  }
  return manifest;
}

describe('Chromium blank-canvas sha256 manifests (Issue #439)', () => {
  it('discovers the WebKit and two target-split manifests without duplicate files', () => {
    expect(MANIFESTS).toHaveLength(3);

    const files = MANIFESTS.flatMap(({ manifest }) =>
      manifest.captures.map((capture) => capture.file),
    );
    expect(files).toHaveLength(16);
    expect(new Set(files).size).toBe(16);

    const base = requireManifest(BASE_MANIFEST_PATH);
    expect(base.environment.target).toBe('webkit');
    expect(base.environment.dpr).toBe(2);
    expect(base.captures).toHaveLength(14);
    expect(base.captures.map((capture) => capture.file)).not.toContain(
      'after-blank-desktop.png',
    );
    expect(base.captures.map((capture) => capture.file)).not.toContain(
      'after-blank-mobile.png',
    );
  });

  it('records the desktop and mobile target, DPR and fixed environment', () => {
    for (const { path, file, target } of BLANK_MANIFESTS) {
      const manifest = requireManifest(path);

      expect(manifest.environment.source, path).toBe('container');
      expect(manifest.environment.target, path).toBe(target);
      expect(manifest.environment.dpr, path).toBe(CAPTURE_TARGET_DPRS[target]);
      expect(manifest.environment.platform, path).toBe(CAPTURE_PLATFORM);
      expect(manifest.environment.image, path).toEqual({
        repository: PLAYWRIGHT_IMAGE_REPOSITORY,
        tag: PLAYWRIGHT_IMAGE_PIN.tag,
        digest: PLAYWRIGHT_IMAGE_PIN.digest,
      });
      expect(manifest.environment.egl, path).toEqual(CAPTURE_EGL_ENV);
      expect(manifest.environment.fonts.map((font) => font.name), path).toEqual([
        ...CAPTURE_FONT_PACKAGES,
      ]);
      expect(manifestEnvironmentMismatches(manifest), path).toEqual([]);
      expect(manifest.captures.map((capture) => capture.file), path).toEqual([file]);
    }
  });

  it('pins each PNG sha256, recapture command and 40-character capture commit', () => {
    for (const { path, file } of BLANK_MANIFESTS) {
      const manifest = requireManifest(path);
      const capture = manifest.captures[0];

      expect(capture, `${path} should record ${file}`).toBeDefined();
      expect(capture?.file).toBe(file);
      expect(capture?.command).toBe(CHROMIUM_COMMAND);
      expect(capture?.sha256).toBe(sha256File(file));
      expect(capture?.provenance.container).toBe(IMAGE_REFERENCE);
      expect(capture?.provenance.captureCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(capture?.provenance.captureCommit).toBe(
        'badc5fefa4d3a8a4810e5d944b75121ffb8c3761',
      );
    }
  });

  it('finds each blank file in exactly its own manifest', () => {
    for (const { path, file, target } of BLANK_MANIFESTS) {
      const found = findSha256ManifestCaptureInSet(MANIFESTS, file);
      expect(found?.path, file).toBe(path);
      expect(found?.capture.file, file).toBe(file);
      expect(found?.manifest.environment.target, file).toBe(target);
    }
  });

  it('matches the README manifest table and documents both recapture commands', () => {
    for (const { path, file } of BLANK_MANIFESTS) {
      const capture = requireManifest(path).captures[0];
      const rows = SCREENSHOTS_README.split('\n').filter(
        (line) =>
          line.startsWith('|') &&
          line.includes(`\`${file}\``) &&
          line.includes(`\`${path}\``),
      );

      expect(rows, `missing manifest table row for ${file}`).toHaveLength(1);
      const row = rows[0] ?? '';
      expect(row).toContain(`\`${capture?.sha256}\``);
      expect(row).toContain(`\`${CHROMIUM_COMMAND}\``);
      expect(row).toContain(`\`${capture?.provenance.captureCommit}\``);
      expect(SCREENSHOTS_README).toContain(
        `npm run verify:screenshots:sha256 -- --manifest ${path}`,
      );
    }

    expect(SCREENSHOTS_README).toContain('3 份清单 / 16 个 capture');
    expect(SCREENSHOTS_README).not.toContain(
      '这两行是两张空白画布图尺寸与完整 sha256 的唯一自动校验来源',
    );
    expect(SCREENSHOTS_README).toContain('doc-dims 不再是这两张图的唯一自动来源');
  });

  it('derives seven nightly manifest targets from the sixteen captures', () => {
    const commands = MANIFESTS.flatMap(({ manifest }) =>
      manifest.captures.map((capture) => capture.command),
    );
    const targets = new Set(commands);

    // The manifests are the source of truth: 16 captures map onto 7 distinct
    // capture commands, each of which the nightly repro runs twice.
    expect(commands).toHaveLength(16);
    expect(targets.size).toBe(7);
    expect(targets.has(CHROMIUM_COMMAND)).toBe(true);

    // The workflow job comment and README carry the human-facing copy of the
    // same manifest-derived contract.
    expect(WORKFLOW).toContain(
      'Fourteen captures (seven manifest targets x two runs)',
    );
    expect(SCREENSHOTS_README).toContain('7 个 target');
    expect(SCREENSHOTS_README).toContain('14 次 capture invocation');
  });

  it('verifies all sixteen captures through the sha256 CLI', () => {
    const result = spawnSync(process.execPath, [CLI], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'OK: 16 screenshot sha256 entries verified across 3 manifests',
    );
  });
});
