import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  previewStartupError,
  waitForPreviewServer,
  waitForServer,
} from '../../scripts/lib/preview-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');

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

function screenshotHashes(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(SCREENSHOT_DIR)
      .sort()
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(SCREENSHOT_DIR, file)))
          .digest('hex'),
      ]),
  );
}

describe('preview server startup', () => {
  it('reports the exit code and stderr when the preview dies early', async () => {
    const child = spawnPreview(
      "process.stderr.write('fake preview exploded\\n'); process.exit(7);",
    );
    const exited = exitOf(child);
    const screenshotsBefore = screenshotHashes();

    const error = await waitForPreviewServer(child, {
      origin: 'http://127.0.0.1:65000',
      port: 65000,
      timeoutMs: 5_000,
      probeIntervalMs: 25,
      probeTimeoutMs: 100,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('exit code 7');
    expect((error as Error).message).toContain('fake preview exploded');
    expect((error as Error).message).toContain('PREVIEW_PORT=65001');
    // The fake preview really exited non-zero before anything was captured.
    expect(await exited).toEqual({ code: 7, signal: null });
    expect(screenshotHashes()).toEqual(screenshotsBefore);
  });

  it('does not hang when the port accepts connections but never answers', async () => {
    const child = spawnPreview('setInterval(() => {}, 1_000);');
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
    expect(Date.now() - started).toBeLessThan(3_000);
    // The hanging server kept the child alive; only the probe timeout ended
    // the wait, not a preview failure.
    expect(child.exitCode).toBeNull();
  }, 10_000);

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

  it('names the real port and the override in the startup error', () => {
    const error = previewStartupError('http://127.0.0.1:4186', 4186, 'boom');

    expect(error.message).toContain('Port 4186');
    expect(error.message).toContain('PREVIEW_PORT=4187');
    expect(error.message).toContain('boom');
  });
});
