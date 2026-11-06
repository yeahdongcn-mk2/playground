import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, '.pre-commit-config.yaml');
const HOOK_REPO = 'https://github.com/pre-commit/pre-commit-hooks';
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');

const REQUIRED_HOOKS = [
  'trailing-whitespace',
  'end-of-file-fixer',
  'check-added-large-files',
  'check-merge-conflict',
] as const;

interface HookDefinition {
  id: string;
  args?: string[];
  exclude?: string;
}

interface RepoDefinition {
  repo: string;
  rev: string;
  hooks: HookDefinition[];
}

interface PreCommitConfig {
  repos: RepoDefinition[];
}

const config = parse(readFileSync(CONFIG_PATH, 'utf8')) as PreCommitConfig;
const hookRepo = config.repos.find((entry) => entry.repo === HOOK_REPO);

function requireHook(id: string): HookDefinition {
  const hook = hookRepo?.hooks.find((candidate) => candidate.id === id);
  if (!hook) {
    throw new Error(`pre-commit hook "${id}" is not configured`);
  }
  return hook;
}

describe('.pre-commit-config.yaml', () => {
  it('pins the pre-commit-hooks repository to a stable release', () => {
    expect(hookRepo).toBeDefined();
    expect(hookRepo?.rev).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('enables the four baseline hooks', () => {
    for (const id of REQUIRED_HOOKS) {
      expect(requireHook(id).id).toBe(id);
    }
  });

  it('keeps a large-file rule that explains the checked-in screenshots', () => {
    const hook = requireHook('check-added-large-files');
    const args = hook.args ?? [];
    expect(args).toContain('--enforce-all');
    const pngSizes = readdirSync(SCREENSHOT_DIR)
      .filter((file) => file.endsWith('.png'))
      .map((file) => statSync(join(SCREENSHOT_DIR, file)).size);
    expect(pngSizes.length).toBeGreaterThan(0);
    const largestScreenshot = Math.max(...pngSizes);

    const maxkbArg = args.find((arg) => /^--maxkb=\d+$/.test(arg));
    if (maxkbArg) {
      const maxkb = Number(maxkbArg.slice('--maxkb='.length));
      expect(maxkb).toBeGreaterThanOrEqual(3072);
      expect(maxkb * 1024).toBeGreaterThan(largestScreenshot);
      return;
    }

    // The alternative documented in the config: keep a low threshold and
    // exclude the screenshot directory, which must then cover the PNGs.
    const excludeArg = args.find((arg) => arg.startsWith('--exclude='));
    const pattern = excludeArg?.slice('--exclude='.length) ?? hook.exclude;
    if (!pattern) {
      throw new Error('check-added-large-files needs --maxkb or a docs/screenshots exclude');
    }
    expect(new RegExp(pattern).test('docs/screenshots/after-hub-mobile.png')).toBe(true);
  });

  it('leaves the repaired src/app/app.ts with a single trailing newline', () => {
    expect(readFileSync(join(ROOT, 'src', 'app', 'app.ts'), 'utf8')).toMatch(/[^\n]\n$/);
  });
});
