import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  captureRecord,
  parseCaptureEngine,
  phoneContextOptions,
} from '../../scripts/lib/capture-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'capture-minesweeper-screenshots.mjs');
const SCORES_SCRIPT = join(ROOT, 'scripts', 'capture-minesweeper-scores-screenshots.mjs');
const README = join(ROOT, 'README.md');
const FRAMEWORK = join(ROOT, 'docs', 'framework.md');
const SCREENSHOTS_README = join(ROOT, 'docs', 'screenshots', 'README.md');
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');
const SCRIPT_DIR = join(ROOT, 'scripts');
const PLAYWRIGHT_CONFIG = join(ROOT, 'playwright.config.ts');

const REMOVED_FLAG = '--before';
const REMOVED_COMMAND = 'screenshots:minesweeper:before';
const RETAINED_BEFORE_FLAGS = [
  '--touch-before',
  '--narrow-before',
  '--min-before',
  '--restart-before',
  '--short-before',
  '--large-before',
  '--webkit-narrow-before',
] as const;

const WEBKIT_SCRIPT_MODES = [
  'screenshots:webkit',
  'screenshots:snake:webkit',
  'screenshots:2048:webkit',
  'screenshots:breakout:webkit',
  'screenshots:minesweeper:webkit',
  'screenshots:minesweeper:webkit-before',
  'screenshots:minesweeper:webkit-narrow',
  'screenshots:minesweeper:webkit-narrow-before',
  'screenshots:minesweeper:scores:webkit',
] as const;

const WEBKIT_SCRIPT_COMMANDS: Record<string, readonly string[]> = {
  'capture-screenshots.mjs': ['screenshots:webkit'],
  'capture-snake-screenshots.mjs': ['screenshots:snake:webkit'],
  'capture-2048-screenshots.mjs': ['screenshots:2048:webkit'],
  'capture-breakout-screenshots.mjs': ['screenshots:breakout:webkit'],
  'capture-minesweeper-screenshots.mjs': [
    'screenshots:minesweeper:webkit',
    'screenshots:minesweeper:webkit-before',
    'screenshots:minesweeper:webkit-narrow',
    'screenshots:minesweeper:webkit-narrow-before',
  ],
  'capture-minesweeper-scores-screenshots.mjs': [
    'screenshots:minesweeper:scores:webkit',
  ],
};

const WEBKIT_SCREENSHOTS = [
  'after-hub-webkit.png',
  'after-blank-webkit.png',
  'after-snake-webkit.png',
  'after-2048-ready-webkit.png',
  'after-2048-playing-webkit.png',
  'after-2048-gameover-webkit.png',
  'after-breakout-ready-webkit.png',
  'after-breakout-playing-webkit.png',
  'after-breakout-levelclear-webkit.png',
  'after-breakout-gameover-webkit.png',
  'after-minesweeper-ready-webkit.png',
  'after-minesweeper-playing-webkit.png',
  'after-minesweeper-lost-webkit.png',
  'after-minesweeper-won-webkit.png',
  'after-minesweeper-scores-webkit.png',
] as const;

interface PackageJson {
  scripts?: Record<string, string>;
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;

/** Run a capture script with an explicit environment. */
function spawnNode(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
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

/** Run the minesweeper capture script with an explicit environment. */
function spawnScript(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; output: string } {
  return spawnNode(SCRIPT, args, env);
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

  it('rejects combining --webkit with the Chromium-only narrow modes', () => {
    const { status, output } = runScript(['--webkit', '--narrow']);

    expect(status).toBe(1);
    expect(output).toContain('use --webkit-narrow');
    expect(output).not.toContain('Captured');
  });

  it('rejects the Chromium-only clear-scores variant on WebKit', () => {
    const { status, output } = spawnNode(SCORES_SCRIPT, ['--webkit', '--clear'], {
      ...process.env,
      BASE_URL: '',
    });

    expect(status).toBe(1);
    expect(output).toContain('clear-records variant is Chromium-only');
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
    expect(script).toContain('const MODE_LABEL =');
    expect(script).toMatch(/SHORT_BEFORE\s*\n\s*\? 'short-before'/);
  });

  it('no longer maps --before to a capture mode in the script', () => {
    const script = readFileSync(SCRIPT, 'utf8');

    expect(script).not.toContain("process.argv.includes('--before')");
    expect(script).not.toContain("MODE === 'before'");
  });
});


describe('WebKit screenshot modes', () => {
  it('selects WebKit only when a WebKit flag is present', () => {
    expect(parseCaptureEngine([])).toBe('chromium');
    expect(parseCaptureEngine(['--short'])).toBe('chromium');
    expect(parseCaptureEngine(['--webkit'])).toBe('webkit');
    expect(parseCaptureEngine(['--webkit-narrow'])).toBe('webkit');
    expect(parseCaptureEngine(['--webkit-narrow-before'])).toBe('webkit');
  });

  it('uses the same iPhone SE device as the mobile-webkit project', () => {
    const webkit = phoneContextOptions('webkit');
    expect(webkit.viewport).toEqual({ width: 375, height: 667 });
    expect(webkit.deviceScaleFactor).toBe(2);
    expect(webkit.isMobile).toBe(true);
    expect(webkit.hasTouch).toBe(true);
    expect(webkit.colorScheme).toBe('dark');
    expect(webkit.reducedMotion).toBe('reduce');
    expect(webkit.userAgent).toContain('iPhone');

    const narrow = phoneContextOptions('webkit', {
      viewport: { width: 320, height: 640 },
    });
    expect(narrow.viewport).toEqual({ width: 320, height: 640 });
    expect(narrow.screen).toEqual({ width: 320, height: 640 });

    const chromium = phoneContextOptions('chromium', {
      viewport: { width: 390, height: 844 },
    });
    expect(chromium.viewport).toEqual({ width: 390, height: 844 });
    expect(chromium.deviceScaleFactor).toBe(2);
  });

  it('records engine, viewport and theme for every capture', () => {
    const record = captureRecord(
      'after-minesweeper-ready-webkit.png',
      'webkit',
      { width: 375, height: 667 },
    );
    expect(record).toContain('after-minesweeper-ready-webkit.png');
    expect(record).toContain('engine=webkit');
    expect(record).toContain('viewport=375x667');
    expect(record).toContain('theme=dark');
    expect(record).toContain('reducedMotion=reduce');
  });

  it('exposes a WebKit npm command for every capture script', () => {
    const scripts = packageJson.scripts ?? {};
    for (const name of WEBKIT_SCRIPT_MODES) {
      const command = scripts[name];
      expect(command, name).toBeDefined();
      if (name.endsWith(':webkit-narrow')) {
        expect(command, name).toContain('--webkit-narrow');
      } else if (name.endsWith(':webkit-narrow-before')) {
        expect(command, name).toContain('--webkit-narrow-before');
      } else if (name === 'screenshots:minesweeper:webkit-before') {
        expect(command, name).toContain('--webkit --touch-before');
      } else {
        expect(command, name).toContain('--webkit');
      }
    }
  });

  it('maps every capture script to its WebKit command and flag', () => {
    const scripts = packageJson.scripts ?? {};
    const captureScripts = readdirSync(SCRIPT_DIR)
      .filter((name) => name.startsWith('capture-') && name !== 'capture-baseline.mjs')
      .sort();
    expect(Object.keys(WEBKIT_SCRIPT_COMMANDS).sort()).toEqual(captureScripts);
    for (const [file, commands] of Object.entries(WEBKIT_SCRIPT_COMMANDS)) {
      expect(existsSync(join(SCRIPT_DIR, file)), file).toBe(true);
      for (const name of commands) {
        expect(scripts[name], name).toBeDefined();
        expect(scripts[name], name).toContain(file);
        expect(scripts[name], name).toContain('--webkit');
      }
    }
  });

  it('uses the same iPhone SE device as the mobile-webkit e2e project', () => {
    const config = readFileSync(PLAYWRIGHT_CONFIG, 'utf8');
    expect(config).toMatch(/name: 'mobile-webkit'[\s\S]*?devices\['iPhone SE \(3rd gen\)'\]/);
    expect(phoneContextOptions('webkit')).toMatchObject({
      viewport: { width: 375, height: 667 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
  });

  it('keeps Chromium commands and filenames working alongside WebKit', () => {
    const scripts = packageJson.scripts ?? {};
    for (const name of ['screenshots', 'screenshots:snake', 'screenshots:2048', 'screenshots:breakout', 'screenshots:minesweeper']) {
      expect(scripts[name], name).toBeDefined();
      expect(scripts[name], name).not.toContain('--webkit');
    }
  });

  it('no longer uses a Chromium-only CDP touch session in any capture script', () => {
    for (const file of readdirSync(SCRIPT_DIR).filter((name) => name.startsWith('capture-'))) {
      const source = readFileSync(join(SCRIPT_DIR, file), 'utf8');
      expect(source, file).not.toContain('newCDPSession');
      expect(source, file).not.toContain('Input.dispatchTouchEvent');
    }
    const touchHelper = readFileSync(join(SCRIPT_DIR, 'lib', 'touch-input.mjs'), 'utf8');
    expect(touchHelper).toContain("pointerType: 'touch'");
    expect(touchHelper).toContain("'pointerdown'");
    expect(touchHelper).toContain("'pointerup'");
    expect(touchHelper).toContain("'click'");
  });

  it('documents every WebKit screenshot and its generation command', () => {
    const docs = readFileSync(SCREENSHOTS_README, 'utf8');
    for (const file of WEBKIT_SCREENSHOTS) {
      expect(existsSync(join(SCREENSHOT_DIR, file)), file).toBe(true);
      expect(docs, file).toContain(file);
    }
    for (const name of WEBKIT_SCRIPT_MODES) {
      expect(docs, name).toContain(`npm run ${name}`);
    }
    expect(docs).toContain('engine=webkit');
    expect(docs).toContain('viewport=');
    expect(docs).toContain('theme=dark');
    expect(docs).not.toContain('未入库的临时脚本');
    expect(docs).not.toContain('.plan/capture-evidence-all.mjs');
  });

  it('keeps README and framework coverage free of the Chromium-only screenshot note', () => {
    for (const file of [README, FRAMEWORK]) {
      const doc = readFileSync(file, 'utf8');
      expect(doc, file).not.toContain('截图脚本仍只在 Chromium 下运行');
      expect(doc, file).not.toContain('#100 继续跟踪截图脚本的 WebKit 覆盖');
      expect(doc, file).toContain('screenshots:minesweeper:webkit');
    }
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

        expect(status).toBe(1);
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

        expect(status).toBe(1);
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
