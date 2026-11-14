import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dprForCaptureTarget } from '../../scripts/lib/capture-env.mjs';
import {
  CAPTURE_IMAGE_BUILD_LABEL,
  readPackageScripts,
  resolveCaptureTargets,
} from '../../scripts/run-container-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const SCRIPTS = readPackageScripts({ packagePath: join(ROOT, 'package.json') });
const DECLARATION_CACHE = new Map<string, string[]>();

/** The targets a target's own script declaration reports for this argv. */
function declaredTargets(target: string, passthrough: readonly string[] = []): string[] {
  const key = JSON.stringify([target, passthrough]);
  const cached = DECLARATION_CACHE.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const { targets } = resolveCaptureTargets(target, [...passthrough], {
    scripts: SCRIPTS,
  });
  DECLARATION_CACHE.set(key, targets);
  return targets;
}

/**
 * The backticked `targets` / `dprs` contract derived from the capture entry's
 * declaration resolver, so the docs cannot pin a hand-written target list that
 * drifts from the script declarations.
 */
function targetContract(script: string, passthrough: readonly string[] = []): string {
  const targets = declaredTargets(script, passthrough);
  return `\`${targets.join(',')}\` / \`${targets
    .map((target) => dprForCaptureTarget(target))
    .join(',')}\``;
}

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
const LOCAL_IMAGE_CONTRACT = bullet(
  section('## 固定捕获环境（Issue #199）'),
  '- 本地镜像复用：',
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

describe('container capture declaration docs (Issue #293)', () => {
  it('documents that the entry executes the target script declaration', () => {
    expect(CONTAINER_COMMAND).toContain('执行目标脚本的声明');
    expect(CONTAINER_COMMAND).toContain('`--print-capture-targets`');
    expect(CONTAINER_COMMAND).toContain('`script` + `targets`');
  });

  it('documents the npm script arguments plus passthrough with validation', () => {
    expect(CONTAINER_COMMAND).toContain('`package.json`');
    expect(CONTAINER_COMMAND).toContain('脚本自带参数');
    expect(CONTAINER_COMMAND).toContain('容器透传参数');
    expect(CONTAINER_COMMAND).toContain('校验目标白名单与固定 DPR');
    expect(CONTAINER_COMMAND).toContain(
      '`screenshots:minesweeper:webkit-before` 自带 `--webkit --touch-before`',
    );
  });

  it('documents the declared targets for the minesweeper examples', () => {
    expect(CONTAINER_COMMAND).toContain(targetContract('screenshots:minesweeper'));
    expect(CONTAINER_COMMAND).toContain(
      targetContract('screenshots:minesweeper:touch-before'),
    );
    expect(CONTAINER_COMMAND).toContain(targetContract('screenshots:webkit'));
  });

  it('documents that before, clear and allow-historical-overwrite never change the target', () => {
    expect(CONTAINER_COMMAND).toContain(
      '`--before` / `--clear` / `--allow-historical-overwrite` 不改变目标',
    );
  });

  it('documents the runtime assertion against the declaration', () => {
    expect(CONTAINER_COMMAND).toContain('实际记录必须与声明一致');
    expect(CONTAINER_COMMAND).toContain('多记或漏记');
    expect(CONTAINER_COMMAND).not.toContain('实际记录的目标必须属于注入列表');
  });

  it('no longer derives the target from the script name alone', () => {
    expect(CONTAINER_COMMAND).not.toContain('容器入口按脚本的捕获模式注入');
    expect(CONTAINER_COMMAND).not.toContain(
      '入口按 target 脚本与透传参数共同推导并注入',
    );
  });
});

describe('container capture image build input docs (Issue #210)', () => {
  it('documents the build-input label and the Dockerfile input', () => {
    expect(LOCAL_IMAGE_CONTRACT).toContain(
      `Docker 标签 \`${CAPTURE_IMAGE_BUILD_LABEL}\``,
    );
    expect(LOCAL_IMAGE_CONTRACT).toContain('`docker/capture/Dockerfile`');
    expect(LOCAL_IMAGE_CONTRACT).toContain('构建输入指纹');
  });

  it('documents when the local image is reused and when it is rebuilt', () => {
    expect(LOCAL_IMAGE_CONTRACT).toContain(
      '只有镜像存在且标签与当前指纹一致时才跳过 `docker build`',
    );
    expect(LOCAL_IMAGE_CONTRACT).toContain('标签缺失（旧镜像）');
    expect(LOCAL_IMAGE_CONTRACT).toContain('任一变化都会使指纹失效');
    expect(LOCAL_IMAGE_CONTRACT).toContain('Dockerfile 的非 `FROM` 内容变化会重建');
  });

  it('documents the FROM drift error with the expected reference and actual FROM', () => {
    expect(LOCAL_IMAGE_CONTRACT).toContain('只改 Dockerfile 的运行阶段 `FROM`（最后一个）而不同步 pin');
    expect(LOCAL_IMAGE_CONTRACT).toContain('包含期望 reference 与实际 FROM 的可读错误');
  });
});
