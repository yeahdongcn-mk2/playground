export interface DocumentedCount {
  line: number;
  count: number;
}

export interface DocCountsSource {
  path: string;
  text: string;
}

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

export const TEST_COMMAND: string;
export const DOC_COUNT_PATHS: readonly string[];

export class DocCountsError extends Error {}

export function parseDocumentedCount(text: string, file?: string): DocumentedCount;
export function parseVitestReport(text: string, source?: string): VitestReportCounts;
export function verifyDocCounts(options: VerifyDocCountsOptions): DocCountsVerification;
