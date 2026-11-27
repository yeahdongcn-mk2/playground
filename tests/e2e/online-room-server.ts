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
 * - shortened join, turn and presence windows plus a fixed match seed, so a
 *   test never waits the design's 2 min / 15 min deadlines, offline detection
 *   and reconnect stay observable within seconds, and a replay is stable;
 * - the production SIGTERM/SIGINT handlers, so Playwright's `gracefulShutdown`
 *   leaves the port free instead of relying on `SIGKILL`.
 *
 * This file is not a Playwright spec: it is launched from
 * `playwright.config.ts` as a `webServer` command. Importing it in a test is
 * safe because the listener only starts for direct execution.
 */

import { pathToFileURL } from 'node:url';
import {
  main,
  type RoomServerPresenceOptions,
} from '../../server/room/main';
import type { RoomManagerOptions } from '../../server/room/room-manager';
import {
  ONLINE_ROOM_SERVER_HOST,
  ONLINE_ROOM_SERVER_PORT,
} from './online-room-constants';

/**
 * Deterministic room-manager settings for e2e runs.
 *
 * Join, turn and match windows are shorter than production and the fixed seed
 * makes a match replayable. The turn window still sits after the whole
 * presence chain: a seat is declared offline after
 * `heartbeatIntervalMs * missedBeatsThreshold` and only then does the grace
 * window start, so a turn forfeit must not pre-empt a reconnect that grace
 * still allows. {@link ONLINE_ROOM_EFFECTIVE_TIMINGS} exports the resolved
 * numbers and `online-server-smoke.spec.ts` locks their ordering.
 */
export const ONLINE_ROOM_MANAGER_OPTIONS = {
  joinTimeoutMs: 10_000,
  turnTimeoutMs: 20_000,
  matchTimeoutMs: 120_000,
  createSeed: () => 0x5eed_5eed,
} as const satisfies RoomManagerOptions;

/**
 * Presence windows for e2e runs.
 *
 * One beat per second and two missed beats keep offline detection at 2 s, and
 * a 10 s grace window leaves a page reload enough time to rebind its seat
 * token even on a loaded CI worker. The production values (5 s / 2 beats /
 * 15 s) stay untouched because the entry only forwards these overrides to
 * `createPresenceController`. The values must stay ordered as
 * detect < grace < turn < match; the smoke spec enforces it.
 */
export const ONLINE_ROOM_PRESENCE_OPTIONS = {
  heartbeatIntervalMs: 1_000,
  missedBeatsThreshold: 2,
  graceMs: 10_000,
} as const satisfies RoomServerPresenceOptions;

/**
 * Effective test windows the launcher actually starts the room service with.
 *
 * Specs assert against these instead of production constants or duplicated
 * numbers: `offlineDetectMs` is derived from the heartbeat pair, and the turn
 * and match values come from the manager overrides above.
 */
export const ONLINE_ROOM_EFFECTIVE_TIMINGS = {
  heartbeatIntervalMs: ONLINE_ROOM_PRESENCE_OPTIONS.heartbeatIntervalMs,
  missedBeatsThreshold: ONLINE_ROOM_PRESENCE_OPTIONS.missedBeatsThreshold,
  offlineDetectMs:
    ONLINE_ROOM_PRESENCE_OPTIONS.heartbeatIntervalMs *
    ONLINE_ROOM_PRESENCE_OPTIONS.missedBeatsThreshold,
  graceMs: ONLINE_ROOM_PRESENCE_OPTIONS.graceMs,
  turnTimeoutMs: ONLINE_ROOM_MANAGER_OPTIONS.turnTimeoutMs,
  matchTimeoutMs: ONLINE_ROOM_MANAGER_OPTIONS.matchTimeoutMs,
} as const;

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
  // one-shot SIGTERM/SIGINT handlers. Only the test bind, manager options and
  // presence windows are overrides.
  void main(
    {
      ...process.env,
      HOST: ONLINE_ROOM_SERVER_HOST,
      PORT: String(ONLINE_ROOM_SERVER_PORT),
    },
    {
      managerOptions: ONLINE_ROOM_MANAGER_OPTIONS,
      ...ONLINE_ROOM_PRESENCE_OPTIONS,
    },
  );
}
