/**
 * Connection-layer presence controller for the online Minesweeper room service
 * (issue #485, design 5.1–5.3).
 *
 * The controller is the only owner of heartbeat and reconnect timers. It never
 * touches a room record: the transport tells it when a connection opens,
 * closes, answers a heartbeat or binds a seat token, and the controller turns
 * that into `setPresence` / `graceExpired` calls on the injected
 * {@link PresenceRoomManager}. Every room broadcast the manager returns is
 * handed to the injected delivery sink, so presence never has to know how a
 * message reaches a socket.
 *
 * Timing follows design 5.1/5.2 and the constants in `contracts.ts`:
 *
 * - one application-level `ping` per connection every {@link HEARTBEAT_INTERVAL_MS}
 *   (5 s); each beat is recorded on the connection until a `pong` arrives;
 * - two consecutive unanswered beats ({@link HEARTBEAT_MISSED_BEATS}, i.e. 10 s)
 *   mark the bound token `offline` exactly once and open the
 *   {@link RECONNECT_GRACE_MS} (15 s) grace window;
 * - a replacement connection that binds the same token inside the window
 *   cancels it and returns the seat to `online`; after the window lapses,
 *   `graceExpired` runs exactly once and its deliveries go to the sink.
 *
 * Cleanup rules are equally important:
 *
 * - a closed socket stops its heartbeat, and a bound token that was still
 *   `online` goes offline immediately (a close frame is definitive evidence,
 *   unlike a single lost packet);
 * - a token taken over by a newer connection is removed from the old
 *   connection, so the old socket's close, late `pong` or next missed beat can
 *   never restart a grace window for the new owner;
 * - duplicate `pong`, close and expiry events are no-ops: the controller
 *   records what it has already said, so the room layer sees one offline
 *   transition and one grace expiry per episode.
 *
 * The clock, timers and timing thresholds are injectable. The defaults are the
 * design constants and `Date.now`, so production code needs no configuration
 * while tests can use fake timers, a manual clock or shorter windows without
 * sleeping. The controller deliberately has no WebSocket, DOM, storage or
 * environment dependency.
 */

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSED_BEATS,
  RECONNECT_GRACE_MS,
  type PlayerToken,
  type PresenceController,
  type PresenceRoomManager,
  type PresenceSocket,
  type RoomCommandResult,
  type RoomDelivery,
} from './contracts';

/** Opaque timer handle owned by an injected {@link PresenceClock}. */
export type PresenceTimer = ReturnType<typeof setTimeout>;

/**
 * Clock and timer surface the controller runs on.
 *
 * Node's `Date.now` plus the global timers form the default; injecting the
 * whole surface keeps heartbeat and grace deadlines on one deterministic
 * clock in tests and lets a host swap in a virtual clock without touching the
 * controller's logic.
 */
export interface PresenceClock {
  /** Current server time in milliseconds. */
  now(): number;
  /** Schedule a one-shot timer. */
  setTimeout(callback: () => void, delayMs: number): PresenceTimer;
  /** Cancel a one-shot timer created by {@link PresenceClock.setTimeout}. */
  clearTimeout(handle: PresenceTimer): void;
  /** Schedule a repeating timer. */
  setInterval(callback: () => void, intervalMs: number): PresenceTimer;
  /** Cancel a repeating timer created by {@link PresenceClock.setInterval}. */
  clearInterval(handle: PresenceTimer): void;
}

/** Default clock: the design constants are relative, so `Date.now` is enough. */
const systemPresenceClock: PresenceClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * Receives the room messages produced by presence commands.
 *
 * The transport owns sockets and the connection→token map, so it is also the
 * only layer that can send a delivery. The controller calls this with the exact
 * `deliveries` array the room manager returned: a `graceExpired` result is
 * handed over even when it is empty, so the transport sees the one expiry the
 * room layer resolved.
 */
export type PresenceDeliverySink = (deliveries: readonly RoomDelivery[]) => void;

/** Construction options for {@link createPresenceController}. */
export interface PresenceControllerOptions {
  /** Room-layer half of the seam; the only way presence can affect a room. */
  readonly manager: PresenceRoomManager;
  /** Delivery sink for room commands produced by presence transitions. */
  readonly deliver: PresenceDeliverySink;
  /** Clock and timer surface; defaults to `Date.now` and the global timers. */
  readonly clock?: PresenceClock;
  /** Application-level ping cadence; defaults to {@link HEARTBEAT_INTERVAL_MS}. */
  readonly heartbeatIntervalMs?: number;
  /** Unanswered beats that mark a seat offline; defaults to {@link HEARTBEAT_MISSED_BEATS}. */
  readonly missedBeatsThreshold?: number;
  /** Reconnect window; defaults to {@link RECONNECT_GRACE_MS}. */
  readonly graceMs?: number;
}

/** One live transport connection as the presence controller sees it. */
interface ConnectionState {
  readonly connectionId: string;
  socket: PresenceSocket;
  /** Seat token this connection currently owns, or null before `create`/`join`. */
  token: PlayerToken | null;
  /** Heartbeat interval handle, null once the connection is closed. */
  heartbeat: PresenceTimer | null;
  /**
   * Clock times of the pings this connection sent since the last `pong`.
   *
   * The array length is the consecutive-miss count the offline rule uses; the
   * entries are the heartbeat record itself, stamped by the injected clock.
   * The record is capped at the miss threshold because further beats cannot
   * change the offline decision for this episode and a quiet or replaced
   * socket must not grow an unbounded list.
   */
  pendingPingAt: number[];
}

/** Connection-layer presence of one seat token. */
interface TokenState {
  readonly token: PlayerToken;
  /** Connection that owns the token, or null while it waits in a grace window. */
  ownerConnectionId: string | null;
  /** Whether the room layer currently shows this seat as `online`. */
  online: boolean;
  /** Active grace timer, or null when the seat is online or already expired. */
  grace: PresenceTimer | null;
}

/**
 * Build a presence controller.
 *
 * The returned object implements the {@link PresenceController} contract from
 * `contracts.ts`; it owns all heartbeat/grace timers and no room state. Every
 * method is synchronous and safe to call with an unknown or already-closed
 * connection id: the transport may race a close against a delayed `pong`, and
 * a heartbeat must never throw just because its socket is already gone.
 */
export function createPresenceController(
  options: PresenceControllerOptions,
): PresenceController {
  const manager = options.manager;
  const deliver = options.deliver;
  const clock = options.clock ?? systemPresenceClock;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const missedBeatsThreshold = options.missedBeatsThreshold ?? HEARTBEAT_MISSED_BEATS;
  const graceMs = options.graceMs ?? RECONNECT_GRACE_MS;

  if (
    !Number.isFinite(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    !Number.isInteger(missedBeatsThreshold) ||
    missedBeatsThreshold < 1 ||
    !Number.isFinite(graceMs) ||
    graceMs <= 0
  ) {
    throw new RangeError(
      'presence timing options must be positive (and missed beats a positive integer)',
    );
  }

  const connections = new Map<string, ConnectionState>();
  const tokens = new Map<PlayerToken, TokenState>();

  /** Send the non-empty deliveries of a presence update, if any. */
  function deliverPresenceResult(result: RoomCommandResult): void {
    if (result.ok && result.deliveries.length > 0) {
      deliver(result.deliveries);
    }
  }

  function stopHeartbeat(connection: ConnectionState): void {
    if (connection.heartbeat !== null) {
      clock.clearInterval(connection.heartbeat);
      connection.heartbeat = null;
    }
  }

  function startHeartbeat(connection: ConnectionState): void {
    connection.pendingPingAt.length = 0;
    connection.heartbeat = clock.setInterval(() => beat(connection), heartbeatIntervalMs);
  }

  /** The token state this connection currently owns, if any. */
  function ownedToken(connection: ConnectionState): TokenState | null {
    if (connection.token === null) {
      return null;
    }
    const state = tokens.get(connection.token);
    if (state === undefined || state.ownerConnectionId !== connection.connectionId) {
      return null;
    }
    return state;
  }

  /**
   * One heartbeat beat: ping, record the unanswered beat and detect offline.
   *
   * Beats continue after a seat goes offline so the miss record keeps tracking
   * a still-open socket; only a token bind cancels the grace window.
   */
  function beat(connection: ConnectionState): void {
    connection.socket.ping();
    if (connection.pendingPingAt.length < missedBeatsThreshold) {
      connection.pendingPingAt.push(clock.now());
    }
    if (connection.pendingPingAt.length < missedBeatsThreshold) {
      return;
    }
    const state = ownedToken(connection);
    if (state !== null) {
      markOffline(state);
    }
  }

  /** Mark a seat offline once and open its grace window once. */
  function markOffline(state: TokenState): void {
    // An already-open window means this episode has been reported; a duplicate
    // missed beat, close or socket error must not restart the 15 s clock.
    if (state.grace !== null) {
      return;
    }
    if (state.online) {
      state.online = false;
      // The room layer remains the authority on whether the token still has a
      // seat. Its answer (including a rejection) is final for this episode;
      // the window below still lapses exactly once so the manager can resolve
      // the token through `graceExpired`.
      deliverPresenceResult(manager.setPresence(state.token, 'offline'));
    }
    state.grace = clock.setTimeout(() => expireGrace(state.token), graceMs);
  }

  /** Resolve the seat once the reconnect window lapses. */
  function expireGrace(token: PlayerToken): void {
    const state = tokens.get(token);
    if (state === undefined || state.grace === null) {
      return;
    }
    state.grace = null;
    if (state.ownerConnectionId !== null) {
      const owner = connections.get(state.ownerConnectionId);
      if (owner !== undefined && owner.token === token) {
        // The token is resolved; a late pong from the still-open socket must
        // not revive a seat the room layer has already released or forfeited.
        owner.token = null;
      }
    }
    tokens.delete(token);
    const result = manager.graceExpired(token);
    if (result.ok) {
      // Hand the result over even when it is empty: this is the single
      // `graceExpired` outcome the transport has to deliver.
      deliver(result.deliveries);
    }
  }

  function cancelGrace(state: TokenState): void {
    if (state.grace === null) {
      return;
    }
    clock.clearTimeout(state.grace);
    state.grace = null;
  }

  /** Return a seat to online, cancelling any grace window that was running. */
  function restoreOnline(state: TokenState): void {
    if (state.online) {
      return;
    }
    cancelGrace(state);
    state.online = true;
    deliverPresenceResult(manager.setPresence(state.token, 'online'));
  }

  /**
   * Detach a connection from its token without changing the room.
   *
   * A transport-level unbind happens on `leave`, seat release and replacement,
   * so it cannot by itself start a grace window. Online state has no reserved
   * seat to keep and is dropped; an offline token keeps its running window
   * because the unbind may be the first half of a connection replacement, and
   * the replacement cancels the window when it binds.
   *
   * The controller cannot tell a replacement unbind from an explicit release,
   * so an offline token keeps its window in both cases. If the room layer has
   * already released the seat, the later `graceExpired` call is rejected by the
   * manager rather than restarting anything here; it is never a duplicate
   * offline transition because the presence state was reported only once.
   */
  function detachToken(connection: ConnectionState): void {
    const token = connection.token;
    connection.token = null;
    if (token === null) {
      return;
    }
    const state = tokens.get(token);
    if (state === undefined || state.ownerConnectionId !== connection.connectionId) {
      return;
    }
    state.ownerConnectionId = null;
    if (state.online) {
      tokens.delete(token);
    }
  }

  function connectionOpened(connectionId: string, socket: PresenceSocket): void {
    const existing = connections.get(connectionId);
    if (existing !== undefined) {
      // A repeated open for the same id is treated as a transport retry: keep
      // the seat binding, restart the heartbeat and forget old unanswered
      // beats (the new socket has not had a chance to answer yet).
      stopHeartbeat(existing);
      existing.socket = socket;
      startHeartbeat(existing);
      return;
    }
    const connection: ConnectionState = {
      connectionId,
      socket,
      token: null,
      heartbeat: null,
      pendingPingAt: [],
    };
    connections.set(connectionId, connection);
    startHeartbeat(connection);
  }

  function connectionClosed(connectionId: string): void {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      return;
    }
    connections.delete(connectionId);
    stopHeartbeat(connection);

    const token = connection.token;
    connection.token = null;
    if (token === null) {
      return;
    }
    const state = tokens.get(token);
    if (state === undefined || state.ownerConnectionId !== connectionId) {
      // A newer connection owns the token: closing the replaced socket must
      // leave its presence and grace window untouched.
      return;
    }
    state.ownerConnectionId = null;
    // A close frame is definitive, so the seat goes offline now instead of
    // waiting for two more missed beats; a repeated close is already a no-op
    // because the connection record was removed above.
    markOffline(state);
  }

  function pongReceived(connectionId: string): void {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      // Late pong from an already-closed or replaced connection.
      return;
    }
    // A valid pong resets the consecutive-miss count. It does not cancel a
    // grace window: recovery from an offline seat deliberately goes through a
    // token re-join, so a seat the room layer already sees as offline must not
    // flip back without one.
    connection.pendingPingAt.length = 0;
  }

  function tokenBound(connectionId: string, playerToken: PlayerToken): void {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      // The transport owns socket opening, so a bind for a connection we never
      // saw means it is already gone; there is no heartbeat to tie the seat to.
      return;
    }
    if (connection.token === playerToken) {
      return;
    }
    detachToken(connection);
    connection.token = playerToken;
    // A bind follows a client command, which already proves the connection is
    // alive; unanswered beats sent before the seat existed must not count
    // against the freshly bound token. A duplicate bind returns above and
    // deliberately resets nothing.
    connection.pendingPingAt.length = 0;

    const state = tokens.get(playerToken);
    if (state === undefined) {
      tokens.set(playerToken, {
        token: playerToken,
        ownerConnectionId: connectionId,
        online: true,
        grace: null,
      });
      return;
    }

    if (state.ownerConnectionId !== null && state.ownerConnectionId !== connectionId) {
      const previous = connections.get(state.ownerConnectionId);
      if (previous !== undefined && previous.token === playerToken) {
        // Replacement: the old socket may stay open for a few turns while the
        // transport closes it. It no longer represents this token, so its
        // close, pong and missed beats are inert for the new owner.
        previous.token = null;
      }
    }
    state.ownerConnectionId = connectionId;
    // Reconnecting inside the grace window cancels it and reports online;
    // binding an already-online seat only transfers ownership.
    restoreOnline(state);
  }

  function tokenUnbound(connectionId: string): void {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      return;
    }
    detachToken(connection);
  }

  return {
    connectionOpened,
    connectionClosed,
    pongReceived,
    tokenBound,
    tokenUnbound,
  };
}
