import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  OFFLINE_DETECT_MS,
  RECONNECT_GRACE_MS,
  type PlayerToken,
  type PresenceController,
  type PresenceRoomManager,
  type PresenceSocket,
  type RoomDelivery,
} from '../../server/room/contracts';
import {
  createPresenceController,
  type PresenceClock,
  type PresenceControllerOptions,
} from '../../server/room/presence';

const TOKEN = 'token-a';
const OFFLINE_CALL = `presence:${TOKEN}:offline`;
const ONLINE_CALL = `presence:${TOKEN}:online`;
const GRACE_CALL = `grace:${TOKEN}`;

/** One room message a `graceExpired` command could produce. */
const GRACE_DELIVERY: RoomDelivery = {
  playerToken: TOKEN,
  message: {
    type: 'room_closed',
    roomId: 'room-1',
    seq: 7,
    reason: 'grace-expired',
    finalState: 'dissolved',
  },
};

interface FakePresenceManager extends PresenceRoomManager {
  /** Ordered record of every room command presence issued. */
  readonly calls: string[];
}

interface FakeManagerResults {
  /** Deliveries returned by every `setPresence` command. */
  readonly presenceDeliveries?: readonly RoomDelivery[];
  /** Deliveries returned by `graceExpired`; defaults to one message. */
  readonly graceDeliveries?: readonly RoomDelivery[];
}

/**
 * Minimal room manager double.
 *
 * Presence must go through this seam and nowhere else, so the recorded calls
 * are the complete observable effect of the controller on the room layer. A
 * test may script the deliveries so the sink hand-off and the empty-result
 * contract can be asserted without a real room table.
 */
function createFakeManager(results: FakeManagerResults = {}): FakePresenceManager {
  const calls: string[] = [];
  const presenceDeliveries = results.presenceDeliveries ?? [];
  const graceDeliveries = results.graceDeliveries ?? [GRACE_DELIVERY];
  return {
    calls,
    setPresence(playerToken, presence) {
      calls.push(`presence:${playerToken}:${presence}`);
      return { ok: true, deliveries: presenceDeliveries };
    },
    graceExpired(playerToken) {
      calls.push(`grace:${playerToken}`);
      return { ok: true, deliveries: graceDeliveries };
    },
  };
}

interface FakePresenceSocket extends PresenceSocket {
  /** Number of application-level pings sent through this socket. */
  pingCount: number;
}

function createFakeSocket(): FakePresenceSocket {
  const socket: FakePresenceSocket = {
    pingCount: 0,
    ping() {
      socket.pingCount += 1;
    },
  };
  return socket;
}

type HarnessOptions = Partial<Omit<PresenceControllerOptions, 'manager' | 'deliver'>>;

interface HarnessOptionsWithManager extends HarnessOptions {
  /** Optional scripted manager double. */
  readonly manager?: FakePresenceManager;
}

interface PresenceHarness {
  readonly manager: FakePresenceManager;
  /** Every delivery array handed to the sink (grace results included). */
  readonly delivered: (readonly RoomDelivery[])[];
  readonly controller: PresenceController;
  readonly open: (connectionId: string) => FakePresenceSocket;
}

function createHarness(overrides: HarnessOptionsWithManager = {}): PresenceHarness {
  const { manager: managerOverride, ...controllerOptions } = overrides;
  const manager = managerOverride ?? createFakeManager();
  const delivered: (readonly RoomDelivery[])[] = [];
  const controller = createPresenceController({
    manager,
    deliver(deliveries) {
      delivered.push(deliveries);
    },
    ...controllerOptions,
  });
  return {
    manager,
    delivered,
    controller,
    open(connectionId: string) {
      const socket = createFakeSocket();
      controller.connectionOpened(connectionId, socket);
      return socket;
    },
  };
}

/** Bind a freshly opened connection to the shared test seat token. */
function openBound(
  harness: PresenceHarness,
  connectionId: string,
  token: PlayerToken = TOKEN,
): FakePresenceSocket {
  const socket = harness.open(connectionId);
  harness.controller.tokenBound(connectionId, token);
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('online presence controller', () => {
  it('pings once per heartbeat interval and stops on close', () => {
    const harness = createHarness();
    const socket = harness.open('conn-1');

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(socket.pingCount).toBe(0);

    vi.advanceTimersByTime(1);
    expect(socket.pingCount).toBe(1);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(socket.pingCount).toBe(2);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(socket.pingCount).toBe(3);

    // No token is bound, so a quiet connection has no seat presence to report.
    expect(harness.manager.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    harness.controller.connectionClosed('conn-1');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(socket.pingCount).toBe(3);
    expect(harness.manager.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('marks the seat offline exactly 10 s after two unanswered beats', () => {
    const harness = createHarness();
    const socket = openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS - 1);
    expect(socket.pingCount).toBe(1);
    expect(harness.manager.calls).toEqual([]);
    expect(harness.delivered).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(socket.pingCount).toBe(2);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);
    expect(harness.delivered).toEqual([]);
    // The heartbeat and the grace deadline are the only live timers left.
    expect(vi.getTimerCount()).toBe(2);
  });

  it('starts a 15 s grace on detection and reports its deliveries exactly once', () => {
    const harness = createHarness();
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);
    expect(harness.delivered).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, GRACE_CALL]);
    expect(harness.delivered).toEqual([[GRACE_DELIVERY]]);

    // The socket stays open and keeps beating, but the token is resolved: no
    // duplicate offline transition or second expiry is produced.
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 4);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, GRACE_CALL]);
    expect(harness.delivered).toHaveLength(1);
  });

  it('cancels the grace when the same token reconnects and returns it online', () => {
    const harness = createHarness();
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    // Halfway through the grace window, a replacement connection binds the
    // token: the window is cancelled and the seat is online again.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const replacement = openBound(harness, 'conn-2');
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, ONLINE_CALL]);

    // Closing the replaced socket must not restart the window for the token.
    harness.controller.connectionClosed('conn-1');

    // Keep the replacement answered while the original window would elapse.
    for (let beat = 0; beat < 6; beat += 1) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      harness.controller.pongReceived('conn-2');
    }

    expect(harness.manager.calls).toEqual([OFFLINE_CALL, ONLINE_CALL]);
    expect(harness.delivered).toEqual([]);
    expect(replacement.pingCount).toBe(6);
  });

  it('cancels the grace when a replacement binds after the old socket closed', () => {
    const harness = createHarness();
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    // The transport may close the replaced socket before the new connection
    // binds; that ordering must not consume the grace window.
    harness.controller.connectionClosed('conn-1');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    openBound(harness, 'conn-2');
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, ONLINE_CALL]);

    // Keep the replacement answered until the original window (t = 25 s) has
    // certainly elapsed; a missed cancellation would surface here.
    for (let beat = 0; beat < 3; beat += 1) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      harness.controller.pongReceived('conn-2');
    }
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, ONLINE_CALL]);
    expect(harness.delivered).toEqual([]);
  });

  it('keeps the grace across an unbind that precedes the replacement bind', () => {
    const harness = createHarness();
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    // `tokenUnbound` is also how the transport announces a replacement; the
    // seat is still offline in its window until the new connection binds. The
    // heartbeat and the preserved grace are the two live timers here.
    harness.controller.tokenUnbound('conn-1');
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);
    expect(vi.getTimerCount()).toBe(2);

    openBound(harness, 'conn-2');
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, ONLINE_CALL]);

    harness.controller.connectionClosed('conn-1');
    for (let beat = 0; beat < 3; beat += 1) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      harness.controller.pongReceived('conn-2');
    }
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, ONLINE_CALL]);
    expect(harness.delivered).toEqual([]);
  });

  it('does not start a grace when the seat is explicitly unbound', () => {
    const harness = createHarness();
    openBound(harness, 'conn-1');

    harness.controller.tokenUnbound('conn-1');
    vi.advanceTimersByTime(OFFLINE_DETECT_MS + RECONNECT_GRACE_MS);

    // `leave` releases the seat in the room layer; presence must not invent an
    // offline transition or a grace for a token the transport already dropped.
    expect(harness.manager.calls).toEqual([]);
    expect(harness.delivered).toEqual([]);
  });

  it('does not reopen a grace when a replaced connection closes while online', () => {
    const harness = createHarness();
    const oldSocket = openBound(harness, 'conn-1');

    openBound(harness, 'conn-2');
    harness.controller.connectionClosed('conn-1');

    for (let beat = 0; beat < 4; beat += 1) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      harness.controller.pongReceived('conn-2');
    }

    expect(harness.manager.calls).toEqual([]);
    expect(harness.delivered).toEqual([]);
    // The replaced socket was closed before its first beat and never pinged.
    expect(oldSocket.pingCount).toBe(0);
    // Only the replacement's heartbeat is still scheduled.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('resets the miss streak on a pong instead of accumulating misses', () => {
    const harness = createHarness();
    const socket = openBound(harness, 'conn-1');

    // First beat answered: no offline transition.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    harness.controller.pongReceived('conn-1');
    expect(harness.manager.calls).toEqual([]);

    // One unanswered beat is below the threshold.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(harness.manager.calls).toEqual([]);

    // The second consecutive unanswered beat detects offline.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);
    expect(socket.pingCount).toBe(3);
  });

  it('keeps duplicate pongs, closes and expiries idempotent', () => {
    const harness = createHarness();
    openBound(harness, 'conn-1');

    harness.controller.pongReceived('conn-1');
    harness.controller.pongReceived('conn-1');
    expect(harness.manager.calls).toEqual([]);

    harness.controller.connectionClosed('conn-1');
    harness.controller.connectionClosed('conn-1');
    harness.controller.pongReceived('conn-1');
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    harness.controller.connectionClosed('conn-1');
    harness.controller.pongReceived('conn-1');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);

    expect(harness.manager.calls).toEqual([OFFLINE_CALL, GRACE_CALL]);
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered).toEqual([[GRACE_DELIVERY]]);
  });

  it('keeps the grace running when a late pong arrives after detection', () => {
    const harness = createHarness();
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    // A pong resets the miss streak, but it is not the recovery path: only a
    // token bind cancels the window, so the seat stays offline.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    harness.controller.pongReceived('conn-1');
    harness.controller.pongReceived('conn-1');
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    // The original window still lapses exactly once at t = 25 s.
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, GRACE_CALL]);
    expect(harness.delivered).toEqual([[GRACE_DELIVERY]]);
  });

  it('does not count pre-bind missed beats against the fresh seat', () => {
    const harness = createHarness();
    harness.open('conn-1');

    // One unanswered beat arrives before any token is bound.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(harness.manager.calls).toEqual([]);

    // Binding follows a client command, so the pre-seat miss is forgotten and
    // the next two beats are what detect offline.
    harness.controller.tokenBound('conn-1', TOKEN);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(harness.manager.calls).toEqual([]);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);
  });

  it('restarts the heartbeat when the transport reopens the same connection id', () => {
    const harness = createHarness();
    const first = harness.open('conn-1');
    harness.controller.tokenBound('conn-1', TOKEN);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(first.pingCount).toBe(1);

    const second = harness.open('conn-1');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    // The old interval is cleared, the new socket takes over the cadence and
    // the seat binding survives the transport retry.
    expect(second.pingCount).toBe(1);
    expect(first.pingCount).toBe(1);
    expect(harness.manager.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('ignores hooks for connections it never opened', () => {
    const harness = createHarness();

    harness.controller.tokenBound('missing', TOKEN);
    harness.controller.tokenUnbound('missing');
    harness.controller.pongReceived('missing');
    harness.controller.connectionClosed('missing');
    vi.advanceTimersByTime(OFFLINE_DETECT_MS + RECONNECT_GRACE_MS);

    expect(harness.manager.calls).toEqual([]);
    expect(harness.delivered).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid timing options', () => {
    expect(() => createHarness({ heartbeatIntervalMs: 0 })).toThrow(RangeError);
    expect(() => createHarness({ missedBeatsThreshold: 0 })).toThrow(RangeError);
    expect(() => createHarness({ graceMs: Number.NaN })).toThrow(RangeError);
  });

  it('forwards non-empty setPresence deliveries to the sink', () => {
    const harness = createHarness({
      manager: createFakeManager({ presenceDeliveries: [GRACE_DELIVERY] }),
    });
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);
    expect(harness.delivered).toEqual([[GRACE_DELIVERY]]);
  });

  it('hands an empty graceExpired result to the sink exactly once', () => {
    const harness = createHarness({
      manager: createFakeManager({ graceDeliveries: [] }),
    });
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(OFFLINE_DETECT_MS + RECONNECT_GRACE_MS);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, GRACE_CALL]);
    expect(harness.delivered).toEqual([[]]);

    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(harness.delivered).toEqual([[]]);
  });

  it('runs on an injected clock, timers and timing thresholds', () => {
    const scheduledDelays: number[] = [];
    let nowCalls = 0;
    const clock: PresenceClock = {
      now() {
        nowCalls += 1;
        return Date.now();
      },
      setTimeout(callback, delayMs) {
        scheduledDelays.push(delayMs);
        return setTimeout(callback, delayMs);
      },
      clearTimeout(handle) {
        clearTimeout(handle);
      },
      setInterval(callback, intervalMs) {
        scheduledDelays.push(intervalMs);
        return setInterval(callback, intervalMs);
      },
      clearInterval(handle) {
        clearInterval(handle);
      },
    };
    const harness = createHarness({
      clock,
      heartbeatIntervalMs: 1_000,
      missedBeatsThreshold: 3,
      graceMs: 2_000,
    });
    openBound(harness, 'conn-1');

    vi.advanceTimersByTime(2_999);
    expect(harness.manager.calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    vi.advanceTimersByTime(1_999);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL]);

    vi.advanceTimersByTime(1);
    expect(harness.manager.calls).toEqual([OFFLINE_CALL, GRACE_CALL]);
    expect(harness.delivered).toEqual([[GRACE_DELIVERY]]);

    // The injected scheduler saw the interval and the grace deadline, and the
    // injected clock stamped each unanswered heartbeat (the record is capped at
    // the three-beat threshold).
    expect(scheduledDelays).toContain(1_000);
    expect(scheduledDelays).toContain(2_000);
    expect(nowCalls).toBe(3);
  });
});
