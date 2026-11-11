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

export const HISTORICAL_OVERWRITE_FLAG: string;
export const HISTORICAL_AFTER_EVIDENCE: readonly HistoricalAfterEvidence[];
export function findHistoricalAfterEvidence(file: string): HistoricalAfterEvidence | null;
export function decideAfterCaptureWrite(options: CaptureWriteOptions): CaptureWriteDecision;
export function guardHistoricalAfterEvidence(
  options: CaptureWriteOptions & { log?: CaptureEvidenceLogger },
): boolean;
