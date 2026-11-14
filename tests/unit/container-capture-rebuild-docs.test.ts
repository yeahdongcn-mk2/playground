import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPTURE_IMAGE_BUILD_LABEL } from '../../scripts/run-container-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);

/** The text of one level-2 section, up to the next level-2 heading. */
function section(heading: string): string {
  const start = SCREENSHOTS_README.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = SCREENSHOTS_README.indexOf('\n## ', start + heading.length);
  return SCREENSHOTS_README.slice(start, end === -1 ? undefined : end);
}

/** The bullet line that starts with the given prefix. */
function bullet(text: string, prefix: string): string {
  const line = text.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`missing bullet: ${prefix}`);
  }
  return line;
}

const FIXED_CAPTURE_ENV = section('## 固定捕获环境（Issue #199）');
const REBUILD_CONTRACT = bullet(FIXED_CAPTURE_ENV, '- 本地镜像重建：');

describe('container capture image rebuild docs (Issue #210)', () => {
  it('documents the same build-input label the container entry applies', () => {
    expect(REBUILD_CONTRACT).toContain(
      `Docker 标签 \`${CAPTURE_IMAGE_BUILD_LABEL}\``,
    );
    expect(REBUILD_CONTRACT).toContain('构建输入指纹');
  });

  it('documents the fingerprint inputs: pin tag / digest plus Dockerfile contents', () => {
    expect(REBUILD_CONTRACT).toContain('`PLAYWRIGHT_IMAGE_PIN` 的 tag / digest');
    expect(REBUILD_CONTRACT).toContain('`docker/capture/Dockerfile` 全文');
  });

  it('documents rebuild-on-change and skip-when-unchanged', () => {
    expect(REBUILD_CONTRACT).toContain('pin 或 Dockerfile 任一变化时自动重建');
    expect(REBUILD_CONTRACT).toContain('输入不变时重复运行直接跳过 `docker build`');
  });

  it('documents that pre-fix images rebuild once due to the missing label', () => {
    expect(REBUILD_CONTRACT).toContain('本次修复前构建的旧镜像没有该标签');
    expect(REBUILD_CONTRACT).toContain('重建一次');
    expect(REBUILD_CONTRACT).toContain('无需手动 `docker rmi`');
  });

  it('documents the Dockerfile FROM check and the resulting digest guarantee', () => {
    expect(REBUILD_CONTRACT).toContain(
      '校验 Dockerfile 运行阶段的 `FROM` 与 pin 一致',
    );
    expect(REBUILD_CONTRACT).toContain(
      '`CAPTURE_IMAGE_DIGEST` 始终与实际基础镜像一致',
    );
  });

  it('no longer claims the image is built only when it is missing', () => {
    expect(FIXED_CAPTURE_ENV).not.toContain('只在镜像缺失时才构建');
    expect(FIXED_CAPTURE_ENV).not.toMatch(/只在镜像缺失时[^。；\n]*构建/);
  });
});
