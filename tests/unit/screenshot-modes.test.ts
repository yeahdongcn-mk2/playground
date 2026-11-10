import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  captureRecord,
  captureScreenshot,
  parseCaptureEngine,
  phoneContextOptions,
} from '../../scripts/lib/capture-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'capture-minesweeper-screenshots.mjs');
const GENERIC_SCRIPT = join(ROOT, 'scripts', 'capture-screenshots.mjs');
const SCORES_SCRIPT = join(ROOT, 'scripts', 'capture-minesweeper-scores-screenshots.mjs');
const SCRIPT_2048 = join(ROOT, 'scripts', 'capture-2048-screenshots.mjs');
const SCRIPT_BREAKOUT = join(ROOT, 'scripts', 'capture-breakout-screenshots.mjs');
const SNAKE_SCRIPT = join(ROOT, 'scripts', 'capture-snake-screenshots.mjs');
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

/** Every screenshot script that must know about the shared capture runtime. */
const CAPTURE_SCRIPTS = readdirSync(SCRIPT_DIR)
  .filter(
    (name) =>
      name.startsWith('capture-') &&
      name.endsWith('.mjs') &&
      name !== 'capture-baseline.mjs',
  )
  .sort();

interface WebkitScriptGuard {
  /** WebKit-only capture helpers the script must define. */
  functions: readonly string[];
  /**
   * The dispatch branch that calls the WebKit helper. The match deliberately
   * stops at the first nested `{` so a helper that is defined but no longer
   * called cannot keep the guard green.
   */
  dispatch: RegExp;
}

const WEBKIT_SCRIPT_GUARDS: Record<string, WebkitScriptGuard> = {
  'capture-screenshots.mjs': {
    functions: ['captureWebkitMobile'],
    dispatch: /if \(IS_WEBKIT\)\s*\{[^{}]*\bcaptureWebkitMobile\(browser\)/,
  },
  'capture-snake-screenshots.mjs': {
    functions: ['captureWebkitMobile'],
    dispatch: /if \(IS_WEBKIT\)\s*\{[^{}]*\bcaptureWebkitMobile\(browser\)/,
  },
  'capture-2048-screenshots.mjs': {
    functions: ['captureWebkitMobile'],
    dispatch: /if \(IS_WEBKIT\)\s*\{[^{}]*\bcaptureWebkitMobile\(browser\)/,
  },
  'capture-breakout-screenshots.mjs': {
    functions: ['captureWebkitMobile'],
    dispatch: /if \(IS_WEBKIT\)\s*\{[^{}]*\bcaptureWebkitMobile\(browser\)/,
  },
  'capture-minesweeper-screenshots.mjs': {
    functions: ['captureWebkitNarrow', 'captureTouchMobile'],
    dispatch: /if \(IS_WEBKIT\)\s*\{[^{}]*\bcaptureTouchMobile\(browser,/,
  },
  'capture-minesweeper-scores-screenshots.mjs': {
    functions: ['captureWebkitMobile'],
    dispatch: /if \(IS_WEBKIT\)\s*\{[^{}]*\bcaptureWebkitMobile\(browser\)/,
  },
};

interface WebkitArtifacts {
  /** Names written in modes whose screenshots the repository commits. */
  committed: string[];
  /**
   * `--webkit --touch-before` phone names: they need BASE_URL at the pre-touch
   * baseline and docs/screenshots/README.md says those Before files are not
   * committed. Everything else must exist on disk and be documented.
   */
  transient: string[];
}

function captureSource(file: string): string {
  return readFileSync(join(SCRIPT_DIR, file), 'utf8');
}

/** Literal `*-webkit*.png` names referenced by a script. */
function literalWebkitPngNames(source: string): string[] {
  return [...source.matchAll(/['"]([^'"\n]*-webkit[^'"\n]*\.png)['"]/g)].map(
    (match) => match[1]!,
  );
}

/** Template literals that build a `*-webkit*.png` name at runtime. */
function webkitPngTemplates(source: string): string[] {
  return [...source.matchAll(/`([^`\n]*-webkit[^`\n]*)`/g)]
    .map((match) => match[1]!)
    .filter((template) => template.includes('${'));
}

/**
 * The two prefixes one WebKit branch passes to its capture helper.
 *
 * The dispatch regex is anchored to the branch that actually runs the helper
 * and captures the branch's mode literal plus both ternaries. Reading the call
 * site, not every `'after'` / `'before'` literal in the file, makes a rename at
 * the point that supplies the prefix change the expanded set.
 */
function dispatchPrefixes(
  source: string,
  dispatch: RegExp,
  beforeMode: string,
): string[] {
  const match = source.match(dispatch);
  expect(
    match,
    `${beforeMode} should dispatch its capture helper with before/after prefixes`,
  ).not.toBeNull();

  const [, mode, beforePrefix, afterPrefix] = match!;
  expect(mode, 'the before mode literal should keep its name').toBe(beforeMode);
  expect(beforePrefix, 'the before branch should pass a before* prefix').toMatch(/^before/);
  expect(afterPrefix, 'the after branch should pass an after* prefix').toMatch(/^after/);

  const prefixes = [...new Set([beforePrefix!, afterPrefix!])];
  expect(prefixes, 'the two branches should pass distinct prefixes').toHaveLength(2);
  return prefixes;
}

function isTransientBeforeTouch(name: string): boolean {
  // The committed narrow Before matrix also starts with `before-`; only the
  // touch-before phone states are absent from the repository.
  return /^before-minesweeper-(?!webkit-narrow-).*-webkit\.png$/.test(name);
}

/**
 * Expand every `*-webkit*.png` name a capture script can write from its own
 * source: literal file names plus the two template families the scripts use.
 *
 * The expansion reads the scene list, viewport matrix and file prefix from the
 * script instead of restating them, so renaming an artifact or dropping a
 * template changes the extracted set and fails the cross-check against the
 * committed files and docs.
 */
function extractWebkitArtifacts(file: string): WebkitArtifacts {
  const source = captureSource(file);
  const names = new Set(literalWebkitPngNames(source));
  const templates = webkitPngTemplates(source);
  const handledTemplates = new Set<string>();

  const expandTemplate = (template: string, expand: () => readonly string[]) => {
    if (!templates.includes(template)) {
      return;
    }
    handledTemplates.add(template);
    for (const name of expand()) {
      names.add(name);
    }
  };

  if (file === 'capture-minesweeper-screenshots.mjs') {
    const states = [...source.matchAll(/touchMobileName\(prefix, '([a-z]+)'\)/g)].map(
      (match) => match[1]!,
    );
    expect(states.length, 'touchMobileName should be called for each phone state').toBeGreaterThan(0);

    const touchPrefixes = dispatchPrefixes(
      source,
      // Anchored to the IS_WEBKIT branch so the Chromium `'after'` / `'before'`
      // call sites below it cannot satisfy (or shadow) the extraction.
      /if \(IS_WEBKIT\)\s*\{[^{}]*await captureTouchMobile\(browser, MODE === '([a-z-]+)' \? '([a-z0-9-]+)' : '([a-z0-9-]+)'\);/,
      'touch-before',
    );
    const narrowPrefixes = dispatchPrefixes(
      source,
      // Anchored to the narrow branch that actually calls captureWebkitNarrow.
      /if \(MODE === 'webkit-narrow' \|\| MODE === 'webkit-narrow-before'\)\s*\{[^{}]*await captureWebkitNarrow\(browser, MODE === '([a-z-]+)' \? '([a-z0-9-]+)' : '([a-z0-9-]+)'\);/,
      'webkit-narrow-before',
    );

    expandTemplate('${prefix}-minesweeper-${state}-webkit.png', () =>
      touchPrefixes.flatMap((prefix) =>
        states.map((state) => `${prefix}-minesweeper-${state}-webkit.png`),
      ),
    );

    // The narrow matrix must come from the loop in captureWebkitNarrow itself:
    // a different iterated list fails here, and the committed-file cross-check
    // catches a viewport removed from the constant.
    const narrowLoop = source.match(
      /async function captureWebkitNarrow\([^)]*\)\s*\{[^{}]*for \(const viewport of ([A-Za-z_$][\w$]*)\)/,
    );
    expect(narrowLoop?.[1], 'captureWebkitNarrow should iterate a named viewport list').toBe(
      'WEBKIT_NARROW_VIEWPORTS',
    );

    // A `continue` / `if` between the loop and its capture call would skip a
    // viewport even though the iterated list is unchanged, leaving that
    // committed artifact stale while every source-derived check stays green.
    const loopIndex = source.indexOf('for (const viewport of WEBKIT_NARROW_VIEWPORTS)');
    const captureIndex = source.indexOf(
      '${prefix}-minesweeper-webkit-narrow-',
      loopIndex,
    );
    expect(captureIndex, 'the narrow loop should reach its capture call').toBeGreaterThan(
      loopIndex,
    );
    expect(
      source.slice(loopIndex, captureIndex),
      'the narrow loop should not skip a viewport before capturing',
    ).not.toMatch(/\b(?:continue|break)\b|\bif \(/);

    const viewportBlock = source.match(/const WEBKIT_NARROW_VIEWPORTS = \[([\s\S]*?)\];/);
    expect(viewportBlock, 'WEBKIT_NARROW_VIEWPORTS should be declared').not.toBeNull();
    const viewports = [
      ...(viewportBlock?.[1] ?? '').matchAll(/\{ width: (\d+), height: (\d+) \}/g),
    ].map((match) => `${match[1]}x${match[2]}`);
    expect(viewports.length, 'the narrow matrix should list its viewports').toBeGreaterThan(0);

    expandTemplate(
      '${prefix}-minesweeper-webkit-narrow-${viewport.width}x${viewport.height}.png',
      () =>
        narrowPrefixes.flatMap((prefix) =>
          viewports.map((viewport) => `${prefix}-minesweeper-webkit-narrow-${viewport}.png`),
        ),
    );
  }

  if (file === 'capture-minesweeper-scores-screenshots.mjs') {
    // `--webkit --clear` is rejected, so only the non-clear branch can name a
    // WebKit artifact.
    const filePrefix = source.match(/const FILE_PREFIX = [^;]*?: '([^']+)';/)?.[1];
    expect(filePrefix, 'FILE_PREFIX should keep a non-clear value').toBeTruthy();
    expandTemplate('after-${FILE_PREFIX}-webkit.png', () => [
      `after-${filePrefix!}-webkit.png`,
    ]);
  }

  expect(
    [...handledTemplates].sort(),
    `${file}: every WebKit .png template needs an explicit expansion`,
  ).toEqual(templates.sort());

  const artifacts = [...names].sort();
  return {
    committed: artifacts.filter((name) => !isTransientBeforeTouch(name)),
    transient: artifacts.filter(isTransientBeforeTouch),
  };
}

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

/** Hold a 127.0.0.1 port open for the duration of the test. */
function listenOnPort(port: number): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
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

/** Hold a random 127.0.0.1 port open for the duration of the test. */
function listenOnRandomPort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return listenOnPort(0);
}

/**
 * The body of the first `marker { ... }` block in `source`, matched by braces.
 *
 * Position-only assertions cannot prove the preview startup sits inside the
 * guard: closing the guard immediately and moving the startup lines after it
 * keeps every `indexOf` ordering intact. Skipping strings and comments makes
 * the brace match insensitive to textual braces.
 */
function blockBody(source: string, marker: string): string {
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) {
    throw new Error(`Missing ${marker}`);
  }
  const open = source.indexOf('{', markerAt + marker.length);
  if (open === -1) {
    throw new Error(`Missing block after ${marker}`);
  }

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "'" || char === '"' || char === '`') {
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '\\') {
          i += 1;
        } else if (source[i] === char) {
          break;
        }
      }
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) {
        break;
      }
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        throw new Error(`Unterminated comment after ${marker}`);
      }
      i = end + 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`Unbalanced block after ${marker}`);
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

describe('WebKit screenshot static guards', () => {
  it('guards exactly the capture scripts that write screenshots', () => {
    expect(Object.keys(WEBKIT_SCRIPT_GUARDS).sort()).toEqual(CAPTURE_SCRIPTS);
  });

  it.each(CAPTURE_SCRIPTS)(
    'selects the engine through the runtime and dispatches WebKit in %s',
    (file) => {
      const source = captureSource(file);
      const guard = WEBKIT_SCRIPT_GUARDS[file];
      expect(guard, file).toBeDefined();

      expect(source, file).toMatch(/from '\.\/lib\/capture-runtime\.mjs'/);
      expect(source, file).toMatch(/\bparseCaptureEngine\(ARGS\)/);
      expect(source, file).toMatch(/\bIS_WEBKIT = ENGINE === WEBKIT_ENGINE\b/);
      expect(source, file).toMatch(/\blaunchCaptureBrowser\(ENGINE\)/);
      for (const fn of guard?.functions ?? []) {
        expect(source, `${file}: ${fn}`).toMatch(new RegExp(`async function ${fn}\\(`));
      }
      expect(source, `${file}: IS_WEBKIT dispatch`).toMatch(guard!.dispatch);
    },
  );

  it('keeps both WebKit narrow modes wired in the minesweeper script', () => {
    const source = captureSource('capture-minesweeper-screenshots.mjs');

    expect(source).toContain('WEBKIT_NARROW_FLAG');
    expect(source).toContain('WEBKIT_NARROW_BEFORE_FLAG');
    expect(source).toMatch(/MODE === 'webkit-narrow' \|\| MODE === 'webkit-narrow-before'/);
    expect(source).toMatch(
      /if \(MODE === 'webkit-narrow' \|\| MODE === 'webkit-narrow-before'\)\s*\{[^{}]*captureWebkitNarrow\(browser,/,
    );
  });

  it.each(CAPTURE_SCRIPTS)(
    'maps %s WebKit artifacts to committed files and the screenshot docs',
    (file) => {
      const { committed, transient } = extractWebkitArtifacts(file);
      const docs = readFileSync(SCREENSHOTS_README, 'utf8');

      expect(committed.length + transient.length, file).toBeGreaterThan(0);
      for (const name of committed) {
        expect(existsSync(join(SCREENSHOT_DIR, name)), name).toBe(true);
        expect(docs, name).toContain(name);
      }
      for (const name of transient) {
        // `--webkit --touch-before` files need a baseline preview and are
        // explicitly not committed (docs/screenshots/README.md, webkit-phone).
        expect(existsSync(join(SCREENSHOT_DIR, name)), name).toBe(false);
      }
    },
  );

  it('has a one-to-one mapping between scripts, committed files and docs', () => {
    const committed = readdirSync(SCREENSHOT_DIR)
      .filter((name) => name.includes('-webkit') && name.endsWith('.png'))
      .sort();
    const documented = [
      ...new Set(
        [
          ...readFileSync(SCREENSHOTS_README, 'utf8').matchAll(
            /[a-z0-9][a-z0-9.-]*-webkit[a-z0-9.-]*\.png/g,
          ),
        ].map((match) => match[0]!),
      ),
    ].sort();
    const extracted = CAPTURE_SCRIPTS.flatMap(
      (file) => extractWebkitArtifacts(file).committed,
    ).sort();

    expect(committed.length).toBeGreaterThan(0);
    expect(documented, 'docs and committed WebKit screenshots should match').toEqual(committed);
    expect(extracted, 'every committed screenshot should come from a script').toEqual(committed);
  });
});

describe('captureScreenshot evidence logging', () => {
  it('logs the engine, viewport and theme passed for every image a fake page writes', async () => {
    const writes: Array<{ path: string; fullPage?: boolean }> = [];
    let viewport = { width: 375, height: 667 };
    const page = {
      viewportSize: () => viewport,
      screenshot: async (options: { path: string; fullPage?: boolean }) => {
        writes.push(options);
      },
    } as unknown as Page;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Different engines, themes and viewports per call: a constant returned by
    // captureRecord instead of its arguments cannot match every case.
    const calls = [
      {
        name: 'after-hub-webkit.png',
        engine: 'webkit',
        viewport: { width: 375, height: 667 },
        theme: 'dark',
        fullPage: false,
      },
      {
        name: 'after-minesweeper-scores-webkit.png',
        engine: 'webkit',
        viewport: { width: 320, height: 640 },
        theme: 'dark',
        fullPage: true,
      },
      {
        name: 'after-hub.png',
        engine: 'chromium',
        viewport: { width: 390, height: 844 },
        theme: 'light',
        fullPage: false,
      },
    ] as const;

    try {
      for (const call of calls) {
        viewport = call.viewport;
        await captureScreenshot(page, call.name, {
          engine: call.engine,
          colorScheme: call.theme,
          fullPage: call.fullPage,
        });
      }

      expect(writes.map((write) => write.path)).toEqual(
        calls.map((call) => `docs/screenshots/${call.name}`),
      );
      expect(writes.map((write) => write.fullPage)).toEqual(calls.map((call) => call.fullPage));

      // One record per write, matched by file name and position so a missing or
      // reordered log line cannot be hidden by a log from another capture.
      expect(log.mock.calls).toHaveLength(writes.length);
      for (const [index, call] of calls.entries()) {
        const record = String(log.mock.calls[index]?.[0]);
        expect(record, call.name).toContain(`${call.name}: engine=${call.engine}`);
        expect(record, call.name).toContain(`theme=${call.theme}`);
        expect(record, call.name).toContain(
          `viewport=${call.viewport.width}x${call.viewport.height}`,
        );
      }
    } finally {
      log.mockRestore();
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

describe('minesweeper scores screenshot preview startup', () => {
  it('uses the shared preview startup helper and keeps the default and Before guards', () => {
    const source = readFileSync(SCORES_SCRIPT, 'utf8');

    expect(source).toMatch(/from '\.\/lib\/preview-server\.mjs'/);
    expect(source).toContain(
      'await waitForPreviewServer(server, { origin: ORIGIN, port: PORT });',
    );
    // The private copy must not come back: only the shared helper bounds each
    // probe with AbortSignal.timeout and rechecks the child after a response.
    expect(source).not.toContain('function waitForServer');
    expect(source).not.toContain('previewStartupError');
    expect(source).not.toMatch(/from 'node:timers\/promises'/);

    // No fallback argument keeps the shared 4192 default; preview-port.test.ts
    // covers the empty-string PREVIEW_PORT fallback.
    expect(source).toContain('const PORT = parsePreviewPort();');
    expect(source).toContain('entry: process.env.PREVIEW_ENTRY || undefined');

    // The probe and spawn stay inside the After branch, so a Before run with
    // BASE_URL never touches the local preview port. Extracting the guarded
    // block by matching braces makes this falsifiable: closing the guard early
    // and moving the startup lines after it empties the block, so these
    // assertions fail instead of matching elsewhere in the file.
    const beforeBlock = blockBody(source, 'if (!BEFORE)');
    const probe = beforeBlock.indexOf('await assertPortAvailable(PORT, HOST);');
    const spawn = beforeBlock.indexOf('startPreviewServer({');
    const wait = beforeBlock.indexOf('waitForPreviewServer(server,');
    expect(probe).toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(probe);
    expect(wait).toBeGreaterThan(spawn);

    // A duplicate after the guard must not satisfy the assertions above: the
    // startup code has to live in the Before-excluding branch, not merely
    // somewhere in the file.
    const afterBlock = source.slice(
      source.indexOf(beforeBlock) + beforeBlock.length,
    );
    expect(afterBlock).not.toContain('assertPortAvailable(PORT, HOST)');
    expect(afterBlock).not.toContain('startPreviewServer({');
    expect(afterBlock).not.toContain('waitForPreviewServer(server,');
  });

  it(
    'fails fast without screenshots when PREVIEW_PORT is taken',
    { timeout: 30_000 },
    async () => {
      const owner = await listenOnRandomPort();
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        delete env.PREVIEW_ENTRY;
        env.PREVIEW_PORT = String(owner.port);

        const { status, output } = spawnNode(SCORES_SCRIPT, [], env);

        expect(status).toBe(1);
        // The specific failure names the real port and the fix; a generic
        // locator timeout from a private poller would not match this.
        expect(output).toContain(
          `Cannot start the preview server on 127.0.0.1:${owner.port}`,
        );
        expect(output).toContain('the port is already in use');
        expect(output).toContain('Set PREVIEW_PORT');
        expect(output).not.toContain('Saved');
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
      const dir = mkdtempSync(join(tmpdir(), 'minesweeper-scores-preview-'));
      const fakePreview = join(dir, 'fake-preview.mjs');
      writeFileSync(
        fakePreview,
        "process.stderr.write('scores preview exploded\\n');\nprocess.exit(9);\n",
      );
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        env.PREVIEW_PORT = String(port);
        // Test seam consumed by the scores script: stand in for vite preview
        // with a process that dies right after an otherwise successful probe.
        env.PREVIEW_ENTRY = fakePreview;

        const { status, output } = spawnNode(SCORES_SCRIPT, [], env);

        expect(status).toBe(1);
        expect(output).toContain(
          `The preview server exited before http://127.0.0.1:${port} became ready`,
        );
        // The child's own exit code and stderr reach the operator, so the
        // post-probe race is not mistaken for a locator or port failure.
        expect(output).toContain('exit code 9');
        expect(output).toContain('scores preview exploded');
        expect(output).toContain('PREVIEW_PORT');
        expect(output).not.toContain('Saved');
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

interface PreviewPortScript {
  label: string;
  script: string;
  defaultPort: number;
  fakePreviewExitCode: number;
  fakePreviewStderr: string;
  tempPrefix: string;
  /** Text the successful capture path prints; its absence proves no screenshot ran. */
  successMarker: string;
}

/**
 * These scripts still had private readiness pollers and a port fixed in source,
 * so their failing branches need the same coverage as the minesweeper scripts.
 */
const PREVIEW_PORT_SCRIPTS: readonly PreviewPortScript[] = [
  {
    label: 'generic hub / blank',
    script: GENERIC_SCRIPT,
    defaultPort: 4174,
    fakePreviewExitCode: 5,
    fakePreviewStderr: 'fake generic preview exploded',
    tempPrefix: 'generic-preview-',
    successMarker: 'Screenshots written to',
  },
  {
    label: '2048',
    script: SCRIPT_2048,
    defaultPort: 4183,
    fakePreviewExitCode: 7,
    fakePreviewStderr: 'fake 2048 preview exploded',
    tempPrefix: '2048-preview-',
    successMarker: 'Captured',
  },
  {
    label: 'breakout',
    script: SCRIPT_BREAKOUT,
    defaultPort: 4185,
    fakePreviewExitCode: 9,
    fakePreviewStderr: 'fake breakout preview exploded',
    tempPrefix: 'breakout-preview-',
    successMarker: 'Captured',
  },
];

describe('generic, 2048 and breakout screenshot preview startup', () => {
  it.each(PREVIEW_PORT_SCRIPTS)(
    'uses the shared preview startup helper and keeps the Before guard ($label)',
    ({ script, defaultPort }) => {
      const source = readFileSync(script, 'utf8');

      expect(source).toMatch(/from '\.\/lib\/preview-port\.mjs'/);
      expect(source).toMatch(/from '\.\/lib\/preview-server\.mjs'/);
      expect(source).toContain(
        'await waitForPreviewServer(server, { origin: ORIGIN, port: PORT });',
      );
      // The private copy must not come back: only the shared helper bounds each
      // probe with AbortSignal.timeout and rechecks the child after a response.
      expect(source).not.toContain('function waitForServer');
      expect(source).not.toMatch(/from 'node:timers\/promises'/);

      // The fallback argument keeps each script's original default port, so an
      // empty PREVIEW_PORT cannot silently move the capture to the shared 4192.
      expect(source).toContain(
        `const PORT = parsePreviewPort(process.env.PREVIEW_PORT, ${defaultPort});`,
      );
      expect(source).toContain('entry: process.env.PREVIEW_ENTRY || undefined');

      // The probe and spawn stay inside the After branch, so a Before run with
      // BASE_URL never touches the local preview port. Extracting the guarded
      // block by matching braces makes this falsifiable: closing the guard
      // early and moving the startup lines after it empties the block.
      const beforeBlock = blockBody(source, 'if (!process.env.BASE_URL)');
      const probe = beforeBlock.indexOf('await assertPortAvailable(PORT, HOST);');
      const spawn = beforeBlock.indexOf('startPreviewServer({');
      const wait = beforeBlock.indexOf('waitForPreviewServer(server,');
      expect(probe).toBeGreaterThan(-1);
      expect(spawn).toBeGreaterThan(probe);
      expect(wait).toBeGreaterThan(spawn);

      // A duplicate after the guard must not satisfy the assertions above: the
      // startup code has to live in the BASE_URL-excluding branch, not merely
      // somewhere in the file.
      const afterBlock = source.slice(
        source.indexOf(beforeBlock) + beforeBlock.length,
      );
      expect(afterBlock).not.toContain('assertPortAvailable(PORT, HOST)');
      expect(afterBlock).not.toContain('startPreviewServer({');
      expect(afterBlock).not.toContain('waitForPreviewServer(server,');
    },
  );

  it.each(PREVIEW_PORT_SCRIPTS)(
    'fails fast without screenshots when PREVIEW_PORT is taken ($label)',
    { timeout: 30_000 },
    async ({ script, successMarker }) => {
      const owner = await listenOnRandomPort();
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        delete env.PREVIEW_ENTRY;
        env.PREVIEW_PORT = String(owner.port);

        const { status, output } = spawnNode(script, [], env);

        expect(status).toBe(1);
        // The specific failure names the real port and the fix; a generic
        // locator timeout from the old private poller would not match this.
        expect(output).toContain(
          `Cannot start the preview server on 127.0.0.1:${owner.port}`,
        );
        expect(output).toContain('the port is already in use');
        expect(output).toContain('Set PREVIEW_PORT');
        expect(output).not.toContain(successMarker);
        // Byte-for-byte proof that no screenshot was created or overwritten.
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        await owner.close();
      }
    },
  );

  it.each(PREVIEW_PORT_SCRIPTS)(
    'falls back to its own default port when PREVIEW_PORT is empty ($label)',
    { timeout: 45_000 },
    async ({
      script,
      defaultPort,
      fakePreviewExitCode,
      fakePreviewStderr,
      tempPrefix,
      successMarker,
    }) => {
      const dir = mkdtempSync(join(tmpdir(), tempPrefix));
      const fakePreview = join(dir, 'fake-preview.mjs');
      writeFileSync(
        fakePreview,
        `process.stderr.write('${fakePreviewStderr}\\n');\nprocess.exit(${fakePreviewExitCode});\n`,
      );
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        env.PREVIEW_PORT = '';
        env.PREVIEW_ENTRY = fakePreview;

        const { status, output } = spawnNode(script, [], env);

        expect(status).toBe(1);
        // Both failure paths name the resolved port: the bind error when the
        // default is taken, the startup error when the stand-in exits. Either
        // way the resolved port proves the empty value fell back correctly.
        expect(output).toContain(`127.0.0.1:${defaultPort}`);
        expect(output).not.toContain('127.0.0.1:4192');
        expect(output).not.toContain(successMarker);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(PREVIEW_PORT_SCRIPTS)(
    'fails with the preview exit code and stderr when the preview dies after the port probe ($label)',
    { timeout: 45_000 },
    async ({
      script,
      fakePreviewExitCode,
      fakePreviewStderr,
      tempPrefix,
      successMarker,
    }) => {
      const probe = await listenOnRandomPort();
      const port = probe.port;
      // Releasing the port makes the pre-spawn probe pass; the fake preview
      // then owns the post-probe failure the wait helper must surface.
      await probe.close();
      const dir = mkdtempSync(join(tmpdir(), tempPrefix));
      const fakePreview = join(dir, 'fake-preview.mjs');
      writeFileSync(
        fakePreview,
        `process.stderr.write('${fakePreviewStderr}\\n');\nprocess.exit(${fakePreviewExitCode});\n`,
      );
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        env.PREVIEW_PORT = String(port);
        // Test seam consumed by the capture script: stand in for vite preview
        // with a process that dies right after an otherwise successful probe.
        env.PREVIEW_ENTRY = fakePreview;

        const { status, output } = spawnNode(script, [], env);

        expect(status).toBe(1);
        expect(output).toContain(
          `The preview server exited before http://127.0.0.1:${port} became ready`,
        );
        // The child's own exit code and stderr reach the operator, so the
        // post-probe race is not mistaken for a locator or port failure.
        expect(output).toContain(`exit code ${fakePreviewExitCode}`);
        expect(output).toContain(fakePreviewStderr);
        expect(output).toContain('PREVIEW_PORT');
        expect(output).not.toContain(successMarker);
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'guards the port before launching the WebKit engine (--webkit)',
    { timeout: 30_000 },
    async () => {
      const owner = await listenOnRandomPort();
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.BASE_URL;
        delete env.PREVIEW_ENTRY;
        env.PREVIEW_PORT = String(owner.port);

        // The WebKit mode shares the startup path: a taken port must fail
        // before the browser launches, not after an unrelated locator timeout.
        const { status, output } = spawnNode(GENERIC_SCRIPT, ['--webkit'], env);

        expect(status).toBe(1);
        expect(output).toContain(
          `Cannot start the preview server on 127.0.0.1:${owner.port}`,
        );
        expect(output).toContain('the port is already in use');
        expect(output).toContain('Set PREVIEW_PORT');
        expect(output).not.toContain('Screenshots written to');
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        await owner.close();
      }
    },
  );
});

describe('snake screenshot dev server startup', () => {
  it('guards the dev server port before spawning and uses the shared readiness helper', () => {
    const source = readFileSync(SNAKE_SCRIPT, 'utf8');

    expect(source).toMatch(/from '\.\/lib\/preview-port\.mjs'/);
    expect(source).toMatch(/from '\.\/lib\/preview-server\.mjs'/);
    // The dev server keeps its own 5188 default; an empty PREVIEW_PORT must
    // fall back to it instead of the shared 4192 preview default.
    expect(source).toContain(
      'const PORT = parsePreviewPort(process.env.PREVIEW_PORT, 5188);',
    );
    expect(source).toContain("const SERVER_NAME = 'dev';");
    expect(source).toContain(
      'await assertPortAvailable(PORT, HOST, { serverName: SERVER_NAME });',
    );
    expect(source).toContain('await waitForPreviewServer(server, {');
    expect(source).toContain('origin: ORIGIN,');
    expect(source).toContain('port: PORT,');
    expect(source).toContain('serverName: SERVER_NAME,');
    // Test seam: a stand-in entry can replace the Vite dev server binary.
    expect(source).toContain(
      "process.env.PREVIEW_ENTRY || 'node_modules/vite/bin/vite.js'",
    );
    // The private poller must not come back; the shared helper bounds probes
    // and rechecks the child after a response.
    expect(source).not.toContain('function waitForServer');
    expect(source).not.toContain('Timed out waiting for');
    // Dev-server purpose and the fixed-first-fruit scenario stay unchanged.
    expect(source).toContain("'--strictPort',");
    expect(source).toContain('food=11,10');
    expect(source).not.toContain("'preview',");
  });

  it(
    'fails fast without screenshots when PREVIEW_PORT is taken',
    { timeout: 30_000 },
    async () => {
      const owner = await listenOnRandomPort();
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.PREVIEW_ENTRY;
        env.PREVIEW_PORT = String(owner.port);

        const { status, output } = spawnNode(SNAKE_SCRIPT, [], env);

        expect(status).toBe(1);
        // The dev server is named, not the preview the other scripts start.
        expect(output).toContain(
          `Cannot start the dev server on 127.0.0.1:${owner.port}`,
        );
        expect(output).toContain('the port is already in use');
        expect(output).toContain('Set PREVIEW_PORT');
        expect(output).not.toContain('Cannot start the preview server');
        expect(output).not.toContain('Captured');
        // Byte-for-byte proof that no screenshot was created or overwritten.
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        await owner.close();
      }
    },
  );

  it(
    'fails fast without screenshots when the default 5188 port is taken',
    { timeout: 30_000 },
    async () => {
      let owner: Awaited<ReturnType<typeof listenOnPort>> | null = null;
      try {
        owner = await listenOnPort(5188);
      } catch (error) {
        // Another process may already own 5188; the script must still report
        // the taken default port, so keep going without owning it.
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw error;
        }
      }
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        delete env.PREVIEW_ENTRY;
        delete env.PREVIEW_PORT;

        const { status, output } = spawnNode(SNAKE_SCRIPT, [], env);

        expect(status).toBe(1);
        expect(output).toContain(
          'Cannot start the dev server on 127.0.0.1:5188',
        );
        expect(output).toContain('the port is already in use');
        expect(output).toContain('Set PREVIEW_PORT');
        expect(output).not.toContain('Cannot start the preview server');
        expect(output).not.toContain('Captured');
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        await owner?.close();
      }
    },
  );

  it(
    'reports the dev server exit code and stderr when it dies after the port probe',
    { timeout: 45_000 },
    async () => {
      const probe = await listenOnRandomPort();
      const port = probe.port;
      // Releasing the port makes the pre-spawn probe pass; the fake entry then
      // owns the post-probe failure the shared wait helper must surface.
      await probe.close();
      const dir = mkdtempSync(join(tmpdir(), 'snake-dev-server-'));
      const fakeEntry = join(dir, 'fake-dev-server.mjs');
      writeFileSync(
        fakeEntry,
        "process.stderr.write('fake snake dev server exploded\\n');\nprocess.exit(7);\n",
      );
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        env.PREVIEW_PORT = String(port);
        env.PREVIEW_ENTRY = fakeEntry;

        const { status, output } = spawnNode(SNAKE_SCRIPT, [], env);

        expect(status).toBe(1);
        expect(output).toContain(
          `The dev server exited before http://127.0.0.1:${port} became ready`,
        );
        expect(output).toContain('vite dev server stopped');
        expect(output).toContain('exit code 7');
        expect(output).toContain('fake snake dev server exploded');
        expect(output).toContain('PREVIEW_PORT');
        expect(output).not.toContain('Captured');
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'falls back to 5188 when PREVIEW_PORT is empty',
    { timeout: 45_000 },
    async () => {
      // The fallback path needs 5188 to be free; if another process owns it,
      // the occupied-port test above already covers that failure mode.
      const probe = await listenOnPort(5188).catch(
        (error: NodeJS.ErrnoException) => error,
      );
      if (probe instanceof Error) {
        expect(probe.code).toBe('EADDRINUSE');
        return;
      }
      await probe.close();

      const dir = mkdtempSync(join(tmpdir(), 'snake-dev-fallback-'));
      const fakeEntry = join(dir, 'fake-dev-server.mjs');
      writeFileSync(
        fakeEntry,
        "process.stderr.write('fake snake dev server exploded\\n');\nprocess.exit(7);\n",
      );
      const screenshotsBefore = screenshotHashes();
      try {
        const env = { ...process.env };
        env.PREVIEW_PORT = '';
        env.PREVIEW_ENTRY = fakeEntry;

        const { status, output } = spawnNode(SNAKE_SCRIPT, [], env);

        expect(status).toBe(1);
        // The resolved port proves the empty value fell back to 5188, not 4192.
        expect(output).toContain('127.0.0.1:5188');
        expect(output).not.toContain('127.0.0.1:4192');
        expect(output).toContain('The dev server exited before');
        expect(output).toContain('exit code 7');
        expect(output).not.toContain('Captured');
        expect(screenshotHashes()).toEqual(screenshotsBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
