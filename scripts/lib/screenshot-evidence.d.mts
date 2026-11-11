import type { CaptureEnvironmentFingerprint } from './capture-env.mjs';

export type HistoricalAfterGame = '2048' | 'breakout' | 'snake' | 'minesweeper';

export interface HistoricalAfterEvidence {
  readonly file: string;
  readonly game: HistoricalAfterGame;
  readonly issue: string;
  readonly trackingIssue: string;
  readonly captureCommit: string;
  readonly note: string;
}

export type CaptureWriteAction = 'write' | 'skip';

export interface CaptureWriteDecision {
  action: CaptureWriteAction;
  file: string;
  entry: HistoricalAfterEvidence | null;
}

export interface CaptureWriteOptions {
  file: string;
  mode?: string;
  allowHistoricalOverwrite?: boolean;
}

export interface CaptureEvidenceLogger {
  warn(message: string): void;
}

export interface AssertHistoricalOverwriteEnvironmentOptions {
  file: string;
  env?: Record<string, string | undefined>;
  fingerprint?: CaptureEnvironmentFingerprint;
}

export interface GuardHistoricalAfterEvidenceOptions extends CaptureWriteOptions {
  env?: Record<string, string | undefined>;
  fingerprint?: CaptureEnvironmentFingerprint;
  /** Parsed sha256 manifest; when omitted the repository manifest is read. */
  manifest?: unknown;
  manifestPath?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
  log?: CaptureEvidenceLogger;
}

export const HISTORICAL_OVERWRITE_FLAG: string;
export const HISTORICAL_OVERWRITE_CONTAINER_COMMAND: string;
export const HISTORICAL_SHA256_MANIFEST: string;
export const HISTORICAL_AFTER_EVIDENCE: readonly HistoricalAfterEvidence[];
export function findHistoricalAfterEvidence(file: string): HistoricalAfterEvidence | null;
export function decideAfterCaptureWrite(options: CaptureWriteOptions): CaptureWriteDecision;
export function assertHistoricalOverwriteEnvironment(
  options: AssertHistoricalOverwriteEnvironmentOptions,
): CaptureEnvironmentFingerprint;
export function guardHistoricalAfterEvidence(
  options: GuardHistoricalAfterEvidenceOptions,
): boolean;
