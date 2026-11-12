import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const README = read('README.md');
const FRAMEWORK = read('docs/framework.md');
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

/**
 * The oxlint targets are read from package.json instead of hard-coded here, so
 * the docs have to follow the real command when a directory joins or leaves
 * the lint gate.
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

/** A lint description is complete only when it lists every target and the boundary script. */
function expectLintCoverage(line: string): void {
  expect(line).toContain('oxlint');
  for (const target of TARGETS) {
    expect(line).toContain(target);
  }
  expect(line).toContain(BOUNDARY_CHECK);
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
  return /(?:仅|只)/.test(line) && /(?:src|tests)/.test(line) && !line.includes('scripts');
}

describe('lint coverage docs', () => {
  it('derives the oxlint targets from package.json so the docs follow the real command', () => {
    expect(TARGETS).toEqual(expect.arrayContaining(['src', 'tests', 'scripts']));
    expect(lintCommand).toContain(`node ${BOUNDARY_CHECK}`);
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

  it('does not describe lint as limited to src and tests', () => {
    for (const text of [README, FRAMEWORK]) {
      for (const line of lintDescriptionLines(text)) {
        expect(limitsLintToSrcAndTests(line), line).toBe(false);
      }
    }
  });
});
