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

describe('startRoomServerFromConfig', () => {
  it('serves /health on a system-assigned port and releases it on close', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const config = resolveRoomServerConfig({ HOST: '127.0.0.1', PORT: '0' });
      const server = await startRoomServerFromConfig(config);
      servers.push(server);

      expect(server.port).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledWith(
        `room server listening on http://127.0.0.1:${server.port}`,
      );

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
