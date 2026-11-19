export interface PlaywrightJsonTestError {
  message?: string;
  value?: string;
  stack?: string;
}

export interface PlaywrightJsonTestResult {
  status?: string;
  retry?: number;
  error?: PlaywrightJsonTestError | string;
  errors?: Array<string | PlaywrightJsonTestError>;
  [key: string]: unknown;
}

export interface PlaywrightJsonTest {
  projectName?: string;
  status?: string;
  expectedStatus?: string;
  results?: PlaywrightJsonTestResult[];
  [key: string]: unknown;
}

export interface PlaywrightJsonSpec {
  title?: string;
  ok?: boolean;
  file?: string;
  line?: number;
  column?: number;
  tests?: PlaywrightJsonTest[];
  [key: string]: unknown;
}

export interface PlaywrightJsonSuite {
  title?: string;
  file?: string;
  line?: number;
  column?: number;
  specs?: PlaywrightJsonSpec[];
  suites?: PlaywrightJsonSuite[];
  [key: string]: unknown;
}

export interface PlaywrightJsonReport {
  suites?: PlaywrightJsonSuite[];
  errors?: unknown[];
  stats?: Record<string, number>;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export type TargetCaseOutcome = 'passed' | 'flaky' | 'failed' | 'skipped' | 'unknown';

export type E2eFlakesStatus = 'passed' | 'flaky' | 'failed' | 'skipped' | 'missing' | 'unknown';

/** One guarded first-run case: project, title fragment and a readable label. */
export interface E2eFlakeTarget {
  label: string;
  projectName: string;
  titleFragment: string;
}

export interface TargetE2eCase {
  targetLabel: string;
  title: string;
  projectName: string;
  file: string;
  line: number;
  outcome: TargetCaseOutcome;
  retryCount: number;
  firstError: string | null;
}

/** Verdict for one entry of `TARGET_CASES`. */
export interface TargetE2eFlakesAnalysis {
  target: E2eFlakeTarget;
  status: E2eFlakesStatus;
  cases: TargetE2eCase[];
}

export interface E2eFlakesAnalysis {
  status: E2eFlakesStatus;
  targets: TargetE2eFlakesAnalysis[];
  cases: TargetE2eCase[];
}

/** First-run outcome counts for one guarded target. */
export interface TargetFirstRunCounts {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  unknown: number;
  total: number;
}

/** Counts plus the matched cases for one entry of `TARGET_CASES`. */
export interface TargetFirstRunSummary {
  target: E2eFlakeTarget;
  counts: TargetFirstRunCounts;
  cases: TargetE2eCase[];
}

export const DEFAULT_E2E_REPORT_PATH: string;
export const TARGET_CASES: E2eFlakeTarget[];

export class E2eFlakesError extends Error {}

export function parseE2eReport(text: string): PlaywrightJsonReport;
export function readE2eReport(filePath: string): PlaywrightJsonReport;
export function summarizeResultError(result: PlaywrightJsonTestResult): string | null;
export function collectTargetCases(report: PlaywrightJsonReport): TargetE2eCase[];
export function summarizeTargetCases(report: PlaywrightJsonReport): TargetFirstRunSummary[];
export function analyzeE2eFlakes(report: PlaywrightJsonReport): E2eFlakesAnalysis;
export function exitCodeForAnalysis(analysis: E2eFlakesAnalysis): number;
export function describeE2eFlakes(
  analysis: E2eFlakesAnalysis,
  reportPath?: string,
): string[];
