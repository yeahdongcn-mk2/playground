import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPortAvailable,
  DEFAULT_PREVIEW_PORT,
  parsePreviewPort,
} from '../../scripts/lib/preview-port.mjs';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

function listen(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the probe server to have an IP socket address');
  }
  return address.port;
}

describe('parsePreviewPort', () => {
  it('defaults to the screenshot script port when unset', () => {
    expect(DEFAULT_PREVIEW_PORT).toBe(4192);
    expect(parsePreviewPort(undefined)).toBe(DEFAULT_PREVIEW_PORT);
    expect(parsePreviewPort('')).toBe(DEFAULT_PREVIEW_PORT);
  });

  it('accepts an environment override', () => {
    expect(parsePreviewPort('4193')).toBe(4193);
    expect(parsePreviewPort(' 5000 ')).toBe(5000);
  });

  it('uses a caller-provided fallback for unset and empty values', () => {
    // The minesweeper screenshot script keeps 4186 as its own default.
    expect(parsePreviewPort(undefined, 4186)).toBe(4186);
    expect(parsePreviewPort('', 4186)).toBe(4186);
    // The scores scripts keep the shared 4192 default.
    expect(parsePreviewPort(undefined)).toBe(DEFAULT_PREVIEW_PORT);
    expect(parsePreviewPort('')).toBe(DEFAULT_PREVIEW_PORT);
  });

  it.each(['abc', '0', '-1', '1.5', '65536'])(
    'rejects the invalid value %s',
    (value) => {
      expect(() => parsePreviewPort(value)).toThrow(/PREVIEW_PORT/);
      expect(() => parsePreviewPort(value, 4186)).toThrow(/PREVIEW_PORT/);
    },
  );
});

describe('assertPortAvailable', () => {
  it('resolves when the port can be bound', async () => {
    const probe = await listen();
    const port = portOf(probe);
    await close(probe);

    await expect(assertPortAvailable(port)).resolves.toBeUndefined();
  });

  it('rejects a taken port with the override in the message', async () => {
    const owner = await listen();
    const port = portOf(owner);

    await expect(assertPortAvailable(port)).rejects.toThrow(/already in use/);
    await expect(assertPortAvailable(port)).rejects.toThrow(/PREVIEW_PORT/);
  });
});
