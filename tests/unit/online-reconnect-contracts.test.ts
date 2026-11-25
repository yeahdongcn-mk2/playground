import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSED_BEATS,
  MATCH_TIMEOUT_MS,
  OFFLINE_DETECT_MS,
  RECONNECT_GRACE_MS,
  TURN_TIMEOUT_MS,
  type PresenceController,
  type PresenceRoomManager,
  type PresenceSocket,
  type RoomCommandResult,
} from '../../server/room/contracts';
import type { PlayerPresence, RoomState } from '../../src/games/minesweeper/online/index';

/** Compile-time assertion helper: the type argument must be exactly `true`. */
type Assert<T extends true> = T;
type IsAssignable<A, B> = A extends B ? true : false;

/**
 * Presence is a connection-layer value. Checking each literal (rather than
 * the whole `PlayerPresence` union) means adding even one of `online` /
 * `reconnecting` / `offline` to the lifecycle union breaks the build instead
 * of slipping through because the other two are still absent.
 */
type IsNotRoomState<T extends string> = IsAssignable<T, RoomState> extends true ? false : true;
type PresenceIsNotRoomState = Assert<
  [
    IsNotRoomState<'online'>,
    IsNotRoomState<'reconnecting'>,
    IsNotRoomState<'offline'>,
  ] extends [true, true, true]
    ? true
    : false
>;

/**
 * Both room-layer presence commands must answer with the unified command
 * result the transport already knows how to deliver.
 */
type PresenceRoomCommandsReturnRoomCommandResult = Assert<
  IsAssignable<ReturnType<PresenceRoomManager['setPresence']>, RoomCommandResult> &
    IsAssignable<ReturnType<PresenceRoomManager['graceExpired']>, RoomCommandResult>
>;

/** Connection-layer hooks are fire-and-forget; they never return deliveries. */
type PresenceControllerHooksReturnVoid = Assert<
  IsAssignable<ReturnType<PresenceController['connectionOpened']>, void> &
    IsAssignable<ReturnType<PresenceController['connectionClosed']>, void> &
    IsAssignable<ReturnType<PresenceController['pongReceived']>, void> &
    IsAssignable<ReturnType<PresenceController['tokenBound']>, void> &
    IsAssignable<ReturnType<PresenceController['tokenUnbound']>, void>
>;

// Referencing the aliases keeps them checked without exporting test-only types.
const presenceIsNotRoomState: PresenceIsNotRoomState = true;
const roomCommandsReturnRoomCommandResult: PresenceRoomCommandsReturnRoomCommandResult = true;
const controllerHooksReturnVoid: PresenceControllerHooksReturnVoid = true;

const ROOM_STATES: readonly RoomState[] = [
  'idle',
  'waiting',
  'ready',
  'playing',
  'finished',
  'dissolved',
];

const PRESENCE_VALUES: readonly PlayerPresence[] = ['online', 'reconnecting', 'offline'];

interface FakePresenceSocket extends PresenceSocket {
  /** Connection ids pinged through this socket, for assertions. */
  readonly pings: string[];
}

function createFakeSocket(connectionId: string): FakePresenceSocket {
  const pings: string[] = [];
  return {
    pings,
    ping() {
      pings.push(connectionId);
    },
  };
}

/** A successful command result with nothing to deliver. */
function emptySuccess(): RoomCommandResult {
  return { ok: true, deliveries: [] };
}

interface FakeController extends PresenceController {
  readonly calls: string[];
}

/**
 * Minimal fake of the connection-layer contract.
 *
 * The transport would wire these hooks to its socket lifecycle; the fake only
 * records the calls and pings, which proves the interface is implementable
 * without a real WebSocket or timers.
 */
function createFakeController(): FakeController {
  const calls: string[] = [];
  return {
    calls,
    connectionOpened(connectionId, socket) {
      calls.push(`opened:${connectionId}`);
      socket.ping();
    },
    connectionClosed(connectionId) {
      calls.push(`closed:${connectionId}`);
    },
    pongReceived(connectionId) {
      calls.push(`pong:${connectionId}`);
    },
    tokenBound(connectionId, playerToken) {
      calls.push(`bound:${connectionId}:${playerToken}`);
    },
    tokenUnbound(connectionId) {
      calls.push(`unbound:${connectionId}`);
    },
  };
}

interface FakeRoomManager extends PresenceRoomManager {
  readonly calls: string[];
}

/** Minimal fake of the room-layer contract; every command succeeds empty-handed. */
function createFakeRoomManager(): FakeRoomManager {
  const calls: string[] = [];
  function record(call: string): RoomCommandResult {
    calls.push(call);
    return emptySuccess();
  }
  return {
    calls,
    setPresence(playerToken, presence) {
      return record(`presence:${playerToken}:${presence}`);
    },
    graceExpired(playerToken) {
      return record(`grace:${playerToken}`);
    },
  };
}

describe('online reconnect contracts', () => {
  it('pins the heartbeat, detection and grace values from design 5.1/5.2', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(HEARTBEAT_MISSED_BEATS).toBe(2);
    expect(OFFLINE_DETECT_MS).toBe(10_000);
    expect(RECONNECT_GRACE_MS).toBe(15_000);
    expect(TURN_TIMEOUT_MS).toBe(30_000);
    expect(MATCH_TIMEOUT_MS).toBe(900_000);
  });

  it('keeps offline detection, grace, turn and match deadlines strictly ordered', () => {
    // Two missed 5 s beats is the 10 s detection threshold; it must stay
    // shorter than the grace window so detection can start the grace timer.
    expect(OFFLINE_DETECT_MS).toBe(HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSED_BEATS);
    expect(OFFLINE_DETECT_MS).toBeLessThan(RECONNECT_GRACE_MS);
    // The grace window must end before the 30 s turn forfeit, which in turn
    // must be far tighter than the 15 min hard match cap.
    expect(RECONNECT_GRACE_MS).toBeLessThan(TURN_TIMEOUT_MS);
    expect(TURN_TIMEOUT_MS).toBeLessThan(MATCH_TIMEOUT_MS);
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(MATCH_TIMEOUT_MS);
  });

  it('keeps presence out of RoomState', () => {
    expect(presenceIsNotRoomState).toBe(true);
    expect(ROOM_STATES).toHaveLength(6);
    expect(new Set(ROOM_STATES).size).toBe(ROOM_STATES.length);
    expect(PRESENCE_VALUES).toHaveLength(3);
    for (const presence of PRESENCE_VALUES) {
      expect(ROOM_STATES as readonly string[]).not.toContain(presence);
    }
  });

  it('lets the transport implement PresenceController with a ping-only socket', () => {
    const fake = createFakeController();
    const controller: PresenceController = fake;
    const socket = createFakeSocket('conn-1');

    // `PresenceSocket` only demands a ping capability, so the transport does
    // not have to expose close/error handling to the presence layer.
    let pingOnlyCount = 0;
    const socketWithPingOnly: PresenceSocket = {
      ping() {
        pingOnlyCount += 1;
      },
    };

    const opened: void = controller.connectionOpened('conn-1', socket);
    controller.tokenBound('conn-1', 'token-a');
    controller.pongReceived('conn-1');
    const unbound: void = controller.tokenUnbound('conn-1');
    const closed: void = controller.connectionClosed('conn-1');
    controller.connectionOpened('conn-2', socketWithPingOnly);

    expect(opened).toBeUndefined();
    expect(unbound).toBeUndefined();
    expect(closed).toBeUndefined();
    expect(socket.pings).toEqual(['conn-1']);
    expect(pingOnlyCount).toBe(1);
    expect(fake.calls).toEqual([
      'opened:conn-1',
      'bound:conn-1:token-a',
      'pong:conn-1',
      'unbound:conn-1',
      'closed:conn-1',
      'opened:conn-2',
    ]);
  });

  it('lets the room manager implement PresenceRoomManager as serialized commands', () => {
    const fake = createFakeRoomManager();
    const manager: PresenceRoomManager = fake;

    const online: RoomCommandResult = manager.setPresence('token-a', 'online');
    const reconnecting: RoomCommandResult = manager.setPresence('token-a', 'reconnecting');
    const offline: RoomCommandResult = manager.setPresence('token-a', 'offline');
    const expired: RoomCommandResult = manager.graceExpired('token-a');

    for (const result of [online, reconnecting, offline, expired]) {
      expect(result).toEqual({ ok: true, deliveries: [] });
    }
    expect(fake.calls).toEqual([
      'presence:token-a:online',
      'presence:token-a:reconnecting',
      'presence:token-a:offline',
      'grace:token-a',
    ]);
    expect(roomCommandsReturnRoomCommandResult).toBe(true);
    expect(controllerHooksReturnVoid).toBe(true);
  });
});
