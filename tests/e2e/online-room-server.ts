/**
 * Test-only launcher for the online Minesweeper room service (#487).
 *
 * The browser e2e suite talks to the real room service through the preview
 * site's same-origin `/ws` proxy; this process is the room half of that pair.
 * It reuses the production startup (`main` from `server/room/main.ts`) and only
 * changes what a test needs:
 *
 * - a fixed loopback port from `online-room-constants.ts` so `vite preview` can
 *   proxy to it and Playwright can wait on `GET /health`;
 * - shortened join/match windows and a fixed match seed, so a test never waits
 *   the design's 2 min / 15 min deadlines and a replay is stable; the turn
 *   window keeps production's value so it still covers the presence chain;
 * - the production SIGTERM/SIGINT handlers, so Playwright's `gracefulShutdown`
 *   leaves the port free instead of relying on `SIGKILL`.
 *
 * This file is not a Playwright spec: it is launched from
 * `playwright.config.ts` as a `webServer` command. Importing it in a test is
 * safe because the listener only starts for direct execution.
 */

import { pathToFileURL } from 'node:url';
import { TURN_TIMEOUT_MS } from '../../server/room/contracts';
import { main } from '../../server/room/main';
import type { RoomManagerOptions } from '../../server/room/room-manager';
import {
  ONLINE_ROOM_SERVER_HOST,
  ONLINE_ROOM_SERVER_PORT,
} from './online-room-constants';

/**
 * Deterministic room-manager settings for e2e runs.
 *
 * The join and match windows are shorter than production and the fixed seed
 * makes a match replayable. The turn window keeps production's value because
 * the room manager's presence windows are not injectable through
 * {@link RoomManagerOptions}, and it must sit after the whole presence chain:
 * `RECONNECT_GRACE_MS` (15 s) starts only after `OFFLINE_DETECT_MS` (10 s)
 * fires, so grace can last until 25 s. A shorter turn deadline would forfeit
 * the match before the grace window resolves, so an online/reconnect spec built
 * on this launcher would see a turn forfeit instead of the real lifecycle.
 * `online-server-smoke.spec.ts` locks
 * `OFFLINE_DETECT_MS + RECONNECT_GRACE_MS < turn < match`.
 *
 * They are exported so a spec can assert against the same values instead of
 * copying the numbers.
 */
export const ONLINE_ROOM_MANAGER_OPTIONS = {
  joinTimeoutMs: 10_000,
  turnTimeoutMs: TURN_TIMEOUT_MS,
  matchTimeoutMs: 120_000,
  createSeed: () => 0x5eed_5eed,
} as const satisfies RoomManagerOptions;

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
  // Reuse the production entry point: it owns startup errors, logging and the
  // one-shot SIGTERM/SIGINT handlers. Only the test bind and manager options
  // are overrides.
  void main(
    {
      ...process.env,
      HOST: ONLINE_ROOM_SERVER_HOST,
      PORT: String(ONLINE_ROOM_SERVER_PORT),
    },
    { managerOptions: ONLINE_ROOM_MANAGER_OPTIONS },
  );
}
