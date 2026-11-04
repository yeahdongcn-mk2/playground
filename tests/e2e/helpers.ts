import { expect, type Page } from '@playwright/test';
import type { SnakeSnapshot } from '../../src/games/snake/engine';

export const HIGH_SCORE_KEY = 'playground:v1:snake.highscore';
export const SOUND_KEY = 'playground:v1:settings.sound';

export interface OpenSnakeOptions {
  /** Dev-only first fruit position, e.g. "11,10". */
  food?: string;
  /** Seed an existing best score once per browser context. */
  best?: number;
}

export async function openSnake(page: Page, options: OpenSnakeOptions = {}): Promise<void> {
  if (options.best !== undefined) {
    await page.addInitScript(
      ({ key, value }) => {
        if (!sessionStorage.getItem('best-seeded')) {
          localStorage.setItem(key, String(value));
          sessionStorage.setItem('best-seeded', '1');
        }
      },
      { key: HIGH_SCORE_KEY, value: options.best },
    );
  }

  const query = options.food ? `?food=${options.food}` : '';
  await page.goto(`/${query}#/games/snake`);
  await expect(page.getByTestId('snake-canvas')).toBeVisible();
  await expect.poll(() => readStatus(page)).toBe('ready');
}

export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  return errors;
}

export function readState(page: Page): Promise<SnakeSnapshot> {
  return page.evaluate(() => {
    const api = window.__playground;
    if (!api) {
      throw new Error('Playwright debug API is not available');
    }
    return api.getState();
  });
}

export async function readStatus(page: Page): Promise<SnakeSnapshot['status'] | 'missing'> {
  return page.evaluate(() => window.__playground?.getState().status ?? 'missing');
}

export async function startGame(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await expect.poll(() => readStatus(page)).toBe('running');
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}
