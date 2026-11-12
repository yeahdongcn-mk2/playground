import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_PATH = join(ROOT, 'package.json');
const OXLINT_BIN = join(ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint');
const BOUNDARY_CHECK = 'node scripts/check-boundaries.mjs';

interface PackageJson {
  scripts?: Record<string, string>;
}

const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as PackageJson;
const lintCommand = packageJson.scripts?.lint ?? '';
/** The `npm run lint` command split into the steps joined by `&&`. */
const lintSteps = lintCommand.split(/\s*&&\s*/);
const oxlintIndex = lintSteps.findIndex((step) => step.startsWith('oxlint '));

/** Arguments passed to oxlint in the first step of the lint command. */
function oxlintArgs(): string[] {
  const step = lintSteps[oxlintIndex];
  return step === undefined ? [] : step.split(/\s+/).slice(1);
}

describe('lint coverage contract', () => {
  it('makes npm run lint check src, tests and scripts with oxlint', () => {
    expect(lintCommand.startsWith('oxlint ')).toBe(true);
    expect(oxlintArgs()).toEqual(expect.arrayContaining(['src', 'tests', 'scripts']));
  });

  it('keeps the module boundary check after oxlint', () => {
    const boundaryIndex = lintSteps.findIndex((step) => step.startsWith(BOUNDARY_CHECK));

    expect(oxlintIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeGreaterThan(oxlintIndex);
  });

  it('enables --deny-warnings so oxlint warnings fail npm run lint', () => {
    // Issue #223: a warning used to leave `npm run lint` at exit code 0, so the
    // gate only caught errors. The flag makes warnings blocking too.
    expect(oxlintArgs()).toContain('--deny-warnings');
  });

  it('exits non-zero for a warning-producing fixture under the real oxlint flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-deny-warnings-'));
    try {
      const fixture = join(dir, 'control-regex.mjs');
      // `no-control-regex` warns by default; the repository only suppresses
      // the rule at its one intentional use (scripts/lib/e2e-flakes.mjs).
      writeFileSync(fixture, 'export const range = /[\\x00-\\x08]/;\n');
      const flags = oxlintArgs().filter((argument) => argument.startsWith('-'));
      const result = spawnSync(process.execPath, [OXLINT_BIN, ...flags, fixture], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.error, output).toBeUndefined();
      expect(output).toContain('warning');
      expect(result.status, output).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no warnings or errors for src, tests and scripts', () => {
    const result = spawnSync(process.execPath, [OXLINT_BIN, '--format=json', ...oxlintArgs()], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    const report = JSON.parse(result.stdout) as { diagnostics?: unknown[] };
    expect(report.diagnostics, output).toEqual([]);
  });
});
