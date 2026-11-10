import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'capture-minesweeper-screenshots.mjs');
const README = join(ROOT, 'README.md');
const SCREENSHOTS_README = join(ROOT, 'docs', 'screenshots', 'README.md');

const REMOVED_FLAG = '--before';
const REMOVED_COMMAND = 'screenshots:minesweeper:before';
const RETAINED_BEFORE_FLAGS = [
  '--touch-before',
  '--narrow-before',
  '--min-before',
  '--restart-before',
  '--short-before',
  '--large-before',
] as const;

interface PackageJson {
  scripts?: Record<string, string>;
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;

/** Run the minesweeper capture script without a preview server. */
function runScript(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, BASE_URL: '' },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('minesweeper screenshot modes', () => {
  it('rejects the removed generic --before flag instead of capturing After shots', () => {
    const { status, output } = runScript([REMOVED_FLAG]);

    expect(status).toBe(1);
    expect(output).toContain('The generic --before mode has been removed');
    expect(output).not.toContain('Captured');
  });

  it('still recognises every retained before mode', () => {
    for (const flag of RETAINED_BEFORE_FLAGS) {
      const { status, output } = runScript([flag]);

      expect(status, flag).toBe(1);
      expect(output, flag).toMatch(/needs? BASE_URL/);
      expect(output, flag).not.toContain('The generic --before mode has been removed');
    }
  });

  it('removes only the generic before npm script', () => {
    const scripts = packageJson.scripts ?? {};

    expect(scripts).not.toHaveProperty(REMOVED_COMMAND);

    for (const name of [
      'screenshots:minesweeper',
      'screenshots:minesweeper:touch-before',
      'screenshots:minesweeper:narrow',
      'screenshots:minesweeper:narrow-before',
      'screenshots:minesweeper:min',
      'screenshots:minesweeper:min-before',
      'screenshots:minesweeper:restart',
      'screenshots:minesweeper:restart-before',
      'screenshots:minesweeper:short',
      'screenshots:minesweeper:short-before',
      'screenshots:minesweeper:large',
      'screenshots:minesweeper:large-before',
      'screenshots:minesweeper:scores',
      'screenshots:minesweeper:scores-before',
    ]) {
      expect(scripts[name], name).toBeDefined();
    }
  });

  it('keeps README and the screenshot docs free of the removed command', () => {
    for (const file of [README, SCREENSHOTS_README]) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(REMOVED_COMMAND);
    }
  });

  it('captures the 360x640 and 375x667 short viewports for Issue #60', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const shortViewports = script.match(/const SHORT_VIEWPORTS = \[(.*?)\];/s);

    expect(shortViewports, 'SHORT_VIEWPORTS should be declared').not.toBeNull();
    expect(shortViewports?.[1]).toContain('{ width: 360, height: 640 }');
    expect(shortViewports?.[1]).toContain('{ width: 375, height: 667 }');
    expect(script).toContain("MODE === 'short' || MODE === 'short-before'");
  });

  it('no longer maps --before to a capture mode in the script', () => {
    const script = readFileSync(SCRIPT, 'utf8');

    expect(script).not.toContain("process.argv.includes('--before')");
    expect(script).not.toContain("MODE === 'before'");
  });
});
