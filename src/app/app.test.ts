// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';

/**
 * The shell reads `window.location.hash` on start, so each case pins the hash
 * before constructing the App and lets the first render settle.
 */
async function startAt(hash: string): Promise<{ root: HTMLElement }> {
  window.history.replaceState({}, '', hash);
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const app = new App(root);
  app.start();
  await vi.waitFor(() => {
    expect(root.querySelector('#view')).not.toBeNull();
  });
  return { root };
}

function routeTitle(root: HTMLElement): string | null {
  return root.querySelector<HTMLElement>('#view h1')?.textContent ?? null;
}

beforeEach(() => {
  document.body.replaceChildren();
  // jsdom does not implement scrolling; the shell calls it on every route render.
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), configurable: true });
});

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
});

describe('App online route', () => {
  it('renders a recoverable placeholder for the online entry', async () => {
    const { root } = await startAt('#/online/minesweeper');

    expect(root.dataset.route).toBe('online');
    expect(routeTitle(root)).toBe('联机房间入口尚未接入');
    expect(document.title).toBe('联机房间入口尚未接入 · Playground Arcade');

    const back = root.querySelector<HTMLAnchorElement>('#view .route-error-actions a');
    expect(back?.getAttribute('href')).toBe('#/');
    expect(back?.textContent).toBe('返回大厅');
    // The placeholder is not retryable: it is not a load failure.
    expect(root.querySelector('#view [data-action="retry"]')).toBeNull();
  });

  it('renders the same placeholder when the room query is present', async () => {
    const { root } = await startAt('#/online/minesweeper?room=room_1');

    expect(root.dataset.route).toBe('online');
    expect(routeTitle(root)).toBe('联机房间入口尚未接入');
    expect(root.querySelector('#view .route-error-hint')).not.toBeNull();
  });

  it('keeps other unknown routes on the not-found page', async () => {
    const { root } = await startAt('#/nope');

    expect(root.dataset.route).toBe('unknown');
    expect(routeTitle(root)).toBe('没有找到这个页面');
    expect(document.title).toBe('没有找到这个页面 · Playground Arcade');
  });
});
