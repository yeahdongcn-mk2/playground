import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'capture-minesweeper-screenshots.mjs');
const README = join(ROOT, 'README.md');
const SCREENSHOTS_README = join(ROOT, 'docs', 'screenshots', 'README.md');
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');

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

/** Run the minesweeper capture script with an explicit environment. */
function spawnScript(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** Run the minesweeper capture script without a preview server. */
function runScript(args: string[]): { status: number | null; output: string } {
  return spawnScript(args, { ...process.env, BASE_URL: '' });
}

/**
 * sha256 of every file in the screenshot directory, keyed by file name.
 *
 * Comparing hashes instead of the file-name set proves the failing run did not
 * overwrite an existing screenshot: the short-mode targets already exist in the
 * repository, so a filename-only comparison would stay green after a write.
 */
function screenshotHashes(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(SCREENSHOT_DIR)
      .sort()
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(SCREENSHOT_DIR, file)))
          .digest('hex'),
      ]),
  );
}

/** Hold a random 127.0.0.1 port open for the duration of the test. */
function listenOnRandomPort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Expected the probe server to have an IP socket address'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
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
    // The short modes keep the plain ready filenames, not the restart suffix.
    expect(script).toContain('const MODE_LABEL = SHORT_BEFORE');
    expect(script).toContain("? 'short-before'");
  });

  it('no longer maps --before to a capture mode in the script', () => {
    const script = readFileSync(SCRIPT, 'utf8');

    expect(script).not.toContain("process.argv.includes('--before')");
    expect(script).not.toContain("MODE === 'before'");
  });
});

describe('minesweeper screenshot preview port', () => {
  it.each([
    { label: 'default After', args: [] as string[] },
    { label: '--short', args: ['--short'] },
  ])(
    'fails fast without screenshots when PREVIEW_PORT is taken ($label)',
    { timeout: 30_000 },
    async ({ args }) => {
      const owner = await listenOnRandomPort();
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        env.PREVIEW_PORT = String(owner.port);

        const { status, output } = spawnScript(args, env);

        expect(status).not.toBe(0);
        // The specific failure names the real port and the fix; a generic
        // locator timeout from the old script would not match this.
        expect(output).toContain(
          `Cannot start the preview server on 127.0.0.1:${owner.port}`,
        );
        expect(output).toContain('the port is already in use');
        expect(output).toContain('Set PREVIEW_PORT');
        expect(output).not.toContain('Captured');
        // Byte-for-byte proof that no screenshot was created or overwritten.
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        await owner.close();
      }
    },
  );

  it(
    'fails with the preview exit code and stderr when the preview dies after the port probe',
    { timeout: 45_000 },
    async () => {
      const probe = await listenOnRandomPort();
      const port = probe.port;
      await probe.close();
      const dir = mkdtempSync(join(tmpdir(), 'minesweeper-preview-'));
      const fakePreview = join(dir, 'fake-preview.mjs');
      writeFileSync(
        fakePreview,
        "process.stderr.write('fake preview exploded\\n');\nprocess.exit(7);\n",
      );
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        env.PREVIEW_PORT = String(port);
        // Test seam consumed by the capture script: stand in for vite preview
        // with a process that dies right after an otherwise successful probe.
        env.PREVIEW_ENTRY = fakePreview;

        const { status, output } = spawnScript([], env);

        expect(status).not.toBe(0);
        expect(output).toContain(
          `The preview server exited before http://127.0.0.1:${port} became ready`,
        );
        // The child's own exit code and stderr reach the operator, so the
        // post-probe race is not mistaken for a locator or port failure.
        expect(output).toContain('exit code 7');
        expect(output).toContain('fake preview exploded');
        expect(output).toContain('PREVIEW_PORT');
        expect(output).not.toContain('Captured');
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
