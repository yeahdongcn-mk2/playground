import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import playwrightConfig from '../../playwright.config';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const README = read('README.md');
const FRAMEWORK = read('docs/framework.md');
const SNAKE_DESIGN = read('docs/snake-design.md');
const MOBILE_SPEC = read('tests/e2e/minesweeper.mobile.spec.ts');
const NARROW_WEBKIT_SPEC = read('tests/e2e/minesweeper.narrow.webkit.spec.ts');
const WEBKIT_DEVICE = 'iPhone SE (3rd gen)';
const INSTALL_COMMAND = 'npx playwright install chromium webkit';
const CHROMIUM_NARROW_VIEWPORTS = [
  '320×640',
  '340×700',
  '349×700',
  '360×640',
  '360×740',
  '375×667',
  '400×700',
  '412×839',
];
const WEBKIT_NARROW_VIEWPORTS = ['320×640', '360×640', '375×667', '412×839'];

interface PackageJson {
  scripts?: Record<string, string>;
}

interface PlaywrightProjectConfig {
  name?: string;
  testMatch?: RegExp | RegExp[];
  testIgnore?: RegExp | RegExp[];
  use?: {
    defaultBrowserType?: string;
    viewport?: { width: number; height: number };
  };
}

interface WorkflowStep {
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const packageJson = JSON.parse(read('package.json')) as PackageJson;
const config = playwrightConfig as unknown as { projects?: PlaywrightProjectConfig[] };
const projects = config.projects ?? [];
const workflow = parse(read('.github/workflows/ci.yml')) as Workflow;
const ciCommands = (workflow.jobs?.verify?.steps ?? [])
  .map((step) => (step.run ?? '').trim())
  .filter((command) => command.length > 0);

/** The Playwright project with the given name, failing the test when missing. */
function project(name: string): PlaywrightProjectConfig {
  const found = projects.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`playwright.config.ts is missing the ${name} project`);
  }
  return found;
}

/** Whether a project's testMatch / testIgnore pattern lists match a spec file. */
function matches(
  pattern: RegExp | RegExp[] | undefined,
  file: string,
): boolean {
  if (!pattern) {
    return false;
  }
  return (Array.isArray(pattern) ? pattern : [pattern]).some((candidate) =>
    candidate.test(file),
  );
}

/** Viewport labels such as `320×640` declared in an e2e viewport matrix. */
function viewportLabels(source: string): string[] {
  return Array.from(source.matchAll(/label:\s*'(\d{3,4})x(\d{3,4})'/g), (match) => {
    const width = match[1];
    const height = match[2];
    if (!width || !height) {
      throw new Error(`unparsable viewport label: ${match[0]}`);
    }
    return `${width}×${height}`;
  });
}

/** The `N passed` / `全仓 N 个用例` count documented next to an npm script, if any. */
function documentedCount(source: string, command: string): number {
  const pattern = new RegExp(`${command}[^\\n]*?(?:# )?(\\d+) (?:passed|个用例)`);
  const match = pattern.exec(source);
  if (!match?.[1]) {
    throw new Error(`missing a documented "N passed" count for ${command}`);
  }
  return Number(match[1]);
}

/** The desktop / mobile / WebKit split documented in a verification line. */
function documentedBreakdown(source: string): [number, number, number] | null {
  const match = /桌面 (\d+) \+ 手机 (\d+) \+ WebKit (\d+)/.exec(source);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

interface ContractClause {
  number: number;
  text: string;
}

const CONTRACT_INTRO = '以下 7 条是';

/**
 * The numbered contract clauses, sliced out of the surrounding document.
 *
 * Clause assertions must read this slice (one numbered line each) instead of
 * the whole document: `docs/framework.md` and `README.md` repeat the same
 * tokens in their known-limitations prose, so a document-wide `toContain`
 * would stay green even after a contract clause was deleted or corrupted.
 * The clause block must be a contiguous run of numbered lines at the top
 * level of the section, terminated by a blank line.
 */
function contractClauses(source: string, name: string): ContractClause[] {
  const introOccurrences = source.split(CONTRACT_INTRO).length - 1;
  if (introOccurrences !== 1) {
    throw new Error(
      `${name} should have exactly one narrow-screen contract intro, found ${introOccurrences}`,
    );
  }
  const start = source.indexOf(CONTRACT_INTRO);
  const clauses: ContractClause[] = [];
  for (const line of source.slice(start).split('\n')) {
    const match = /^(\d+)\.\s+(.+)$/.exec(line.trim());
    if (!match) {
      if (clauses.length > 0 && line.trim() === '') {
        break;
      }
      continue;
    }
    const number = Number(match[1]);
    const text = match[2] ?? '';
    clauses.push({ number, text });
  }
  return clauses;
}

/** The body of the `for (const viewport of <matrix>)` loop in an e2e spec. */
function matrixLoopBody(source: string, matrix: string, name: string): string {
  const start = source.indexOf(`for (const viewport of ${matrix})`);
  if (start < 0) {
    throw new Error(`${name} is missing its ${matrix} viewport loop`);
  }
  const end = source.indexOf('\n  }\n', start);
  if (end < 0) {
    throw new Error(`${name} has an unterminated ${matrix} viewport loop`);
  }
  return source.slice(start, end);
}

describe('browser coverage documentation', () => {
  it('runs the WebKit specs on the mobile-webkit project with the iPhone SE device', () => {
    const webkit = project('mobile-webkit');
    expect(webkit.use?.defaultBrowserType).toBe('webkit');
    expect(webkit.use?.viewport).toEqual({ width: 375, height: 667 });
    expect(matches(webkit.testMatch, 'minesweeper.webkit.spec.ts')).toBe(true);
    expect(matches(webkit.testMatch, 'minesweeper.narrow.webkit.spec.ts')).toBe(true);
    expect(matches(webkit.testMatch, 'minesweeper.mobile.spec.ts')).toBe(false);

    const webkitSpecs = readdirSync(join(ROOT, 'tests', 'e2e'))
      .filter((file) => file.endsWith('.webkit.spec.ts'))
      .sort();
    expect(webkitSpecs).toEqual([
      'minesweeper.narrow.webkit.spec.ts',
      'minesweeper.webkit.spec.ts',
    ]);

    // The Chromium projects must keep ignoring the WebKit-only specs, so the
    // documented matrix is not silently double-counted or skipped.
    expect(
      matches(project('chromium').testIgnore, 'minesweeper.narrow.webkit.spec.ts'),
    ).toBe(true);
    expect(
      matches(project('mobile').testIgnore, 'minesweeper.narrow.webkit.spec.ts'),
    ).toBe(true);
  });

  it('documents the same viewport matrices the Chromium and WebKit specs assert', () => {
    const chromiumViewports = viewportLabels(MOBILE_SPEC);
    const webkitViewports = viewportLabels(NARROW_WEBKIT_SPEC);
    expect(chromiumViewports).toEqual(CHROMIUM_NARROW_VIEWPORTS);
    expect(webkitViewports).toEqual(WEBKIT_NARROW_VIEWPORTS);

    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      for (const projectName of ['chromium', 'mobile', 'mobile-webkit']) {
        expect(doc, `${name} should mention the ${projectName} project`).toContain(projectName);
      }
      expect(doc, `${name} should mention the WebKit device`).toContain(WEBKIT_DEVICE);
      // Matrix order, counts and per-viewport coverage are asserted inside
      // contract clause 4 below; matching the whole document would let
      // another copy of the same list hide an out-of-order or missing clause.
    }
  });

  it('documents every executable narrow-screen layout contract clause', () => {
    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      const clauses = contractClauses(doc, name);
      expect(
        clauses.map((candidate) => candidate.number),
        `${name} should number exactly clauses 1-7`,
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const clause = (number: number): string => {
        const found = clauses.find((candidate) => candidate.number === number);
        if (!found) {
          throw new Error(`${name} is missing contract clause ${number}`);
        }
        return found.text;
      };

      // Clause 1: minimum viewport and its height boundary.
      expect(clause(1), `${name} clause 1 should document the 320×640 minimum`).toMatch(
        /最低支持视口\s*320×640/,
      );
      expect(
        clause(1),
        `${name} clause 1 should state that heights under 640px are not guaranteed`,
      ).toMatch(/高度\s*<640[^。\n]{0,20}不保证/);

      // Clause 2: cell-size promise and the 320–339px geometric fallback.
      expect(clause(2), `${name} clause 2 should document the ≥36×36px cell promise`).toContain(
        '≥36×36px',
      );
      expect(clause(2), `${name} clause 2 should scope the 36px promise to 9×9 boards`).toContain(
        '9×9',
      );
      expect(
        clause(2),
        `${name} clause 2 should scope the 36px promise to widths of at least 340px`,
      ).toContain('≥340px');
      expect(clause(2), `${name} clause 2 should document the ≥34×34px geometric fallback`).toContain(
        '≥34×34px',
      );
      expect(clause(2), `${name} clause 2 should scope the fallback to 320–339px`).toMatch(
        /320[–-]339px/,
      );

      // Clause 3: first-screen entries and no horizontal scrolling.
      for (const entry of [
        '返回大厅',
        '剩余雷数',
        '计时器',
        'touch-hint',
        'mobile-restart-button',
      ]) {
        expect(
          clause(3),
          `${name} clause 3 should require ${entry} on the first screen`,
        ).toContain(entry);
      }
      expect(
        clause(3),
        `${name} clause 3 should keep the first screen free of horizontal scrolling`,
      ).toContain('不横向滚动');
      expect(
        clause(3),
        `${name} clause 3 should require the entries as part of the first-screen rule`,
      ).toMatch(/必须包含[^。\n]*touch-hint[^。\n]*不横向滚动/);

      // Clause 4: the only authoritative matrix order for both engines.
      expect(
        clause(4),
        `${name} clause 4 should list the Chromium matrix in spec order`,
      ).toContain(CHROMIUM_NARROW_VIEWPORTS.join('、'));
      expect(
        clause(4),
        `${name} clause 4 should list the WebKit matrix in spec order`,
      ).toContain(WEBKIT_NARROW_VIEWPORTS.join('、'));
      expect(
        clause(4),
        `${name} clause 4 should state the Chromium matrix has ${CHROMIUM_NARROW_VIEWPORTS.length} viewports`,
      ).toContain(`Chromium ${CHROMIUM_NARROW_VIEWPORTS.length} 个视口`);
      expect(
        clause(4),
        `${name} clause 4 should state the WebKit matrix has ${WEBKIT_NARROW_VIEWPORTS.length} viewports`,
      ).toContain(`WebKit ${WEBKIT_NARROW_VIEWPORTS.length} 个视口`);
      expect(
        clause(4),
        `${name} clause 4 should state that all WebKit viewports assert the restart entry`,
      ).toMatch(/四个视口都断言[^。\n]{0,80}重开入口/);
      expect(
        clause(4),
        `${name} clause 4 should keep the existing 320×640 / 412×839 assertions`,
      ).toContain('320×640 与 412×839 的既有断言未放宽');

      // Clause 5: out-of-matrix boundary.
      expect(clause(5), `${name} clause 5 should document the matrix boundary examples`).toMatch(
        /未列入矩阵[^。\n]{0,80}375×640[^。\n]{0,20}400×667/,
      );
      expect(
        clause(5),
        `${name} clause 5 should not promise the restart entry outside the matrix`,
      ).toMatch(/(?:不承诺|不保证)[^。\n]{0,30}重开入口/);

      // Clause 6: large-board degradation.
      expect(
        clause(6),
        `${name} clause 6 should only guarantee 36px for 9×9 boards`,
      ).toMatch(/列数\s*>9[^。\n]{0,40}9×9[^。\n]{0,30}≥36px/);
      expect(
        clause(6),
        `${name} clause 6 should guarantee 36px only for 9×9 boards`,
      ).toContain('只有 9×9 享受');
      expect(clause(6), `${name} clause 6 should reference the large-board follow-up #86`).toContain(
        '#86',
      );
      expect(clause(6), `${name} clause 6 should say large boards scale down proportionally`).toContain(
        '按比例缩小',
      );
      expect(clause(6), `${name} clause 6 should keep the page free of horizontal scrolling`).toContain(
        '不横向滚动',
      );

      // Clause 7: rule for new viewport widths.
      expect(clause(7), `${name} clause 7 should document the new-width rule`).toMatch(
        /新增视口宽度[^。\n]{0,60}按同一规则/,
      );
      expect(clause(7), `${name} clause 7 should require an e2e for new widths`).toContain(
        '补对应 e2e',
      );
      expect(clause(7), `${name} clause 7 should avoid per-width tickets`).toContain(
        '不再逐条开单',
      );
      expect(
        clause(7),
        `${name} clause 7 should record out-of-rule widths as known limitations`,
      ).toMatch(/超出规则范围[^。\n]{0,30}已知限制/);
    }
  });

  it('attributes the phone viewport matrices to the projects that run them', () => {
    // The chromium project ignores the mobile spec, so only the mobile
    // (Pixel 7) project runs the 8-viewport matrix. The docs must state the
    // same ownership as playwright.config.ts.
    expect(
      matches(project('chromium').testIgnore, 'minesweeper.mobile.spec.ts'),
      'the chromium project should ignore minesweeper.mobile.spec.ts',
    ).toBe(true);
    expect(
      matches(project('mobile').testMatch, 'minesweeper.mobile.spec.ts'),
      'the mobile project should run minesweeper.mobile.spec.ts',
    ).toBe(true);
    expect(
      matches(project('mobile-webkit').testMatch, 'minesweeper.mobile.spec.ts'),
      'the mobile-webkit project should not run the Chromium mobile spec',
    ).toBe(false);

    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      // No document-wide sentence may claim both projects run the phone
      // matrix; the attribution must stay on the mobile project alone.
      expect(
        doc,
        `${name} should not say the chromium and mobile projects both run the phone matrix`,
      ).not.toMatch(/`chromium`[^。\n]{0,40}(?:与|和) `mobile`[^。\n]{0,40}运行/);
      const attributionLines = doc
        .split('\n')
        .filter((line) => line.includes('tests/e2e/minesweeper.mobile.spec.ts'));
      expect(
        attributionLines.length,
        `${name} should attribute minesweeper.mobile.spec.ts to a project`,
      ).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(
          line,
          `${name} should attribute the 8-viewport matrix to the mobile project`,
        ).toMatch(
          /`mobile`（Pixel 7）项目运行 `tests\/e2e\/minesweeper\.mobile\.spec\.ts`/,
        );
        expect(
          line,
          `${name} should name the 8-viewport phone matrix`,
        ).toContain('8 视口矩阵');
      }
    }
  });

  it('asserts the restart entry for every narrow viewport matrix', () => {
    for (const [name, spec, matrix, count] of [
      ['Chromium mobile', MOBILE_SPEC, 'FIRST_SCREEN_VIEWPORTS', 8],
      ['WebKit narrow', NARROW_WEBKIT_SPEC, 'WEBKIT_NARROW_VIEWPORTS', 4],
    ] as const) {
      expect(viewportLabels(spec), `${name} matrix size`).toHaveLength(count);
      // Each matrix loop must keep the restart entry assertion enabled. A
      // regression to `restartEntry: false`, or a loop that opts out of the
      // assertion, must fail this guard instead of only the docs promising it.
      const loop = matrixLoopBody(spec, matrix, name);
      expect(loop, `${name} should call the first-screen contract`).toContain(
        'expectFirstScreenContract',
      );
      expect(loop, `${name} should assert the restart entry`).toMatch(
        /restartEntry:\s*true/,
      );
      expect(loop, `${name} should not opt out of the restart entry`).not.toMatch(
        /restartEntry:\s*false/,
      );
    }
  });

  it('documents the browser install and e2e commands that package.json and CI use', () => {
    const scripts = packageJson.scripts ?? {};
    expect(scripts['test:e2e']).toContain('playwright test');
    expect(scripts['test:e2e:webkit']).toContain('playwright test');
    expect(scripts['test:e2e:webkit']).toContain('--project=mobile-webkit');

    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      expect(doc, `${name} should document ${INSTALL_COMMAND}`).toContain(INSTALL_COMMAND);
      expect(doc, `${name} should document npm run test:e2e`).toContain('npm run test:e2e');
      expect(doc, `${name} should document npm run test:e2e:webkit`).toContain(
        'npm run test:e2e:webkit',
      );
    }

    expect(ciCommands).toContain('npx playwright install --with-deps chromium webkit');
    expect(ciCommands).toContain('npm run test:e2e');
  });

  it('records the real iOS limitations and the requirement for manual acceptance', () => {
    // These are the measured WebKit / iOS differences the docs promise to
    // disclose, plus the still-open follow-up that tracks the remaining work.
    const requiredTerms = [
      'safe-area',
      'dvh',
      '字体度量',
      'any-pointer',
      '人工验收',
      '#100',
    ];
    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      for (const term of requiredTerms) {
        expect(doc, `${name} should document ${term}`).toContain(term);
      }
      expect(doc, `${name} should state that real iOS still needs manual acceptance`).toMatch(
        /(?:真实 iOS|iOS Safari|真机)[^。\n]{0,40}人工验收|人工验收[^。\n]{0,40}(?:真实 iOS|iOS Safari|真机)/,
      );
      expect(doc, `${name} should state that the rest is still Chromium-only`).toContain(
        '截图脚本仍只在 Chromium',
      );
    }
  });

  it('does not restore the stale Chromium-only narrow-contract wording', () => {
    const staleNarrowContract = /窄屏(?:首屏)?契约[^。\n]{0,40}(?:只|仅)(?:在|用) Chromium/;
    const staleResolved = /#(?:60|100)[^。\n]{0,20}已(?:解决|完成|关闭)/;
    const staleWebkitMatrix =
      /WebKit[^。\n]{0,20}(?:只|仅)[^。\n]{0,20}(?:320×640|412×839)[^。\n]{0,20}(?:断言|覆盖)/;
    const staleWebkitTracking = /(?:360×640|375×667)[^。\n]{0,40}重开入口[^。\n]{0,20}#60/;
    const stale60Tracking =
      /#60[^。\n]{0,30}(?:继续|仍|还)[^。\n]{0,10}跟踪|(?:继续|仍|还)[^。\n]{0,20}跟踪[^。\n]{0,20}#60/;
    const stalePr84 = /(?:PR\s*)?#84[^。\n]{0,30}(?:未合并|未合入|待合并|仍打开)/;
    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      expect(doc, `${name} should not claim a Chromium-only narrow contract`).not.toMatch(
        staleNarrowContract,
      );
      expect(doc, `${name} should not claim the follow-ups are resolved`).not.toMatch(
        staleResolved,
      );
      expect(doc, `${name} should not limit the WebKit assertion to two viewports`).not.toMatch(
        staleWebkitMatrix,
      );
      expect(doc, `${name} should not say the short-screen fix is still tracked by #60`).not.toMatch(
        staleWebkitTracking,
      );
      expect(doc, `${name} should not say #60 is still tracking the contract`).not.toMatch(
        stale60Tracking,
      );
      expect(doc, `${name} should not say PR #84 is still unmerged`).not.toMatch(
        stalePr84,
      );
    }
  });

  it('keeps the verification counts and e2e breakdown in sync across the docs', () => {
    const counts = {
      readmeUnit: documentedCount(README, 'npm run test:unit'),
      readmeE2e: documentedCount(README, 'npm run test:e2e'),
      frameworkUnit: documentedCount(FRAMEWORK, 'npm run test:unit'),
      frameworkE2e: documentedCount(FRAMEWORK, 'npm run test:e2e'),
      snakeDesignUnit: documentedCount(SNAKE_DESIGN, 'npm run test:unit'),
    };
    expect(counts.frameworkUnit).toBe(counts.readmeUnit);
    expect(counts.frameworkE2e).toBe(counts.readmeE2e);
    // The game design doc repeats the whole-repo unit count; keep it from
    // drifting back to the stale 44 it carried when the snake game landed.
    expect(counts.snakeDesignUnit).toBe(counts.readmeUnit);

    const readmeBreakdown = documentedBreakdown(README);
    const frameworkBreakdown = documentedBreakdown(FRAMEWORK);
    expect(readmeBreakdown).not.toBeNull();
    expect(frameworkBreakdown).toEqual(readmeBreakdown);
    const [desktop, mobile, webkit] = readmeBreakdown ?? [0, 0, 0];
    expect(desktop + mobile + webkit).toBe(counts.readmeE2e);
    expect(webkit).toBeGreaterThanOrEqual(6);
  });
});
