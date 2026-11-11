import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const POLICY_PATH = 'docs/ci-flaky-policy.md';
const POLICY = read(POLICY_PATH);
const README = read('README.md');
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const FLAKE_WATCH_WORKFLOW_PATH = '.github/workflows/flake-watch.yml';

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const ci = parse(read(CI_WORKFLOW_PATH)) as Workflow;
const verifySteps = ci.jobs?.verify?.steps ?? [];
const flakeWatch = parse(read(FLAKE_WATCH_WORKFLOW_PATH)) as Workflow;
const watchSteps = flakeWatch.jobs?.['mobile-webkit-first-run']?.steps ?? [];

function stepNamed(steps: WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find((step) => step.name === name);
}

describe('flaky policy docs', () => {
  it('is linked from the README verification section', () => {
    const start = README.indexOf('## 验证');
    const end = README.indexOf('## 已知限制', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const verification = README.slice(start, end);
    expect(verification).toMatch(/\[[^\]]+\]\(docs\/ci-flaky-policy\.md\)/);
    expect(existsSync(join(ROOT, POLICY_PATH))).toBe(true);
    expect(POLICY.length).toBeGreaterThan(500);
  });

  it('defines passed, flaky and failed with first-run semantics', () => {
    expect(POLICY).toMatch(/passed[^\n]*首跑[^\n]*通过/);
    expect(POLICY).toMatch(/flaky[^\n]*首跑失败[^\n]*重试后通过/);
    expect(POLICY).toMatch(/failed[^\n]*重试用尽[^\n]*仍失败/);
    expect(POLICY).toContain('retries: 2');
  });

  it('documents the PR gate step and the target case it protects', () => {
    const e2eIndex = verifySteps.findIndex((step) => step.name === 'End-to-end tests');
    const gateIndex = verifySteps.findIndex((step) => step.name === 'Check target e2e flakes');
    expect(e2eIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(e2eIndex);
    expect(verifySteps[gateIndex]?.run?.trim()).toBe('node scripts/check-e2e-flakes.mjs');

    expect(POLICY).toContain('Check target e2e flakes');
    expect(POLICY).toContain('node scripts/check-e2e-flakes.mjs');
    expect(POLICY).toContain('mobile-webkit');
    expect(POLICY).toContain('hub and blank canvas');
  });

  it('keeps other cases on retries: 2 and only records them as flaky', () => {
    expect(POLICY).toMatch(/其他项目与其他用例[^\n]*retries: 2[^\n]*只记录为 flaky/);
    expect(POLICY).toContain('不会让 `Check target e2e flakes` 失败');
  });

  it('documents the daily flake-watch command off the PR path', () => {
    expect(POLICY).toContain('.github/workflows/flake-watch.yml');
    expect(POLICY).toContain('Flake watch');
    expect(POLICY).toContain('--repeat-each=5 --retries=0');
    expect(POLICY).toMatch(/不在 PR 关键路径/);

    expect(Object.keys(flakeWatch.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);

    const repeated = stepNamed(watchSteps, 'Repeat the mobile-webkit hub case five times');
    expect(repeated).toBeDefined();
    expect(repeated?.run).toContain('--project=mobile-webkit');
    expect(repeated?.run).toContain('-g "hub and blank canvas"');
    expect(repeated?.run).toContain('--repeat-each=5');
    expect(repeated?.run).toContain('--retries=0');
  });

  it('documents the CI duration and the residual false-negative cost', () => {
    expect(POLICY).toContain('CI 时长');
    expect(POLICY).toMatch(/只多一次 JSON 报告解析/);
    expect(POLICY).toMatch(/不拉长/);
    expect(POLICY).toContain('误报成本');
    expect(POLICY).toContain('其他用例的 flaky 仍可能以 success 放行');
  });

  it('sets triage expectations that do not hide flakiness', () => {
    expect(POLICY).toMatch(/先看[^\n]*flaky[^\n]*首跑错误/);
    expect(POLICY).toMatch(/不要通过放宽断言、跳过用例或加大超时/);
    expect(POLICY).toContain('放宽断言');
    expect(POLICY).toContain('跳过用例');
    expect(POLICY).toContain('加大超时');
  });

  it('references workflow files, steps and scripts that exist in the repository', () => {
    const referenced = [
      CI_WORKFLOW_PATH,
      FLAKE_WATCH_WORKFLOW_PATH,
      'scripts/check-e2e-flakes.mjs',
      'scripts/flake-watch-summary.mjs',
    ];
    for (const relativePath of referenced) {
      expect(POLICY).toContain(relativePath);
      expect(existsSync(join(ROOT, relativePath)), relativePath).toBe(true);
    }

    expect(POLICY).toContain('node scripts/flake-watch-summary.mjs');
    const summary = stepNamed(watchSteps, 'Summarize first-run results');
    expect(summary?.run).toContain('node scripts/flake-watch-summary.mjs');
    expect(summary?.run).toContain('$GITHUB_STEP_SUMMARY');
  });
});
