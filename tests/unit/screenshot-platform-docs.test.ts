import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPTURE_PLATFORM } from '../../scripts/lib/capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  manifestEnvironmentMismatches,
  manifestPlatformMismatch,
  parseCaptureEnvironmentFingerprintLine,
  parseSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const MANIFEST_TEXT = readFileSync(join(ROOT, DEFAULT_MANIFEST_PATH), 'utf8');

const FIXED_ENVIRONMENT_HEADING = '## 固定捕获环境（Issue #199）';
const MANIFEST_HEADING = '### 已提交证据 sha256 清单与校验（Issue #199）';

/** The text of one Markdown section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * The fixed-environment section excludes its nested sha256-manifest
 * subsection: the two headings assert different contracts, and sharing text
 * between them would let one contract pass on the other's wording.
 */
function sectionBefore(text: string, heading: string, nextHeading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf(nextHeading, start + heading.length);
  if (end < 0) {
    throw new Error(`missing section after ${heading}: ${nextHeading}`);
  }
  return text.slice(start, end);
}

const FIXED_ENVIRONMENT = sectionBefore(
  README,
  FIXED_ENVIRONMENT_HEADING,
  MANIFEST_HEADING,
);
const MANIFEST_SECTION = section(README, MANIFEST_HEADING);
const manifest = parseSha256Manifest(MANIFEST_TEXT);

describe('fixed capture platform docs (Issue #314)', () => {
  it('records the multi-arch digest and the explicit linux/amd64 platform pinning', () => {
    expect(FIXED_ENVIRONMENT).toContain('多架构 manifest list');
    expect(FIXED_ENVIRONMENT).toContain('linux/amd64');
    expect(FIXED_ENVIRONMENT).toContain('docker build --platform linux/amd64');
    expect(FIXED_ENVIRONMENT).toContain('docker run --platform linux/amd64');
    expect(FIXED_ENVIRONMENT).toContain('docker image inspect');
    expect(FIXED_ENVIRONMENT).toContain('{{.Os}}/{{.Architecture}}');
    expect(FIXED_ENVIRONMENT).toContain('`platform`');
    expect(FIXED_ENVIRONMENT).toContain('CAPTURE_PLATFORM');
    expect(FIXED_ENVIRONMENT).toContain('captureEnvironmentFingerprint');
  });

  it('documents the arm64 host limitation, amd64 emulation and readable refusal', () => {
    expect(FIXED_ENVIRONMENT).toContain('arm64');
    expect(FIXED_ENVIRONMENT).toContain('amd64 模拟');
    expect(FIXED_ENVIRONMENT).toContain('binfmt');
    // Pin the refusal to the build / inspect stage inside the arm64 bullet,
    // so the generic "可读错误" wording elsewhere in this section cannot pass.
    expect(FIXED_ENVIRONMENT).toContain(
      '入口在构建 / inspect 阶段以可读错误拒绝（非 0 退出）',
    );
    expect(FIXED_ENVIRONMENT).toContain(
      'inspect 成功但平台不符时再列出实际平台',
    );
    // The host entry, not the container entry, injects the platform variable.
    expect(FIXED_ENVIRONMENT).toContain(
      '宿主入口还通过 `docker run --env CAPTURE_PLATFORM=linux/amd64` 注入平台',
    );
    expect(FIXED_ENVIRONMENT).toContain('绝不会静默');
    expect(FIXED_ENVIRONMENT).toContain('写出不同 PNG');
    // The documented error names both the actual and the fixed platform.
    expect(FIXED_ENVIRONMENT).toContain('is platform "linux/arm64"');
    expect(FIXED_ENVIRONMENT).toContain(
      'fixed capture platform is "linux/amd64"',
    );
    expect(FIXED_ENVIRONMENT).toContain(
      'Capture environment variable "CAPTURE_PLATFORM" is "linux/arm64"',
    );
  });

  it('records the platform upgrade checklist for the pinned image and manifest', () => {
    expect(FIXED_ENVIRONMENT).toContain('升级清单');
    expect(FIXED_ENVIRONMENT).toContain('`--platform linux/amd64`');
    expect(FIXED_ENVIRONMENT).toContain('`Os` / `Architecture`');
    expect(FIXED_ENVIRONMENT).toContain(
      '同步文档：本节、`docs/screenshots/capture-sha256-manifest.json` 的 `environment.platform`',
    );
    expect(FIXED_ENVIRONMENT).toContain('不共用一份 sha256');
    expect(FIXED_ENVIRONMENT).toContain(
      '拆分后给 `verify:screenshots:sha256` 传对应 `--manifest`',
    );
    expect(FIXED_ENVIRONMENT).toContain('同步扩展校验器与测试');
  });
});

describe('sha256 manifest platform docs (Issue #314)', () => {
  it('records the manifest environment.platform and the separate platform report', () => {
    expect(MANIFEST_SECTION).toContain('`environment.platform`');
    expect(MANIFEST_SECTION).toContain(CAPTURE_PLATFORM);
    expect(MANIFEST_SECTION).toContain('平台差异单独成段（`Platform mismatch`）');
    expect(MANIFEST_SECTION).toContain('单独出现时退出 1');
    expect(MANIFEST_SECTION).toContain('linux/arm64');
    expect(MANIFEST_SECTION).toContain(
      '缺少 / 非法 `environment.platform`',
    );
  });

  it('documents the exit-code precedence, recapture gate and per-platform split', () => {
    // A manifest with another contract mismatch exits 2 even when the
    // platform section is also printed.
    expect(MANIFEST_SECTION).toContain('校验器仍以清单非法退出 2');
    expect(MANIFEST_SECTION).toContain('只有平台一项不一致时才用 1');
    expect(MANIFEST_SECTION).toContain(
      '平台门禁：重拍前先确认入口的 `--platform linux/amd64`',
    );
    expect(MANIFEST_SECTION).toContain('单独的平台漂移按退出码 1 处理');
    expect(MANIFEST_SECTION).toContain('按平台');
    expect(MANIFEST_SECTION).toContain('独立清单');
    expect(MANIFEST_SECTION).toContain('capture-sha256-manifest-linux-arm64.json');
    expect(MANIFEST_SECTION).toContain('不得写进同一份清单');
    expect(MANIFEST_SECTION).toContain('--manifest');
    expect(MANIFEST_SECTION).toContain('当前实现仍只接受 `linux/amd64`');
  });

  it('keeps the committed manifest itself on the fixed platform', () => {
    expect(manifest.environment.platform).toBe(CAPTURE_PLATFORM);
    expect(manifestPlatformMismatch(manifest)).toBeNull();
    expect(manifestEnvironmentMismatches(manifest)).toEqual([]);
  });
});

describe('sha256 manifest capture-log docs (Issue #329)', () => {
  it('documents the captured-sha256 check and the old-log compatibility behaviour', () => {
    // The `--log` verifier reads the write-time drift checklist, not only the
    // capture-env fingerprint, and reports its own failure section.
    expect(MANIFEST_SECTION).toContain('captured sha256');
    expect(MANIFEST_SECTION).toContain(
      '`captured sha256` 必须等于当前清单的 `sha256`',
    );
    expect(MANIFEST_SECTION).toContain('`manifest sha256` 只是捕获时的基线');
    // The documented section label must match the string the CLI prints.
    expect(MANIFEST_SECTION).toContain(
      'FAIL: <n> capture-log captured sha256 problem(s):',
    );
    expect(MANIFEST_SECTION).toContain('expected / captured sha256');
    expect(MANIFEST_SECTION).toContain('日志 captured sha256 不一致退出 1');
    // Older logs without the checklist keep the previous exit-0 behaviour, and
    // malformed checklist records are invalid input, not silent passes.
    expect(MANIFEST_SECTION).toContain('没有 drift checklist');
    expect(MANIFEST_SECTION).toContain('保持原行为');
    expect(MANIFEST_SECTION).toContain('sha256 drift 记录格式非法');
    expect(MANIFEST_SECTION).toContain('记录里的文件不在当前清单');
  });
});

describe('documented container fingerprint sample (Issue #314)', () => {
  it('parses the README sample and matches the manifest platform', () => {
    const samples = FIXED_ENVIRONMENT.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) => line.startsWith('capture-env:') && line.includes('source=container'),
      );
    expect(samples.length).toBeGreaterThan(0);

    for (const sample of samples) {
      const fingerprint = parseCaptureEnvironmentFingerprintLine(sample);
      expect(fingerprint.source).toBe('container');
      expect(fingerprint.platform).toBe(CAPTURE_PLATFORM);
      expect(fingerprint.platform).toBe(manifest.environment.platform);
    }
  });
});
