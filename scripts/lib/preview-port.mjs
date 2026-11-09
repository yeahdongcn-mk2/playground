import { createServer } from 'node:net';

/** Port the screenshot scripts use unless the caller overrides it. */
export const DEFAULT_PREVIEW_PORT = 4192;

/**
 * Resolve the preview port from an environment value.
 *
 * Shared CI hosts and parallel worktrees can already own the default port, so
 * callers may pass `PREVIEW_PORT` instead of editing the script. An invalid
 * value fails fast instead of being coerced to a surprising port.
 */
export function parsePreviewPort(value = process.env.PREVIEW_PORT) {
  if (value === undefined || value === '') {
    return DEFAULT_PREVIEW_PORT;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `Invalid PREVIEW_PORT "${value}": expected an integer between 1 and 65535.`,
    );
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PREVIEW_PORT "${value}": expected an integer between 1 and 65535.`,
    );
  }
  return port;
}

/**
 * Reject before spawning `vite preview` when the port is already taken.
 *
 * Without this probe, `vite --strictPort` exits immediately but the capture
 * script's readiness poll happily connects to the other server and later times
 * out on an unrelated locator. The error names the port and the override so the
 * real cause is obvious.
 */
export async function assertPortAvailable(port, host = '127.0.0.1') {
  const reason = await new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error) => resolve(error));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close((error) => resolve(error ?? null));
    });
  });
  if (reason === null) {
    return;
  }

  const detail =
    reason.code === 'EADDRINUSE'
      ? 'the port is already in use'
      : reason.code === 'EACCES'
        ? 'permission to bind the port was denied'
        : reason.message;
  throw new Error(
    `Cannot start the preview server on ${host}:${port}: ${detail}. ` +
      `Set PREVIEW_PORT to a free port (for example PREVIEW_PORT=${port + 1}) ` +
      `or stop the server that owns ${port}.`,
    { cause: reason },
  );
}
