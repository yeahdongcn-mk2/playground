import type { Page } from '@playwright/test';

export interface BlankReadoutSample {
  x: number;
  y: number;
  trail: number;
}

export interface BlankPointerTarget {
  x: number;
  y: number;
}

export interface BlankSettleOptions {
  read?: (page: Page) => Promise<BlankReadoutSample>;
  wait?: (page: Page, delayMs: number) => Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  required?: number;
  tolerance?: number;
}

export const BLANK_TARGET_TOLERANCE: number;
export const BLANK_STABLE_SAMPLES: number;
export const BLANK_SETTLE_INTERVAL_MS: number;
export const BLANK_SETTLE_TIMEOUT_MS: number;

export function isBlankAtTarget(
  sample: BlankReadoutSample,
  target: BlankPointerTarget,
  tolerance?: number,
): boolean;

export function nextBlankStableStreak(
  streak: number,
  sample: BlankReadoutSample,
  target: BlankPointerTarget,
  options?: { required?: number; tolerance?: number },
): number;

export function readBlankReadout(page: Page): Promise<BlankReadoutSample>;

export function waitForBlankSettled(
  page: Page,
  target: BlankPointerTarget,
  options?: BlankSettleOptions,
): Promise<BlankReadoutSample>;

export interface BlankHeaderRepaintOptions {
  selector: string;
  frames: number;
}

export interface BlankHeaderSettleOptions {
  evaluate?: (
    page: Page,
    repaint: (options: BlankHeaderRepaintOptions) => Promise<boolean>,
    options: BlankHeaderRepaintOptions,
  ) => Promise<boolean>;
  selector?: string;
  frames?: number;
}

export const BLANK_HEADER_SELECTOR: string;
export const BLANK_HEADER_SETTLE_FRAMES: number;

export function repaintBlankHeader(
  options: BlankHeaderRepaintOptions,
): Promise<boolean>;

export function settleBlankHeader(
  page: Page,
  options?: BlankHeaderSettleOptions,
): Promise<void>;
