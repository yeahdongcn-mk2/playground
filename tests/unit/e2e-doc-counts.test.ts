import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_E2E_COUNTS } from './e2e-count-lock';

/**
 * Guard the whole-project e2e count documented next to `npm run test:e2e`.
 *
 * The count means the number of tests in Playwright's `--list` manifest, not
 * retries: every spec contributes once per project that runs it. Actual pass /
 * fail status stays with the CI `End-to-end tests` step; this test only keeps
 * the documentation and the committed Playwright suite in sync.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYWRIGHT_BIN = join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
);

/** Documents that record the whole-project `npm run test:e2e` count. */
const E2E_DOC_PATHS = ['README.md', 'docs/framework.md'] as const;

type E2eField = 'total' | 'chromium' | 'mobile' | 'mobile-webkit';

interface E2eCounts {
  total: number;
  chromium: number;
  mobile: number;
  mobileWebkit: number;
}

interface E2eDocument {
  path: string;
  text: string;
}

interface DocumentedE2eCount extends E2eCounts {
  line: number;
}

interface PlaywrightMeasurement {
  total: number;
  byProject: Record<string, number>;
}

interface E2eProblem {
  kind: 'measured-mismatch' | 'documented-mismatch' | 'missing-count';
  file: string;
  line: number | null;
  field: E2eField | null;
  documented: number | null;
  measured: number | null;
  reason: string;
}

const E2E_COMMAND_PATTERN = /npm run test:e2e(?![\w:])/;
// Anchor the count to the e2e command: docs/framework.md also records the
// unit-test count on the same line, before `npm run test:e2e`.
const TOTAL_PATTERN = /npm run test:e2e(?![\w:])[^\r\n]*?(\d+)\s+passed/;
const BREAKDOWN_PATTERN = /桌面\s*(\d+)\s*\+\s*手机\s*(\d+)\s*\+\s*WebKit\s*(\d+)/;

class E2eDocCountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eDocCountsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldLabel(field: E2eField): string {
  switch (field) {
    case 'total':
      return '总数';
    case 'chromium':
      return '桌面（chromium）分项';
    case 'mobile':
      return '手机（mobile）分项';
    case 'mobile-webkit':
      return 'WebKit（mobile-webkit）分项';
  }
}

function projectCount(measurement: PlaywrightMeasurement, project: string): number {
  return measurement.byProject[project] ?? 0;
}

function formatMeasured(measurement: PlaywrightMeasurement): string {
  return `总数 ${measurement.total}（桌面 ${projectCount(measurement, 'chromium')} + 手机 ${projectCount(measurement, 'mobile')} + WebKit ${projectCount(measurement, 'mobile-webkit')}）`;
}

function formatExpected(expected: E2eCounts): string {
  return `总数 ${expected.total}（桌面 ${expected.chromium} + 手机 ${expected.mobile} + WebKit ${expected.mobileWebkit}）`;
}

/** Find the documented e2e count on the same line as `npm run test:e2e`. */
function parseDocumentedE2eCount(
  text: string,
  file = 'document',
): DocumentedE2eCount {
  const lines = text.split(/\r?\n/);
  let sawCommand = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!E2E_COMMAND_PATTERN.test(line)) continue;
    sawCommand = true;

    const totalMatch = TOTAL_PATTERN.exec(line);
    // Command tables / usage blocks mention the command without a count.
    if (totalMatch?.[1] === undefined) continue;

    const breakdown = BREAKDOWN_PATTERN.exec(line);
    if (breakdown === null) {
      throw new E2eDocCountsError(
        `${file}:${index + 1}: \`npm run test:e2e\` 计数行缺少分项 "桌面 N + 手机 N + WebKit N"（文档行：${line.trim()}）`,
      );
    }

    return {
      line: index + 1,
      total: Number(totalMatch[1]),
      chromium: Number(breakdown[1]),
      mobile: Number(breakdown[2]),
      mobileWebkit: Number(breakdown[3]),
    };
  }

  if (sawCommand) {
    throw new E2eDocCountsError(
      `${file}: npm run test:e2e 同行缺少 "N passed" 计数`,
    );
  }
  throw new E2eDocCountsError(`${file}: 找不到 npm run test:e2e 的计数行`);
}

/** Recursively count `--list` specs and their tests per Playwright project. */
function parsePlaywrightList(
  text: string,
  source = 'Playwright --list JSON',
): PlaywrightMeasurement {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new E2eDocCountsError(`${source}: 不是合法的 JSON（${detail}）`);
  }

  if (!isRecord(report) || !Array.isArray(report.suites)) {
    throw new E2eDocCountsError(`${source}: 顶层缺少 suites 数组`);
  }

  const byProject: Record<string, number> = {};
  let total = 0;

  const visitSuites = (suites: unknown[], parent: string): void => {
    for (const suite of suites) {
      if (!isRecord(suite)) {
        throw new E2eDocCountsError(`${source}: suites 中的条目不是对象`);
      }
      const suiteTitle = typeof suite.title === 'string' ? suite.title : parent;

      if (suite.specs !== undefined) {
        if (!Array.isArray(suite.specs)) {
          throw new E2eDocCountsError(`${source}: ${suiteTitle} 的 specs 不是数组`);
        }
        for (const spec of suite.specs) {
          if (!isRecord(spec) || !Array.isArray(spec.tests)) {
            throw new E2eDocCountsError(`${source}: ${suiteTitle} 的 spec 缺少 tests 数组`);
          }
          for (const test of spec.tests) {
            if (!isRecord(test) || typeof test.projectName !== 'string') {
              throw new E2eDocCountsError(
                `${source}: ${suiteTitle} 中的 test 缺少 projectName`,
              );
            }
            const projectName = test.projectName;
            if (projectName === '') {
              throw new E2eDocCountsError(
                `${source}: ${suiteTitle} 中的 test 的 projectName 为空`,
              );
            }
            // `results` may contain retries; only the listed test is counted.
            total += 1;
            byProject[projectName] = (byProject[projectName] ?? 0) + 1;
          }
        }
      }

      if (suite.suites !== undefined) {
        if (!Array.isArray(suite.suites)) {
          throw new E2eDocCountsError(`${source}: ${suiteTitle} 的 suites 不是数组`);
        }
        visitSuites(suite.suites, suiteTitle);
      }
    }
  };

  visitSuites(report.suites, 'root');
  return { total, byProject };
}

function verifyE2eDocCounts({
  documents,
  reportText,
  reportPath = 'Playwright --list JSON',
  expected,
}: {
  documents: E2eDocument[];
  reportText: string;
  reportPath?: string;
  expected: E2eCounts;
}): {
  measured: PlaywrightMeasurement;
  documented: Array<DocumentedE2eCount & { file: string }>;
  problems: E2eProblem[];
} {
  if (!Array.isArray(documents)) {
    throw new E2eDocCountsError('documents 必须是文档数组');
  }

  const measured = parsePlaywrightList(reportText, reportPath);
  const measuredLabel = formatMeasured(measured);
  const expectedLabel = formatExpected(expected);
  const problems: E2eProblem[] = [];

  const compareMeasured = (field: E2eField, actual: number, wanted: number): void => {
    if (actual === wanted) return;
    problems.push({
      kind: 'measured-mismatch',
      file: reportPath,
      line: null,
      field,
      documented: null,
      measured: actual,
      reason: `${reportPath}: Playwright 清单${fieldLabel(field)}实测 ${actual} 条，与锁定的 ${wanted} 条不一致（实测：${measuredLabel}；锁定：${expectedLabel}）`,
    });
  };

  compareMeasured('total', measured.total, expected.total);
  compareMeasured('chromium', projectCount(measured, 'chromium'), expected.chromium);
  compareMeasured('mobile', projectCount(measured, 'mobile'), expected.mobile);
  compareMeasured(
    'mobile-webkit',
    projectCount(measured, 'mobile-webkit'),
    expected.mobileWebkit,
  );

  for (const [projectName, count] of Object.entries(measured.byProject)) {
    if (count === 0) continue;
    if (
      projectName === 'chromium' ||
      projectName === 'mobile' ||
      projectName === 'mobile-webkit'
    ) {
      continue;
    }
    problems.push({
      kind: 'measured-mismatch',
      file: reportPath,
      line: null,
      field: null,
      documented: null,
      measured: count,
      reason: `${reportPath}: Playwright 清单新增了未纳入计数的项目 ${projectName}（${count} 条），请同步 README/docs 与锁定值（实测：${measuredLabel}；锁定：${expectedLabel}）`,
    });
  }

  const documented: Array<DocumentedE2eCount & { file: string }> = [];

  for (const document of documents) {
    let parsed: DocumentedE2eCount;
    try {
      parsed = parseDocumentedE2eCount(document.text, document.path);
    } catch (error) {
      if (!(error instanceof E2eDocCountsError)) throw error;
      problems.push({
        kind: 'missing-count',
        file: document.path,
        line: null,
        field: null,
        documented: null,
        measured: measured.total,
        reason: error.message,
      });
      continue;
    }

    documented.push({ file: document.path, ...parsed });

    const comparisons: Array<[E2eField, number, number]> = [
      ['total', parsed.total, measured.total],
      ['chromium', parsed.chromium, projectCount(measured, 'chromium')],
      ['mobile', parsed.mobile, projectCount(measured, 'mobile')],
      ['mobile-webkit', parsed.mobileWebkit, projectCount(measured, 'mobile-webkit')],
    ];

    for (const [field, documentedCount, measuredCount] of comparisons) {
      if (documentedCount === measuredCount) continue;
      problems.push({
        kind: 'documented-mismatch',
        file: document.path,
        line: parsed.line,
        field,
        documented: documentedCount,
        measured: measuredCount,
        reason: `${document.path}:${parsed.line}: 文档${fieldLabel(field)}写 ${documentedCount} 条，Playwright 清单实测 ${measuredCount} 条（文档：${parsed.total} passed（桌面 ${parsed.chromium} + 手机 ${parsed.mobile} + WebKit ${parsed.mobileWebkit}）；实测：${measuredLabel}）`,
      });
    }
  }

  return { measured, documented, problems };
}

function docsWithE2eCounts(counts: E2eCounts): E2eDocument[] {
  return [
    {
      path: 'README.md',
      text: `# README\n\nnpm run test:e2e     # ${counts.total} passed（桌面 ${counts.chromium} + 手机 ${counts.mobile} + WebKit ${counts.mobileWebkit}）\n`,
    },
    {
      path: 'docs/framework.md',
      text: `当前提交本地通过：\`npm run test:unit\` 1603 passed；\`npm run test:e2e\` ${counts.total} passed（桌面 ${counts.chromium} + 手机 ${counts.mobile} + WebKit ${counts.mobileWebkit}）。\n`,
    },
  ];
}

function playwrightListJson(
  counts: Record<string, number>,
  resultsPerTest = 1,
): string {
  const specs = Object.entries(counts).flatMap(([projectName, count]) =>
    Array.from({ length: count }, (_, index) => ({
      title: `${projectName} spec ${index + 1}`,
      file: 'fixture.spec.ts',
      tests: [
        {
          projectName,
          // Playwright retries show up as extra results, not extra tests.
          results: Array.from({ length: resultsPerTest }, () => ({
            status: 'passed',
          })),
        },
      ],
    })),
  );

  return JSON.stringify({
    config: { rootDir: '/tmp/tests/e2e' },
    suites: [
      {
        title: 'fixture.spec.ts',
        file: 'fixture.spec.ts',
        suites: [{ title: 'nested group', file: 'fixture.spec.ts', specs }],
      },
    ],
    errors: [],
    stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 },
  });
}

function measuredCounts(reportText: string): E2eCounts {
  const measured = parsePlaywrightList(reportText, 'fixture.json');
  return {
    total: measured.total,
    chromium: projectCount(measured, 'chromium'),
    mobile: projectCount(measured, 'mobile'),
    mobileWebkit: projectCount(measured, 'mobile-webkit'),
  };
}

describe('parseDocumentedE2eCount', () => {
  it('parses the README "npm run test:e2e # N passed (breakdown)" form', () => {
    const text = [
      '# README',
      '',
      'npm run test:e2e     # 155 passed（桌面 87 + 手机 36 + WebKit 32）',
    ].join('\n');

    expect(parseDocumentedE2eCount(text, 'README.md')).toEqual({
      line: 3,
      total: 155,
      chromium: 87,
      mobile: 36,
      mobileWebkit: 32,
    });
  });

  it('parses the docs/framework "`npm run test:e2e` N passed" form', () => {
    const text =
      '当前提交：`npm run test:unit` 1585 passed；`npm run test:e2e` 155 passed（桌面 87 + 手机 36 + WebKit 32）。';

    expect(parseDocumentedE2eCount(text, 'docs/framework.md')).toEqual({
      line: 1,
      total: 155,
      chromium: 87,
      mobile: 36,
      mobileWebkit: 32,
    });
  });

  it('skips command mentions without a count and reports the real line', () => {
    const text = [
      '| `npm run test:e2e` | 先构建，再跑全部 Playwright 项目 |',
      '',
      'npm run test:e2e     # 155 passed（桌面 87 + 手机 36 + WebKit 32）',
    ].join('\n');

    expect(parseDocumentedE2eCount(text, 'README.md').line).toBe(3);
  });

  it('throws when a command line has no "N passed" count', () => {
    expect(() =>
      parseDocumentedE2eCount('npm run test:e2e\n', 'README.md'),
    ).toThrow(E2eDocCountsError);
    expect(() =>
      parseDocumentedE2eCount('npm run test:e2e\n', 'README.md'),
    ).toThrow(/README\.md: npm run test:e2e 同行缺少/);
  });

  it('throws when the count line omits the project breakdown', () => {
    expect(() =>
      parseDocumentedE2eCount('npm run test:e2e # 155 passed\n', 'README.md'),
    ).toThrow(/缺少分项/);
  });

  it('throws when the document never mentions the e2e command', () => {
    expect(() =>
      parseDocumentedE2eCount('# no command here\n', 'docs/framework.md'),
    ).toThrow(/找不到 npm run test:e2e/);
  });
});

describe('parsePlaywrightList', () => {
  it('walks nested suites and counts tests per Playwright project', () => {
    const report = playwrightListJson({
      chromium: 2,
      mobile: 1,
      'mobile-webkit': 1,
    });

    expect(measuredCounts(report)).toEqual({
      total: 4,
      chromium: 2,
      mobile: 1,
      mobileWebkit: 1,
    });
  });

  it('counts a retried test once instead of once per result', () => {
    const report = playwrightListJson({ chromium: 1, mobile: 1 }, 3);

    expect(measuredCounts(report)).toEqual({
      total: 2,
      chromium: 1,
      mobile: 1,
      mobileWebkit: 0,
    });
  });

  it('rejects invalid JSON with a clear error', () => {
    expect(() => parsePlaywrightList('not json', 'fixture.json')).toThrow(
      E2eDocCountsError,
    );
    expect(() => parsePlaywrightList('not json', 'fixture.json')).toThrow(
      /fixture\.json: 不是合法的 JSON/,
    );
  });

  it('rejects a report without a suites array', () => {
    expect(() => parsePlaywrightList('{}', 'fixture.json')).toThrow(
      /fixture\.json: 顶层缺少 suites 数组/,
    );
  });

  it('rejects a test without a projectName instead of guessing its project', () => {
    const report = JSON.stringify({
      suites: [{ title: 'fixture', specs: [{ tests: [{}] }] }],
    });

    expect(() => parsePlaywrightList(report, 'fixture.json')).toThrow(
      /fixture\.json: fixture 中的 test 缺少 projectName/,
    );
  });
});

describe('verifyE2eDocCounts', () => {
  it('passes when both documents and the manifest match the locked counts', () => {
    const verification = verifyE2eDocCounts({
      documents: docsWithE2eCounts(EXPECTED_E2E_COUNTS),
      reportText: playwrightListJson({
        chromium: EXPECTED_E2E_COUNTS.chromium,
        mobile: EXPECTED_E2E_COUNTS.mobile,
        'mobile-webkit': EXPECTED_E2E_COUNTS.mobileWebkit,
      }),
      expected: EXPECTED_E2E_COUNTS,
    });

    expect(verification.problems).toEqual([]);
    expect(verification.measured.total).toBe(EXPECTED_E2E_COUNTS.total);
    expect(verification.documented.map((document) => document.file)).toEqual([
      'README.md',
      'docs/framework.md',
    ]);
  });

  it('reports a documented total mismatch with the documented and measured values', () => {
    const documented = { ...EXPECTED_E2E_COUNTS, total: EXPECTED_E2E_COUNTS.total - 1 };
    const verification = verifyE2eDocCounts({
      documents: docsWithE2eCounts(documented),
      reportText: playwrightListJson({
        chromium: EXPECTED_E2E_COUNTS.chromium,
        mobile: EXPECTED_E2E_COUNTS.mobile,
        'mobile-webkit': EXPECTED_E2E_COUNTS.mobileWebkit,
      }),
      expected: EXPECTED_E2E_COUNTS,
    });

    expect(verification.problems).toHaveLength(2);
    expect(verification.problems[0]).toMatchObject({
      kind: 'documented-mismatch',
      file: 'README.md',
      field: 'total',
      documented: EXPECTED_E2E_COUNTS.total - 1,
      measured: EXPECTED_E2E_COUNTS.total,
    });
    expect(verification.problems[0]?.reason).toContain(
      `文档总数写 ${EXPECTED_E2E_COUNTS.total - 1} 条`,
    );
    expect(verification.problems[0]?.reason).toContain(
      `Playwright 清单实测 ${EXPECTED_E2E_COUNTS.total} 条`,
    );
  });

  it('reports a documented breakdown mismatch with the documented and measured values', () => {
    const documented = {
      ...EXPECTED_E2E_COUNTS,
      chromium: EXPECTED_E2E_COUNTS.chromium - 1,
    };
    const verification = verifyE2eDocCounts({
      documents: docsWithE2eCounts(documented),
      reportText: playwrightListJson({
        chromium: EXPECTED_E2E_COUNTS.chromium,
        mobile: EXPECTED_E2E_COUNTS.mobile,
        'mobile-webkit': EXPECTED_E2E_COUNTS.mobileWebkit,
      }),
      expected: EXPECTED_E2E_COUNTS,
    });

    expect(verification.problems).toHaveLength(2);
    expect(verification.problems[0]?.field).toBe('chromium');
    expect(verification.problems[0]?.reason).toContain(
      `文档桌面（chromium）分项写 ${EXPECTED_E2E_COUNTS.chromium - 1} 条`,
    );
    expect(verification.problems[0]?.reason).toContain(
      `实测 ${EXPECTED_E2E_COUNTS.chromium} 条`,
    );
  });

  it('reports when the Playwright manifest drifts from the locked counts', () => {
    const drifted = {
      ...EXPECTED_E2E_COUNTS,
      total: EXPECTED_E2E_COUNTS.total + 1,
      chromium: EXPECTED_E2E_COUNTS.chromium + 1,
    };
    const verification = verifyE2eDocCounts({
      documents: docsWithE2eCounts(drifted),
      reportText: playwrightListJson({
        chromium: EXPECTED_E2E_COUNTS.chromium + 1,
        mobile: EXPECTED_E2E_COUNTS.mobile,
        'mobile-webkit': EXPECTED_E2E_COUNTS.mobileWebkit,
      }),
      expected: EXPECTED_E2E_COUNTS,
    });

    // Neither the docs nor the manifest may silently raise the locked count.
    expect(verification.problems).toHaveLength(2);
    expect(verification.problems[0]).toMatchObject({
      kind: 'measured-mismatch',
      field: 'total',
    });
    expect(verification.problems[0]?.reason).toContain(
      `实测 ${EXPECTED_E2E_COUNTS.total + 1} 条`,
    );
    expect(verification.problems[0]?.reason).toContain(
      `锁定的 ${EXPECTED_E2E_COUNTS.total} 条`,
    );
    expect(verification.problems[1]?.field).toBe('chromium');
  });

  it('reports an unexpected Playwright project instead of folding it into the total', () => {
    const verification = verifyE2eDocCounts({
      documents: docsWithE2eCounts(EXPECTED_E2E_COUNTS),
      reportText: playwrightListJson({
        chromium: 87,
        mobile: 36,
        'mobile-webkit': 32,
        firefox: 1,
      }),
      expected: EXPECTED_E2E_COUNTS,
    });

    expect(verification.problems[0]).toMatchObject({
      kind: 'measured-mismatch',
      field: 'total',
    });
    expect(
      verification.problems.some((problem) =>
        problem.reason.includes('未纳入计数的项目 firefox'),
      ),
    ).toBe(true);
  });

  it('reports a document whose e2e count line cannot be parsed', () => {
    const verification = verifyE2eDocCounts({
      documents: [
        ...docsWithE2eCounts(EXPECTED_E2E_COUNTS),
        { path: 'docs/snake-design.md', text: '运行 `npm run test:e2e` 即可。\n' },
      ],
      reportText: playwrightListJson({
        chromium: EXPECTED_E2E_COUNTS.chromium,
        mobile: EXPECTED_E2E_COUNTS.mobile,
        'mobile-webkit': EXPECTED_E2E_COUNTS.mobileWebkit,
      }),
      expected: EXPECTED_E2E_COUNTS,
    });

    expect(verification.problems).toHaveLength(1);
    expect(verification.problems[0]).toMatchObject({
      kind: 'missing-count',
      file: 'docs/snake-design.md',
      line: null,
      measured: EXPECTED_E2E_COUNTS.total,
    });
    expect(verification.problems[0]?.reason).toContain('同行缺少');
  });
});

describe('committed e2e documentation', () => {
  it('matches the actual Playwright --list manifest and the locked counts', () => {
    const result = spawnSync(
      PLAYWRIGHT_BIN,
      ['test', '--list', '--reporter=json'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    expect(result.error).toBeUndefined();
    expect(
      result.status,
      `playwright test --list 退出码 ${String(result.status)}：${result.stderr}`,
    ).toBe(0);

    const documents = E2E_DOC_PATHS.map((path) => ({
      path,
      text: readFileSync(join(ROOT, path), 'utf8'),
    }));
    const verification = verifyE2eDocCounts({
      documents,
      reportText: result.stdout,
      reportPath: 'playwright test --list --reporter=json',
      expected: EXPECTED_E2E_COUNTS,
    });

    if (verification.problems.length > 0) {
      throw new Error(
        [
          'e2e 文档计数与 Playwright 测试清单不一致：',
          ...verification.problems.map((problem) => `- ${problem.reason}`),
        ].join('\n'),
      );
    }

    expect(verification.measured.total).toBe(EXPECTED_E2E_COUNTS.total);
    expect(verification.measured.byProject).toEqual({
      chromium: EXPECTED_E2E_COUNTS.chromium,
      mobile: EXPECTED_E2E_COUNTS.mobile,
      'mobile-webkit': EXPECTED_E2E_COUNTS.mobileWebkit,
    });
  }, 30_000);
});
