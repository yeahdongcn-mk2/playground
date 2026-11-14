/** A capture target id from the fixed capture-env DPR contract. */
export type CaptureTargetId = 'desktop' | 'mobile' | 'mobile-touch' | 'webkit';

export const CAPTURE_TARGET_IDS: Readonly<{
  DESKTOP: 'desktop';
  MOBILE: 'mobile';
  MOBILE_TOUCH: 'mobile-touch';
  WEBKIT: 'webkit';
}>;

export const PRINT_CAPTURE_TARGETS_FLAG: string;
export const WEBKIT_FLAG: string;
export const WEBKIT_NARROW_FLAG: string;
export const WEBKIT_NARROW_BEFORE_FLAG: string;
export const MINESWEEPER_TOUCH_BEFORE_FLAG: string;
export const MINESWEEPER_NARROW_FLAGS: readonly string[];

export interface CaptureTargetsDeclaration {
  script: string;
  targets: CaptureTargetId[];
}

export interface PrintCaptureTargetsOptions {
  /** Sink for the declaration line; defaults to synchronous fd 1. */
  write?: (text: string) => unknown;
  /** Exit callback; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export function isPrintCaptureTargetsRequested(
  args?: readonly string[],
): boolean;
export function captureTargetsDeclaration(
  script: string,
  targets: string | readonly string[],
): CaptureTargetsDeclaration;
export function formatCaptureTargetsDeclaration(
  script: string,
  targets: string | readonly string[],
): string;
export function printCaptureTargets(
  script: string,
  targets: string | readonly string[],
  options?: PrintCaptureTargetsOptions,
): void;
