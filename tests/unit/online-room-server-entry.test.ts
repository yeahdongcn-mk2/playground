import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOM_SERVER_PORT } from '../../server/room/contracts';
import {
  resolveRoomServerConfig,
  startRoomServerFromConfig,
} from '../../server/room/main';
import type { RoomServer } from '../../server/room/ws-server';

const servers: RoomServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => server.close().catch(() => undefined)),
  );
});

/** Build a stand-in transport handle for tests that mock `startRoomServer`. */
function fakeRoomServer(overrides: Partial<RoomServer> = {}): RoomServer {
  return {
    host: '127.0.0.1',
    port: 0,
    deliver: () => undefined,
    close: () => Promise.resolve(),
    ...overrides,
  };
}

/** Return the readable message a rejected `PORT` value produces. */
function invalidPortMessage(rawPort: string): string {
  try {
    resolveRoomServerConfig({ PORT: rawPort });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected PORT "${rawPort}" to be rejected`);
}

/** Resolve once a TCP connect to the port fails, rejecting if it still accepts. */
function expectPortReleased(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const failStillListening = (): void => {
      socket.destroy();
      reject(new Error(`port ${port} still accepts connections after close()`));
    };
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error(`timed out checking that port ${port} was released`));
    });
    socket.once('connect', failStillListening);
    socket.once('error', () => {
      socket.destroy();
      resolve();
    });
  });
}

describe('resolveRoomServerConfig', () => {
  it('defaults to loopback and the contract port when nothing is set', () => {
    expect(DEFAULT_ROOM_SERVER_PORT).toBe(8787);
    expect(resolveRoomServerConfig({})).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_ROOM_SERVER_PORT,
    });
    expect(resolveRoomServerConfig({ HOST: '', PORT: '' })).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_ROOM_SERVER_PORT,
    });
    expect(resolveRoomServerConfig({ HOST: '   ', PORT: '  ' })).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_ROOM_SERVER_PORT,
    });
  });

  it('reads HOST and PORT overrides, trimming surrounding whitespace', () => {
    expect(resolveRoomServerConfig({ HOST: '0.0.0.0', PORT: '9000' })).toEqual({
      host: '0.0.0.0',
      port: 9000,
    });
    expect(resolveRoomServerConfig({ HOST: ' 192.0.2.10 ', PORT: ' 9010 ' })).toEqual({
      host: '192.0.2.10',
      port: 9010,
    });
    expect(resolveRoomServerConfig({ HOST: 'room.example', PORT: '8787' })).toEqual({
      host: 'room.example',
      port: 8787,
    });
  });

  it('accepts the 0 and 65535 port boundaries', () => {
    expect(resolveRoomServerConfig({ PORT: '0' })).toEqual({ host: '127.0.0.1', port: 0 });
    expect(resolveRoomServerConfig({ PORT: '65535' })).toEqual({
      host: '127.0.0.1',
      port: 65535,
    });
  });

  it.each(['abc', '12.5', '-1', '1e3', '9000x'])(
    'rejects non-decimal PORT %s with a readable error',
    (rawPort) => {
      const message = invalidPortMessage(rawPort);
      expect(message).toContain(`Invalid PORT "${rawPort}"`);
      expect(message).toContain('0 and 65535');
    },
  );

  it.each(['65536', '70000', '999999999999999999999'])(
    'rejects out-of-range PORT %s with a readable error',
    (rawPort) => {
      const message = invalidPortMessage(rawPort);
      expect(message).toContain(`Invalid PORT "${rawPort}"`);
      expect(message).toContain('0 and 65535');
    },
  );
});

describe('server/room/main.ts import safety', () => {
  it('does not start the room server when the module is imported', async () => {
    const startRoomServer = vi.fn(async () => fakeRoomServer());
    vi.resetModules();
    vi.doMock('../../server/room/ws-server', () => ({ startRoomServer }));
    // A bypassed guard must reach the mocked transport even when the ambient
    // environment carries an invalid PORT; 0 is always valid and ephemeral.
    vi.stubEnv('PORT', '0');

    try {
      const mod = await import('../../server/room/main');
      // Give a bypassed (but asynchronous) startup a chance to reach the mock.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(startRoomServer).not.toHaveBeenCalled();

      // Prove the mock is wired to the dynamically imported module: without
      // this, a broken mock path could hide a bypassed guard whenever 8787 is
      // already occupied.
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await mod.startRoomServerFromConfig({ host: '127.0.0.1', port: 0 });
      } finally {
        log.mockRestore();
      }
      expect(startRoomServer).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../../server/room/ws-server');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('main shutdown', () => {
  it('reports a failed close and exits non-zero on SIGTERM', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    const close = vi.fn(() => Promise.reject(new Error('close failed')));
    const startRoomServer = vi.fn(async () => fakeRoomServer({ close }));
    // Intercept registration so the assertion path never installs a real signal
    // handler whose rejected close outlives this test.
    const once = vi.spyOn(process, 'once').mockImplementation(() => process);

    vi.resetModules();
    vi.doMock('../../server/room/ws-server', () => ({ startRoomServer }));

    try {
      const { main } = await import('../../server/room/main');
      const server = await main({ PORT: '0' });
      expect(server).not.toBeNull();

      const sigterm = once.mock.calls.find(([event]) => event === 'SIGTERM')?.[1];
      expect(sigterm).toBeTypeOf('function');
      if (sigterm === undefined) {
        throw new Error('main() did not register a SIGTERM handler');
      }

      // Clear any ambient value so the assertion proves the handler set it.
      process.exitCode = undefined;
      sigterm();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(close).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('close failed');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      once.mockRestore();
      vi.doUnmock('../../server/room/ws-server');
      vi.resetModules();
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('startRoomServerFromConfig', () => {
  it('binds the HOST override, serves /health, and releases the port on close', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // A non-default HOST proves `startRoomServerFromConfig` forwards
      // `config.host`; with the default the forwarded value is invisible.
      const config = resolveRoomServerConfig({ HOST: '0.0.0.0', PORT: '0' });
      const server = await startRoomServerFromConfig(config);
      servers.push(server);

      expect(server.host).toBe('0.0.0.0');
      expect(server.port).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledWith(
        `room server listening on http://0.0.0.0:${server.port}`,
      );

      // A wildcard bind still accepts loopback connections, and hitting it via
      // 127.0.0.1 proves the listener is actually reachable, not just reported.
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });

      const { port } = server;
      await expect(server.close()).resolves.toBeUndefined();
      // close() is documented (and needed by the signal handlers) to be idempotent.
      await expect(server.close()).resolves.toBeUndefined();
      await expectPortReleased(port);
    } finally {
      log.mockRestore();
    }
  });
});
