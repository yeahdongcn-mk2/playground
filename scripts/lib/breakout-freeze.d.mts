import type { Page } from '@playwright/test';

export interface BreakoutFreezeTarget {
  selector: string;
}

export interface BreakoutFreezeRequest {
  found: boolean;
  frozen: boolean;
}

export const BREAKOUT_GAME_SELECTOR: string;
export const BREAKOUT_FROZEN_ATTRIBUTE: string;
export const BREAKOUT_FREEZE_TIMEOUT_MS: number;

export function requestBreakoutFreeze(
  options: BreakoutFreezeTarget,
): BreakoutFreezeRequest;

export function freezeBreakoutLoop(
  page: Page,
  options?: Partial<BreakoutFreezeTarget> & {
    attribute?: string;
    timeout?: number;
  },
): Promise<void>;
