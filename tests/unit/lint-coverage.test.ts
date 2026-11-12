import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

  it('does not adopt --deny-warnings, which #223 tracks separately', () => {
    // `--deny-warnings` changes the warning policy for the whole repository;
    // this change only silences the single intentional regex.
    expect(lintCommand).not.toContain('--deny-warnings');
  });

  it('reports no warnings or errors for scripts', () => {
    const result = spawnSync(process.execPath, [OXLINT_BIN, '--format=json', 'scripts'], {
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
