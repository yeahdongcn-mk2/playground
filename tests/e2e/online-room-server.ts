/**
 * Test-only launcher for the online Minesweeper room service (#487).
 *
 * The browser e2e suite talks to the real room service through the preview
 * site's same-origin `/ws` proxy; this process is the room half of that pair.
 * It reuses the production composition (`startRoomServerFromConfig`) and only
 * changes what a test needs:
 *
 * - a fixed loopback port (4174) so `vite preview` can proxy to it and
 *   Playwright can wait on `GET /health`;
 * - shortened join/turn/match windows and a fixed match seed, so a test never
 *   waits the design's 2 min / 30 s / 15 min deadlines and a replay is stable;
 * - one-shot `SIGTERM`/`SIGINT` handlers that close the server, so Playwright's
 *   `gracefulShutdown` leaves the port free instead of relying on `SIGKILL`.
 *
 * This file is not a Playwright spec: it is launched from
 * `playwright.config.ts` as a `webServer` command. Importing it in a test is
 * safe because the listener only starts for direct execution.
 */

import { pathToFileURL } from 'node:url';
import {
  startRoomServerFromConfig,
  type RoomServerRuntimeOptions,
} from '../../server/room/main';
import type { RoomManagerOptions } from '../../server/room/room-manager';
import type { RoomServer } from '../../server/room/ws-server';

/** Loopback host the test room service binds. */
export const ONLINE_ROOM_SERVER_HOST = '127.0.0.1';

/** Port the test room service binds; `vite preview` proxies `/ws` here. */
export const ONLINE_ROOM_SERVER_PORT = 4174;

/** Base URL of the test room service (health probe and WebSocket origin). */
export const ONLINE_ROOM_SERVER_URL = `http://${ONLINE_ROOM_SERVER_HOST}:${ONLINE_ROOM_SERVER_PORT}`;

/** Readiness URL Playwright polls before starting the browser tests. */
export const ONLINE_ROOM_HEALTH_URL = `${ONLINE_ROOM_SERVER_URL}/health`;

/**
 * Deterministic room-manager settings for e2e runs.
 *
 * The windows are long enough for a real browser round trip under CI load but
 * far shorter than production, and the fixed seed makes a match replayable.
 * They are exported so a spec can assert against the same values instead of
 * copying the numbers.
 */
export const ONLINE_ROOM_MANAGER_OPTIONS = {
  joinTimeoutMs: 10_000,
  turnTimeoutMs: 5_000,
  matchTimeoutMs: 120_000,
  createSeed: () => 0x5eed_5eed,
} as const satisfies RoomManagerOptions;

/**
 * Start the real room service on the test port.
 *
 * Extra runtime options are forwarded for tests that need a manual clock or a
 * pre-built manager; manager option defaults still apply unless overridden.
 */
export async function startTestRoomServer(
  options: RoomServerRuntimeOptions = {},
): Promise<RoomServer> {
  return startRoomServerFromConfig(
    { host: ONLINE_ROOM_SERVER_HOST, port: ONLINE_ROOM_SERVER_PORT },
    {
      ...options,
      managerOptions: { ...ONLINE_ROOM_MANAGER_OPTIONS, ...options.managerOptions },
    },
  );
}

/** Report an unknown thrown value without hiding a plain string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the launcher as a long-lived web server until Playwright stops it.
 *
 * A startup failure sets a non-zero exit code so Playwright fails fast; the
 * shutdown handlers close the listener so the port is released before the
 * process exits.
 */
async function main(): Promise<void> {
  let server: RoomServer;
  try {
    server = await startTestRoomServer();
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
    return;
  }

  const shutdown = (): void => {
    void server.close().catch((error: unknown) => {
      console.error(describeError(error));
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/** True only when this module is the file Node/tsx was asked to run. */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main();
}
