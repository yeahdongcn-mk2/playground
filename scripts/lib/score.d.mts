export type CheckStatus = 'pass' | 'fail' | null;

export interface CheckDefinition {
  readonly name: string;
  readonly script: string;
  readonly successPattern: RegExp;
  readonly failurePattern?: RegExp;
}

export interface CapturedCommandResult {
  name: string;
  script?: string;
  status: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: string | null;
}

export interface BuildSnapshotOptions {
  results: CapturedCommandResult[];
  build?: CapturedCommandResult | null;
  gitCommit: string | null;
  gitCommitError?: string | null;
  generatedAt: string;
}

export interface ScoreSnapshot {
  unitTests: number | null;
  entryGzipBytes: number | null;
  totalJsGzipBytes: number | null;
  checks: Record<string, CheckStatus>;
  gitCommit: string | null;
  generatedAt: string;
  error: Record<string, string>;
}

export interface ParsedBudgetMetrics {
  entryGzipBytes: number | null;
  totalJsGzipBytes: number | null;
}

export interface ScoreBaseline {
  unitTests: number | null;
  entryGzipBytes: number | null;
  totalJsGzipBytes: number | null;
  checks: Record<string, CheckStatus>;
}

export type ComparisonVerdict = 'improved' | 'regressed' | 'unchanged' | 'unknown';

export interface ComparisonRow {
  kind: 'metric' | 'check';
  name: string;
  current: number | string | null;
  baseline: number | string | null;
  delta: number | null;
  deltaLabel: string;
  verdict: ComparisonVerdict;
}

export interface ScoreComparison {
  rows: ComparisonRow[];
  regressed: ComparisonRow[];
  improved: ComparisonRow[];
  unchanged: ComparisonRow[];
  unknown: ComparisonRow[];
  status: 'improved' | 'regressed' | 'unchanged';
  errors: Record<string, string>;
}

export interface ClassifiedCheck {
  status: CheckStatus;
  reason: string | null;
}

export const CHECK_DEFINITIONS: readonly CheckDefinition[];

export class ScoreBaselineError extends Error {
  constructor(message: string);
}

export function kbToBytes(kilobytes: number): number;
export function parseBudgetMetrics(output: string): ParsedBudgetMetrics;
export function parseUnitTests(output: string): number | null;
export function classifyCheckResult(
  definition: CheckDefinition,
  result: CapturedCommandResult | undefined,
): ClassifiedCheck;
export function buildSnapshot(options: BuildSnapshotOptions): ScoreSnapshot;
export function parseBaseline(text: string, source?: string): ScoreBaseline;
export function createBaseline(snapshot: ScoreSnapshot): ScoreBaseline;
export function serializeBaseline(baseline: ScoreBaseline): string;
export function findSnapshotGaps(snapshot: ScoreSnapshot): string[];
export function compareSnapshot(
  snapshot: ScoreSnapshot,
  baseline: ScoreBaseline,
): ScoreComparison;
export function formatComparisonTable(comparison: ScoreComparison): string;
export function formatComparisonSummary(comparison: ScoreComparison): string;
export function formatBaselineUpdate(
  previous: ScoreBaseline | null,
  next: ScoreBaseline,
): string;
