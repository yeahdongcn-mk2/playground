export interface DocumentedCount {
  line: number;
  count: number;
}

export interface DocCountsSource {
  path: string;
  text: string;
}

export type RemoveDirectory = (
  path: string,
  options: { recursive: boolean; force: boolean },
) => void;

export interface VitestReportCounts {
  numTotalTests: number;
  numFailedTests: number;
  numPassedTests: number;
  numPendingTests: number;
}

export type DocCountsProblemKind = 'mismatch' | 'missing-count' | 'tests-failed';

export interface DocCountsProblem {
  kind: DocCountsProblemKind;
  file: string;
  line: number | null;
  expected: number | null;
  actual: number | null;
  reason: string;
}

export interface VerifyDocCountsOptions {
  documents: DocCountsSource[];
  reportText: string;
  reportPath?: string;
  testExitCode?: number;
}

export interface DocCountsVerification {
  total: number;
  numFailedTests: number;
  documented: Array<{ file: string; line: number; count: number }>;
  problems: DocCountsProblem[];
}

export interface PlannedDocCountWrite {
  path: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface PlanDocCountWritesOptions {
  documents: DocCountsSource[];
  baselineText: string;
  total: number;
  numFailedTests?: number;
}

export interface DocCountWritesPlan {
  total: number;
  documents: PlannedDocCountWrite[];
  baseline: PlannedDocCountWrite;
  changedPaths: string[];
}

export const TEST_COMMAND: string;
export const DOC_COUNT_PATHS: readonly string[];
export const BASELINE_RELATIVE_PATH: string;

export class DocCountsError extends Error {}

export function parseDocumentedCount(text: string, file?: string): DocumentedCount;
export function parseVitestReport(text: string, source?: string): VitestReportCounts;
export function verifyDocCounts(options: VerifyDocCountsOptions): DocCountsVerification;
export function rewriteDocumentedCount(text: string, total: number, file?: string): string;
export function rewriteBaselineUnitTests(text: string, total: number, source?: string): string;
export function planDocCountWrites(options: PlanDocCountWritesOptions): DocCountWritesPlan;
export function cleanupTempDirs(dirs: string[], remove?: RemoveDirectory): void;
