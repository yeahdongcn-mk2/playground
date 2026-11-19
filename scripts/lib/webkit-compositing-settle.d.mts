import type { Page } from '@playwright/test';

export interface SharedHeaderRepaintOptions {
  selector: string;
  frames: number;
}

export interface SharedHeaderSettleOptions {
  evaluate?: (
    page: Page,
    repaint: (options: SharedHeaderRepaintOptions) => Promise<boolean>,
    options: SharedHeaderRepaintOptions,
  ) => Promise<boolean>;
  selector?: string;
  frames?: number;
}

export interface HubHeroAnimationsOptions {
  selector: string;
  frames: number;
}

export interface HubHeroAnimationsResult {
  found: boolean;
  pending: number;
}

export interface HubHeroSettleOptions {
  evaluate?: (
    page: Page,
    settle: (
      options: HubHeroAnimationsOptions,
    ) => Promise<HubHeroAnimationsResult>,
    options: HubHeroAnimationsOptions,
  ) => Promise<HubHeroAnimationsResult>;
  selector?: string;
  frames?: number;
}

export const SHARED_HEADER_SELECTOR: string;
export const SHARED_HEADER_SETTLE_FRAMES: number;
export const HUB_HERO_SELECTOR: string;
export const HUB_HERO_SETTLE_FRAMES: number;

export function repaintSharedHeader(
  options: SharedHeaderRepaintOptions,
): Promise<boolean>;

export function settleSharedHeaderCompositing(
  page: Page,
  options?: SharedHeaderSettleOptions,
): Promise<void>;

export function settleHubHeroAnimations(
  options: HubHeroAnimationsOptions,
): Promise<HubHeroAnimationsResult>;

export function settleHubHeroCompositing(
  page: Page,
  options?: HubHeroSettleOptions,
): Promise<void>;
