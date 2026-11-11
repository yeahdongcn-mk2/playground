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
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_CONTAINER_FLAG,
  CAPTURE_EGL_ENV,
  CAPTURE_IMAGE_DIGEST_VAR,
  CAPTURE_IMAGE_TAG_VAR,
  PLAYWRIGHT_IMAGE_PIN,
} from '../../scripts/lib/capture-env.mjs';
import {
  HISTORICAL_AFTER_EVIDENCE,
  HISTORICAL_OVERWRITE_CONTAINER_COMMAND,
  HISTORICAL_OVERWRITE_FLAG,
  HISTORICAL_SHA256_MANIFEST,
  decideAfterCaptureWrite,
  findHistoricalAfterEvidence,
  guardHistoricalAfterEvidence,
} from '../../scripts/lib/screenshot-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');
const SCREENSHOTS_README = readFileSync(
  join(SCREENSHOT_DIR, 'README.md'),
  'utf8',
);
const ROOT_README = readFileSync(join(ROOT, 'README.md'), 'utf8');

const SCRIPT_2048 = join(ROOT, 'scripts', 'capture-2048-screenshots.mjs');
const SCRIPT_BREAKOUT = join(ROOT, 'scripts', 'capture-breakout-screenshots.mjs');
const SCRIPT_SNAKE = join(ROOT, 'scripts', 'capture-snake-screenshots.mjs');
const SCRIPT_MINESWEEPER = join(ROOT, 'scripts', 'capture-minesweeper-screenshots.mjs');
const SCRIPT_SCORES = join(
  ROOT,
  'scripts',
  'capture-minesweeper-scores-screenshots.mjs',
);
const CAPTURE_SCRIPTS = [
  ['2048', SCRIPT_2048],
  ['breakout', SCRIPT_BREAKOUT],
  ['snake', SCRIPT_SNAKE],
  ['minesweeper', SCRIPT_MINESWEEPER],
] as const;

/** The frozen set from Issue #137's t1–t3 documentation. */
const EXPECTED_EVIDENCE = [
  { file: 'after-2048-ready-desktop.png', game: '2048', issue: '#26', commit: '8ec4adc' },
  { file: 'after-2048-ready-mobile.png', game: '2048', issue: '#26', commit: '8ec4adc' },
  {
    file: 'after-breakout-ready-desktop.png',
    game: 'breakout',
    issue: '#29',
    commit: '26e84fa',
  },
  {
    file: 'after-breakout-levelclear-desktop.png',
    game: 'breakout',
    issue: '#29',
    commit: '26e84fa',
  },
  {
    file: 'after-breakout-gameover-desktop.png',
    game: 'breakout',
    issue: '#29',
    commit: '26e84fa',
  },
  { file: 'after-snake-ready.png', game: 'snake', issue: '#14', commit: '048fe5a' },
  {
    file: 'after-snake-gameover.png',
    game: 'snake',
    issue: '#14',
    commit: '048fe5a',
  },
  { file: 'after-snake-mobile.png', game: 'snake', issue: '#14', commit: '048fe5a' },
  {
    file: 'after-breakout-ready-mobile.png',
    game: 'breakout',
    issue: '#29',
    commit: '26e84fa',
  },
  {
    file: 'after-breakout-gameover-mobile.png',
    game: 'breakout',
    issue: '#29',
    commit: '26e84fa',
  },
  {
    file: 'after-minesweeper-ready-desktop.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-minesweeper-playing-desktop.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-minesweeper-lost-desktop.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-minesweeper-won-desktop.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-minesweeper-ready-mobile.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-minesweeper-playing-mobile.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-minesweeper-lost-mobile.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-minesweeper-won-mobile.png',
    game: 'minesweeper',
    issue: '#61',
    commit: '993f5e7',
  },
  {
    file: 'after-2048-ready-webkit.png',
    game: '2048',
    issue: '#120',
    commit: '498a14f',
  },
  {
    file: 'after-breakout-ready-webkit.png',
    game: 'breakout',
    issue: '#120',
    commit: '498a14f',
  },
  {
    file: 'after-breakout-levelclear-webkit.png',
    game: 'breakout',
    issue: '#120',
    commit: '498a14f',
  },
  {
    file: 'after-breakout-gameover-webkit.png',
    game: 'breakout',
    issue: '#120',
    commit: '498a14f',
  },
  {
    file: 'after-minesweeper-ready-webkit.png',
    game: 'minesweeper',
    issue: '#120',
    commit: '498a14f',
  },
  {
    file: 'after-minesweeper-playing-webkit.png',
    game: 'minesweeper',
    issue: '#120',
    commit: '498a14f',
  },
  {
    file: 'after-minesweeper-lost-webkit.png',
    game: 'minesweeper',
    issue: '#120',
    commit: '498a14f',
  },
  {
    file: 'after-minesweeper-won-webkit.png',
    game: 'minesweeper',
    issue: '#120',
    commit: '498a14f',
  },
] as const;

/** Captures that must keep refreshing because they are current-build evidence. */
const REFRESHABLE = [
  'after-hub-desktop.png',
  'after-hub-mobile.png',
  'after-2048-playing-desktop.png',
  'after-2048-gameover-desktop.png',
  'after-2048-playing-mobile.png',
  'after-2048-gameover-mobile.png',
  'after-2048-playing-webkit.png',
  'after-2048-gameover-webkit.png',
  'after-breakout-playing-desktop.png',
  'after-breakout-playing-mobile.png',
  'after-breakout-playing-webkit.png',
  'after-snake-playing.png',
  'after-snake-webkit.png',
  'after-minesweeper-webkit-narrow-320x640.png',
  'after-minesweeper-webkit-narrow-360x640.png',
  'after-minesweeper-webkit-narrow-375x667.png',
  'after-minesweeper-webkit-narrow-412x839.png',
  'after-minesweeper-ready-320x640.png',
  'after-minesweeper-ready-360x740.png',
  'after-minesweeper-ready-360x640.png',
  'after-minesweeper-ready-375x667.png',
  'after-minesweeper-large-board-320x640.png',
  'after-minesweeper-large-board-360x640.png',
  'after-minesweeper-scores-desktop.png',
  'after-minesweeper-scores-320x640.png',
  'after-minesweeper-scores-webkit.png',
] as const;

/** The body of one top-level function, found by matching braces. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) {
    throw new Error(`missing function: ${name}`);
  }
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

/** A logger that records every warning so tests can assert on the text. */
function recordingLogger(): { messages: string[]; warn: (message: string) => void } {
  const messages: string[] = [];
  return { messages, warn: (message: string) => messages.push(message) };
}

/** The environment the container entry injects for a fixed capture run. */
function fixedCaptureEnv(): Record<string, string> {
  return {
    [CAPTURE_CONTAINER_FLAG]: '1',
    [CAPTURE_IMAGE_TAG_VAR]: PLAYWRIGHT_IMAGE_PIN.tag,
    [CAPTURE_IMAGE_DIGEST_VAR]: PLAYWRIGHT_IMAGE_PIN.digest,
    ...CAPTURE_EGL_ENV,
  };
}

describe('historical After evidence list (Issue #137)', () => {
  it('covers exactly the files frozen in the t1–t3 docs with issue, game and capture commit', () => {
    const files = HISTORICAL_AFTER_EVIDENCE.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files.slice().sort()).toEqual(
      EXPECTED_EVIDENCE.map((entry) => entry.file).slice().sort(),
    );
    expect(files).toHaveLength(26);

    for (const expected of EXPECTED_EVIDENCE) {
      const entry = findHistoricalAfterEvidence(expected.file);
      expect(entry, expected.file).not.toBeNull();
      expect(entry?.game).toBe(expected.game);
      expect(entry?.issue).toBe(expected.issue);
      expect(entry?.trackingIssue).toBe('#137');
      expect(entry?.captureCommit).toBe(expected.commit);
      expect(entry?.note.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('points every protected file at a committed PNG', () => {
    for (const entry of HISTORICAL_AFTER_EVIDENCE) {
      expect(existsSync(join(SCREENSHOT_DIR, entry.file)), entry.file).toBe(true);
    }
  });

  it('keeps webkit-narrow and current-build captures out of the protected set', () => {
    const files = HISTORICAL_AFTER_EVIDENCE.map((entry) => entry.file);
    for (const file of REFRESHABLE) {
      expect(files, file).not.toContain(file);
    }
    expect(files.some((file) => file.includes('webkit-narrow'))).toBe(false);
    expect(files.some((file) => file.startsWith('before-'))).toBe(false);
    expect(files.some((file) => file.includes('scores'))).toBe(false);
  });

  it('returns an entry only for an exact file name match', () => {
    expect(findHistoricalAfterEvidence('after-2048-ready-desktop.png')).not.toBeNull();
    expect(findHistoricalAfterEvidence('after-2048-ready-mobile.png')).not.toBeNull();
    expect(findHistoricalAfterEvidence('after-2048-ready-desktop.png ')).toBeNull();
    expect(findHistoricalAfterEvidence('after-2048-playing-desktop.png')).toBeNull();
    expect(findHistoricalAfterEvidence('after-2048-playing-mobile.png')).toBeNull();
    expect(findHistoricalAfterEvidence('before-2048-ready-desktop.png')).toBeNull();
  });
});

describe('decideAfterCaptureWrite', () => {
  it('skips every protected historical file by default', () => {
    for (const entry of HISTORICAL_AFTER_EVIDENCE) {
      const decision = decideAfterCaptureWrite({ file: entry.file });
      expect(decision.action, entry.file).toBe('skip');
      expect(decision.entry?.file).toBe(entry.file);
    }
  });

  it('writes protected files only with --allow-historical-overwrite', () => {
    for (const entry of HISTORICAL_AFTER_EVIDENCE) {
      const decision = decideAfterCaptureWrite({
        file: entry.file,
        allowHistoricalOverwrite: true,
      });
      expect(decision.action, entry.file).toBe('write');
      expect(decision.entry?.file).toBe(entry.file);
    }
  });

  it('never blocks Before or dedicated narrow modes', () => {
    for (const mode of ['before', 'touch-before', 'narrow', 'short', 'large', 'webkit-narrow', 'webkit-narrow-before']) {
      for (const entry of HISTORICAL_AFTER_EVIDENCE) {
        const decision = decideAfterCaptureWrite({ file: entry.file, mode });
        expect(decision.action, `${mode} ${entry.file}`).toBe('write');
      }
    }
  });

  it('writes files that are not protected in After mode', () => {
    for (const file of REFRESHABLE) {
      const decision = decideAfterCaptureWrite({ file });
      expect(decision.action, file).toBe('write');
      expect(decision.entry).toBeNull();
    }
  });
});

describe('guardHistoricalAfterEvidence', () => {
  it('warns with the tracking issue, file and container command when it skips', () => {
    const file = 'after-2048-ready-desktop.png';
    const logger = recordingLogger();

    const write = guardHistoricalAfterEvidence({ file, log: logger });

    expect(write).toBe(false);
    expect(logger.messages).toHaveLength(1);
    const warning = logger.messages[0] ?? '';
    expect(warning).toContain('historical After evidence');
    expect(warning).toContain('#137');
    expect(warning).toContain(file);
    expect(warning).toContain(HISTORICAL_OVERWRITE_FLAG);
    expect(warning).toContain(HISTORICAL_OVERWRITE_CONTAINER_COMMAND);
    expect(warning).toContain('8ec4adc');
    expect(warning).toContain('docs/screenshots/README.md');
  });

  it('allows the explicit overwrite only inside the fixed capture environment', () => {
    const file = 'after-breakout-ready-webkit.png';
    const logger = recordingLogger();

    const write = guardHistoricalAfterEvidence({
      file,
      allowHistoricalOverwrite: true,
      env: fixedCaptureEnv(),
      manifest: { captures: [{ file }] },
      log: logger,
    });

    expect(write).toBe(true);
    expect(logger.messages).toHaveLength(1);
    const warning = logger.messages[0] ?? '';
    expect(warning).toContain('Overwriting historical After evidence');
    expect(warning).toContain('#137');
    expect(warning).toContain(file);
    expect(warning).toContain(HISTORICAL_OVERWRITE_FLAG);
    expect(warning).toContain('498a14f');
    expect(warning).toContain('docs/screenshots/README.md');
    expect(warning).toContain(HISTORICAL_SHA256_MANIFEST);
    expect(warning).toContain('Update all of the following');
  });

  it('rejects the overwrite flag on the host and names the file and container entry', () => {
    const file = 'after-2048-ready-desktop.png';
    const logger = recordingLogger();

    expect(() =>
      guardHistoricalAfterEvidence({
        file,
        allowHistoricalOverwrite: true,
        env: {},
        log: logger,
      }),
    ).toThrowError(
      new RegExp(
        `Refusing to overwrite historical After evidence ${file}.*` +
          `${CAPTURE_CONTAINER_FLAG}.*${HISTORICAL_OVERWRITE_CONTAINER_COMMAND}`,
        's',
      ),
    );
    expect(logger.messages).toHaveLength(0);
  });

  it('rejects a container fingerprint that does not match the pinned image', () => {
    const env = { ...fixedCaptureEnv(), [CAPTURE_IMAGE_TAG_VAR]: 'v0.0.0-noble' };

    expect(() =>
      guardHistoricalAfterEvidence({
        file: 'after-snake-ready.png',
        allowHistoricalOverwrite: true,
        env,
      }),
    ).toThrowError(/image tag.*v0\.0\.0-noble.*v1\.64\.1-noble/);
  });

  it('rejects a container fingerprint whose image digest does not match the pin', () => {
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    const env = { ...fixedCaptureEnv(), [CAPTURE_IMAGE_DIGEST_VAR]: wrongDigest };

    expect(() =>
      guardHistoricalAfterEvidence({
        file: 'after-snake-ready.png',
        allowHistoricalOverwrite: true,
        env,
      }),
    ).toThrowError(
      new RegExp(`image digest.*${wrongDigest}.*${PLAYWRIGHT_IMAGE_PIN.digest}`),
    );
  });

  it('rejects an injected fingerprint whose image repository is not the pinned one', () => {
    const fingerprint = {
      source: 'container' as const,
      target: 'desktop' as const,
      dpr: 1,
      image: {
        repository: 'ghcr.io/example/playwright',
        tag: PLAYWRIGHT_IMAGE_PIN.tag,
        digest: PLAYWRIGHT_IMAGE_PIN.digest,
      },
      node: 'v24.0.0',
      playwright: '1.64.1',
      browser: null,
      fonts: null,
      env: { ...CAPTURE_EGL_ENV },
    };

    expect(() =>
      guardHistoricalAfterEvidence({
        file: 'after-snake-ready.png',
        allowHistoricalOverwrite: true,
        fingerprint,
      }),
    ).toThrowError(
      /image repository is "ghcr\.io\/example\/playwright".*mcr\.microsoft\.com\/playwright/,
    );
  });

  it('rejects a container fingerprint with a missing EGL variable', () => {
    const env: Record<string, string | undefined> = { ...fixedCaptureEnv() };
    delete env.EGL_PLATFORM;

    expect(() =>
      guardHistoricalAfterEvidence({
        file: 'after-snake-ready.png',
        allowHistoricalOverwrite: true,
        env,
      }),
    ).toThrowError(/EGL_PLATFORM is missing/);
  });

  it('reads the sha256 manifest and only lists it when the file is tracked', () => {
    const file = 'after-2048-ready-desktop.png';
    const dir = mkdtempSync(join(tmpdir(), 'screenshot-evidence-manifest-'));
    const manifestPath = join(dir, 'capture-sha256-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ captures: [{ file }] }));

    try {
      const logger = recordingLogger();
      expect(
        guardHistoricalAfterEvidence({
          file,
          allowHistoricalOverwrite: true,
          env: fixedCaptureEnv(),
          manifestPath,
          log: logger,
        }),
      ).toBe(true);
      expect(logger.messages[0]).toContain(HISTORICAL_SHA256_MANIFEST);

      const otherLogger = recordingLogger();
      expect(
        guardHistoricalAfterEvidence({
          file: 'after-snake-mobile.png',
          allowHistoricalOverwrite: true,
          env: fixedCaptureEnv(),
          manifestPath,
          log: otherLogger,
        }),
      ).toBe(true);
      expect(otherLogger.messages[0]).not.toContain(HISTORICAL_SHA256_MANIFEST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent for unprotected files and for Before mode', () => {
    const logger = recordingLogger();

    expect(
      guardHistoricalAfterEvidence({
        file: 'after-breakout-playing-desktop.png',
        log: logger,
      }),
    ).toBe(true);
    expect(
      guardHistoricalAfterEvidence({
        file: 'after-2048-ready-desktop.png',
        mode: 'before',
        log: logger,
      }),
    ).toBe(true);
    expect(logger.messages).toHaveLength(0);
  });

  it('does not validate the fixed environment for ordinary captures', () => {
    const logger = recordingLogger();

    expect(
      guardHistoricalAfterEvidence({
        file: 'after-breakout-playing-desktop.png',
        allowHistoricalOverwrite: true,
        env: {},
        log: logger,
      }),
    ).toBe(true);
    expect(
      guardHistoricalAfterEvidence({
        file: 'after-2048-ready-desktop.png',
        mode: 'before',
        allowHistoricalOverwrite: true,
        env: {},
        log: logger,
      }),
    ).toBe(true);
    expect(logger.messages).toHaveLength(0);
  });
});

describe('capture scripts wire the guard before writing (Issue #137)', () => {
  it.each(CAPTURE_SCRIPTS)(
    'calls the guard in %s capture() before captureScreenshot',
    (_game, scriptPath) => {
      const source = readFileSync(scriptPath, 'utf8');
      expect(source).toContain("from './lib/screenshot-evidence.mjs'");
      expect(source).toContain('guardHistoricalAfterEvidence');
      expect(source).toContain(
        'const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes(HISTORICAL_OVERWRITE_FLAG);',
      );

      const body = functionBody(source, 'capture');
      const guard = body.indexOf('guardHistoricalAfterEvidence(');
      const screenshot = body.indexOf('captureScreenshot(');
      expect(guard).toBeGreaterThan(-1);
      expect(screenshot).toBeGreaterThan(guard);
      expect(body).toContain('allowHistoricalOverwrite: ALLOW_HISTORICAL_OVERWRITE');
      expect(body).toContain('mode: MODE');
      expect(body).toMatch(/if \(!write\) return;/);
    },
  );

  it('keeps the scores script on its own fail-fast refusal', () => {
    const source = readFileSync(SCRIPT_SCORES, 'utf8');
    expect(source).toContain(
      "const ALLOW_HISTORICAL_OVERWRITE = ARGS.includes('--allow-historical-overwrite');",
    );
    expect(source).toContain(
      'if (!BEFORE && !CLEAR && !IS_WEBKIT && !ALLOW_HISTORICAL_OVERWRITE)',
    );
    expect(source).toContain('Refusing to overwrite the #45 subtask 1 historical After evidence');
  });
});

describe('historical evidence command docs', () => {
  const COMMANDS = [
    'npm run screenshots:2048',
    'npm run screenshots:breakout',
    'npm run screenshots:snake',
    'npm run screenshots:minesweeper',
  ];

  /** The container form of one npm script, as the docs must show it. */
  function containerCommand(command: string): string {
    return `${HISTORICAL_OVERWRITE_CONTAINER_COMMAND} -- ${command.replace('npm run ', '')} ${HISTORICAL_OVERWRITE_FLAG}`;
  }

  it.each(COMMANDS)('documents the container-only overwrite for %s', (command) => {
    const row = ROOT_README.split('\n').find((line) =>
      line.startsWith(`| \`${command}\` |`),
    );
    expect(row).toBeDefined();
    expect(row).toContain('历史证据');
    expect(row).toContain(HISTORICAL_OVERWRITE_FLAG);
    expect(row).toContain(HISTORICAL_OVERWRITE_CONTAINER_COMMAND);
    expect(row).toContain(containerCommand(command));
  });

  it.each(COMMANDS)('documents the container-only overwrite in the screenshots guide for %s', (command) => {
    expect(SCREENSHOTS_README).toContain(containerCommand(command));
  });

  it('documents the container-only overwrite for the WebKit commands that write protected files', () => {
    for (const command of [
      'npm run screenshots:2048:webkit',
      'npm run screenshots:breakout:webkit',
      'npm run screenshots:minesweeper:webkit',
    ]) {
      expect(SCREENSHOTS_README).toContain(containerCommand(command));
    }
  });

  it('explains the default skip, the fixed environment and the update checklist', () => {
    const section = SCREENSHOTS_README.slice(
      SCREENSHOTS_README.indexOf('## 历史 After 证据与当前构建不一致（Issue #137）'),
      SCREENSHOTS_README.indexOf('## CI：截图文档整页尺寸校验（Issue #134）'),
    );
    expect(section).toContain('historical After evidence');
    expect(section).toContain(HISTORICAL_OVERWRITE_FLAG);
    expect(section).toContain('默认');
    expect(section).toContain('#137');
    expect(section).toContain(HISTORICAL_OVERWRITE_CONTAINER_COMMAND);
    expect(section).toContain(HISTORICAL_SHA256_MANIFEST);
    expect(section).toContain('捕获 commit');
  });
});
