// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';

const apps: App[] = [];

/**
 * The shell reads `window.location.hash` on start, so each case pins the hash
 * before constructing the App and lets the first render settle.
 */
async function startAt(hash: string): Promise<{ root: HTMLElement; app: App }> {
  window.history.replaceState({}, '', hash);
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const app = new App(root);
  apps.push(app);
  app.start();
  await vi.waitFor(() => {
    expect(root.querySelector('#view')).not.toBeNull();
  });
  return { root, app };
}

/** Drive one hash change exactly the way the browser shell observes it. */
function navigate(hash: string): void {
  window.history.replaceState({}, '', hash);
  window.dispatchEvent(new Event('hashchange'));
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
  for (const app of apps.splice(0)) {
    app.stop();
  }
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
});

describe('App online route', () => {
  it('mounts the real online room lazily and destroys it on leave', async () => {
    const { root } = await startAt('#/online/minesweeper');

    await vi.waitFor(
      () => {
        expect(root.querySelector('#view [data-testid="online-room"]')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(root.dataset.route).toBe('online');
    expect(document.title).toBe('联机扫雷 · Playground Arcade');
    expect(root.querySelector('#view [data-testid="landing"]')).not.toBeNull();
    expect(root.querySelector('#view [data-testid="create-form"]')).not.toBeNull();

    navigate('#/');
    await vi.waitFor(() => {
      expect(root.querySelector('#view [data-testid="online-room"]')).toBeNull();
      expect(root.querySelector('#view #hero-title')).not.toBeNull();
    });

    // Re-entering mounts one fresh room, never a leftover second copy.
    navigate('#/online/minesweeper?room=room_1');
    await vi.waitFor(
      () => {
        expect(root.querySelectorAll('#view [data-testid="online-room"]')).toHaveLength(1);
      },
      { timeout: 10_000 },
    );

    const roomInput = root.querySelector<HTMLInputElement>('#view [data-testid="join-room-id"]');
    expect(roomInput?.value).toBe('room_1');
    const share = root.querySelector<HTMLAnchorElement>('#view [data-testid="share-link"]');
    expect(share?.getAttribute('href')).toBe('#/online/minesweeper?room=room_1');
  });

  it('destroys a mounted online room on beforeunload', async () => {
    const { root } = await startAt('#/online/minesweeper');
    await vi.waitFor(
      () => {
        expect(root.querySelector('#view [data-testid="online-room"]')).not.toBeNull();
      },
      { timeout: 10_000 },
    );

    window.dispatchEvent(new Event('beforeunload'));

    expect(root.querySelector('#view [data-testid="online-room"]')).toBeNull();
  });

  it('keeps other unknown routes on the not-found page', async () => {
    const { root } = await startAt('#/nope');

    expect(root.dataset.route).toBe('unknown');
    expect(routeTitle(root)).toBe('没有找到这个页面');
    expect(document.title).toBe('没有找到这个页面 · Playground Arcade');
  });
});
