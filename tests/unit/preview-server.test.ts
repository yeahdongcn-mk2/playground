import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  waitForPreviewServer,
  waitForServer,
} from '../../scripts/lib/preview-server.mjs';

const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
  }
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

/** Spawn a stand-in preview process that runs the given inline script. */
function spawnPreview(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

/** Resolve with the child's exit code and signal once it exits. */
function exitOf(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

/** Reserve and immediately release an ephemeral port, leaving it unbound. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Accept TCP connections on a random port without ever answering HTTP. */
function listenSilently(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      // Accept the connection but never write a response.
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    servers.push(server);
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    // HTTP servers own closeAllConnections; net servers get their tracked
    // sockets destroyed explicitly so an unanswered request cannot block close.
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('preview server startup', () => {
  it('reports the exit code and stderr when the preview dies early', async () => {
    const port = await freePort();
    const child = spawnPreview(
      "process.stderr.write('fake preview exploded\\n'); process.exit(7);",
    );
    const exited = exitOf(child);

    const error = await waitForPreviewServer(child, {
      origin: `http://127.0.0.1:${port}`,
      port,
      timeoutMs: 5_000,
      probeIntervalMs: 25,
      probeTimeoutMs: 100,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('The preview server exited before');
    expect((error as Error).message).toContain('vite preview stopped');
    expect((error as Error).message).toContain('exit code 7');
    expect((error as Error).message).toContain('fake preview exploded');
    expect((error as Error).message).toContain(`PREVIEW_PORT=${port + 1}`);
    // The fake preview really exited non-zero before anything was captured.
    expect(await exited).toEqual({ code: 7, signal: null });
  });

  it('names the caller server instead of preview when asked', async () => {
    const port = await freePort();
    const child = spawnPreview(
      "process.stderr.write('fake dev server exploded\\n'); process.exit(9);",
    );
    const exited = exitOf(child);

    const error = await waitForPreviewServer(child, {
      origin: `http://127.0.0.1:${port}`,
      port,
      serverName: 'dev',
      timeoutMs: 5_000,
      probeIntervalMs: 25,
      probeTimeoutMs: 100,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('The dev server exited before');
    expect((error as Error).message).toContain('vite dev server stopped');
    expect((error as Error).message).toContain('exit code 9');
    expect((error as Error).message).toContain('fake dev server exploded');
    expect((error as Error).message).not.toContain('The preview server exited');
    expect(await exited).toEqual({ code: 9, signal: null });
  });

  it('reports a spawn failure before the preview starts', async () => {
    const port = await freePort();
    const child = spawn('/definitely/missing-preview-binary', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    const error = await waitForPreviewServer(child, {
      origin: `http://127.0.0.1:${port}`,
      port,
      timeoutMs: 5_000,
      probeIntervalMs: 25,
      probeTimeoutMs: 100,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'Failed to spawn the preview server',
    );
    expect((error as Error).message).toContain('ENOENT');
  });

  it('does not hang when the port accepts connections but never answers', async () => {
    const port = await listenSilently();
    const started = Date.now();

    const error = await waitForServer(`http://127.0.0.1:${port}`, {
      port,
      timeoutMs: 500,
      probeIntervalMs: 25,
      probeTimeoutMs: 100,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Timed out waiting/);
    // The default timeout hint keeps the historic preview wording.
    expect((error as Error).message).toContain(
      'If the preview is on another port',
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it('does not trust a response that arrives after the preview died', async () => {
    let checks = 0;
    const error = await waitForServer('http://127.0.0.1:65000', {
      port: 65000,
      failure: () =>
        checks++ === 0
          ? null
          : 'vite preview stopped (exit code 7, signal none).',
      // A 200 from the readiness probe must not hide the child's death.
      fetchImpl: async () => ({ ok: true }),
      timeoutMs: 1_000,
      probeIntervalMs: 10,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('exit code 7');
  });

  it('resolves once the preview answers', async () => {
    const child = spawnPreview('setInterval(() => {}, 1_000);');
    const server = createHttpServer((_request, response) => {
      response.end('ok');
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    await expect(
      waitForPreviewServer(child, {
        origin: `http://127.0.0.1:${port}`,
        port,
        timeoutMs: 2_000,
        probeIntervalMs: 25,
        probeTimeoutMs: 200,
      }),
    ).resolves.toBeUndefined();
  });

  it('derives the real port from the URL in the startup error', async () => {
    const error = await waitForServer('http://127.0.0.1:4186', {
      failure: () => 'boom',
      timeoutMs: 100,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Port 4186');
    expect((error as Error).message).toContain('PREVIEW_PORT=4187');
    expect((error as Error).message).toContain('boom');
  });
});
