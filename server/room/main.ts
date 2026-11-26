/**
 * Startup entry point for the standalone online Minesweeper room service.
 *
 * This module only wires the process environment, the in-memory room manager,
 * the connection-layer presence controller and the room-deadline scheduler
 * together with the WebSocket transport. It owns no room or match behaviour:
 * every lifecycle command and every authoritative action still belongs to
 * `room-manager.ts` / `match.ts`, presence timing to `presence.ts`, deadline
 * timing to `deadline-scheduler.ts`, and the transport stays in `ws-server.ts`.
 *
 * The composition is deliberately acyclic: the manager is created first, then
 * the presence controller and the scheduler are built against it, and both use
 * the one delivery sink that forwards to the running transport's
 * `server.deliver`. That makes the transport's delivery path the single place
 * where command results and presence/grace-expiry deliveries re-arm a room's
 * deadline. The scheduler and the manager share the same injected clock, so a
 * test can advance virtual time without sleeping.
 *
 * The file is import-safe: the socket is only opened when the module is the
 * process entry point (`npm run server:room`), so the unit tests can import the
 * helpers without starting a listener.
 */

import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOM_SERVER_PORT } from './contracts';
import type {
  MatchRoomManager,
  PresenceRoomManager,
  RoomDelivery,
} from './contracts';
import {
  createDeadlineScheduler,
  type DeadlineRoomManager,
} from './deadline-scheduler';
import { createPresenceController, type PresenceClock } from './presence';
import {
  createRoomManager,
  type RoomManagerOptions,
} from './room-manager';
import { startRoomServer, type RoomServer } from './ws-server';

/** Resolved bind settings for one room-server start. */
export interface RoomServerConfig {
  /** Host or address to bind; loopback unless `HOST` overrides it. */
  readonly host: string;
  /** TCP port; `0` asks the OS for an ephemeral port. */
  readonly port: number;
}

/**
 * The room-layer surface the standalone entry needs from one manager object.
 *
 * `InMemoryRoomManager` implements all three seams; keeping the requirement
 * structural lets a test inject the same object it then inspects.
 */
export type StandaloneRoomManager = MatchRoomManager &
  PresenceRoomManager &
  DeadlineRoomManager;

/**
 * Optional composition hooks for {@link startRoomServerFromConfig}.
 *
 * Production passes nothing and gets `Date.now`, the design's heartbeat /
 * grace windows and the default room timings. A test passes a manual clock (to
 * drive heartbeat, grace, turn and match deadlines without sleeping) and/or a
 * pre-built manager whose state it can inspect.
 */
export interface RoomServerRuntimeOptions {
  /**
   * Clock shared by room deadlines, presence heartbeat/grace and the deadline
   * scheduler. When set it also becomes the manager's `now`.
   */
  readonly clock?: PresenceClock;
  /**
   * In-memory manager overrides (join/turn/match windows, seed source).
   * Ignored when {@link manager} is set.
   */
  readonly managerOptions?: RoomManagerOptions;
  /**
   * Pre-built manager satisfying every room-layer seam; mostly for tests.
   *
   * A caller that passes both this and {@link clock} must build the manager
   * with that same clock (`now: () => clock.now()`). The scheduler and the
   * presence controller always use {@link clock}; a manager on a different
   * clock would compare deadlines against a different epoch.
   */
  readonly manager?: StandaloneRoomManager;
}

/** Loopback bind host used when `HOST` is unset or only whitespace. */
const DEFAULT_ROOM_SERVER_HOST = '127.0.0.1';

/** Highest valid TCP port. */
const MAX_PORT = 65_535;

/** Build the one readable error every invalid `PORT` value produces. */
function invalidPortError(raw: string): Error {
  return new Error(
    `Invalid PORT "${raw}": expected a decimal integer between 0 and ${MAX_PORT} ` +
      `(0 lets the OS pick a free port); leave PORT unset to use ${DEFAULT_ROOM_SERVER_PORT}.`,
  );
}

/**
 * Resolve bind settings from the process environment.
 *
 * `HOST` is trimmed and falls back to loopback when unset or blank. `PORT` is
 * trimmed and falls back to {@link DEFAULT_ROOM_SERVER_PORT} when unset or
 * blank; otherwise it must be a decimal integer in `0..65535`, where `0` means
 * an ephemeral port. Anything else throws a readable error instead of silently
 * binding something unintended.
 */
export function resolveRoomServerConfig(env: NodeJS.ProcessEnv = process.env): RoomServerConfig {
  const rawHost = env.HOST?.trim() ?? '';
  const host = rawHost === '' ? DEFAULT_ROOM_SERVER_HOST : rawHost;

  const rawPort = env.PORT?.trim() ?? '';
  if (rawPort === '') {
    return { host, port: DEFAULT_ROOM_SERVER_PORT };
  }
  if (!/^\d+$/.test(rawPort)) {
    throw invalidPortError(rawPort);
  }

  const port = Number(rawPort);
  if (port > MAX_PORT) {
    throw invalidPortError(rawPort);
  }
  return { host, port };
}

/**
 * Start one room server from resolved settings.
 *
 * Composition order matters: the manager exists before the presence controller
 * and the deadline scheduler, both of which only reach the transport through
 * `server.deliver`. The transport is started last and its handle installed in
 * the sink; the scheduler shares the manager's clock so a deadline and the
 * timer that adjudicates it never disagree. Once listening, it reports the
 * actual bind address (which differs from the request when `port: 0` was used)
 * and returns the transport handle, whose `close()` releases the presence and
 * deadline timers as well as the sockets.
 */
export async function startRoomServerFromConfig(
  config: RoomServerConfig,
  options: RoomServerRuntimeOptions = {},
): Promise<RoomServer> {
  const clock = options.clock;
  const manager =
    options.manager ??
    createRoomManager({
      ...options.managerOptions,
      ...(clock === undefined ? {} : { now: () => clock.now() }),
    });

  let server: RoomServer | null = null;
  const deliver = (deliveries: readonly RoomDelivery[]): void => {
    server?.deliver(deliveries);
  };
  const deadlines = createDeadlineScheduler({ manager, deliver, clock });
  const presence = createPresenceController({ manager, deliver, clock });

  server = await startRoomServer({
    manager,
    presence,
    deadlines,
    host: config.host,
    port: config.port,
  });
  console.log(`room server listening on http://${server.host}:${server.port}`);
  return server;
}

/** Report an unknown thrown value without hiding a plain string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start the room server from `env` and wire graceful shutdown.
 *
 * A successful start registers one-shot `SIGTERM` and `SIGINT` handlers that
 * close the server through its idempotent `close()`, after which the event loop
 * drains and the process exits normally. A startup failure is printed and sets
 * a non-zero exit code; a failed close does the same. Returns the running
 * handle (or `null` on startup failure); the direct-execution path ignores it.
 */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  options: RoomServerRuntimeOptions = {},
): Promise<RoomServer | null> {
  let server: RoomServer;
  try {
    server = await startRoomServerFromConfig(resolveRoomServerConfig(env), options);
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
    return null;
  }

  const shutdown = (): void => {
    void server.close().catch((error: unknown) => {
      console.error(describeError(error));
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
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
