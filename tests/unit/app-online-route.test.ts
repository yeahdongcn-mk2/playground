// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/app';
import {
  openOnlineRoute,
  type OnlineRoomClientModule,
  type OnlineRoomModuleLoader,
  type OnlineRoomMountOptions,
} from '../../src/app/online-route';

interface FakeMount {
  readonly root: HTMLElement;
  readonly options: OnlineRoomMountOptions | undefined;
  readonly destroy: ReturnType<typeof vi.fn>;
}

/**
 * A deterministic stand-in for the lazily imported room client.
 *
 * The fake renders one marker so the shell test can count real mounts instead
 * of only trusting the loader call count. Its `destroy` deliberately leaves
 * the marker in place: only the shell is allowed to clear the mount point, so
 * the "root is empty after leaving" assertions can fail when the shell stops
 * clearing it.
 */
function createFakeClient(): {
  module: OnlineRoomClientModule;
  mounts: FakeMount[];
} {
  const mounts: FakeMount[] = [];
  const module: OnlineRoomClientModule = {
    mountOnlineRoom(root, options) {
      root.innerHTML = '<div data-testid="fake-online-room">room</div>';
      const destroy = vi.fn();
      mounts.push({ root, options, destroy });
      return { destroy };
    },
  };
  return { module, mounts };
}

const apps: App[] = [];

function startApp(loadOnlineRoom?: OnlineRoomModuleLoader): {
  root: HTMLElement;
  app: App;
} {
  window.history.replaceState({}, '', '#/');
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const app = new App(root, loadOnlineRoom === undefined ? {} : { loadOnlineRoom });
  apps.push(app);
  app.start();
  return { root, app };
}

/** Drive one hash change exactly the way the browser shell observes it. */
function navigate(hash: string): void {
  window.history.replaceState({}, '', hash);
  window.dispatchEvent(new Event('hashchange'));
}

/** Let a resolved loader promise and its `await` continuations settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  // jsdom does not implement scrolling; the shell calls it on every render.
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), configurable: true });
});

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.stop();
  }
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('openOnlineRoute', () => {
  it('passes a null room id to the create/join screen', async () => {
    const { module, mounts } = createFakeClient();
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const root = document.createElement('div');

    const route = openOnlineRoute(root, null, { load });
    await route.ready;

    expect(route.roomId).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.options).toEqual({ roomId: null });

    route.destroy();
    expect(root.childNodes).toHaveLength(0);
  });

  it('passes the decoded room query through to the room view', async () => {
    const { module, mounts } = createFakeClient();
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const root = document.createElement('div');

    const route = openOnlineRoute(root, 'room_42', { load });
    await route.ready;

    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.options).toEqual({ roomId: 'room_42' });
  });

  it('ignores a load that settles after destroy', async () => {
    const { module, mounts } = createFakeClient();
    let resolveClient: ((client: OnlineRoomClientModule) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<OnlineRoomClientModule>((resolve) => {
          resolveClient = resolve;
        }),
    );
    const root = document.createElement('div');

    const route = openOnlineRoute(root, 'room_slow', { load });
    route.destroy();
    route.destroy();
    expect(root.childNodes).toHaveLength(0);

    resolveClient?.(module);
    await route.ready;

    expect(mounts).toHaveLength(0);
    expect(root.childNodes).toHaveLength(0);
  });

  it('destroys a mounted room once even when destroy is called again', async () => {
    const { module, mounts } = createFakeClient();
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const root = document.createElement('div');

    const route = openOnlineRoute(root, 'room_mounted', { load });
    await route.ready;
    expect(mounts).toHaveLength(1);
    expect(root.childNodes).toHaveLength(1);

    route.destroy();
    route.destroy();

    expect(mounts[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(root.childNodes).toHaveLength(0);
  });

  it('rejects ready when mounting fails and clears the mount point on destroy', async () => {
    const module: OnlineRoomClientModule = {
      mountOnlineRoom(mountRoot) {
        // Leave a partial render behind so destroy() has to clear it.
        mountRoot.innerHTML = '<div data-testid="partial-online-room">partial</div>';
        throw new Error('mount failed');
      },
    };
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const root = document.createElement('div');

    const route = openOnlineRoute(root, 'room_broken', { load });

    await expect(route.ready).rejects.toThrow('mount failed');
    expect(load).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-testid="partial-online-room"]')).not.toBeNull();

    route.destroy();
    expect(root.childNodes).toHaveLength(0);
  });

  it('cancels when the shell aborts the route signal', async () => {
    const { module, mounts } = createFakeClient();
    let resolveClient: ((client: OnlineRoomClientModule) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<OnlineRoomClientModule>((resolve) => {
          resolveClient = resolve;
        }),
    );
    const controller = new AbortController();
    const root = document.createElement('div');
    const route = openOnlineRoute(root, 'room_abort', {
      load,
      signal: controller.signal,
    });

    controller.abort();
    resolveClient?.(module);
    await route.ready;

    expect(mounts).toHaveLength(0);
    expect(root.childNodes).toHaveLength(0);
  });
});

describe('App online route wiring', () => {
  it('shows the route loading status until the lazy room replaces it', async () => {
    const { module, mounts } = createFakeClient();
    let resolveClient: ((client: OnlineRoomClientModule) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<OnlineRoomClientModule>((resolve) => {
          resolveClient = resolve;
        }),
    );
    const { root } = startApp(load);

    navigate('#/online/minesweeper?room=room_loading');

    // The shell renders this synchronously, before the lazy import settles.
    const status = root.querySelector<HTMLElement>('#view [role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('正在加载「联机扫雷」…');
    expect(root.querySelector('#view [data-testid="fake-online-room"]')).toBeNull();

    resolveClient?.(module);
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(1);
    });

    expect(root.querySelector('#view [role="status"]')).toBeNull();
    expect(root.querySelectorAll('#view [data-testid="fake-online-room"]')).toHaveLength(1);
    expect(mounts[0]?.options).toEqual({ roomId: 'room_loading' });
  });

  it('loads the online client only while the online route is active', async () => {
    const { module, mounts } = createFakeClient();
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const { root } = startApp(load);

    expect(load).not.toHaveBeenCalled();

    navigate('#/nope');
    await vi.waitFor(() => {
      expect(root.dataset.route).toBe('unknown');
    });
    expect(load).not.toHaveBeenCalled();

    navigate('#/online/minesweeper');
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(1);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounts[0]?.options).toEqual({ roomId: null });
  });

  it('destroys the previous room when switching online routes', async () => {
    const { module, mounts } = createFakeClient();
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const { root } = startApp(load);

    navigate('#/online/minesweeper?room=room_a');
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(1);
    });

    navigate('#/online/minesweeper?room=room_b');
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(2);
    });

    expect(mounts[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(mounts[1]?.options).toEqual({ roomId: 'room_b' });
    expect(root.querySelectorAll('[data-testid="fake-online-room"]')).toHaveLength(1);
  });

  it('destroys the room and restores the hub when leaving the route', async () => {
    const { module, mounts } = createFakeClient();
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const { root } = startApp(load);

    navigate('#/online/minesweeper?room=room_leave');
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(1);
    });

    navigate('#/');
    await vi.waitFor(() => {
      expect(root.querySelector('#view #hero-title')).not.toBeNull();
    });

    expect(mounts[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-testid="fake-online-room"]')).toBeNull();
    expect(root.dataset.route).toBe('home');
  });

  it('destroys the room on beforeunload', async () => {
    const { module, mounts } = createFakeClient();
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => module);
    const { root } = startApp(load);

    navigate('#/online/minesweeper');
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(1);
    });

    window.dispatchEvent(new Event('beforeunload'));

    expect(mounts[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-testid="fake-online-room"]')).toBeNull();
  });

  it('renders a retryable error and retries the same room', async () => {
    const { module, mounts } = createFakeClient();
    let attempt = 0;
    const load = vi.fn(async (): Promise<OnlineRoomClientModule> => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('network down');
      }
      return module;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root } = startApp(load);

    navigate('#/online/minesweeper?room=room_retry');
    await vi.waitFor(() => {
      expect(root.querySelector('#view [data-action="retry"]')).not.toBeNull();
    });

    expect(root.querySelector('#view h1')?.textContent).toBe('联机房间加载失败');
    expect(document.title).toBe('联机房间加载失败 · Playground Arcade');
    expect(load).toHaveBeenCalledTimes(1);

    root.querySelector<HTMLButtonElement>('#view [data-action="retry"]')?.click();
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(1);
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(mounts[0]?.options).toEqual({ roomId: 'room_retry' });
    expect(consoleError).toHaveBeenCalled();
  });

  it('does not let a slow old route overwrite the current room', async () => {
    const { module, mounts } = createFakeClient();
    const pending: Array<(client: OnlineRoomClientModule) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<OnlineRoomClientModule>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { root } = startApp(load);

    navigate('#/online/minesweeper?room=room_a');
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });

    navigate('#/online/minesweeper?room=room_b');
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });

    // The newer route resolves first: its room mounts.
    pending[1]?.(module);
    await vi.waitFor(() => {
      expect(mounts).toHaveLength(1);
    });
    expect(mounts[0]?.options).toEqual({ roomId: 'room_b' });

    // The abandoned route resolves last and must not mount over it.
    pending[0]?.(module);
    await flush();

    expect(mounts).toHaveLength(1);
    expect(root.querySelectorAll('[data-testid="fake-online-room"]')).toHaveLength(1);
  });
});
