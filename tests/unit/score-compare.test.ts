import { describe, expect, it } from 'vitest';
import {
  ScoreBaselineError,
  compareSnapshot,
  createBaseline,
  formatBaselineUpdate,
  formatComparisonSummary,
  formatComparisonTable,
  parseBaseline,
  serializeBaseline,
} from '../../scripts/lib/score.mjs';
import type {
  CheckStatus,
  ScoreBaseline,
  ScoreSnapshot,
} from '../../scripts/lib/score.mjs';

const COMMIT = 'a'.repeat(40);
const GENERATED_AT = '2026-11-18T00:00:00.000Z';

const PASS_CHECKS: Record<string, CheckStatus> = {
  lint: 'pass',
  'check:budget': 'pass',
  'verify:doc-counts': 'pass',
  'verify:screenshots:doc-dims': 'pass',
  'verify:screenshots:sha256': 'pass',
  'verify:screenshots:webkit': 'pass',
};

function snapshot(overrides: Partial<ScoreSnapshot> = {}): ScoreSnapshot {
  return {
    unitTests: 1258,
    entryGzipBytes: 8315,
    totalJsGzipBytes: 422226,
    checks: { ...PASS_CHECKS },
    gitCommit: COMMIT,
    generatedAt: GENERATED_AT,
    error: {},
    ...overrides,
  };
}

function baseline(overrides: Partial<ScoreBaseline> = {}): ScoreBaseline {
  return {
    unitTests: 1258,
    entryGzipBytes: 8315,
    totalJsGzipBytes: 422226,
    checks: { ...PASS_CHECKS },
    ...overrides,
  };
}

function row(comparison: ReturnType<typeof compareSnapshot>, name: string) {
  return comparison.rows.find((candidate) => candidate.name === name);
}

describe('compareSnapshot', () => {
  it('reports identical metrics and checks as unchanged', () => {
    const comparison = compareSnapshot(snapshot(), baseline());

    expect(comparison.status).toBe('unchanged');
    expect(comparison.regressed).toEqual([]);
    expect(comparison.improved).toEqual([]);
    expect(comparison.unknown).toEqual([]);
    expect(comparison.rows).toHaveLength(9);
    expect(comparison.rows.every((candidate) => candidate.verdict === 'unchanged')).toBe(true);
  });

  it('reports better metrics and a fail to pass check as improved', () => {
    const comparison = compareSnapshot(
      snapshot({
        unitTests: 1259,
        entryGzipBytes: 8314,
        totalJsGzipBytes: 422225,
      }),
      baseline({
        checks: { ...PASS_CHECKS, 'verify:screenshots:sha256': 'fail' },
      }),
    );

    expect(comparison.status).toBe('improved');
    expect(comparison.regressed).toEqual([]);
    expect(row(comparison, 'unitTests')).toMatchObject({ delta: 1, deltaLabel: '+1' });
    expect(row(comparison, 'entryGzipBytes')).toMatchObject({
      delta: -1,
      deltaLabel: '-1',
    });
    expect(row(comparison, 'totalJsGzipBytes')).toMatchObject({
      delta: -1,
      deltaLabel: '-1',
    });
    expect(row(comparison, 'verify:screenshots:sha256')).toMatchObject({
      verdict: 'improved',
      deltaLabel: 'fail → pass',
    });
    expect(formatComparisonSummary(comparison)).toContain('指标变好');
  });

  it('reports fewer unit tests as a regression with the size of the drop', () => {
    const comparison = compareSnapshot(snapshot({ unitTests: 1257 }), baseline());

    expect(comparison.status).toBe('regressed');
    expect(row(comparison, 'unitTests')).toMatchObject({
      delta: -1,
      deltaLabel: '-1',
      verdict: 'regressed',
    });
    expect(formatComparisonSummary(comparison)).toContain('退化');
    expect(formatComparisonSummary(comparison)).toContain('unitTests');
    expect(formatComparisonSummary(comparison)).toContain('差 -1');
  });

  it('reports a larger entry gzip size as a regression even when only one byte', () => {
    const comparison = compareSnapshot(
      snapshot({ entryGzipBytes: 8315 }),
      baseline({ entryGzipBytes: 8314 }),
    );

    expect(comparison.status).toBe('regressed');
    expect(row(comparison, 'entryGzipBytes')).toMatchObject({
      delta: 1,
      deltaLabel: '+1',
      verdict: 'regressed',
    });
    expect(formatComparisonSummary(comparison)).toContain('entryGzipBytes');
    expect(formatComparisonSummary(comparison)).toContain('差 +1');
  });

  it('reports a larger total JS gzip size as a regression', () => {
    const comparison = compareSnapshot(
      snapshot({ totalJsGzipBytes: 422227 }),
      baseline(),
    );

    expect(comparison.status).toBe('regressed');
    expect(row(comparison, 'totalJsGzipBytes')).toMatchObject({
      delta: 1,
      deltaLabel: '+1',
      verdict: 'regressed',
    });
  });

  it('reports a pass to fail check as a regression and keeps the transition', () => {
    const comparison = compareSnapshot(
      snapshot({ checks: { ...PASS_CHECKS, lint: 'fail' } }),
      baseline(),
    );

    expect(comparison.status).toBe('regressed');
    expect(row(comparison, 'lint')).toMatchObject({
      verdict: 'regressed',
      deltaLabel: 'pass → fail',
    });
    expect(formatComparisonSummary(comparison)).toContain('lint');
  });

  it('treats null metrics and checks as unknown instead of throwing', () => {
    const comparison = compareSnapshot(
      snapshot({
        unitTests: null,
        entryGzipBytes: null,
        checks: { ...PASS_CHECKS, lint: null },
      }),
      baseline({
        unitTests: 1258,
        entryGzipBytes: null,
        checks: { ...PASS_CHECKS, lint: null },
      }),
    );

    expect(comparison.status).toBe('unchanged');
    expect(comparison.regressed).toEqual([]);
    expect(row(comparison, 'unitTests')).toMatchObject({ verdict: 'unknown', delta: null });
    expect(row(comparison, 'entryGzipBytes')).toMatchObject({
      verdict: 'unchanged',
      delta: null,
    });
    expect(row(comparison, 'lint')).toMatchObject({ verdict: 'unchanged' });
    expect(formatComparisonSummary(comparison)).toContain('部分指标无法比较');
  });

  it('keeps the current snapshot error reasons in the summary', () => {
    const comparison = compareSnapshot(
      snapshot({ error: { lint: 'npm run lint was not executed' } }),
      baseline(),
    );

    expect(formatComparisonSummary(comparison)).toContain('npm run lint was not executed');
  });
});

describe('formatComparisonTable', () => {
  it('renders the metric / current / baseline / delta columns', () => {
    const comparison = compareSnapshot(
      snapshot({ unitTests: 1257, entryGzipBytes: 8315 }),
      baseline(),
    );
    const table = formatComparisonTable(comparison);

    expect(table).toContain('指标');
    expect(table).toContain('当前值');
    expect(table).toContain('基线值');
    expect(table).toContain('差值');
    expect(table).toContain('unitTests');
    expect(table).toContain('1257');
    expect(table).toContain('1258');
    expect(table).toContain('-1');
    expect(table).toContain('verify:screenshots:webkit');
  });
});

describe('baseline update', () => {
  it('writes the new baseline and prints every old value → new value', () => {
    const previous = baseline();
    const next = createBaseline(
      snapshot({
        unitTests: 1259,
        entryGzipBytes: 8314,
        checks: { ...PASS_CHECKS, lint: 'fail' },
      }),
    );
    const report = formatBaselineUpdate(previous, next);

    expect(report).toContain('基线已更新');
    expect(report).toContain('unitTests: 1258 → 1259');
    expect(report).toContain('entryGzipBytes: 8315 → 8314');
    expect(report).toContain('lint: pass → fail');
    expect(parseBaseline(serializeBaseline(next))).toEqual(next);
    expect(serializeBaseline(next).endsWith('\n')).toBe(true);
  });

  it('labels a missing previous baseline as 无', () => {
    const report = formatBaselineUpdate(null, baseline({ unitTests: 1259 }));

    expect(report).toContain('基线已更新');
    expect(report).toContain('unitTests: 无 → 1259');
  });
});

describe('parseBaseline', () => {
  it('accepts null metrics and null checks from a partially failed capture', () => {
    const parsed = parseBaseline(
      serializeBaseline(
        baseline({
          unitTests: null,
          entryGzipBytes: null,
          checks: { ...PASS_CHECKS, lint: null },
        }),
      ),
    );

    expect(parsed.unitTests).toBeNull();
    expect(parsed.entryGzipBytes).toBeNull();
    expect(parsed.checks).toEqual({ ...PASS_CHECKS, lint: null });
  });

  it('rejects invalid JSON with a readable error', () => {
    expect(() => parseBaseline('{', 'docs/score-baseline.json')).toThrow(ScoreBaselineError);
    expect(() => parseBaseline('{', 'docs/score-baseline.json')).toThrow(/不是合法的 JSON/);
  });

  it('rejects a non-object top level', () => {
    expect(() => parseBaseline('[]')).toThrow(/顶层必须是 JSON 对象/);
  });

  it.each([
    ['unitTests', { ...baseline(), unitTests: undefined }],
    ['entryGzipBytes', { ...baseline(), entryGzipBytes: -1 }],
    ['totalJsGzipBytes', { ...baseline(), totalJsGzipBytes: 1.5 }],
  ])('rejects an invalid %s', (name, report) => {
    expect(() => parseBaseline(JSON.stringify(report))).toThrow(ScoreBaselineError);
    expect(() => parseBaseline(JSON.stringify(report))).toThrow(new RegExp(name));
  });

  it('rejects an invalid check status', () => {
    const report = { ...baseline(), checks: { ...PASS_CHECKS, lint: 'ok' } };

    expect(() => parseBaseline(JSON.stringify(report))).toThrow(ScoreBaselineError);
    expect(() => parseBaseline(JSON.stringify(report))).toThrow(/checks\.lint/);
  });
});

describe('createBaseline', () => {
  it('keeps only the comparable snapshot values and fills missing checks with null', () => {
    const created = createBaseline(
      snapshot({
        unitTests: 1259,
        checks: { lint: 'pass' },
        error: { lint: 'should not be stored' },
      }),
    );

    expect(created).toEqual({
      unitTests: 1259,
      entryGzipBytes: 8315,
      totalJsGzipBytes: 422226,
      checks: {
        ...PASS_CHECKS,
        lint: 'pass',
        'check:budget': null,
        'verify:doc-counts': null,
        'verify:screenshots:doc-dims': null,
        'verify:screenshots:sha256': null,
        'verify:screenshots:webkit': null,
      },
    });
  });
});
