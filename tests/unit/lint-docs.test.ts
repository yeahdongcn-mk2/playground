import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const README = read('README.md');
const FRAMEWORK = read('docs/framework.md');
const ADR = read('docs/tech-stack-decision.md');
const BOUNDARY_CHECK = 'scripts/check-boundaries.mjs';

interface PackageJson {
  scripts?: Record<string, string>;
}

const lintCommand = (JSON.parse(read('package.json')) as PackageJson).scripts?.lint ?? '';

/** Directories passed to oxlint by the `npm run lint` command. */
function oxlintTargets(command: string): string[] {
  const oxlintStep = command.split(/\s*&&\s*/).find((step) => step.startsWith('oxlint '));
  if (oxlintStep === undefined) return [];
  return oxlintStep
    .split(/\s+/)
    .slice(1)
    .filter((argument) => !argument.startsWith('-'));
}

/** Flags that make oxlint warnings fail the `npm run lint` command. */
function warningFlags(command: string): string[] {
  const oxlintStep = command.split(/\s*&&\s*/).find((step) => step.startsWith('oxlint '));
  if (oxlintStep === undefined) return [];
  return oxlintStep
    .split(/\s+/)
    .slice(1)
    .filter(
      (argument) => argument === '--deny-warnings' || argument.startsWith('--max-warnings='),
    );
}

/**
 * The docs are checked against the real command instead of a hard-coded flag,
 * so switching package.json to `--max-warnings=0` (or dropping the flag while
 * keeping another equivalent one) forces the documents to follow.
 */
const WARNING_FLAGS = warningFlags(lintCommand);

/**
 * The oxlint targets are read from package.json instead of hard-coded here, so
 * the docs have to follow the real command when a directory joins or leaves
 * the lint gate. `scripts` is the deliberate exception: Issue #192 requires it
 * to stay in the gate, so removing it means changing package.json, the docs and
 * the dedicated guard below together, not only package.json.
 */
const TARGETS = oxlintTargets(lintCommand);

/** The one line of `text` that contains every marker. */
function lineWith(text: string, ...markers: string[]): string {
  const line = text
    .split('\n')
    .find((candidate) => markers.every((marker) => candidate.includes(marker)));
  if (line === undefined) {
    throw new Error(`找不到同时包含 ${markers.join(' / ')} 的行`);
  }
  return line;
}

/** The body of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`找不到小节：${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * A lint description is complete only when it lists every target and the
 * boundary script. The boundary script path itself contains the `scripts`
 * target name, so drop it before checking the targets; otherwise a line that
 * no longer claims `scripts` coverage still passes via the path.
 */
function expectLintCoverage(line: string): void {
  expect(line).toContain('oxlint');
  expect(line).toContain(BOUNDARY_CHECK);
  const coverage = line.split(BOUNDARY_CHECK).join('');
  for (const target of TARGETS) {
    expect(coverage).toContain(target);
  }
}

/** Lines that describe the lint gate in a document. */
function lintDescriptionLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.includes('oxlint') || line.includes('npm run lint'));
}

/**
 * The pre-#192 wording listed only src and tests as lint targets. A current
 * line may still contrast the old and new scope ("不仅...还..."), so it only
 * counts as stale when it claims a limitation and never names scripts.
 */
function limitsLintToSrcAndTests(line: string): boolean {
  const coverage = line.split(BOUNDARY_CHECK).join('');
  return (
    /(?:仅|只)/.test(coverage) &&
    /(?:src|tests)/.test(coverage) &&
    !coverage.includes('scripts')
  );
}

/**
 * Every line that documents the lint gate. These are exactly the places the
 * docs use to explain what `npm run lint` rejects, so each one has to describe
 * the whole gate rather than only the oxlint target list.
 */
function documentedLintGateLines(): Array<{ document: string; line: string }> {
  return [
    { document: 'README.md', line: lineWith(README, '**工程化**') },
    { document: 'README.md', line: lineWith(README, '| `npm run lint` |') },
    { document: 'README.md', line: lineWith(section(README, '## 验证'), 'npm run lint') },
    { document: 'docs/framework.md', line: lineWith(FRAMEWORK, '| Lint |') },
    {
      document: 'docs/framework.md',
      line: lineWith(FRAMEWORK, '`npm run lint`', '`scripts/check-boundaries.mjs`'),
    },
    {
      document: 'docs/framework.md',
      line: lineWith(section(FRAMEWORK, '## 12. 测试'), 'npm run lint'),
    },
    { document: 'docs/framework.md', line: lineWith(FRAMEWORK, 'Lint 使用 oxlint') },
  ];
}

/**
 * Issue #223: oxlint used to exit 0 for warnings, so the old wording only
 * mentioned errors. Each description must now say that errors and warnings
 * both fail, using the same flag as the package.json lint command.
 */
function expectWarningGate(document: string, line: string): void {
  const label = `${document}: ${line}`;
  expect(line, label).toContain('error');
  expect(line, label).toContain('warning');
  expect(line, label).toMatch(/失败|非 0|阻断/);
  for (const flag of WARNING_FLAGS) {
    expect(line, label).toContain(flag);
  }
}

/** The boundary step is part of the gate, so its failure must be described as non-zero. */
function expectBoundaryFailure(document: string, line: string): void {
  const label = `${document}: ${line}`;
  const index = line.indexOf(BOUNDARY_CHECK);
  expect(index, label).toBeGreaterThanOrEqual(0);
  expect(line.slice(index), label).toMatch(/失败|非 0|阻断/);
}

describe('lint coverage docs', () => {
  it('derives the oxlint targets from package.json so the docs follow the real command', () => {
    expect(TARGETS.length).toBeGreaterThan(0);
    expect(lintCommand).toContain(`node ${BOUNDARY_CHECK}`);
  });

  it('keeps scripts inside the lint gate as Issue #192 requires', () => {
    expect(TARGETS).toContain('scripts');
  });

  it('README engineering overview lists every lint target and the boundary check', () => {
    expectLintCoverage(lineWith(README, '**工程化**'));
  });

  it('README command table documents what npm run lint checks', () => {
    expectLintCoverage(lineWith(README, '| `npm run lint` |'));
  });

  it('README verification block repeats the lint coverage', () => {
    expectLintCoverage(lineWith(section(README, '## 验证'), 'npm run lint'));
  });

  it('framework tool table lists every lint target and the boundary script', () => {
    expectLintCoverage(lineWith(FRAMEWORK, '| Lint |'));
  });

  it('framework hard constraint keeps the boundary check and names every target', () => {
    expectLintCoverage(lineWith(FRAMEWORK, '`npm run lint`', '`scripts/check-boundaries.mjs`'));
  });

  it('framework test command documents the lint coverage', () => {
    expectLintCoverage(lineWith(section(FRAMEWORK, '## 12. 测试'), 'npm run lint'));
  });

  it('ADR module boundary section names oxlint, the boundary script and the budget check', () => {
    const line = lineWith(
      section(ADR, '## 5. 模块分层与边界'),
      'oxlint',
      BOUNDARY_CHECK,
      'check:budget',
    );
    expectLintCoverage(line);
  });

  it('ADR local command list describes npm run lint as oxlint plus the boundary script', () => {
    const line = lineWith(section(ADR, '## 7. 本地开发 / 构建 / 测试命令'), 'npm run lint');
    expectLintCoverage(line);
    expect(line).not.toContain('ESLint');
  });

  it('does not describe lint as limited to src and tests', () => {
    for (const text of [README, FRAMEWORK]) {
      for (const line of lintDescriptionLines(text)) {
        expect(limitsLintToSrcAndTests(line), line).toBe(false);
      }
    }
  });

  it('finds a warning-blocking flag in package.json for the docs to mirror', () => {
    expect(WARNING_FLAGS.length, lintCommand).toBeGreaterThan(0);
  });

  it('says in every documented lint line that errors and warnings both fail', () => {
    expect(WARNING_FLAGS.length, lintCommand).toBeGreaterThan(0);
    for (const { document, line } of documentedLintGateLines()) {
      expectWarningGate(document, line);
      expectLintCoverage(line);
    }
  });

  it('says in every documented lint line that a failing boundary check returns non-zero', () => {
    for (const { document, line } of documentedLintGateLines()) {
      expectBoundaryFailure(document, line);
      expect(line, `${document}: ${line}`).toContain('oxlint');
    }
  });
});

describe('lint coverage guard', () => {
  it('rejects a line that only names scripts through the boundary script path', () => {
    const regression =
      'oxlint（覆盖 `src`、`tests`）+ `scripts/check-boundaries.mjs` 模块边界检查';
    expect(() => expectLintCoverage(regression)).toThrow();
  });

  it('accepts the current wording that lists scripts as an oxlint target', () => {
    const current =
      'oxlint（覆盖 `src`、`tests` 与 `scripts`）+ `scripts/check-boundaries.mjs` 模块边界检查';
    expect(() => expectLintCoverage(current)).not.toThrow();
  });
});
