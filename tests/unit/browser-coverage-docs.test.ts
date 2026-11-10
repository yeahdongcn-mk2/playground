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

/** The `N passed` count documented next to an npm script, if any. */
function documentedCount(source: string, command: string): number {
  const pattern = new RegExp(`${command}[^\\n]*?(?:# )?(\\d+) passed`);
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
      expect(doc, `${name} should mention the WebKit project`).toContain('mobile-webkit');
      expect(doc, `${name} should mention the WebKit device`).toContain(WEBKIT_DEVICE);
      for (const viewport of [...chromiumViewports, ...webkitViewports]) {
        expect(doc, `${name} is missing the ${viewport} viewport`).toContain(viewport);
      }
      // The labels must match each spec in order, not just appear somewhere.
      expect(doc, `${name} should list the Chromium matrix in spec order`).toContain(
        chromiumViewports.join('、'),
      );
      expect(doc, `${name} should list the WebKit matrix in spec order`).toContain(
        webkitViewports.join('、'),
      );
      expect(
        doc,
        `${name} should state the Chromium matrix has ${chromiumViewports.length} viewports`,
      ).toContain(`Chromium ${chromiumViewports.length} 个视口`);
      expect(
        doc,
        `${name} should state the WebKit matrix has ${webkitViewports.length} viewports`,
      ).toContain(`WebKit ${webkitViewports.length} 个视口`);
      expect(
        doc,
        `${name} should state that all WebKit viewports assert the restart entry`,
      ).toMatch(/四个视口都断言[^。\n]{0,80}重开入口/);
    }
  });

  it('documents every executable narrow-screen layout contract clause', () => {
    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      // Minimum viewport and its height boundary.
      expect(doc, `${name} should document the 320×640 minimum viewport`).toMatch(
        /最低支持视口\s*320×640/,
      );
      expect(doc, `${name} should state that heights under 640px are not guaranteed`).toMatch(
        /高度\s*<640[^。\n]{0,20}不保证/,
      );

      // Cell-size promise and the 320–339px geometric fallback.
      expect(doc, `${name} should document the ≥36×36px cell promise`).toContain(
        '≥36×36px',
      );
      expect(doc, `${name} should document the ≥34×34px geometric fallback`).toContain(
        '≥34×34px',
      );
      expect(doc, `${name} should scope the fallback to 320–339px`).toMatch(
        /320[–-]339px/,
      );

      // First-screen entries the matrix must contain.
      for (const entry of [
        '返回大厅',
        '剩余雷数',
        '计时器',
        'touch-hint',
        'mobile-restart-button',
      ]) {
        expect(doc, `${name} should require ${entry} on the first screen`).toContain(
          entry,
        );
      }

      // Out-of-matrix boundary.
      expect(doc, `${name} should document the matrix boundary examples`).toMatch(
        /未列入矩阵[^。\n]{0,80}375×640[^。\n]{0,20}400×667/,
      );
      expect(doc, `${name} should not promise the restart entry outside the matrix`).toMatch(
        /(?:不承诺|不保证)[^。\n]{0,30}重开入口/,
      );

      // Large-board degradation.
      expect(doc, `${name} should only guarantee 36px for 9×9 boards`).toMatch(
        /列数\s*>9[^。\n]{0,40}9×9[^。\n]{0,30}≥36px/,
      );
      expect(doc, `${name} should reference the large-board follow-up #86`).toContain(
        '#86',
      );
      expect(doc, `${name} should say large boards scale down proportionally`).toContain(
        '按比例缩小',
      );
      expect(doc, `${name} should keep the page free of horizontal scrolling`).toContain(
        '不横向滚动',
      );

      // Rule for new viewport widths.
      expect(doc, `${name} should document the new-width rule`).toMatch(
        /新增视口宽度[^。\n]{0,60}按同一规则/,
      );
      expect(doc, `${name} should require an e2e for new widths`).toContain(
        '补对应 e2e',
      );
      expect(doc, `${name} should avoid per-width tickets`).toContain('不再逐条开单');
      expect(doc, `${name} should record out-of-rule widths as known limitations`).toMatch(
        /超出规则范围[^。\n]{0,30}已知限制/,
      );
    }
  });

  it('asserts the restart entry for every WebKit narrow viewport', () => {
    expect(viewportLabels(NARROW_WEBKIT_SPEC)).toHaveLength(4);
    // The four viewports share one contract call with the restart entry
    // enabled. A regression to `restartEntry: false`, or a new viewport that
    // opts out of the assertion, must fail this guard.
    expect(NARROW_WEBKIT_SPEC).not.toMatch(/restartEntry:\s*false/);
    expect(NARROW_WEBKIT_SPEC).toMatch(/restartEntry:\s*true/);
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

  it('keeps the verification counts and e2e breakdown in sync across both docs', () => {
    const counts = {
      readmeUnit: documentedCount(README, 'npm run test:unit'),
      readmeE2e: documentedCount(README, 'npm run test:e2e'),
      frameworkUnit: documentedCount(FRAMEWORK, 'npm run test:unit'),
      frameworkE2e: documentedCount(FRAMEWORK, 'npm run test:e2e'),
    };
    expect(counts.frameworkUnit).toBe(counts.readmeUnit);
    expect(counts.frameworkE2e).toBe(counts.readmeE2e);

    const readmeBreakdown = documentedBreakdown(README);
    const frameworkBreakdown = documentedBreakdown(FRAMEWORK);
    expect(readmeBreakdown).not.toBeNull();
    expect(frameworkBreakdown).toEqual(readmeBreakdown);
    const [desktop, mobile, webkit] = readmeBreakdown ?? [0, 0, 0];
    expect(desktop + mobile + webkit).toBe(counts.readmeE2e);
    expect(webkit).toBeGreaterThanOrEqual(6);
  });
});
