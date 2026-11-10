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
const NARROW_WEBKIT_SPEC = read('tests/e2e/minesweeper.narrow.webkit.spec.ts');
const WEBKIT_DEVICE = 'iPhone SE (3rd gen)';
const INSTALL_COMMAND = 'npx playwright install chromium webkit';

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

/** Viewport labels such as `320×640` declared in the WebKit narrow spec. */
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

  it('documents the same viewport matrix the WebKit narrow spec asserts', () => {
    const viewports = viewportLabels(NARROW_WEBKIT_SPEC);
    expect(viewports).toEqual(['320×640', '360×640', '375×667', '412×839']);

    for (const [name, doc] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
    ] as const) {
      for (const projectName of ['chromium', 'mobile', 'mobile-webkit']) {
        expect(doc, `${name} should mention the ${projectName} project`).toContain(projectName);
      }
      expect(doc, `${name} should mention the WebKit project`).toContain('mobile-webkit');
      expect(doc, `${name} should mention the WebKit device`).toContain(WEBKIT_DEVICE);
      for (const viewport of viewports) {
        expect(doc, `${name} is missing the ${viewport} viewport`).toContain(viewport);
      }
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
    // disclose, plus the still-open follow-ups that track the remaining work.
    const requiredTerms = [
      'safe-area',
      'dvh',
      '字体度量',
      'any-pointer',
      '人工验收',
      '#60',
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
