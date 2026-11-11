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

export interface TargetE2eCase {
  title: string;
  projectName: string;
  file: string;
  line: number;
  outcome: TargetCaseOutcome;
  retryCount: number;
  firstError: string | null;
}

export interface E2eFlakesAnalysis {
  status: E2eFlakesStatus;
  cases: TargetE2eCase[];
}

export const DEFAULT_E2E_REPORT_PATH: string;
export const TARGET_PROJECT_NAME: string;
export const TARGET_TITLE_FRAGMENT: string;

export class E2eFlakesError extends Error {}

export function parseE2eReport(text: string): PlaywrightJsonReport;
export function readE2eReport(filePath: string): PlaywrightJsonReport;
export function summarizeResultError(result: PlaywrightJsonTestResult): string | null;
export function collectTargetCases(report: PlaywrightJsonReport): TargetE2eCase[];
export function analyzeE2eFlakes(report: PlaywrightJsonReport): E2eFlakesAnalysis;
export function exitCodeForAnalysis(analysis: E2eFlakesAnalysis): number;
export function describeE2eFlakes(
  analysis: E2eFlakesAnalysis,
  reportPath?: string,
): string[];
