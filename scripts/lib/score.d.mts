export type CheckStatus = 'pass' | 'fail' | null;

export interface CheckDefinition {
  readonly name: string;
  readonly script: string;
  readonly successPattern: RegExp;
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

export interface ClassifiedCheck {
  status: CheckStatus;
  reason: string | null;
}

export const CHECK_DEFINITIONS: readonly CheckDefinition[];

export function kbToBytes(kilobytes: number): number;
export function parseBudgetMetrics(output: string): ParsedBudgetMetrics;
export function parseUnitTests(output: string): number | null;
export function classifyCheckResult(
  definition: CheckDefinition,
  result: CapturedCommandResult | undefined,
): ClassifiedCheck;
export function buildSnapshot(options: BuildSnapshotOptions): ScoreSnapshot;
export function formatScoreTable(snapshot: ScoreSnapshot): string;
