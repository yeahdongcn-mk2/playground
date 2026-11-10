import { setTimeout as delay } from 'node:timers/promises';

/** The TCP port an HTTP URL points at, for callers that do not pass one. */
function portOf(url) {
  const parsed = new URL(url);
  if (parsed.port !== '') {
    return Number(parsed.port);
  }
  return parsed.protocol === 'https:' ? 443 : 80;
}

/**
 * Wording for the shared startup messages.
 *
 * `serverName` defaults to `'preview'`, which keeps every historic message
 * byte-for-byte. A caller that starts a different server (the snake capture
 * script runs `vite` in dev mode) passes its own name so the failure names that
 * server instead of claiming a preview failed.
 */
function serverWording(serverName) {
  if (serverName === 'preview') {
    return {
      exited: 'The preview server',
      stopped: 'vite preview',
      onAnotherPort: 'the preview',
    };
  }
  return {
    exited: `The ${serverName} server`,
    stopped: `vite ${serverName} server`,
    onAnotherPort: `the ${serverName} server`,
  };
}

/** Error shown when the preview dies before the capture can connect to it. */
export function previewStartupError(
  origin,
  port,
  detail,
  serverName = 'preview',
) {
  const suffix = detail.trim() === '' ? '' : `\n${detail.trim()}`;
  const { exited } = serverWording(serverName);
  return new Error(
    `${exited} exited before ${origin} became ready. ` +
      `Port ${port} may be taken by another process; set PREVIEW_PORT to a ` +
      `free port (for example PREVIEW_PORT=${port + 1}).${suffix}`,
  );
}

/**
 * Poll the preview URL until it answers, giving up when the spawned child
 * reports a failure or the deadline expires.
 *
 * Every probe is bounded by `probeTimeoutMs`: a process that accepts the TCP
 * connection but never answers the HTTP request must not make the poll hang
 * past a failed child exit. `failure` returns a non-null detail once the child
 * has died, and is checked before each probe and again after a response so a
 * server that answered between spawn and death is not mistaken for ours.
 *
 * `serverName` selects the wording of the startup error; its default keeps the
 * existing preview messages and every current caller unchanged.
 */
export async function waitForServer(
  url,
  {
    port = portOf(url),
    timeoutMs = 30_000,
    probeIntervalMs = 250,
    probeTimeoutMs = 1_000,
    failure,
    fetchImpl = fetch,
    serverName = 'preview',
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failureDetail = failure?.();
    if (failureDetail != null) {
      throw previewStartupError(url, port, failureDetail, serverName);
    }
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      // A responding port is not proof that our preview is the server there:
      // the child may already have exited because another process owns it.
      if (response.ok && failure?.() == null) {
        return;
      }
    } catch {
      // server not ready yet (or the probe timed out)
    }
    await delay(probeIntervalMs);
  }
  const failureDetail = failure?.();
  const { onAnotherPort } = serverWording(serverName);
  throw new Error(
    `Timed out waiting for ${url}. If ${onAnotherPort} is on another port, set ` +
      `PREVIEW_PORT to match it.` +
      (failureDetail == null ? '' : `\n${failureDetail}`),
  );
}

/**
 * Wait until a spawned preview child serves `origin`, surfacing an early exit
 * instead of quietly connecting to whatever else owns the port.
 *
 * Collects stderr, listens for `error` / `exit`, and feeds the resulting detail
 * to `waitForServer`, so a preview that dies after the pre-spawn port probe
 * still fails the run with the exit code and the child's own message.
 *
 * `serverName` defaults to `'preview'`; callers that start a dev server (the
 * snake capture script) pass `'dev'` so the report names the right process.
 */
export async function waitForPreviewServer(
  child,
  {
    origin,
    port = portOf(origin),
    timeoutMs = 30_000,
    probeIntervalMs = 250,
    probeTimeoutMs = 1_000,
    serverName = 'preview',
  } = {},
) {
  let stderr = '';
  let failure = null;
  const { stopped } = serverWording(serverName);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  child.once('error', (error) => {
    failure = `Failed to spawn the ${serverName} server: ${error.message}`;
  });
  child.once('exit', (code, signal) => {
    failure = `${stopped} stopped (exit code ${code}, signal ${signal ?? 'none'}).`;
  });

  await waitForServer(origin, {
    port,
    timeoutMs,
    probeIntervalMs,
    probeTimeoutMs,
    serverName,
    failure: () => {
      if (failure == null) {
        return null;
      }
      const detail = stderr.trim();
      return `${failure}${detail === '' ? '' : `\n${detail}`}`;
    },
  });
}
