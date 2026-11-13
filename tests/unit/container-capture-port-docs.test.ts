import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

const CONTAINER_COMMAND = bullet(
  section('## 固定捕获环境（Issue #199）'),
  '- 容器命令：',
);
const GAME_2048_PORT = bullet(section('## t4：2048（PR #26）'), '- 预览端口：');
const BREAKOUT_PORT = bullet(section('## t5：打砖块（Issue #27 / 子任务 1）'), '- 预览端口：');

describe('container capture host preview port precheck docs (Issue #207)', () => {
  it('documents that the host precheck probes the preview port only when BASE_URL is empty', () => {
    expect(CONTAINER_COMMAND).toContain('预览端口只在 `BASE_URL` 未设置或为空串');
    expect(CONTAINER_COMMAND).toContain('容器内会自行启动 preview');
    expect(CONTAINER_COMMAND).toContain('`PREVIEW_PORT`');
  });

  it('documents that an explicit BASE_URL skips the host preview port probe', () => {
    expect(CONTAINER_COMMAND).toContain(
      '显式设置 `BASE_URL`（外部 preview 模式）时跳过宿主预览端口探测',
    );
    expect(CONTAINER_COMMAND).toContain('4183 / 4185');
  });

  it('no longer claims the container entry probes the preview port unconditionally', () => {
    expect(CONTAINER_COMMAND).not.toMatch(/入口会预检[^；。]*预览端口/);
    expect(CONTAINER_COMMAND).not.toContain('target 白名单和该 target 的预览端口');
  });

  it('keeps the 2048 and breakout Before sections consistent with the container entry', () => {
    for (const [portLine, port] of [
      [GAME_2048_PORT, '4183'],
      [BREAKOUT_PORT, '4185'],
    ] as const) {
      expect(portLine).toContain('不启动 preview、不探测 preview 端口');
      expect(portLine).toContain('`npm run screenshots:container` 与此一致');
      expect(portLine).toContain('`BASE_URL` 非空时跳过宿主预览端口预检');
      expect(portLine).toContain(`默认 \`${port}\``);
    }
  });
});
