import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSED_BEATS,
  MATCH_TIMEOUT_MS,
  OFFLINE_DETECT_MS,
  RECONNECT_GRACE_MS,
  ROOM_CAPACITY,
  TURN_TIMEOUT_MS,
  type MatchCommandResult,
  type PlayerToken,
  type RoomCommandResult,
  type RoomCommandSuccess,
  type RoomConnection,
  type RoomDelivery,
} from '../../server/room/contracts';
import {
  createPresenceController,
  type PresenceControllerHandle,
} from '../../server/room/presence';
import {
  createDeadlineScheduler,
  type DeadlineScheduler,
} from '../../server/room/deadline-scheduler';
import {
  createRoomManager,
  type InMemoryRoomManager,
  type RoomManagerOptions,
} from '../../server/room/room-manager';
import {
  PROTOCOL_VERSION,
  type ActionMessage,
  type CreateMessage,
  type EndMessage,
  type JoinMessage,
  type PlayerPresence,
  type ReadyMessage,
  type RoomStateMessage,
  type ServerToClientMessage,
  type SnapshotMessage,
  type StartMessage,
  type TimeoutMessage,
  type TimeoutTimer,
} from '../../src/games/minesweeper/online/index';
import type {
  MinesweeperCell,
  MinesweeperConfig,
} from '../../src/games/minesweeper/engine';

const NOW = 1_700_000_000_000;
const SEED = 7;

const CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

/** Only the room-manager options that do not change the test clock or seed. */
type HarnessOptions = Omit<RoomManagerOptions, 'now' | 'createSeed'>;

type CommandResult = RoomCommandResult | MatchCommandResult;

type CommandFailure =
  | Extract<RoomCommandResult, { readonly ok: false }>
  | Extract<MatchCommandResult, { readonly ok: false }>;

/** The socket surface the presence controller needs; no WebSocket involved. */
interface FakeSocket {
  pingCount: number;
  ping(): void;
}

/** One simulated transport connection with the messages it received. */
interface TestConnection {
  readonly id: string;
  readonly socket: FakeSocket;
  readonly messages: ServerToClientMessage[];
  token: PlayerToken | null;
  closed: boolean;
}

/**
 * Deterministic integration harness for #485.
 *
 * It wires the real presence controller, the real deadline scheduler and the
 * real in-memory room manager together the way `ws-server.ts` does: a room
 * command binds the returned token before its deliveries are sent, presence
 * deliveries go through the same sink, and every delivered batch re-arms the
 * deadlines of the rooms it mentions. The only fakes are the sockets (a ping
 * counter and a message list) and the environment timers, which Vitest fakes.
 *
 * A token has one owning connection, exactly like the transport registry: a
 * new connection binding an existing token replaces the old one, unbinds it and
 * closes its heartbeat before the new owner is registered.
 */
class ReconnectHarness {
  readonly manager: InMemoryRoomManager;
  readonly scheduler: DeadlineScheduler;
  readonly presence: PresenceControllerHandle;

  private readonly connections = new Map<string, TestConnection>();
  private readonly tokenOwners = new Map<PlayerToken, string>();
  private nextId = 0;

  constructor(options: HarnessOptions = {}) {
    this.manager = createRoomManager({
      createSeed: () => SEED,
      now: () => Date.now(),
      ...options,
    });
    this.scheduler = createDeadlineScheduler({
      manager: this.manager,
      deliver: (deliveries) => this.deliverBatch(deliveries),
    });
    this.presence = createPresenceController({
      manager: this.manager,
      deliver: (deliveries) => this.deliverBatch(deliveries),
    });
  }

  /** Open a simulated transport connection and start its heartbeat. */
  open(label: string): TestConnection {
    this.nextId += 1;
    const id = `${label}-${this.nextId}`;
    const socket: FakeSocket = {
      pingCount: 0,
      ping() {
        socket.pingCount += 1;
      },
    };
    const connection: TestConnection = {
      id,
      socket,
      messages: [],
      token: null,
      closed: false,
    };
    this.connections.set(id, connection);
    this.presence.connectionOpened(id, socket);
    return connection;
  }

  /** Model a clean transport close; presence remains the owner of the offline state. */
  close(connection: TestConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    const token = connection.token;
    if (token !== null && this.tokenOwners.get(token) === connection.id) {
      this.tokenOwners.delete(token);
    }
    this.presence.connectionClosed(connection.id);
  }

  /** Run a room command, bind its returned token, then deliver its messages. */
  command(
    connection: TestConnection,
    run: (roomConnection: RoomConnection) => CommandResult,
  ): CommandResult {
    const result = run({
      connectionId: connection.id,
      playerToken: connection.token,
    });
    if (result.ok) {
      if (result.boundToken !== undefined) {
        this.adoptToken(connection, result.boundToken);
      }
      this.deliverBatch(result.deliveries);
    }
    return result;
  }

  create(displayName = 'Ada'): { readonly host: TestConnection; readonly hostToken: PlayerToken; readonly roomId: string } {
    const host = this.open('host');
    const result = expectOk(
      this.command(host, (connection) => this.manager.create(connection, createMessage(displayName))),
    );
    return { host, hostToken: boundTokenOf(result), roomId: roomStateOf(result).roomId };
  }

  join(
    roomId: string,
    displayName = 'Grace',
  ): { readonly guest: TestConnection; readonly guestToken: PlayerToken } {
    const guest = this.open('guest');
    const result = expectOk(
      this.command(guest, (connection) =>
        this.manager.join(connection, joinMessage(roomId, displayName)),
      ),
    );
    return { guest, guestToken: boundTokenOf(result) };
  }

  /** Resume a seat with its original token from a new connection. */
  resume(roomId: string, playerToken: PlayerToken, displayName = 'Ada'): TestConnection {
    const connection = this.open('resume');
    expectOk(
      this.command(connection, (roomConnection) =>
        this.manager.join(roomConnection, joinMessage(roomId, displayName, playerToken)),
      ),
    );
    return connection;
  }

  ready(
    connection: TestConnection,
    roomId: string,
    ready = true,
  ): RoomCommandResult {
    return this.command(connection, (roomConnection) =>
      this.manager.ready(roomConnection, readyMessage(roomId, ready)),
    ) as RoomCommandResult;
  }

  start(connection: TestConnection, roomId: string): RoomCommandResult {
    return this.command(connection, (roomConnection) =>
      this.manager.start(roomConnection, startMessage(roomId)),
    ) as RoomCommandResult;
  }

  action(connection: TestConnection, message: ActionMessage): CommandResult {
    return this.command(connection, (roomConnection) =>
      this.manager.action(roomConnection, message),
    );
  }

  timeout(roomId: string, timer: TimeoutTimer): RoomCommandResult {
    return this.manager.timeout(roomId, timer);
  }

  /**
   * Advance the shared fake clock in heartbeat-sized steps.
   *
   * Connections passed in `keepAlive` answer every heartbeat they observe, so
   * tests can take exactly one player offline without accidentally timing the
   * other one out. Nothing here sleeps: `vi.advanceTimersByTime` runs the
   * presence, grace and scheduler callbacks synchronously.
   */
  advance(ms: number, keepAlive: readonly TestConnection[] = []): void {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(remaining, HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(step);
      remaining -= step;
      for (const connection of keepAlive) {
        if (!connection.closed) {
          this.presence.pongReceived(connection.id);
        }
      }
    }
  }

  /**
   * The transport's one-token-one-socket rule, minus the WebSocket close frame.
   *
   * The old connection is unbound before presence sees the close, so its close
   * event can neither start a grace window nor restart one for the new owner.
   */
  private adoptToken(connection: TestConnection, token: PlayerToken): void {
    const previousId = this.tokenOwners.get(token);
    if (previousId !== undefined && previousId !== connection.id) {
      const previous = this.connections.get(previousId);
      if (previous !== undefined && !previous.closed) {
        previous.token = null;
        previous.closed = true;
        this.tokenOwners.delete(token);
        this.presence.tokenUnbound(previous.id);
        this.presence.connectionClosed(previous.id);
      }
    }
    connection.token = token;
    this.tokenOwners.set(token, connection.id);
    this.presence.tokenBound(connection.id, token);
  }

  /** Send one batch and re-arm every room whose deadline the batch mentions. */
  private deliverBatch(deliveries: readonly RoomDelivery[]): void {
    const rooms = new Set<string>();
    for (const delivery of deliveries) {
      const ownerId = this.tokenOwners.get(delivery.playerToken);
      if (ownerId !== undefined) {
        const connection = this.connections.get(ownerId);
        if (connection !== undefined && !connection.closed) {
          connection.messages.push(delivery.message);
        }
      }
      if (delivery.message.roomId !== null) {
        rooms.add(delivery.message.roomId);
      }
    }
    for (const roomId of rooms) {
      this.scheduler.refresh(roomId);
    }
  }
}

interface SeatedRoom {
  readonly harness: ReconnectHarness;
  readonly roomId: string;
  readonly host: TestConnection;
  readonly guest: TestConnection;
  readonly hostToken: PlayerToken;
  readonly guestToken: PlayerToken;
  readonly hostId: string;
  readonly guestId: string;
}

interface PlayingRoom extends SeatedRoom {
  readonly matchId: string;
}

function createSeatedRoom(harness: ReconnectHarness): SeatedRoom {
  const created = harness.create();
  const joined = harness.join(created.roomId);
  const room = harness.manager.getRoom(created.roomId);
  if (room === undefined) {
    throw new Error('create/join must leave a live room');
  }
  const hostSeat = room.seats.find((seat) => seat.isHost);
  const guestSeat = room.seats.find((seat) => !seat.isHost);
  if (hostSeat === undefined || guestSeat === undefined) {
    throw new Error('the room must have a host and a guest seat');
  }
  return {
    harness,
    roomId: created.roomId,
    host: created.host,
    guest: joined.guest,
    hostToken: created.hostToken,
    guestToken: joined.guestToken,
    hostId: hostSeat.playerId,
    guestId: guestSeat.playerId,
  };
}

function createReadyRoom(harness: ReconnectHarness): SeatedRoom {
  const room = createSeatedRoom(harness);
  expectOk(harness.ready(room.host, room.roomId, true));
  expectOk(harness.ready(room.guest, room.roomId, true));
  expect(harness.manager.getRoom(room.roomId)?.state).toBe('ready');
  return room;
}

function createPlayingRoom(harness: ReconnectHarness): PlayingRoom {
  const room = createReadyRoom(harness);
  expectOk(harness.start(room.host, room.roomId));
  const match = harness.manager.getMatch(room.roomId);
  if (match === null) {
    throw new Error('start must create a match');
  }
  return { ...room, matchId: match.matchId };
}

function createMessage(displayName: string): CreateMessage {
  return {
    type: 'create',
    requestId: 'request-create',
    protocolVersion: PROTOCOL_VERSION,
    config: CONFIG,
    displayName,
  };
}

function joinMessage(
  roomId: string,
  displayName: string,
  playerToken?: PlayerToken,
): JoinMessage {
  return {
    type: 'join',
    requestId: 'request-join',
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    displayName,
    ...(playerToken === undefined ? {} : { playerToken }),
  };
}

function readyMessage(roomId: string, ready: boolean): ReadyMessage {
  return { type: 'ready', roomId, requestId: 'request-ready', ready };
}

function startMessage(roomId: string): StartMessage {
  return { type: 'start', roomId, requestId: 'request-start' };
}

function expectOk(result: CommandResult): RoomCommandSuccess {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.error.message}`);
  }
  return result;
}

function expectFailure(result: CommandResult): CommandFailure {
  if (result.ok) {
    throw new Error('expected a rejected command');
  }
  return result;
}

function boundTokenOf(result: RoomCommandSuccess): PlayerToken {
  if (result.boundToken === undefined) {
    throw new Error('create/join must bind the seat token');
  }
  return result.boundToken;
}

function roomStateOf(result: RoomCommandSuccess): RoomStateMessage {
  const message = result.deliveries[0]?.message;
  if (message?.type !== 'room_state') {
    throw new Error('expected a room_state delivery');
  }
  return message;
}

/** Every message of one type, keeping the wire union narrowed. */
function messagesOfType<T extends ServerToClientMessage['type']>(
  messages: readonly ServerToClientMessage[],
  type: T,
): Extract<ServerToClientMessage, { readonly type: T }>[] {
  return messages.filter(
    (message): message is Extract<ServerToClientMessage, { readonly type: T }> =>
      message.type === type,
  );
}

function presenceOf(
  manager: InMemoryRoomManager,
  roomId: string,
  playerToken: PlayerToken,
): PlayerPresence | undefined {
  return manager
    .getRoom(roomId)
    ?.seats.find((seat) => seat.playerToken === playerToken)?.presence;
}

/** The room and match deadlines that reconnect/presence must never move. */
function deadlinesOf(manager: InMemoryRoomManager, roomId: string): {
  readonly joinDeadlineAt: number;
  readonly roomDeadlineAt: number | null;
  readonly turnDeadlineAt: number | null;
  readonly matchDeadlineAt: number | null;
} {
  const room = manager.getRoom(roomId);
  if (room === undefined) {
    throw new Error(`room ${roomId} is not live`);
  }
  const match = manager.getMatch(roomId);
  return {
    joinDeadlineAt: room.joinDeadlineAt,
    roomDeadlineAt: room.deadlineAt,
    turnDeadlineAt: match?.state.turnDeadlineAt ?? null,
    matchDeadlineAt: match?.state.matchDeadlineAt ?? null,
  };
}

function roomSequence(manager: InMemoryRoomManager, roomId: string): number {
  const room = manager.getRoom(roomId);
  if (room === undefined) {
    throw new Error(`room ${roomId} is not live`);
  }
  return room.seq;
}

/** Current room/match turn data used to build a valid action. */
function actionFor(
  manager: InMemoryRoomManager,
  roomId: string,
  overrides: Partial<ActionMessage> = {},
): ActionMessage {
  const room = manager.getRoom(roomId);
  const match = manager.getMatch(roomId);
  if (room === undefined || room.matchId === null || match === null) {
    throw new Error(`room ${roomId} has no running match`);
  }
  return {
    type: 'action',
    roomId,
    matchId: match.matchId,
    actionId: `action_${room.seq + 1}`,
    seq: room.seq,
    turnId: match.state.turnId,
    kind: 'reveal',
    row: 0,
    col: 0,
    clientTimeMs: Date.now(),
    ...overrides,
  };
}

/** First hidden, unflagged safe cell: safe to reveal without ending the match. */
function firstHiddenSafeCell(
  manager: InMemoryRoomManager,
  roomId: string,
): MinesweeperCell {
  const match = manager.getMatch(roomId);
  if (match === null) {
    throw new Error('expected a match');
  }
  const cell = match.state.engine.state.board
    .flat()
    .find((candidate) => !candidate.revealed && !candidate.flagged && !candidate.mine);
  if (cell === undefined) {
    throw new Error('expected a hidden safe cell');
  }
  return cell;
}

function firstSnapshot(connection: TestConnection): SnapshotMessage {
  const snapshot = messagesOfType(connection.messages, 'snapshot')[0];
  if (snapshot === undefined) {
    throw new Error('expected a snapshot delivery');
  }
  return snapshot;
}

function firstEnd(connection: TestConnection): EndMessage {
  const end = messagesOfType(connection.messages, 'end')[0];
  if (end === undefined) {
    throw new Error('expected an end delivery');
  }
  return end;
}

function firstTimeout(connection: TestConnection): TimeoutMessage {
  const timeout = messagesOfType(connection.messages, 'timeout')[0];
  if (timeout === undefined) {
    throw new Error('expected a timeout delivery');
  }
  return timeout;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('online reconnect and timeout acceptance (#485)', () => {
  it('pins the design thresholds and their strict ordering', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(HEARTBEAT_MISSED_BEATS).toBe(2);
    expect(OFFLINE_DETECT_MS).toBe(10_000);
    expect(RECONNECT_GRACE_MS).toBe(15_000);
    expect(TURN_TIMEOUT_MS).toBe(30_000);
    expect(MATCH_TIMEOUT_MS).toBe(15 * 60 * 1_000);

    expect(OFFLINE_DETECT_MS).toBe(HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSED_BEATS);
    expect(OFFLINE_DETECT_MS).toBeLessThan(RECONNECT_GRACE_MS);
    expect(RECONNECT_GRACE_MS).toBeLessThan(TURN_TIMEOUT_MS);
    expect(TURN_TIMEOUT_MS).toBeLessThan(MATCH_TIMEOUT_MS);
  });

  it('pings every 5 s and marks a seat offline only after two missed beats', () => {
    const harness = new ReconnectHarness();
    const room = createSeatedRoom(harness);
    const joinDeadlineAt = deadlinesOf(harness.manager, room.roomId).joinDeadlineAt;
    const seqBefore = roomSequence(harness.manager, room.roomId);

    harness.advance(HEARTBEAT_INTERVAL_MS, [room.host]);
    expect(room.guest.socket.pingCount).toBe(1);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('online');

    harness.advance(OFFLINE_DETECT_MS - HEARTBEAT_INTERVAL_MS - 1, [room.host]);
    expect(room.guest.socket.pingCount).toBe(1);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('online');

    harness.advance(1, [room.host]);
    expect(room.guest.socket.pingCount).toBe(2);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('offline');

    // Heartbeat is connection state: no seq bump, no timeout, no deadline move.
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore);
    expect(deadlinesOf(harness.manager, room.roomId).joinDeadlineAt).toBe(joinDeadlineAt);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('waiting');
    expect(messagesOfType(room.host.messages, 'timeout')).toHaveLength(0);

    harness.advance(HEARTBEAT_INTERVAL_MS, [room.host]);
    expect(room.guest.socket.pingCount).toBe(3);
    expect(harness.manager.getRoom(room.roomId)?.seats).toHaveLength(ROOM_CAPACITY);
  });

  it('releases a waiting guest seat after the 15 s grace and invalidates its token', () => {
    const harness = new ReconnectHarness();
    const room = createSeatedRoom(harness);
    const seqBefore = roomSequence(harness.manager, room.roomId);

    harness.advance(OFFLINE_DETECT_MS, [room.host]);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('offline');

    harness.advance(RECONNECT_GRACE_MS - 1, [room.host]);
    expect(harness.manager.getRoom(room.roomId)?.seats).toHaveLength(ROOM_CAPACITY);

    harness.advance(1, [room.host]);
    const released = harness.manager.getRoom(room.roomId);
    expect(released?.state).toBe('waiting');
    expect(released?.seats).toHaveLength(1);
    expect(released?.stateReason).toBe('grace-expired');
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore + 1);

    const reconnect = expectFailure(
      harness.command(room.guest, (connection) =>
        harness.manager.join(connection, joinMessage(room.roomId, 'Grace', room.guestToken)),
      ),
    );
    expect(reconnect.code).toBe('not-in-room');
    expect(harness.manager.getRoom(room.roomId)?.seats).toHaveLength(1);

    // The freed seat is still fillable by a fresh join.
    const replacement = harness.join(room.roomId, 'New Guest');
    expect(harness.manager.getRoom(room.roomId)?.seats).toHaveLength(ROOM_CAPACITY);
    expect(replacement.guestToken).not.toBe(room.guestToken);
  });

  it('returns a ready room to waiting when the guest grace runs out', () => {
    const harness = new ReconnectHarness();
    const room = createReadyRoom(harness);
    const seqBefore = roomSequence(harness.manager, room.roomId);

    harness.advance(OFFLINE_DETECT_MS, [room.host]);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('offline');

    harness.advance(RECONNECT_GRACE_MS, [room.host]);
    const waiting = harness.manager.getRoom(room.roomId);
    expect(waiting?.state).toBe('waiting');
    expect(waiting?.seats).toHaveLength(1);
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore + 1);

    const reconnect = expectFailure(
      harness.command(room.guest, (connection) =>
        harness.manager.join(connection, joinMessage(room.roomId, 'Grace', room.guestToken)),
      ),
    );
    expect(reconnect.code).toBe('not-in-room');
  });

  it.each(['waiting', 'ready'] as const)(
    'dissolves a %s room when the host grace expires',
    (state) => {
      const harness = new ReconnectHarness();
      const room =
        state === 'waiting' ? createSeatedRoom(harness) : createReadyRoom(harness);
      expect(harness.manager.getRoom(room.roomId)?.state).toBe(state);

      harness.advance(OFFLINE_DETECT_MS, [room.guest]);
      expect(presenceOf(harness.manager, room.roomId, room.hostToken)).toBe('offline');

      harness.advance(RECONNECT_GRACE_MS, [room.guest]);
      expect(harness.manager.getRoom(room.roomId)).toBeUndefined();
      expect(harness.scheduler.scheduledRoomCount).toBe(0);

      for (const connection of [room.host, room.guest]) {
        const closed = messagesOfType(connection.messages, 'room_closed');
        expect(closed).toHaveLength(1);
        expect(closed[0]?.finalState).toBe('dissolved');
        expect(closed[0]?.reason).toBe('host-grace-expired');
      }

      const reconnect = expectFailure(
        harness.command(room.host, (connection) =>
          harness.manager.join(connection, joinMessage(room.roomId, 'Ada', room.hostToken)),
        ),
      );
      expect(reconnect.code).toBe('room-not-found');
    },
  );

  it('forfeits a current-turn player at grace expiry and emits one terminal result', () => {
    const harness = new ReconnectHarness();
    const room = createPlayingRoom(harness);
    expect(harness.manager.getRoom(room.roomId)?.turnPlayerId).toBe(room.hostId);
    const before = deadlinesOf(harness.manager, room.roomId);
    const seqBefore = roomSequence(harness.manager, room.roomId);

    harness.advance(OFFLINE_DETECT_MS - 1, [room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('playing');

    harness.advance(1, [room.guest]);
    expect(presenceOf(harness.manager, room.roomId, room.hostToken)).toBe('offline');
    expect(deadlinesOf(harness.manager, room.roomId)).toEqual(before);
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore);

    harness.advance(RECONNECT_GRACE_MS - 1, [room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('playing');

    harness.advance(1, [room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');

    const timeout = firstTimeout(room.guest);
    expect(timeout.timer).toBe('turn');
    expect(timeout.subjectId).toBe(room.hostId);
    expect(timeout.deadlineAt).toBe(NOW + TURN_TIMEOUT_MS);
    expect(timeout.resultingState).toBe('finished');
    expect(timeout.reason).toBe('turn-timeout');

    const end = firstEnd(room.guest);
    expect(end.reason).toBe('turn-timeout');
    expect(end.winnerId).toBe(room.guestId);
    expect(end.loserId).toBe(room.hostId);

    // A repeated timeout cannot produce a second terminal result.
    expectFailure(harness.timeout(room.roomId, 'turn'));
    const hostMessages = room.host.messages.length;
    const guestMessages = room.guest.messages.length;
    harness.advance(TURN_TIMEOUT_MS, [room.guest]);
    expect(room.host.messages).toHaveLength(hostMessages);
    expect(room.guest.messages).toHaveLength(guestMessages);
    expect(messagesOfType(room.guest.messages, 'timeout')).toHaveLength(1);
    expect(messagesOfType(room.guest.messages, 'end')).toHaveLength(1);
  });

  it('resumes a playing seat with a full current-seq snapshot and no offline action replay', () => {
    const harness = new ReconnectHarness();
    const room = createPlayingRoom(harness);

    harness.advance(OFFLINE_DETECT_MS, [room.host]);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('offline');

    // The opponent keeps playing while the guest is offline; the guest misses
    // this action, and the resume must show its effect in the snapshot only.
    harness.advance(HEARTBEAT_INTERVAL_MS, [room.host]);
    const cell = firstHiddenSafeCell(harness.manager, room.roomId);
    expectOk(
      harness.action(
        room.host,
        actionFor(harness.manager, room.roomId, { row: cell.row, col: cell.col }),
      ),
    );
    const actionSeq = roomSequence(harness.manager, room.roomId);
    const actionDeadlines = deadlinesOf(harness.manager, room.roomId);
    expect(harness.manager.getRoom(room.roomId)?.turnPlayerId).toBe(room.guestId);

    harness.advance(HEARTBEAT_INTERVAL_MS, [room.host]);
    const resumed = harness.resume(room.roomId, room.guestToken);

    expect(room.guest.closed).toBe(true);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('online');
    expect(roomSequence(harness.manager, room.roomId)).toBe(actionSeq);
    expect(deadlinesOf(harness.manager, room.roomId)).toEqual(actionDeadlines);

    // One room_state for the resuming seat and one full snapshot; the missed
    // action_result is not replayed (the board effect arrives via the snapshot).
    expect(resumed.messages.map((message) => message.type)).toEqual([
      'room_state',
      'snapshot',
    ]);
    expect(messagesOfType(resumed.messages, 'action_result')).toHaveLength(0);
    const snapshot = firstSnapshot(resumed);
    expect(snapshot.seq).toBe(actionSeq);
    expect(snapshot.turnPlayerId).toBe(room.guestId);
    expect(snapshot.deadlineAt).toBe(actionDeadlines.turnDeadlineAt);
    expect(snapshot.matchDeadlineAt).toBe(actionDeadlines.matchDeadlineAt);
    expect(snapshot.board[cell.row]?.[cell.col]?.revealed).toBe(true);

    const hostState = messagesOfType(room.host.messages, 'room_state').at(-1);
    expect(hostState?.seq).toBe(actionSeq);
    expect(hostState?.players.every((player) => player.presence === 'online')).toBe(true);

    // 25 s after the last heartbeat the cancelled grace would have lapsed; the
    // resumed seat keeps the room alive and the original deadlines intact.
    const seqAfterResume = roomSequence(harness.manager, room.roomId);
    harness.advance(HEARTBEAT_INTERVAL_MS, [room.host, resumed]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('playing');
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqAfterResume);
  });

  it('keeps a non-current offline seat through grace until its turn times out', () => {
    const harness = new ReconnectHarness();
    const room = createPlayingRoom(harness);
    const seqBefore = roomSequence(harness.manager, room.roomId);

    harness.advance(OFFLINE_DETECT_MS, [room.host]);
    expect(presenceOf(harness.manager, room.roomId, room.guestToken)).toBe('offline');

    harness.advance(RECONNECT_GRACE_MS, [room.host]);
    const retained = harness.manager.getRoom(room.roomId);
    expect(retained?.state).toBe('playing');
    expect(retained?.seats).toHaveLength(ROOM_CAPACITY);
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore);
    expect(messagesOfType(room.host.messages, 'timeout')).toHaveLength(0);

    // The host hands the turn to the offline guest before the host's own 30 s
    // deadline; the guest's turn timer then becomes the forfeit deadline.
    harness.advance(3_000, [room.host]);
    const cell = firstHiddenSafeCell(harness.manager, room.roomId);
    expectOk(
      harness.action(
        room.host,
        actionFor(harness.manager, room.roomId, { row: cell.row, col: cell.col }),
      ),
    );
    expect(harness.manager.getRoom(room.roomId)?.turnPlayerId).toBe(room.guestId);
    const guestDeadline = deadlinesOf(harness.manager, room.roomId).turnDeadlineAt;
    expect(guestDeadline).toBe(NOW + 28_000 + TURN_TIMEOUT_MS);

    harness.advance(TURN_TIMEOUT_MS - 1, [room.host]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('playing');

    harness.advance(1, [room.host]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');
    const timeout = firstTimeout(room.host);
    expect(timeout.timer).toBe('turn');
    expect(timeout.subjectId).toBe(room.guestId);
    expect(timeout.deadlineAt).toBe(guestDeadline);
    const end = firstEnd(room.host);
    expect(end.winnerId).toBe(room.hostId);
    expect(end.loserId).toBe(room.guestId);
  });

  it('replaces the old socket for a token without moving the turn deadline', () => {
    const harness = new ReconnectHarness();
    const room = createPlayingRoom(harness);
    const before = deadlinesOf(harness.manager, room.roomId);
    const seqBefore = roomSequence(harness.manager, room.roomId);

    harness.advance(HEARTBEAT_INTERVAL_MS * 2, [room.host, room.guest]);
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore);

    const replacement = harness.resume(room.roomId, room.hostToken);
    expect(room.host.closed).toBe(true);
    expect(room.guest.closed).toBe(false);
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore);
    expect(deadlinesOf(harness.manager, room.roomId)).toEqual(before);
    expect(replacement.messages.map((message) => message.type)).toEqual([
      'room_state',
      'snapshot',
    ]);
    expect(firstSnapshot(replacement).seq).toBe(seqBefore);

    // A repeated join on the same connection reuses the seat and still moves
    // neither the room sequence nor the deadlines.
    const duplicate = expectOk(
      harness.command(replacement, (connection) =>
        harness.manager.join(connection, joinMessage(room.roomId, 'Ada', room.hostToken)),
      ),
    );
    expect(duplicate.boundToken).toBe(room.hostToken);
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore);
    expect(deadlinesOf(harness.manager, room.roomId)).toEqual(before);
    expect(harness.manager.getRoom(room.roomId)?.seats).toHaveLength(ROOM_CAPACITY);
    expect(messagesOfType(replacement.messages, 'snapshot')).toHaveLength(2);

    // The replaced socket is inert: it stops beating and cannot revive a grace
    // window or move the deadline that was armed before the replacement.
    const replacedPings = room.host.socket.pingCount;
    harness.advance(TURN_TIMEOUT_MS - HEARTBEAT_INTERVAL_MS * 2 - 1, [
      replacement,
      room.guest,
    ]);
    expect(room.host.socket.pingCount).toBe(replacedPings);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('playing');

    harness.advance(1, [replacement, room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');
    const timeout = firstTimeout(room.guest);
    expect(timeout.timer).toBe('turn');
    expect(timeout.subjectId).toBe(room.hostId);
    expect(timeout.deadlineAt).toBe(NOW + TURN_TIMEOUT_MS);
  });

  it('restores a ready host seat without sending a board snapshot', () => {
    const harness = new ReconnectHarness();
    const room = createReadyRoom(harness);
    const before = deadlinesOf(harness.manager, room.roomId);
    const seqBefore = roomSequence(harness.manager, room.roomId);

    harness.advance(OFFLINE_DETECT_MS, [room.guest]);
    expect(presenceOf(harness.manager, room.roomId, room.hostToken)).toBe('offline');

    harness.advance(HEARTBEAT_INTERVAL_MS, [room.guest]);
    const resumed = harness.resume(room.roomId, room.hostToken);

    const state = harness.manager.getRoom(room.roomId);
    expect(state?.state).toBe('ready');
    expect(state?.hostId).toBe(room.hostId);
    expect(presenceOf(harness.manager, room.roomId, room.hostToken)).toBe('online');
    expect(roomSequence(harness.manager, room.roomId)).toBe(seqBefore);
    expect(deadlinesOf(harness.manager, room.roomId)).toEqual(before);
    expect(resumed.messages.map((message) => message.type)).toEqual(['room_state']);
    expect(messagesOfType(resumed.messages, 'snapshot')).toHaveLength(0);
    expect(messagesOfType(resumed.messages, 'end')).toHaveLength(0);

    // The resumed connection cancels the grace: 25 s after offline detection
    // the room is still ready and the host is still seated.
    harness.advance(RECONNECT_GRACE_MS, [room.guest, resumed]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('ready');
    expect(harness.manager.getRoom(room.roomId)?.seats).toHaveLength(ROOM_CAPACITY);
    expect(messagesOfType(resumed.messages, 'room_closed')).toHaveLength(0);
  });

  it('retains a finished result through grace and replays it on reconnect', () => {
    const harness = new ReconnectHarness();
    const room = createPlayingRoom(harness);

    harness.advance(TURN_TIMEOUT_MS, [room.host, room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');
    const finishedSeq = roomSequence(harness.manager, room.roomId);
    const finishedEnd = firstEnd(room.guest);
    expect(finishedEnd.reason).toBe('turn-timeout');

    harness.advance(OFFLINE_DETECT_MS, [room.guest]);
    expect(presenceOf(harness.manager, room.roomId, room.hostToken)).toBe('offline');
    expect(roomSequence(harness.manager, room.roomId)).toBe(finishedSeq);

    const messagesBeforeGrace = room.host.messages.length;
    harness.advance(RECONNECT_GRACE_MS, [room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(roomSequence(harness.manager, room.roomId)).toBe(finishedSeq);
    expect(room.host.messages).toHaveLength(messagesBeforeGrace);

    const resumed = harness.resume(room.roomId, room.hostToken);
    expect(room.host.closed).toBe(true);
    const roomState = messagesOfType(resumed.messages, 'room_state')[0];
    expect(roomState?.state).toBe('finished');
    expect(roomState?.seq).toBe(finishedSeq);

    const end = firstEnd(resumed);
    expect(end.seq).toBe(finishedSeq);
    expect(end.reason).toBe('turn-timeout');
    expect(end.winnerId).toBe(room.guestId);
    expect(roomSequence(harness.manager, room.roomId)).toBe(finishedSeq);
  });

  it('ends at the 15-minute match cap when it precedes the turn deadline', () => {
    const harness = new ReconnectHarness({ turnTimeoutMs: MATCH_TIMEOUT_MS * 2 });
    const room = createPlayingRoom(harness);

    // The match layer caps the turn at the match deadline, and the scheduler
    // picks the match timer on the tie, so the whole match settles by ranking.
    const match = harness.manager.getMatch(room.roomId);
    expect(match?.state.turnDeadlineAt).toBe(NOW + MATCH_TIMEOUT_MS);
    expect(match?.state.matchDeadlineAt).toBe(NOW + MATCH_TIMEOUT_MS);

    harness.advance(MATCH_TIMEOUT_MS - 1, [room.host, room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('playing');
    expect(messagesOfType(room.host.messages, 'timeout')).toHaveLength(0);

    harness.advance(1, [room.host, room.guest]);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');
    const timeout = firstTimeout(room.host);
    expect(timeout.timer).toBe('match');
    expect(timeout.deadlineAt).toBe(NOW + MATCH_TIMEOUT_MS);
    expect(timeout.reason).toBe('match-timeout');
    expect(firstEnd(room.host).reason).toBe('match-timeout');
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
  });

  it('returns a duplicate action from cache without moving seq, turn or deadline', () => {
    const harness = new ReconnectHarness();
    const room = createPlayingRoom(harness);
    const cell = firstHiddenSafeCell(harness.manager, room.roomId);
    const action = actionFor(harness.manager, room.roomId, {
      row: cell.row,
      col: cell.col,
    });

    expectOk(harness.action(room.host, action));
    const acceptedSeq = roomSequence(harness.manager, room.roomId);
    const acceptedDeadlines = deadlinesOf(harness.manager, room.roomId);
    const acceptedMatch = harness.manager.getMatch(room.roomId);
    expect(acceptedMatch?.state.actions).toHaveLength(1);
    const guestSnapshots = messagesOfType(room.guest.messages, 'snapshot').length;

    const duplicate = expectOk(harness.action(room.host, action));
    expect(duplicate.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'action_result',
    ]);
    expect(roomSequence(harness.manager, room.roomId)).toBe(acceptedSeq);
    expect(deadlinesOf(harness.manager, room.roomId)).toEqual(acceptedDeadlines);
    expect(harness.manager.getMatch(room.roomId)?.state.actions).toHaveLength(1);
    expect(harness.manager.getMatch(room.roomId)?.state.turnId).toBe(
      acceptedMatch?.state.turnId,
    );
    // action_result is addressed to the actor; the opponent only sees the
    // broadcast snapshot, and the duplicate must not add a second snapshot.
    expect(messagesOfType(room.host.messages, 'action_result')).toHaveLength(2);
    expect(messagesOfType(room.guest.messages, 'action_result')).toHaveLength(0);
    expect(messagesOfType(room.guest.messages, 'snapshot')).toHaveLength(guestSnapshots);
  });
});
