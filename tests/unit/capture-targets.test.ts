import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_TARGETS,
  dprForCaptureTarget,
} from '../../scripts/lib/capture-env.mjs';
import {
  CAPTURE_TARGET_IDS,
  MINESWEEPER_NARROW_FLAGS,
  MINESWEEPER_TOUCH_BEFORE_FLAG,
  PRINT_CAPTURE_TARGETS_FLAG,
  captureTargetsDeclaration,
  formatCaptureTargetsDeclaration,
  isPrintCaptureTargetsRequested,
  printCaptureTargets,
} from '../../scripts/lib/capture-targets.mjs';
import type { CaptureTargetsDeclaration } from '../../scripts/lib/capture-targets.mjs';
import {
  assertAllDeclaredCaptureTargets,
  logCaptureEnvironment,
  recordedCaptureTargets,
  resetRecordedCaptureTargets,
} from '../../scripts/lib/capture-runtime.mjs';
import {
  captureTargets as containerCaptureTargets,
  readPackageScripts,
  resolveCaptureTargets,
} from '../../scripts/run-container-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Each declaration case spawns a real capture script, whose Playwright import
// is slow enough to exceed the default 5s when a test covers many flag combos.
vi.setConfig({ testTimeout: 30_000 });
const SCRIPTS = readPackageScripts({
  packagePath: join(ROOT, 'package.json'),
});

/** Every screenshot script that owns a declaration (baseline is excluded). */
const CAPTURE_SCRIPT_FILES = [
  'capture-screenshots.mjs',
  'capture-snake-screenshots.mjs',
  'capture-2048-screenshots.mjs',
  'capture-breakout-screenshots.mjs',
  'capture-minesweeper-scores-screenshots.mjs',
  'capture-minesweeper-screenshots.mjs',
] as const;

/**
 * Each script's own default preview port (Issue #298), keyed by file name.
 *
 * The declaration must report this value even when `PREVIEW_PORT` overrides the
 * runtime port; the same constant is the fallback passed to `parsePreviewPort`.
 */
const DECLARED_PREVIEW_PORTS: Record<string, number> = {
  'capture-screenshots.mjs': 4174,
  'capture-snake-screenshots.mjs': 5188,
  'capture-2048-screenshots.mjs': 4183,
  'capture-breakout-screenshots.mjs': 4185,
  'capture-minesweeper-screenshots.mjs': 4186,
  'capture-minesweeper-scores-screenshots.mjs': 4192,
};

/** The expected default port of one repository-relative capture script path. */
function declaredPreviewPort(script: string): number {
  const port = DECLARED_PREVIEW_PORTS[script.split('/').at(-1) ?? ''];
  if (port === undefined) {
    throw new Error(`No expected default preview port for ${script}`);
  }
  return port;
}

interface ParsedCommand {
  script: string;
  args: string[];
}

/**
 * Parse the `node scripts/....mjs [args]` part of one npm screenshot command.
 *
 * The command may be prefixed with `npm run build &&`; only the node invocation
 * declares targets. Arguments are plain whitespace-separated flags in this
 * repository, so no shell quoting is needed.
 */
function parseCaptureCommand(command: string): ParsedCommand {
  const match = /\bnode\s+(scripts\/\S+\.mjs)(.*)$/.exec(command);
  if (match?.[1] === undefined) {
    throw new Error(`Cannot find the capture script in npm command: ${command}`);
  }
  const rest = match[2]?.trim() ?? '';
  return {
    script: match[1],
    args: rest === '' ? [] : rest.split(/\s+/),
  };
}

interface NpmTargetCase extends ParsedCommand {
  target: string;
}

/** One case per npm target the container entry accepts (baseline excluded). */
const NPM_TARGET_CASES: NpmTargetCase[] = containerCaptureTargets(SCRIPTS).map(
  (target) => {
    const command = SCRIPTS[target];
    if (command === undefined) {
      throw new Error(`package.json is missing the screenshot command ${target}`);
    }
    return { target, ...parseCaptureCommand(command) };
  },
);

/** The six script families, keyed by an npm target that runs the default mode. */
const FLAG_BASE_CASES: NpmTargetCase[] = [
  'screenshots',
  'screenshots:snake',
  'screenshots:2048',
  'screenshots:breakout',
  'screenshots:minesweeper:scores',
  'screenshots:minesweeper',
].map((target) => {
  const found = NPM_TARGET_CASES.find((candidate) => candidate.target === target);
  if (found === undefined) {
    throw new Error(`npm target ${target} is missing from the capture target list`);
  }
  return found;
});

interface DeclarationCase {
  label: string;
  target: string;
  script: string;
  args: readonly string[];
  extra: readonly string[];
}

/** Spawn one script in print mode and return its single JSON declaration. */
function runPrintMode(
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [join(ROOT, script), ...args, PRINT_CAPTURE_TARGETS_FLAG],
      { cwd: ROOT, env, timeout: 20_000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${script} ${args.join(' ')} ${PRINT_CAPTURE_TARGETS_FLAG} failed: ` +
                `${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function parseDeclaration(stdout: string, label: string): CaptureTargetsDeclaration {
  const lines = stdout.split('\n').filter((line) => line !== '');
  expect(lines, `${label}: print mode must write exactly one line`).toHaveLength(1);
  return JSON.parse(lines[0]!) as CaptureTargetsDeclaration;
}

/** Run a bounded number of capture scripts at once to keep the suite fast. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      await work(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

/**
 * Assert that the container entry's declaration resolver reproduces the JSON a
 * target script prints for the same npm command arguments + passthrough args.
 *
 * The container entry parses `package.json` to recover the script's built-in
 * arguments and appends the passthrough args, so this cross-checks both the
 * command parsing and the one-line declaration consumed by the host / container
 * paths without keeping a second script-name / flag table in the tests.
 */
async function assertDeclarationsMatchContainer(
  cases: readonly DeclarationCase[],
): Promise<void> {
  await mapWithConcurrency(cases, 6, async (entry) => {
    const args = [...entry.args, ...entry.extra];
    const { stdout } = await runPrintMode(entry.script, args);
    const declaration = parseDeclaration(stdout, entry.label);
    expect(declaration.script, entry.label).toBe(entry.script);
    expect(declaration.previewPort, entry.label).toBe(
      declaredPreviewPort(entry.script),
    );
    expect(declaration.targets, entry.label).toEqual(
      resolveCaptureTargets(entry.target, args, { scripts: SCRIPTS }).targets,
    );
  });
}

function fakeBrowser(version = '144.0.1'): Browser {
  return {
    version: () => version,
    newContext: vi.fn(async () => ({ close: async () => {} })),
  } as unknown as Browser;
}

beforeEach(() => {
  resetRecordedCaptureTargets();
});

afterEach(() => {
  resetRecordedCaptureTargets();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('capture target declaration contract', () => {
  it('names exactly the targets of the fixed capture-env DPR contract', () => {
    expect(Object.values(CAPTURE_TARGET_IDS)).toEqual([...CAPTURE_TARGETS]);
    for (const target of Object.values(CAPTURE_TARGET_IDS)) {
      expect(() => dprForCaptureTarget(target)).not.toThrow();
    }
  });

  it('recognises only the exact --print-capture-targets flag', () => {
    expect(isPrintCaptureTargetsRequested([PRINT_CAPTURE_TARGETS_FLAG])).toBe(true);
    expect(
      isPrintCaptureTargetsRequested(['--webkit', PRINT_CAPTURE_TARGETS_FLAG]),
    ).toBe(true);
    expect(isPrintCaptureTargetsRequested([])).toBe(false);
    expect(isPrintCaptureTargetsRequested(['--print-capture-target'])).toBe(false);
    expect(isPrintCaptureTargetsRequested(['--webkit'])).toBe(false);
  });

  it('formats one JSON line with the script, validated targets and preview port', () => {
    expect(
      captureTargetsDeclaration('scripts/x.mjs', ['desktop', 'mobile'], 4174),
    ).toEqual({
      script: 'scripts/x.mjs',
      targets: ['desktop', 'mobile'],
      previewPort: 4174,
    });
    expect(
      formatCaptureTargetsDeclaration('scripts/x.mjs', 'mobile-touch', 5188),
    ).toBe(
      '{"script":"scripts/x.mjs","targets":["mobile-touch"],"previewPort":5188}',
    );

    // Preview-port validation mirrors parsePreviewPort: numeric strings are
    // accepted and normalized, while both range boundaries stay valid.
    expect(
      captureTargetsDeclaration('scripts/x.mjs', ['desktop'], '4174').previewPort,
    ).toBe(4174);
    expect(
      captureTargetsDeclaration('scripts/x.mjs', ['desktop'], 1).previewPort,
    ).toBe(1);
    expect(
      captureTargetsDeclaration('scripts/x.mjs', ['desktop'], 65535).previewPort,
    ).toBe(65535);

    // Validation reuses capture-env's target / DPR contract.
    expect(() =>
      captureTargetsDeclaration('scripts/x.mjs', ['tablet'], 4174),
    ).toThrow(/Unknown capture target "tablet"/);
    expect(() => captureTargetsDeclaration('', ['desktop'], 4174)).toThrow(
      /script name/,
    );
    expect(() => captureTargetsDeclaration('scripts/x.mjs', [], 4174)).toThrow(
      /is empty/,
    );
  });

  it('rejects a missing or invalid preview port with a readable error', () => {
    expect(() =>
      captureTargetsDeclaration('scripts/x.mjs', ['desktop'], undefined as never),
    ).toThrow(
      /Capture target declaration for scripts\/x\.mjs needs the script's default previewPort \(1-65535\)/,
    );
    for (const invalid of [null, '', '   ', 0, 65536, -1, 1.5, 'abc', true]) {
      expect(() =>
        captureTargetsDeclaration('scripts/x.mjs', ['desktop'], invalid as never),
      ).toThrow(/Capture target declaration for scripts\/x\.mjs (?:needs|has an invalid)/);
    }
    expect(() =>
      captureTargetsDeclaration('scripts/x.mjs', ['desktop'], 'abc'),
    ).toThrow(/invalid previewPort "abc"/);
    expect(() =>
      captureTargetsDeclaration('scripts/x.mjs', ['desktop'], 0),
    ).toThrow(/invalid previewPort 0/);
    expect(() =>
      captureTargetsDeclaration('scripts/x.mjs', ['desktop'], 65536),
    ).toThrow(/between 1 and 65535/);
  });

  it('prints the declaration with a synchronous write and exits 0', () => {
    const writes: string[] = [];
    const exits: number[] = [];

    printCaptureTargets('scripts/x.mjs', ['webkit'], 4174, {
      write: (text) => {
        writes.push(text);
      },
      exit: (code) => {
        exits.push(code);
      },
    });

    expect(writes).toEqual([
      '{"script":"scripts/x.mjs","targets":["webkit"],"previewPort":4174}\n',
    ]);
    expect(exits).toEqual([0]);
  });
});

describe('npm screenshot target declarations', () => {
  it('covers every container-capturable screenshots* target', () => {
    expect(NPM_TARGET_CASES.length).toBeGreaterThanOrEqual(25);
    expect(NPM_TARGET_CASES.map((entry) => entry.target)).not.toContain(
      'screenshots:container',
    );
    expect(NPM_TARGET_CASES.map((entry) => entry.target)).not.toContain(
      'screenshots:baseline',
    );
  });

  it('pins the declared targets of the key npm modes', () => {
    const expectations: Record<string, string[]> = {
      screenshots: ['desktop', 'mobile'],
      'screenshots:webkit': ['webkit'],
      'screenshots:2048:before': ['desktop', 'mobile'],
      'screenshots:minesweeper': ['desktop', 'mobile-touch'],
      'screenshots:minesweeper:scores': ['desktop', 'mobile'],
      'screenshots:minesweeper:scores-clear': ['desktop', 'mobile'],
      'screenshots:minesweeper:narrow': ['mobile'],
      'screenshots:minesweeper:narrow-before': ['mobile'],
      'screenshots:minesweeper:touch-before': ['mobile-touch'],
      // The webkit-before npm script carries its own --webkit --touch-before
      // arguments, which the resolver must append before the passthrough args.
      'screenshots:minesweeper:webkit-before': ['webkit'],
    };
    for (const [target, expected] of Object.entries(expectations)) {
      expect(
        resolveCaptureTargets(target, [], { scripts: SCRIPTS }).targets,
        target,
      ).toEqual(expected);
    }
    expect(
      resolveCaptureTargets('screenshots:minesweeper', ['--narrow'], {
        scripts: SCRIPTS,
      }).targets,
    ).toEqual(['mobile']);
    expect(
      resolveCaptureTargets('screenshots:minesweeper:touch-before', ['--narrow'], {
        scripts: SCRIPTS,
      }).targets,
    ).toEqual(['mobile']);
  });

  it('prints the targets of every npm target, matching the container entry', async () => {
    await assertDeclarationsMatchContainer(
      NPM_TARGET_CASES.map((entry) => ({
        label: entry.target,
        target: entry.target,
        script: entry.script,
        args: entry.args,
        extra: [],
      })),
    );
  });

  it('handles the WebKit flags on every capture script', async () => {
    const cases = FLAG_BASE_CASES.flatMap((base) =>
      ['--webkit', '--webkit-narrow', '--webkit-narrow-before'].map((flag) => ({
        label: `${base.target} ${flag}`,
        target: base.target,
        script: base.script,
        args: base.args,
        extra: [flag],
      })),
    );
    expect(cases).toHaveLength(FLAG_BASE_CASES.length * 3);
    await assertDeclarationsMatchContainer(cases);
  });

  it('handles --touch-before and the narrow family on every capture script', async () => {
    const cases = FLAG_BASE_CASES.flatMap((base) => [
      {
        label: `${base.target} ${MINESWEEPER_TOUCH_BEFORE_FLAG}`,
        target: base.target,
        script: base.script,
        args: base.args,
        extra: [MINESWEEPER_TOUCH_BEFORE_FLAG],
      },
      {
        label: `${base.target} --narrow`,
        target: base.target,
        script: base.script,
        args: base.args,
        extra: ['--narrow'],
      },
    ]);
    await assertDeclarationsMatchContainer(cases);
  });

  it('keeps --before / --clear / --allow-historical-overwrite target-neutral', async () => {
    const cases = FLAG_BASE_CASES.map((base) => ({
      label: `${base.target} with evidence-mode flags`,
      target: base.target,
      script: base.script,
      args: base.args,
      extra: ['--before', '--clear', '--allow-historical-overwrite'],
    }));
    await assertDeclarationsMatchContainer(cases);
  });

  it('declares only the DPR-2 mobile target for every minesweeper narrow flag', async () => {
    const minesweeper = FLAG_BASE_CASES.find(
      (base) => base.target === 'screenshots:minesweeper',
    )!;
    expect(MINESWEEPER_NARROW_FLAGS).toEqual([
      '--narrow',
      '--narrow-before',
      '--min',
      '--min-before',
      '--restart',
      '--restart-before',
      '--short',
      '--short-before',
      '--large',
      '--large-before',
    ]);
    await assertDeclarationsMatchContainer(
      MINESWEEPER_NARROW_FLAGS.map((flag) => ({
        label: `minesweeper ${flag}`,
        target: minesweeper.target,
        script: minesweeper.script,
        args: minesweeper.args,
        extra: [flag],
      })),
    );
  });

  it('keeps the minesweeper narrow / touch precedence and WebKit precedence', async () => {
    const minesweeper = FLAG_BASE_CASES.find(
      (base) => base.target === 'screenshots:minesweeper',
    )!;
    const webkitBefore = FLAG_BASE_CASES.find(
      (base) => base.target === 'screenshots:2048',
    )!;
    const cases: DeclarationCase[] = [
      {
        label: 'minesweeper --narrow --touch-before',
        target: minesweeper.target,
        script: minesweeper.script,
        args: minesweeper.args,
        extra: ['--narrow', '--touch-before'],
      },
      {
        label: 'minesweeper --touch-before --restart',
        target: minesweeper.target,
        script: minesweeper.script,
        args: minesweeper.args,
        extra: ['--touch-before', '--restart'],
      },
      {
        label: 'minesweeper --webkit --touch-before',
        target: minesweeper.target,
        script: minesweeper.script,
        args: minesweeper.args,
        extra: ['--webkit', '--touch-before'],
      },
      {
        label: 'minesweeper --webkit --narrow',
        target: minesweeper.target,
        script: minesweeper.script,
        args: minesweeper.args,
        extra: ['--webkit', '--narrow'],
      },
      {
        label: 'minesweeper --webkit-narrow-before --large',
        target: minesweeper.target,
        script: minesweeper.script,
        args: minesweeper.args,
        extra: ['--webkit-narrow-before', '--large'],
      },
      {
        label: '2048 --before --webkit',
        target: webkitBefore.target,
        script: webkitBefore.script,
        args: webkitBefore.args,
        extra: ['--before', '--webkit'],
      },
    ];
    await assertDeclarationsMatchContainer(cases);
  });

  it('prints the declaration without starting a preview or a browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-targets-'));
    try {
      const marker = join(dir, 'preview-started');
      const entry = join(dir, 'fake-preview.mjs');
      writeFileSync(
        entry,
        "import { writeFileSync } from 'node:fs';\n" +
          `writeFileSync(${JSON.stringify(marker)}, 'preview started');\n` +
          'process.exit(1);\n',
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PREVIEW_ENTRY: entry,
        PLAYWRIGHT_BROWSERS_PATH: join(dir, 'missing-browsers'),
        // An invalid preview port would make the script fail while parsing the
        // environment; the print branch must exit before that validation.
        PREVIEW_PORT: 'not-a-port',
      };
      delete env.BASE_URL;

      await mapWithConcurrency(FLAG_BASE_CASES, 3, async (base) => {
        const { stdout, stderr } = await runPrintMode(base.script, base.args, env);
        const declaration = parseDeclaration(stdout, base.target);
        expect(declaration.script).toBe(base.script);
        expect(declaration.previewPort).toBe(declaredPreviewPort(base.script));
        expect(declaration.targets).toEqual(
          resolveCaptureTargets(base.target, base.args, { scripts: SCRIPTS })
            .targets,
        );
        expect(stderr, `${base.target} must not write to stderr`).toBe('');
      });

      expect(existsSync(marker), 'print mode must not spawn the preview').toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the script default port even when PREVIEW_PORT overrides the runtime', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PREVIEW_PORT: '4999' };

    await mapWithConcurrency(FLAG_BASE_CASES, 3, async (base) => {
      const { stdout } = await runPrintMode(base.script, base.args, env);
      const declaration = parseDeclaration(stdout, base.target);
      // The declaration always names the script's own default; PREVIEW_PORT
      // only changes the runtime port parsed after the print branch.
      expect(declaration.previewPort, base.target).toBe(
        declaredPreviewPort(base.script),
      );
      expect(declaration.targets, base.target).toEqual(
        resolveCaptureTargets(base.target, base.args, { scripts: SCRIPTS })
          .targets,
      );
    });
  });
});

describe('capture script declaration wiring', () => {
  it('declares, prints early and asserts every target in all six scripts', () => {
    for (const file of CAPTURE_SCRIPT_FILES) {
      const source = readFileSync(join(ROOT, 'scripts', file), 'utf8');

      expect(source, file).toContain("from './lib/capture-targets.mjs'");
      expect(source, file).toContain('function captureTargets(args)');
      expect(source, file).toContain(
        'const DECLARED_CAPTURE_TARGETS = captureTargets(ARGS);',
      );
      expect(source, file).toContain(
        'isPrintCaptureTargetsRequested(ARGS)',
      );

      // The declaration and the runtime fallback share one default port.
      expect(source, file).toMatch(
        /printCaptureTargets\(\s*SCRIPT_NAME,\s*DECLARED_CAPTURE_TARGETS,\s*DEFAULT_PREVIEW_PORT,?\s*\)/,
      );
      expect(source, file).toMatch(
        /parsePreviewPort\(\s*process\.env\.PREVIEW_PORT,\s*DEFAULT_PREVIEW_PORT,?\s*\)/,
      );
      const expectedPort = declaredPreviewPort(file);
      if (file === 'capture-minesweeper-scores-screenshots.mjs') {
        // The scores script reuses the shared 4192 default instead of copying it.
        expect(source, file).toMatch(
          /import \{[^}]*DEFAULT_PREVIEW_PORT[^}]*\} from '\.\/lib\/preview-port\.mjs';/s,
        );
        expect(source, file).not.toContain('const DEFAULT_PREVIEW_PORT');
      } else {
        expect(source, file).toContain(
          `const DEFAULT_PREVIEW_PORT = ${expectedPort};`,
        );
        expect(
          source.split('const DEFAULT_PREVIEW_PORT').length - 1,
          `${file}: must declare the default port once`,
        ).toBe(1);
      }
      // Neither usage reintroduces the literal instead of the constant.
      expect(source, file).not.toMatch(
        new RegExp(
          `printCaptureTargets\\(\\s*SCRIPT_NAME,\\s*DECLARED_CAPTURE_TARGETS,\\s*${expectedPort},?\\s*\\)`,
        ),
      );
      expect(source, file).not.toMatch(
        new RegExp(
          `parsePreviewPort\\(\\s*process\\.env\\.PREVIEW_PORT,\\s*${expectedPort},?\\s*\\)`,
        ),
      );

      const printIndex = source.indexOf('printCaptureTargets(');
      expect(printIndex, `${file}: missing print call`).toBeGreaterThanOrEqual(0);

      // The print branch must run before anything that validates the mode,
      // probes the port, starts the preview, creates the output directory or
      // launches a browser.
      for (const marker of [
        'startPreviewServer(',
        'launchCaptureBrowser(',
        'assertPortAvailable(',
        'mkdir(',
      ]) {
        const markerIndex = source.indexOf(marker);
        if (markerIndex < 0) {
          continue;
        }
        expect(
          printIndex,
          `${file}: ${marker} must run after the print branch`,
        ).toBeLessThan(markerIndex);
      }

      expect(source, file).toContain(
        'assertAllDeclaredCaptureTargets(DECLARED_CAPTURE_TARGETS',
      );
    }
  });
});

describe('container entry declaration wiring', () => {
  it('deletes the hand-written script-name / flag target map', () => {
    const source = readFileSync(
      join(ROOT, 'scripts', 'run-container-capture.mjs'),
      'utf8',
    );

    for (const removed of [
      'captureTargetsForScript',
      'WEBKIT_CAPTURE_FLAGS',
      'MINESWEEPER_TOUCH_CAPTURE_FLAG',
      'MINESWEEPER_PHONE_ONLY_CAPTURE_FLAGS',
      'MOBILE_ONLY_CAPTURE_TARGET',
    ]) {
      expect(source, `${removed} must be deleted`).not.toContain(removed);
    }

    // The only target source is the declaration printed by the target script.
    expect(source).toContain('export function resolveCaptureTargets(');
    expect(source).toContain('PRINT_CAPTURE_TARGETS_FLAG');
    expect(source).toContain('node ${printable}');
  });
});

describe('run-level declared target assertion', () => {
  it('passes when the recorded targets exactly match the declaration', () => {
    resetRecordedCaptureTargets();
    logCaptureEnvironment('desktop', fakeBrowser());
    logCaptureEnvironment('mobile', fakeBrowser());

    expect(recordedCaptureTargets()).toEqual(['desktop', 'mobile']);
    expect(() =>
      assertAllDeclaredCaptureTargets(['desktop', 'mobile'], {
        source: 'fixture captureTargets()',
      }),
    ).not.toThrow();
  });

  it('deduplicates recorded targets across browsers', () => {
    resetRecordedCaptureTargets();
    logCaptureEnvironment('desktop', fakeBrowser('1'));
    logCaptureEnvironment('desktop', fakeBrowser('2'));
    logCaptureEnvironment('mobile', fakeBrowser('1'));

    expect(recordedCaptureTargets()).toEqual(['desktop', 'mobile']);
  });

  it('fails when a declared target was never recorded', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Simulate "declared desktop,mobile but the run only recorded mobile".
    logCaptureEnvironment('mobile', fakeBrowser());

    const error = (() => {
      try {
        assertAllDeclaredCaptureTargets(['desktop', 'mobile'], {
          source: 'capture-2048-screenshots.mjs captureTargets(args)',
        });
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(log).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('declared but not recorded: desktop');
    expect(error?.message).toContain(
      'capture-2048-screenshots.mjs captureTargets(args)',
    );
    expect(error?.message).toContain('declared: desktop,mobile');
    expect(error?.message).toContain('recorded: mobile');
  });

  it('fails when the run records a target the declaration omits', () => {
    expect(() =>
      assertAllDeclaredCaptureTargets(['mobile'], {
        source: 'scripts/capture-snake-screenshots.mjs',
        recorded: ['desktop', 'mobile', 'mobile-touch'],
      }),
    ).toThrow(
      /scripts\/capture-snake-screenshots\.mjs.*recorded but not declared: desktop, mobile-touch/s,
    );
  });

  it('fails an empty declaration instead of treating it as "no targets"', () => {
    expect(() =>
      assertAllDeclaredCaptureTargets([], {
        source: 'fixture captureTargets()',
        recorded: [],
      }),
    ).toThrow(/declaration from fixture captureTargets\(\) is empty/);
  });

  it('rejects an unknown declared target through the capture-env contract', () => {
    expect(() =>
      assertAllDeclaredCaptureTargets(['tablet'], {
        source: 'fixture',
        recorded: [],
      }),
    ).toThrow(/Unknown capture target "tablet"/);
  });
});
