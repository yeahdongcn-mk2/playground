import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JOIN_TIMEOUT_MS,
  MATCH_TIMEOUT_MS,
  ROOM_CAPACITY,
  TURN_TIMEOUT_MS,
  publicRoomState,
  type MatchCommandResult,
  type RoomCommandFailure,
  type RoomCommandResult,
  type RoomCommandSuccess,
  type RoomConnection,
  type RoomErrorCode,
  type RoomRecord,
} from '../../server/room/contracts';
import {
  InMemoryRoomManager,
  createRoomManager,
  type RoomManagerOptions,
  type RoomMatch,
} from '../../server/room/room-manager';
import {
  PROTOCOL_VERSION,
  hashSeed,
  replayMatch,
  validateServerMessage,
  type ActionMessage,
  type CreateMessage,
  type EndMessage,
  type JoinMessage,
  type LeaveMessage,
  type ProtocolErrorCode,
  type ReadyMessage,
  type RematchMessage,
  type RoomStateMessage,
  type ServerToClientMessage,
  type StartMessage,
} from '../../src/games/minesweeper/online/index';
import type {
  MinesweeperCell,
  MinesweeperConfig,
} from '../../src/games/minesweeper/engine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANAGER_PATH = join(ROOT, 'server', 'room', 'room-manager.ts');
const MANAGER_SOURCE = readFileSync(MANAGER_PATH, 'utf8');

const NOW = 1_700_000_000_000;

const CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

let connectionSeq = 0;

function connection(playerToken: string | null = null): RoomConnection {
  connectionSeq += 1;
  return { connectionId: `connection_${connectionSeq}`, playerToken };
}

function createMessage(overrides: Partial<CreateMessage> = {}): CreateMessage {
  return {
    type: 'create',
    requestId: 'req_create',
    protocolVersion: PROTOCOL_VERSION,
    config: CONFIG,
    displayName: 'Ada',
    ...overrides,
  };
}

function joinMessage(roomId: string, overrides: Partial<JoinMessage> = {}): JoinMessage {
  return {
    type: 'join',
    requestId: 'req_join',
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    displayName: 'Grace',
    ...overrides,
  };
}

function readyMessage(roomId: string, ready: boolean): ReadyMessage {
  return { type: 'ready', roomId, requestId: 'req_ready', ready };
}

function startMessage(roomId: string): StartMessage {
  return { type: 'start', roomId, requestId: 'req_start' };
}

function leaveMessage(roomId: string): LeaveMessage {
  return { type: 'leave', roomId, requestId: 'req_leave' };
}

function rematchMessage(roomId: string, accept = true): RematchMessage {
  return { type: 'rematch', roomId, requestId: 'req_rematch', accept };
}

/** Manager with a fixed clock unless a test supplies its own options. */
function makeManager(options: RoomManagerOptions = {}): InMemoryRoomManager {
  return createRoomManager({ now: () => NOW, ...options });
}

/** Deep copy of a live record, so later in-place mutation cannot pass unnoticed. */
function snapshot(manager: InMemoryRoomManager, roomId: string): RoomRecord {
  const room = manager.getRoom(roomId);
  if (room === undefined) {
    throw new Error(`room ${roomId} is not in the table`);
  }
  return structuredClone(room);
}

/**
 * Assert a delivery set cannot cross-talk.
 *
 * Every message must pass the shared #482 server validator, and the JSON of a
 * delivery must never contain another seat's token. `allTokens` lets a
 * single-delivery path (seat resume) still check the other seats' secrets.
 */
function expectNoCrossTalk(
  result: RoomCommandSuccess,
  allTokens: readonly string[] = [],
): void {
  const tokens = new Set([...allTokens, ...result.deliveries.map((delivery) => delivery.playerToken)]);
  for (const delivery of result.deliveries) {
    const validation = validateServerMessage(delivery.message);
    expect(validation.ok, JSON.stringify(validation)).toBe(true);

    const json = JSON.stringify(delivery.message);
    for (const token of tokens) {
      if (token !== delivery.playerToken) {
        expect(json).not.toContain(token);
      }
    }
    if (delivery.message.type === 'room_state') {
      expect(delivery.message.playerToken).toBe(delivery.playerToken);
    } else {
      expect(json).not.toContain('playerToken');
    }
  }
}

function expectOk(
  result: RoomCommandResult | MatchCommandResult,
  allTokens: readonly string[] = [],
): RoomCommandSuccess {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.error.message}`);
  }
  expectNoCrossTalk(result, allTokens);
  return result;
}

function expectError(result: RoomCommandResult, code: RoomErrorCode): RoomCommandFailure {
  expect(result.ok, `expected failure ${code}`).toBe(false);
  if (result.ok) {
    throw new Error(`expected failure ${code}`);
  }
  expect(result.code).toBe(code);
  expect(validateServerMessage(result.error).ok, JSON.stringify(result.error)).toBe(true);
  return result;
}

/** First `room_state` in a successful command's deliveries. */
function roomStateOf(result: RoomCommandResult): RoomStateMessage {
  const success = expectOk(result);
  const message = success.deliveries[0]?.message;
  if (message?.type !== 'room_state') {
    throw new Error('expected a room_state delivery');
  }
  return message;
}

/**
 * Assert the `room_state` copies in a successful command.
 *
 * Start also broadcasts a `snapshot` per seat, so this helper takes the
 * already-filtered `room_state` messages and a separate count assertion keeps
 * lifecycle commands from silently changing their delivery count.
 */
function expectRoomStateMessages(
  messages: readonly RoomStateMessage[],
  expected: {
    readonly state: RoomStateMessage['state'];
    readonly seq: number;
    readonly ready: readonly boolean[];
    readonly playerIds?: readonly string[];
    readonly stateReason?: string | null;
    readonly matchId?: string | null;
    readonly turnPlayerId?: string | null;
  },
): void {
  expect(messages).toHaveLength(expected.ready.length);
  for (const message of messages) {
    expect(message.state).toBe(expected.state);
    expect(message.seq).toBe(expected.seq);
    expect(message.players.map((player) => player.ready)).toEqual(expected.ready);
    if (expected.playerIds !== undefined) {
      expect(message.players.map((player) => player.playerId)).toEqual(expected.playerIds);
    }
    if (expected.stateReason !== undefined) {
      expect(message.stateReason).toBe(expected.stateReason);
    }
    if (expected.matchId !== undefined) {
      expect(message.matchId).toBe(expected.matchId);
    }
    if (expected.turnPlayerId !== undefined) {
      expect(message.turnPlayerId).toBe(expected.turnPlayerId);
    }
  }
}

/**
 * Assert a successful command broadcast one `room_state` per seat.
 *
 * Each per-seat copy must carry the transition's state and sequence, preserve
 * the seat order/readiness, and (when given) its reason and match id. A
 * command that delivers nothing, an old record, or a record with the wrong
 * sequence fails here.
 */
function expectRoomStateBroadcast(
  result: RoomCommandResult,
  expected: {
    readonly state: RoomStateMessage['state'];
    readonly seq: number;
    readonly ready: readonly boolean[];
    readonly playerIds?: readonly string[];
    readonly stateReason?: string | null;
    readonly matchId?: string | null;
    readonly turnPlayerId?: string | null;
  },
): void {
  const success = expectOk(result);
  expect(success.deliveries).toHaveLength(expected.ready.length);
  expect(new Set(success.deliveries.map((delivery) => delivery.playerToken)).size).toBe(
    expected.ready.length,
  );
  expectRoomStateMessages(
    success.deliveries.map((delivery) => {
      if (delivery.message.type !== 'room_state') {
        throw new Error(`expected a room_state delivery, got ${delivery.message.type}`);
      }
      return delivery.message;
    }),
    expected,
  );
}

/** Every message of one type in a successful command, in delivery order. */
function messagesOfType<T extends ServerToClientMessage['type']>(
  result: RoomCommandResult | MatchCommandResult,
  type: T,
): Extract<ServerToClientMessage, { readonly type: T }>[] {
  const success = expectOk(result);
  return success.deliveries.flatMap((delivery) =>
    delivery.message.type === type
      ? [delivery.message as Extract<ServerToClientMessage, { readonly type: T }>]
      : [],
  );
}

/**
 * Assert one message type reached every given seat exactly once.
 *
 * `room_state` copies are seat-specific and `snapshot`/`end` copies are
 * identical, but none of them carries the recipient token inside the payload,
 * so a count or content assertion alone cannot tell a real broadcast from two
 * copies to the same seat. Comparing the sorted recipient lists pins both the
 * recipient set and the one-copy-per-seat property; delivery order is not part
 * of the protocol. `room_state` keeps its per-seat uniqueness through the same
 * comparison, so two copies to one seat fail here.
 */
function expectSeatBroadcast(
  result: RoomCommandResult | MatchCommandResult,
  type: ServerToClientMessage['type'],
  playerTokens: readonly string[],
): void {
  const success = expectOk(result);
  const recipients = success.deliveries
    .filter((delivery) => delivery.message.type === type)
    .map((delivery) => delivery.playerToken);
  expect(new Set(recipients).size).toBe(playerTokens.length);
  expect([...recipients].sort()).toEqual([...playerTokens].sort());
}

/**
 * The join timeout must consume the room's next two sequence numbers.
 *
 * A client that applied the timeout at N+1 would drop a `room_closed` that
 * reused the same seq, so the pair has to be pinned as consecutive on every
 * per-seat copy.
 */
function expectTimeoutThenClose(
  success: RoomCommandSuccess,
  beforeSeq: number,
): void {
  const timeouts = success.deliveries.flatMap((delivery) =>
    delivery.message.type === 'timeout' ? [delivery.message] : [],
  );
  const closes = success.deliveries.flatMap((delivery) =>
    delivery.message.type === 'room_closed' ? [delivery.message] : [],
  );
  const timeout = timeouts[0];
  if (timeout === undefined) {
    throw new Error('expected a timeout delivery');
  }
  expect(timeouts).toHaveLength(2);
  expect(closes).toHaveLength(2);
  expect(timeout.seq).toBe(beforeSeq + 1);
  for (const copy of timeouts) {
    expect(copy.seq).toBe(timeout.seq);
  }
  for (const close of closes) {
    expect(close.seq).toBe(timeout.seq + 1);
  }
}

/**
 * Assert a successful command notified every current seat that the room closed.
 *
 * `room_closed` is the only terminal notification, so its `seq` has to be the
 * sequence of the dissolving transition: reusing the pre-transition seq would
 * let a client drop it as a duplicate. The payload, per-seat recipients and
 * delivery count are pinned too, so an empty or stale broadcast fails here.
 */
function expectRoomClosedBroadcast(
  result: RoomCommandResult,
  expected: {
    readonly roomId: string;
    readonly seq: number;
    readonly reason: string;
    readonly playerTokens: readonly string[];
  },
): void {
  const success = expectOk(result);
  expect(success.deliveries).toHaveLength(expected.playerTokens.length);
  expect(success.deliveries.map((delivery) => delivery.playerToken)).toEqual(
    expected.playerTokens,
  );
  for (const delivery of success.deliveries) {
    const message = delivery.message;
    if (message.type !== 'room_closed') {
      throw new Error(`expected a room_closed delivery, got ${message.type}`);
    }
    expect(message.roomId).toBe(expected.roomId);
    expect(message.seq).toBe(expected.seq);
    expect(message.reason).toBe(expected.reason);
    expect(message.finalState).toBe('dissolved');
  }
}

interface CreatedRoom {
  readonly manager: InMemoryRoomManager;
  readonly roomId: string;
  readonly hostToken: string;
  readonly result: RoomCommandSuccess;
}

function createRoom(
  manager: InMemoryRoomManager,
  overrides: Partial<CreateMessage> = {},
): CreatedRoom {
  const result = expectOk(manager.create(connection(), createMessage(overrides)));
  const hostToken = result.boundToken;
  if (hostToken === undefined) {
    throw new Error('create must bind the host token');
  }
  return { manager, roomId: roomStateOf(result).roomId, hostToken, result };
}

interface JoinedRoom {
  readonly guestToken: string;
  readonly result: RoomCommandSuccess;
}

function joinRoom(
  manager: InMemoryRoomManager,
  roomId: string,
  overrides: Partial<JoinMessage> = {},
): JoinedRoom {
  const result = expectOk(manager.join(connection(), joinMessage(roomId, overrides)));
  const guestToken = result.boundToken;
  if (guestToken === undefined) {
    throw new Error('join must bind the guest token');
  }
  return { guestToken, result };
}

interface ReadyRoom extends CreatedRoom {
  readonly guestToken: string;
}

/** create → join → both ready; the room is in `ready`. */
function readyRoom(options: RoomManagerOptions = {}): ReadyRoom {
  const manager = makeManager(options);
  const created = createRoom(manager);
  const joined = joinRoom(manager, created.roomId);
  expectOk(manager.ready(connection(created.hostToken), readyMessage(created.roomId, true)));
  expectOk(manager.ready(connection(joined.guestToken), readyMessage(created.roomId, true)));
  expect(manager.getRoom(created.roomId)?.state).toBe('ready');
  return { ...created, guestToken: joined.guestToken };
}

interface PlayingRoom extends ReadyRoom {
  readonly match: RoomMatch;
}

/** create → join → ready → start; the room is playing with a held engine. */
function playingRoom(options: RoomManagerOptions = {}): PlayingRoom {
  const room = readyRoom(options);
  expectOk(room.manager.start(connection(room.hostToken), startMessage(room.roomId)));
  const match = room.manager.getMatch(room.roomId);
  if (match === null) {
    throw new Error('start must create a match handle');
  }
  return { ...room, match };
}

/** The retained match of a room that must be playing or finished. */
function matchOf(manager: InMemoryRoomManager, roomId: string): RoomMatch {
  const match = manager.getMatch(roomId);
  if (match === null) {
    throw new Error(`room ${roomId} has no match`);
  }
  return match;
}

interface ActionOverrides {
  readonly actionId?: string;
  readonly seq?: number;
  readonly turnId?: number;
  readonly kind?: 'reveal' | 'flag';
  readonly row?: number;
  readonly col?: number;
  readonly matchId?: string;
}

/**
 * Build an action against the room's current seq/turn, letting a test override
 * exactly the field it wants to make stale or invalid.
 */
function actionFor(
  manager: InMemoryRoomManager,
  roomId: string,
  overrides: ActionOverrides = {},
): ActionMessage {
  const room = manager.getRoom(roomId);
  if (room === undefined || room.matchId === null) {
    throw new Error(`room ${roomId} has no running match`);
  }
  const match = matchOf(manager, roomId);
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
    clientTimeMs: NOW,
    ...overrides,
  };
}

/** Assert a match-layer rejection carries a shared protocol code. */
function expectMatchError(
  result: MatchCommandResult,
  code: ProtocolErrorCode,
): Extract<MatchCommandResult, { readonly ok: false }> {
  expect(result.ok, `expected match failure ${code}`).toBe(false);
  if (result.ok) {
    throw new Error(`expected match failure ${code}, but the command succeeded`);
  }
  expect(result.code).toBe(code);
  expect(validateServerMessage(result.error).ok, JSON.stringify(result.error)).toBe(true);
  return result;
}

/**
 * A rejected action must not move the room or the match: the record and the
 * match handle are compared as before/after values, and the match handle must
 * be the exact same object (a rejection never replaces it).
 */
function expectMatchRejectedWithoutChange(
  manager: InMemoryRoomManager,
  roomId: string,
  call: () => MatchCommandResult,
  code: ProtocolErrorCode,
): void {
  const beforeRoom = snapshot(manager, roomId);
  const beforeMatch = manager.getMatch(roomId);
  const beforeBoard = JSON.stringify(beforeMatch?.state.engine.state.board ?? null);
  const beforeReplay = JSON.stringify(manager.getReplayRecord(roomId));
  const failure = expectMatchError(call(), code);
  expect(manager.getRoom(roomId)).toEqual(beforeRoom);
  expect(manager.getMatch(roomId)).toBe(beforeMatch);
  expect(JSON.stringify(manager.getMatch(roomId)?.state.engine.state.board ?? null)).toBe(
    beforeBoard,
  );
  expect(JSON.stringify(manager.getReplayRecord(roomId))).toBe(beforeReplay);
  expect(failure.error.roomId).toBe(roomId);
}

/** The host and guest player ids of a two-seat room. */
function seatIds(
  manager: InMemoryRoomManager,
  roomId: string,
): { readonly hostId: string; readonly guestId: string } {
  const seats = manager.getRoom(roomId)?.seats ?? [];
  const host = seats.find((seat) => seat.isHost);
  const guest = seats.find((seat) => !seat.isHost);
  if (host === undefined || guest === undefined) {
    throw new Error(`room ${roomId} does not have two seats`);
  }
  return { hostId: host.playerId, guestId: guest.playerId };
}

/** First hidden, unflagged cell of the retained match; any reveal target. */
function firstHiddenCell(manager: InMemoryRoomManager, roomId: string): MinesweeperCell {
  const cell = matchOf(manager, roomId)
    .state.engine.state.board.flat()
    .find((candidate) => !candidate.revealed && !candidate.flagged);
  if (cell === undefined) {
    throw new Error('expected a hidden cell in the match');
  }
  return cell;
}

/** Number of mine cells in an end-only board. */
function countMines(end: EndMessage): number {
  return end.finalSnapshot.flat().filter((cell) => cell.mine).length;
}

/** Run a command that must be rejected without changing the stored record. */
function expectRejectedWithoutChange(
  manager: InMemoryRoomManager,
  roomId: string,
  action: () => RoomCommandResult,
  code: RoomErrorCode,
): RoomCommandFailure {
  const before = snapshot(manager, roomId);
  const beforeCount = manager.roomCount;
  const failure = expectError(action(), code);
  expect(manager.getRoom(roomId)).toEqual(before);
  expect(manager.roomCount).toBe(beforeCount);
  return failure;
}

beforeEach(() => {
  connectionSeq = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('online room creation and joining', () => {
  it('creates a waiting room and seats the host with a 120 s join window', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    const room = manager.getRoom(created.roomId);

    expect(room).toMatchObject({
      roomId: created.roomId,
      capacity: ROOM_CAPACITY,
      state: 'waiting',
      seq: 1,
      matchId: null,
      turnPlayerId: null,
      joinDeadlineAt: NOW + JOIN_TIMEOUT_MS,
      deadlineAt: null,
      stateReason: null,
    });
    expect(room?.config).toEqual(CONFIG);
    expect(room?.seats).toHaveLength(1);
    expect(room?.seats[0]).toMatchObject({
      ready: false,
      presence: 'online',
      isHost: true,
      joinedAt: NOW,
    });
    expect(room?.hostId).toBe(room?.seats[0]?.playerId);

    expect(created.result.deliveries).toHaveLength(1);
    expect(created.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(roomStateOf(created.result)).toMatchObject({
      type: 'room_state',
      roomId: created.roomId,
      state: 'waiting',
      seq: 1,
      playerToken: created.hostToken,
    });
    expect(JSON.stringify(created.result.deliveries[0]?.message)).toContain(
      created.hostToken,
    );
  });

  it('fills both seats on join without exposing either token to the other seat', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    const beforeJoin = snapshot(manager, created.roomId);
    const joined = joinRoom(manager, created.roomId);
    const room = manager.getRoom(created.roomId);
    if (room === undefined) {
      throw new Error('join must keep the room in the table');
    }

    expect(room.state).toBe('waiting');
    expect(room.seats).toHaveLength(2);
    expect(room.seq).toBe(beforeJoin.seq + 1);
    expect(room.seats.map((seat) => seat.isHost)).toEqual([true, false]);
    expect(room.seats.map((seat) => seat.ready)).toEqual([false, false]);
    expect(new Set(room.seats.map((seat) => seat.playerToken)).size).toBe(2);

    expect(joined.result.boundToken).toBe(joined.guestToken);
    expect(joined.result.deliveries).toHaveLength(2);
    expect(joined.result.deliveries.map((delivery) => delivery.playerToken)).toEqual([
      created.hostToken,
      joined.guestToken,
    ]);

    for (const delivery of joined.result.deliveries) {
      const message = delivery.message;
      if (message.type !== 'room_state') {
        throw new Error('join should broadcast room_state');
      }
      expect(message.playerToken).toBe(delivery.playerToken);
      const json = JSON.stringify(message);
      expect(json).not.toContain(
        delivery.playerToken === created.hostToken ? joined.guestToken : created.hostToken,
      );
    }

    // The host already applied create's seq=1; a join broadcast that reused it
    // would be dropped as a duplicate, so pin the transition's seq, state and
    // reason on every per-seat copy.
    expectRoomStateBroadcast(joined.result, {
      state: 'waiting',
      seq: beforeJoin.seq + 1,
      ready: [false, false],
      playerIds: room.seats.map((seat) => seat.playerId),
      stateReason: 'guest-joined',
    });
  });

  it('resumes a seat by token without adding a player or changing the sequence', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    const joined = joinRoom(manager, created.roomId);
    const before = snapshot(manager, created.roomId);
    const allTokens = [created.hostToken, joined.guestToken];

    const resumed = expectOk(
      manager.join(
        connection(),
        joinMessage(created.roomId, { playerToken: joined.guestToken }),
      ),
      allTokens,
    );
    expect(resumed.boundToken).toBe(joined.guestToken);
    expect(resumed.deliveries).toHaveLength(1);
    expect(resumed.deliveries[0]?.playerToken).toBe(joined.guestToken);
    // A reconnecting seat learns the current state only from this message: it
    // must be the stored record's public projection, not a stale or zeroed
    // copy whose seq the client would discard as already applied.
    expect(resumed.deliveries[0]?.message).toEqual({
      ...publicRoomState(before),
      playerToken: joined.guestToken,
    });
    expect(manager.getRoom(created.roomId)).toEqual(before);
    expect(manager.getRoom(created.roomId)?.seats).toHaveLength(2);

    // The transport may already have bound the seat token to this connection;
    // a retried join without a message token must resume, not seat a third
    // player or rebind the connection to a fresh token.
    const boundResume = expectOk(
      manager.join(connection(joined.guestToken), joinMessage(created.roomId)),
      allTokens,
    );
    expect(boundResume.boundToken).toBe(joined.guestToken);
    expect(boundResume.deliveries).toHaveLength(1);
    expect(manager.getRoom(created.roomId)).toEqual(before);

    const bogus = expectError(
      manager.join(
        connection(),
        joinMessage(created.roomId, { playerToken: 'not-a-real-token' }),
      ),
      'not-in-room',
    );
    expect(bogus.error.code).toBe('bad-request');
    expect(manager.getRoom(created.roomId)).toEqual(before);

    // An empty optional token is treated as absent, so it can still join an
    // open seat instead of failing as an unknown resume token.
    const solo = createRoom(manager);
    const emptyToken = expectOk(
      manager.join(connection(), joinMessage(solo.roomId, { playerToken: '' })),
    );
    expect(emptyToken.boundToken).toBeDefined();
    expect(manager.getRoom(solo.roomId)?.seats).toHaveLength(2);
  });

  it('resumes a seat during playing and finished without moving the match', () => {
    const room = playingRoom();
    const allTokens = [room.hostToken, room.guestToken];
    const playing = snapshot(room.manager, room.roomId);
    const playingResume = expectOk(
      room.manager.join(
        connection(),
        joinMessage(room.roomId, { playerToken: room.guestToken }),
      ),
      allTokens,
    );
    expect(playingResume.deliveries).toHaveLength(1);
    expect(playingResume.boundToken).toBe(room.guestToken);
    expect(playingResume.deliveries[0]?.message).toEqual({
      ...publicRoomState(playing),
      playerToken: room.guestToken,
    });
    expect(room.manager.getRoom(room.roomId)).toEqual(playing);
    expect(room.manager.getMatch(room.roomId)).toBe(room.match);

    expectOk(room.manager.finishMatch(room.roomId, room.match.matchId, 'mine-hit'));
    const finished = snapshot(room.manager, room.roomId);
    const finishedResume = expectOk(
      room.manager.join(
        connection(),
        joinMessage(room.roomId, { playerToken: room.hostToken }),
      ),
      allTokens,
    );
    expect(finishedResume.deliveries).toHaveLength(1);
    expect(finishedResume.boundToken).toBe(room.hostToken);
    expect(finishedResume.deliveries[0]?.message).toEqual({
      ...publicRoomState(finished),
      playerToken: room.hostToken,
    });
    expect(room.manager.getRoom(room.roomId)).toEqual(finished);
  });

  it('rejects a blank display name without seating anyone', () => {
    const manager = makeManager();
    expectError(manager.create(connection(), createMessage({ displayName: '   ' })), 'bad-request');
    expect(manager.roomCount).toBe(0);

    const created = createRoom(manager);
    expectError(
      manager.join(connection(), joinMessage(created.roomId, { displayName: '\t' })),
      'bad-request',
    );
    expect(manager.getRoom(created.roomId)?.seats).toHaveLength(1);
  });

  it('rejects a third seat with room-full and keeps the record unchanged', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    joinRoom(manager, created.roomId);
    const before = snapshot(manager, created.roomId);

    const failure = expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.join(connection(), joinMessage(created.roomId, { displayName: 'Alan' })),
      'room-full',
    );
    expect(failure.error.roomId).toBe(created.roomId);
    expect(failure.error.currentSeq).toBe(before.seq);
    expect(manager.getRoom(created.roomId)?.seats).toHaveLength(2);
  });

  it('rejects a new join once the room has started', () => {
    const room = playingRoom();
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () =>
        room.manager.join(
          connection(),
          joinMessage(room.roomId, { displayName: 'Late' }),
        ),
      'invalid-state',
    );
  });

  it('rejects an invalid config or protocol version without creating or mutating a room', () => {
    const manager = makeManager();
    expect(
      expectError(
        manager.create(
          connection(),
          createMessage({ config: { ...CONFIG, mines: CONFIG.rows * CONFIG.cols } }),
        ),
        'bad-request',
      ).error.code,
    ).toBe('bad-request');
    expect(manager.roomCount).toBe(0);

    expectError(
      manager.create(connection(), createMessage({ protocolVersion: PROTOCOL_VERSION + 1 })),
      'bad-request',
    );
    expect(manager.roomCount).toBe(0);

    const created = createRoom(manager);
    expect(manager.roomCount).toBe(1);

    // `join` repeats the same manager-level version guard; a mismatched
    // client must not take the second seat.
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () =>
        manager.join(
          connection(),
          joinMessage(created.roomId, { protocolVersion: PROTOCOL_VERSION + 1 }),
        ),
      'bad-request',
    );
    expect(manager.getRoom(created.roomId)?.seats).toHaveLength(1);
  });

  it('mints unique room ids and seat tokens across many creates', () => {
    const manager = makeManager();
    const ids: string[] = [];
    const tokens: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const created = createRoom(manager);
      ids.push(created.roomId);
      tokens.push(created.hostToken);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(manager.roomCount).toBe(ids.length);
  });
});

describe('online room readiness and start', () => {
  it('moves waiting → ready when both seats are ready and back on unready', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    const host = connection(created.hostToken);

    const beforeHostReady = snapshot(manager, created.roomId);
    expectRoomStateBroadcast(manager.ready(host, readyMessage(created.roomId, true)), {
      state: 'waiting',
      seq: beforeHostReady.seq + 1,
      stateReason: null,
      ready: [true],
      playerIds: [beforeHostReady.hostId],
    });
    expect(manager.getRoom(created.roomId)?.state).toBe('waiting');

    const joined = joinRoom(manager, created.roomId);
    const guest = connection(joined.guestToken);
    expect(manager.getRoom(created.roomId)?.state).toBe('waiting');

    const beforeAllReady = snapshot(manager, created.roomId);
    expectRoomStateBroadcast(manager.ready(guest, readyMessage(created.roomId, true)), {
      state: 'ready',
      seq: beforeAllReady.seq + 1,
      stateReason: 'all-ready',
      ready: [true, true],
      playerIds: beforeAllReady.seats.map((seat) => seat.playerId),
    });
    expect(manager.getRoom(created.roomId)?.state).toBe('ready');
    expect(manager.getRoom(created.roomId)?.seats.every((seat) => seat.ready)).toBe(true);

    const beforeUnready = snapshot(manager, created.roomId);
    expectRoomStateBroadcast(manager.ready(host, readyMessage(created.roomId, false)), {
      state: 'waiting',
      seq: beforeUnready.seq + 1,
      stateReason: 'unready',
      ready: [false, true],
      playerIds: beforeUnready.seats.map((seat) => seat.playerId),
    });
    expect(manager.getRoom(created.roomId)?.state).toBe('waiting');

    const beforeReReady = snapshot(manager, created.roomId);
    expectRoomStateBroadcast(manager.ready(host, readyMessage(created.roomId, true)), {
      state: 'ready',
      seq: beforeReReady.seq + 1,
      stateReason: 'all-ready',
      ready: [true, true],
      playerIds: beforeReReady.seats.map((seat) => seat.playerId),
    });
    expect(manager.getRoom(created.roomId)?.state).toBe('ready');
  });

  it('rejects a non-boolean ready flag without changing the room', () => {
    const room = readyRoom();
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () =>
        room.manager.ready(connection(room.hostToken), {
          ...readyMessage(room.roomId, true),
          ready: 'yes' as unknown as boolean,
        }),
      'bad-request',
    );
  });

  it('rejects readiness and start from the wrong seat or state', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    const joined = joinRoom(manager, created.roomId);

    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.ready(connection('stale-token'), readyMessage(created.roomId, true)),
      'not-in-room',
    );
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.start(connection(created.hostToken), startMessage(created.roomId)),
      'invalid-state',
    );

    expectOk(manager.ready(connection(created.hostToken), readyMessage(created.roomId, true)));
    expectOk(manager.ready(connection(joined.guestToken), readyMessage(created.roomId, true)));
    const ready = manager.getRoom(created.roomId);
    expect(ready?.state).toBe('ready');

    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.start(connection(joined.guestToken), startMessage(created.roomId)),
      'not-host',
    );
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.start(connection('stale-token'), startMessage(created.roomId)),
      'not-in-room',
    );
  });

  it('starts from ready with a new match id, seed and held engine', () => {
    const room = readyRoom();
    const before = snapshot(room.manager, room.roomId);

    const started = room.manager.start(
      connection(room.hostToken),
      startMessage(room.roomId),
    );
    const record = room.manager.getRoom(room.roomId);
    const match = room.manager.getMatch(room.roomId);

    expect(record).toMatchObject({
      state: 'playing',
      seq: before.seq + 1,
      hostId: before.hostId,
      turnPlayerId: before.hostId,
      stateReason: 'match-started',
      deadlineAt: NOW + TURN_TIMEOUT_MS,
    });
    expect(record?.matchId).toMatch(/^match_[0-9a-f-]{36}$/);
    expect(record?.matchId).not.toBeNull();

    expect(match).not.toBeNull();
    if (match === null) {
      return;
    }
    expect(match.matchId).toBe(record?.matchId);
    expect(Number.isSafeInteger(match.seed)).toBe(true);
    expect(match.seed).toBeGreaterThanOrEqual(0);
    expect(match.seed).toBeLessThan(0x1_0000_0000);
    expect(match.engine.state.status).toBe('ready');
    expect(match.engine.state.mineCount).toBe(CONFIG.mines);
    // The host moves first and the initial deadlines come from the defaults.
    expect(match.state.turnId).toBe(0);
    expect(match.state.turnPlayerId).toBe(before.hostId);
    expect(match.state.turnDeadlineAt).toBe(NOW + TURN_TIMEOUT_MS);
    expect(match.state.matchDeadlineAt).toBe(NOW + MATCH_TIMEOUT_MS);
    expect(match.state.seq).toBe(before.seq + 1);

    // start broadcasts the room state first, then the redacted snapshot to
    // both seats: one state change, one shared sequence.
    expect(messagesOfType(started, 'room_state')).toHaveLength(2);
    expect(messagesOfType(started, 'snapshot')).toHaveLength(2);
    // Two copies alone do not prove a broadcast: each seat must receive its
    // own `room_state`, and both must receive the shared snapshot.
    expectSeatBroadcast(started, 'room_state', [room.hostToken, room.guestToken]);
    expectSeatBroadcast(started, 'snapshot', [room.hostToken, room.guestToken]);
    expectRoomStateMessages(messagesOfType(started, 'room_state'), {
      state: 'playing',
      seq: before.seq + 1,
      ready: [true, true],
      playerIds: before.seats.map((seat) => seat.playerId),
      stateReason: 'match-started',
      matchId: record?.matchId ?? null,
      turnPlayerId: before.hostId,
    });
    const snapshots = messagesOfType(started, 'snapshot');
    expect(snapshots[0]).toMatchObject({
      type: 'snapshot',
      roomId: room.roomId,
      matchId: record?.matchId,
      seq: before.seq + 1,
      turnId: 0,
      turnPlayerId: before.hostId,
      deadlineAt: NOW + TURN_TIMEOUT_MS,
      matchDeadlineAt: NOW + MATCH_TIMEOUT_MS,
      seedHash: hashSeed(match.seed),
    });
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(JSON.stringify(snapshots[0])).not.toContain('"seed"');
    expect(JSON.stringify(snapshots[0])).not.toContain('"mine"');
    expect(snapshots[0]?.board.flat().every((cell) => !cell.revealed)).toBe(true);
  });

  it('rejects ready, leave and rematch while the match is playing', () => {
    const room = playingRoom();
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.ready(connection(room.hostToken), readyMessage(room.roomId, true)),
      'invalid-state',
    );
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.leave(connection(room.hostToken), leaveMessage(room.roomId)),
      'invalid-state',
    );
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.rematch(connection(room.hostToken), rematchMessage(room.roomId)),
      'invalid-state',
    );
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.start(connection(room.hostToken), startMessage(room.roomId)),
      'invalid-state',
    );
  });
});

describe('online room leave and dissolve', () => {
  it('keeps the room waiting when a waiting guest leaves', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    const joined = joinRoom(manager, created.roomId);

    const beforeLeave = snapshot(manager, created.roomId);
    const left = expectOk(
      manager.leave(connection(joined.guestToken), leaveMessage(created.roomId)),
    );
    const room = manager.getRoom(created.roomId);
    expect(room?.state).toBe('waiting');
    expect(room?.seats).toHaveLength(1);
    expect(room?.seats[0]?.playerId).toBe(room?.hostId);
    expect(room?.stateReason).toBe('player-left');
    expectRoomStateBroadcast(left, {
      state: 'waiting',
      seq: beforeLeave.seq + 1,
      ready: [false],
      playerIds: [beforeLeave.hostId],
      stateReason: 'player-left',
    });
    expect(left.deliveries.map((delivery) => delivery.playerToken)).toEqual([
      created.hostToken,
    ]);

    // A fresh guest joins the same waiting room; the stale leave reason must
    // not survive into the new full-lobby broadcast.
    const rejoined = joinRoom(manager, created.roomId);
    expect(rejoined.guestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manager.getRoom(created.roomId)?.stateReason).toBe('guest-joined');
  });

  it('rejects leave and rematch from a connection with no seat', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    joinRoom(manager, created.roomId);

    // Both commands look the seat up before their state guard, so an unknown
    // token must be rejected as `not-in-room` instead of dereferencing null.
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.leave(connection('stale-token'), leaveMessage(created.roomId)),
      'not-in-room',
    );
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.rematch(connection('stale-token'), rematchMessage(created.roomId)),
      'not-in-room',
    );
    expect(manager.getRoom(created.roomId)?.seats).toHaveLength(2);
  });

  it('returns a ready room to waiting when the guest leaves', () => {
    const room = readyRoom();
    const before = snapshot(room.manager, room.roomId);
    const left = expectOk(
      room.manager.leave(connection(room.guestToken), leaveMessage(room.roomId)),
    );
    const next = room.manager.getRoom(room.roomId);

    expect(before.seats).toHaveLength(2);
    expect(next?.state).toBe('waiting');
    expect(next?.seats).toHaveLength(1);
    expect(next?.seq).toBe(before.seq + 1);
    expect(next?.stateReason).toBe('player-left');
    expectRoomStateBroadcast(left, {
      state: 'waiting',
      seq: before.seq + 1,
      ready: [true],
      playerIds: [before.hostId],
      stateReason: 'player-left',
    });
    expect(left.deliveries).toHaveLength(1);
    expect(left.deliveries[0]?.playerToken).toBe(room.hostToken);
  });

  it('dissolves the room when the host leaves waiting or ready', () => {
    for (const state of ['waiting', 'ready'] as const) {
      const manager = makeManager();
      const created = createRoom(manager);
      const joined = joinRoom(manager, created.roomId);
      if (state === 'ready') {
        expectOk(manager.ready(connection(created.hostToken), readyMessage(created.roomId, true)));
        expectOk(manager.ready(connection(joined.guestToken), readyMessage(created.roomId, true)));
      }
      expect(manager.getRoom(created.roomId)?.state).toBe(state);
      const beforeLeave = snapshot(manager, created.roomId);

      // The terminal broadcast must carry the dissolving transition's seq;
      // reusing the pre-dissolve seq would make clients drop the only message
      // that tells them the room is gone.
      expectRoomClosedBroadcast(
        manager.leave(connection(created.hostToken), leaveMessage(created.roomId)),
        {
          roomId: created.roomId,
          seq: beforeLeave.seq + 1,
          reason: 'host-left',
          playerTokens: [created.hostToken, joined.guestToken],
        },
      );
      expect(manager.getRoom(created.roomId)).toBeUndefined();
      expect(manager.roomCount).toBe(0);

      expectError(
        manager.join(connection(), joinMessage(created.roomId)),
        'room-not-found',
      );
    }
  });

  it('lets the server dissolve playing and finished rooms exactly once', () => {
    const playing = playingRoom();
    const beforePlayingDissolve = snapshot(playing.manager, playing.roomId);
    expectRoomClosedBroadcast(playing.manager.dissolve(playing.roomId, 'server-shutdown'), {
      roomId: playing.roomId,
      seq: beforePlayingDissolve.seq + 1,
      reason: 'server-shutdown',
      playerTokens: [playing.hostToken, playing.guestToken],
    });
    expect(playing.manager.getRoom(playing.roomId)).toBeUndefined();
    expectError(playing.manager.dissolve(playing.roomId, 'again'), 'room-not-found');

    const finished = playingRoom();
    expectOk(finished.manager.finishMatch(finished.roomId, finished.match.matchId, 'mine-hit'));
    const beforeFinishedDissolve = snapshot(finished.manager, finished.roomId);
    expectRoomClosedBroadcast(finished.manager.dissolve(finished.roomId, 'host-closed'), {
      roomId: finished.roomId,
      seq: beforeFinishedDissolve.seq + 1,
      reason: 'host-closed',
      playerTokens: [finished.hostToken, finished.guestToken],
    });
    expect(finished.manager.getRoom(finished.roomId)).toBeUndefined();

    // A blank server reason falls back to the neutral default instead of
    // broadcasting an empty room_closed reason.
    const blankReason = playingRoom();
    const beforeBlankDissolve = snapshot(blankReason.manager, blankReason.roomId);
    expectRoomClosedBroadcast(blankReason.manager.dissolve(blankReason.roomId, '   '), {
      roomId: blankReason.roomId,
      seq: beforeBlankDissolve.seq + 1,
      reason: 'dissolved',
      playerTokens: [blankReason.hostToken, blankReason.guestToken],
    });
  });

  it('rejects leave in finished because the room closes through dissolve', () => {
    const room = playingRoom();
    expectOk(room.manager.finishMatch(room.roomId, room.match.matchId, 'forfeit'));
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.leave(connection(room.hostToken), leaveMessage(room.roomId)),
      'invalid-state',
    );
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.leave(connection(room.guestToken), leaveMessage(room.roomId)),
      'invalid-state',
    );
    expect(room.manager.getRoom(room.roomId)?.state).toBe('finished');
  });
});

describe('online room join timeout', () => {
  it('uses a 120 s deadline and rejects an early timeout without changing state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const manager = makeManager({ now: () => Date.now() });
    const created = createRoom(manager);
    joinRoom(manager, created.roomId);
    const room = manager.getRoom(created.roomId);
    expect(room?.joinDeadlineAt).toBe(NOW + JOIN_TIMEOUT_MS);

    vi.advanceTimersByTime(JOIN_TIMEOUT_MS - 1);
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.timeout(created.roomId, 'join'),
      'deadline-passed',
    );
    expect(manager.getRoom(created.roomId)?.state).toBe('waiting');
  });

  it('dissolves after 120 s and delivers timeout + room_closed to both seats', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const manager = makeManager({ now: () => Date.now() });
    const created = createRoom(manager);
    const joined = joinRoom(manager, created.roomId);
    const before = snapshot(manager, created.roomId);

    const results: RoomCommandResult[] = [];
    setTimeout(() => {
      results.push(manager.timeout(created.roomId, 'join'));
    }, JOIN_TIMEOUT_MS);

    vi.advanceTimersByTime(JOIN_TIMEOUT_MS - 1);
    expectError(manager.timeout(created.roomId, 'join'), 'deadline-passed');
    expect(manager.getRoom(created.roomId)).toEqual(before);

    vi.advanceTimersByTime(1);
    const result = results[0];
    if (result === undefined) {
      throw new Error('join timer did not fire');
    }
    const success = expectOk(result);

    expect(success.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'timeout',
      'timeout',
      'room_closed',
      'room_closed',
    ]);
    expect(success.deliveries.map((delivery) => delivery.playerToken)).toEqual([
      created.hostToken,
      joined.guestToken,
      created.hostToken,
      joined.guestToken,
    ]);
    expect(success.deliveries[0]?.message).toMatchObject({
      type: 'timeout',
      roomId: created.roomId,
      matchId: null,
      timer: 'join',
      subjectId: null,
      deadlineAt: before.joinDeadlineAt,
      resultingState: 'dissolved',
      reason: 'join-timeout',
    });
    expect(success.deliveries[2]?.message).toMatchObject({
      type: 'room_closed',
      roomId: created.roomId,
      reason: 'join-timeout',
      finalState: 'dissolved',
    });
    expectTimeoutThenClose(success, before.seq);

    expect(manager.getRoom(created.roomId)).toBeUndefined();
    expect(manager.roomCount).toBe(0);
    expectError(
      manager.join(connection(), joinMessage(created.roomId)),
      'room-not-found',
    );
  });

  it('uses the rematch-reset join window for the next timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const manager = makeManager({ now: () => Date.now() });
    const created = createRoom(manager);
    const joined = joinRoom(manager, created.roomId);
    expectOk(manager.ready(connection(created.hostToken), readyMessage(created.roomId, true)));
    expectOk(manager.ready(connection(joined.guestToken), readyMessage(created.roomId, true)));
    expectOk(manager.start(connection(created.hostToken), startMessage(created.roomId)));
    const match = manager.getMatch(created.roomId);
    if (match === null) {
      throw new Error('start must create a match');
    }
    expectOk(manager.finishMatch(created.roomId, match.matchId, 'mine-hit'));

    vi.advanceTimersByTime(60_000);
    expectOk(manager.rematch(connection(created.hostToken), rematchMessage(created.roomId, true)));
    expectOk(manager.rematch(connection(joined.guestToken), rematchMessage(created.roomId, true)));
    expect(manager.getRoom(created.roomId)?.joinDeadlineAt).toBe(NOW + 180_000);

    // The original create-time deadline is now stale.
    vi.advanceTimersByTime(60_000);
    expectError(manager.timeout(created.roomId, 'join'), 'deadline-passed');
    expect(manager.getRoom(created.roomId)?.state).toBe('ready');

    const beforeTimeout = snapshot(manager, created.roomId);
    vi.advanceTimersByTime(60_000);
    const success = expectOk(manager.timeout(created.roomId, 'join'));
    expect(success.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'timeout',
      'timeout',
      'room_closed',
      'room_closed',
    ]);
    expectTimeoutThenClose(success, beforeTimeout.seq);
    expect(manager.getRoom(created.roomId)).toBeUndefined();
  });

  it('also dissolves a ready room whose join window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const manager = makeManager({ now: () => Date.now() });
    const created = createRoom(manager);
    const joined = joinRoom(manager, created.roomId);
    expectOk(manager.ready(connection(created.hostToken), readyMessage(created.roomId, true)));
    expectOk(manager.ready(connection(joined.guestToken), readyMessage(created.roomId, true)));
    expect(manager.getRoom(created.roomId)?.state).toBe('ready');

    const beforeTimeout = snapshot(manager, created.roomId);
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS);
    const success = expectOk(manager.timeout(created.roomId, 'join'));
    expect(success.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'timeout',
      'timeout',
      'room_closed',
      'room_closed',
    ]);
    expectTimeoutThenClose(success, beforeTimeout.seq);
    expect(manager.getRoom(created.roomId)).toBeUndefined();
  });

  it('rejects turn, match and expired join timers outside the lobby', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const playing = playingRoom({ now: () => Date.now() });
    const beforePlaying = snapshot(playing.manager, playing.roomId);

    expectRejectedWithoutChange(
      playing.manager,
      playing.roomId,
      () => playing.manager.timeout(playing.roomId, 'turn'),
      'invalid-state',
    );
    expectRejectedWithoutChange(
      playing.manager,
      playing.roomId,
      () => playing.manager.timeout(playing.roomId, 'match'),
      'invalid-state',
    );

    // A join timer that was scheduled before `start` can fire after the
    // deadline while the match is running; it must not dissolve the room.
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS + 1);
    expectRejectedWithoutChange(
      playing.manager,
      playing.roomId,
      () => playing.manager.timeout(playing.roomId, 'join'),
      'invalid-state',
    );
    expect(playing.manager.getRoom(playing.roomId)).toEqual(beforePlaying);
    expect(playing.manager.getMatch(playing.roomId)).toBe(playing.match);

    // The same expired join timer must not close a finished room either.
    expectOk(
      playing.manager.finishMatch(playing.roomId, playing.match.matchId, 'mine-hit'),
    );
    const beforeFinished = snapshot(playing.manager, playing.roomId);
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS + 1);
    expectRejectedWithoutChange(
      playing.manager,
      playing.roomId,
      () => playing.manager.timeout(playing.roomId, 'join'),
      'invalid-state',
    );
    expect(playing.manager.getRoom(playing.roomId)).toEqual(beforeFinished);
  });
});

describe('online room finished and rematch', () => {
  it('keeps the finished result until both players accept the rematch', () => {
    const room = playingRoom();
    const beforeFinish = snapshot(room.manager, room.roomId);
    expectRoomStateBroadcast(
      room.manager.finishMatch(room.roomId, room.match.matchId, 'mine-hit'),
      {
        state: 'finished',
        seq: beforeFinish.seq + 1,
        stateReason: 'mine-hit',
        ready: [true, true],
        playerIds: beforeFinish.seats.map((seat) => seat.playerId),
        matchId: room.match.matchId,
      },
    );
    const finishedRecord = room.manager.getRoom(room.roomId);
    expect(finishedRecord).toMatchObject({
      state: 'finished',
      turnPlayerId: null,
      deadlineAt: null,
      stateReason: 'mine-hit',
    });
    expect(finishedRecord?.matchId).toBe(room.match.matchId);
    expect(room.manager.getMatch(room.roomId)).toBe(room.match);

    const beforeHostRematch = snapshot(room.manager, room.roomId);
    expectRoomStateBroadcast(
      room.manager.rematch(connection(room.hostToken), rematchMessage(room.roomId, true)),
      {
        state: 'finished',
        seq: beforeHostRematch.seq + 1,
        stateReason: 'rematch-pending',
        ready: [true, true],
        playerIds: beforeHostRematch.seats.map((seat) => seat.playerId),
        matchId: room.match.matchId,
      },
    );
    expect(room.manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(room.manager.getRoom(room.roomId)?.matchId).toBe(room.match.matchId);

    const beforeGuestRematch = snapshot(room.manager, room.roomId);
    expectRoomStateBroadcast(
      room.manager.rematch(connection(room.guestToken), rematchMessage(room.roomId, true)),
      {
        state: 'ready',
        seq: beforeGuestRematch.seq + 1,
        stateReason: 'rematch',
        ready: [true, true],
        playerIds: beforeGuestRematch.seats.map((seat) => seat.playerId),
        matchId: null,
      },
    );
    const ready = room.manager.getRoom(room.roomId);
    expect(ready).toMatchObject({
      state: 'ready',
      matchId: null,
      turnPlayerId: null,
      deadlineAt: null,
      stateReason: 'rematch',
      joinDeadlineAt: NOW + JOIN_TIMEOUT_MS,
    });
    expect(ready?.seats).toHaveLength(2);
    expect(ready?.seats.map((seat) => seat.playerId)).toEqual(
      finishedRecord?.seats.map((seat) => seat.playerId),
    );
    expect(ready?.seats.every((seat) => seat.ready)).toBe(true);
    expect(room.manager.getMatch(room.roomId)).toBeNull();
  });

  it('lets a decline cancel the whole pending rematch', () => {
    const room = playingRoom();
    expectOk(room.manager.finishMatch(room.roomId, room.match.matchId, 'forfeit'));
    expectOk(room.manager.rematch(connection(room.hostToken), rematchMessage(room.roomId, true)));
    const beforeDecline = snapshot(room.manager, room.roomId);
    // A decline is not a state transfer, but its broadcast still advances the
    // seq and must say why: clients may otherwise keep showing rematch-pending.
    expectRoomStateBroadcast(
      room.manager.rematch(connection(room.guestToken), rematchMessage(room.roomId, false)),
      {
        state: 'finished',
        seq: beforeDecline.seq + 1,
        stateReason: 'rematch-declined',
        ready: [true, true],
        playerIds: beforeDecline.seats.map((seat) => seat.playerId),
        matchId: room.match.matchId,
      },
    );
    expect(room.manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(room.manager.getRoom(room.roomId)?.matchId).toBe(room.match.matchId);

    // The host's earlier accept must have been cancelled too: one fresh
    // acceptance is not enough to restart the room.
    expectOk(room.manager.rematch(connection(room.guestToken), rematchMessage(room.roomId, true)));
    expect(room.manager.getRoom(room.roomId)?.state).toBe('finished');

    expectOk(room.manager.rematch(connection(room.hostToken), rematchMessage(room.roomId, true)));
    expect(room.manager.getRoom(room.roomId)?.state).toBe('ready');
  });

  it('rejects a late end from an earlier match', () => {
    const room = playingRoom();
    const firstMatchId = room.match.matchId;
    expectOk(room.manager.finishMatch(room.roomId, firstMatchId, 'forfeit'));
    expectOk(room.manager.rematch(connection(room.hostToken), rematchMessage(room.roomId, true)));
    expectOk(room.manager.rematch(connection(room.guestToken), rematchMessage(room.roomId, true)));
    expectOk(room.manager.start(connection(room.hostToken), startMessage(room.roomId)));

    const failure = expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.finishMatch(room.roomId, firstMatchId, 'forfeit'),
      'invalid-state',
    );
    expect(failure.error.roomId).toBe(room.roomId);
    expect(room.manager.getRoom(room.roomId)?.state).toBe('playing');
  });

  it('starts the next match with a fresh id, seed and engine after rematch', () => {
    let now = NOW;
    let nextSeed = 1_000;
    const manager = createRoomManager({
      now: () => now,
      createSeed: () => {
        nextSeed += 1_000;
        return nextSeed;
      },
    });
    const created = createRoom(manager);
    const joined = joinRoom(manager, created.roomId);
    expectOk(manager.ready(connection(created.hostToken), readyMessage(created.roomId, true)));
    expectOk(manager.ready(connection(joined.guestToken), readyMessage(created.roomId, true)));
    const firstStart = expectOk(
      manager.start(connection(created.hostToken), startMessage(created.roomId)),
    );
    expect(firstStart.deliveries).toHaveLength(4);
    const firstMatch = manager.getMatch(created.roomId);
    if (firstMatch === null) {
      throw new Error('first start must create a match');
    }
    expect(firstMatch.seed).toBe(2_000);
    const firstMatchId = manager.getRoom(created.roomId)?.matchId;

    expectOk(manager.finishMatch(created.roomId, firstMatch.matchId, 'all-safe-revealed'));
    now += 30_000;
    expectOk(manager.rematch(connection(created.hostToken), rematchMessage(created.roomId, true)));
    expectOk(manager.rematch(connection(joined.guestToken), rematchMessage(created.roomId, true)));
    const rematchDeadline = manager.getRoom(created.roomId)?.joinDeadlineAt;
    expect(rematchDeadline).toBe(now + JOIN_TIMEOUT_MS);

    now += 5_000;
    expectOk(manager.start(connection(created.hostToken), startMessage(created.roomId)));
    const secondMatch = manager.getMatch(created.roomId);
    if (secondMatch === null) {
      throw new Error('second start must create a match');
    }
    expect(manager.getRoom(created.roomId)?.matchId).not.toBe(firstMatchId);
    expect(secondMatch.matchId).toBe(manager.getRoom(created.roomId)?.matchId);
    expect(secondMatch.seed).not.toBe(firstMatch.seed);
    expect(secondMatch.seed).toBe(3_000);
    expect(secondMatch.engine).not.toBe(firstMatch.engine);
    expect(manager.getRoom(created.roomId)?.state).toBe('playing');
  });

  it('rejects finish and rematch outside their allowed states', () => {
    const manager = makeManager();
    const created = createRoom(manager);
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.finishMatch(created.roomId, 'match_missing', 'mine-hit'),
      'invalid-state',
    );
    expectRejectedWithoutChange(
      manager,
      created.roomId,
      () => manager.rematch(connection(created.hostToken), rematchMessage(created.roomId)),
      'invalid-state',
    );
  });
});

describe('online authoritative match', () => {
  it('uses the configured turn and match timeouts for the start deadlines', () => {
    const room = playingRoom({ turnTimeoutMs: 1_000, matchTimeoutMs: 5_000 });
    const match = matchOf(room.manager, room.roomId);
    const record = room.manager.getRoom(room.roomId);

    expect(match.state.turnDeadlineAt).toBe(NOW + 1_000);
    expect(match.state.matchDeadlineAt).toBe(NOW + 5_000);
    expect(record?.deadlineAt).toBe(NOW + 1_000);
  });

  it('rotates the turn and resets the turn deadline from each accepted action', () => {
    let now = NOW;
    const room = playingRoom({
      now: () => now,
      turnTimeoutMs: 1_000,
      matchTimeoutMs: 60_000,
    });
    const { hostId, guestId } = seatIds(room.manager, room.roomId);

    now += 400;
    expectOk(
      room.manager.action(
        connection(room.hostToken),
        actionFor(room.manager, room.roomId, { actionId: 'rotate-1' }),
      ),
    );
    expect(room.manager.getRoom(room.roomId)).toMatchObject({
      turnPlayerId: guestId,
      deadlineAt: now + 1_000,
    });
    expect(matchOf(room.manager, room.roomId).state.turnDeadlineAt).toBe(now + 1_000);

    now += 500;
    const hidden = firstHiddenCell(room.manager, room.roomId);
    expectOk(
      room.manager.action(
        connection(room.guestToken),
        actionFor(room.manager, room.roomId, {
          actionId: 'rotate-2',
          kind: 'flag',
          row: hidden.row,
          col: hidden.col,
        }),
      ),
    );
    expect(room.manager.getRoom(room.roomId)).toMatchObject({
      turnPlayerId: hostId,
      deadlineAt: now + 1_000,
    });
    expect(matchOf(room.manager, room.roomId).state.turnId).toBe(2);
  });

  it('never lets a reset turn deadline run past the match deadline', () => {
    let now = NOW;
    const room = playingRoom({
      now: () => now,
      turnTimeoutMs: 10_000,
      matchTimeoutMs: 1_000,
    });

    now += 400;
    expectOk(
      room.manager.action(
        connection(room.hostToken),
        actionFor(room.manager, room.roomId, { actionId: 'capped-deadline' }),
      ),
    );
    expect(room.manager.getRoom(room.roomId)?.deadlineAt).toBe(NOW + 1_000);
    expect(matchOf(room.manager, room.roomId).state.turnDeadlineAt).toBe(NOW + 1_000);
  });

  it('accepts one action: room seq/turn advance, action_result then snapshot', () => {
    const room = playingRoom({ turnTimeoutMs: 1_000, matchTimeoutMs: 60_000 });
    const { guestId } = seatIds(room.manager, room.roomId);
    const before = snapshot(room.manager, room.roomId);
    const beforeMatch = matchOf(room.manager, room.roomId);

    const message = actionFor(room.manager, room.roomId, { actionId: 'host-reveal' });
    const result = room.manager.action(connection(room.hostToken), message);

    const success = expectOk(result);
    expect(success.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'action_result',
      'snapshot',
      'snapshot',
    ]);
    // The verdict goes to the actor first; the snapshot is a broadcast.
    expect(success.deliveries[0]?.playerToken).toBe(room.hostToken);
    expectSeatBroadcast(result, 'action_result', [room.hostToken]);

    const actionResult = messagesOfType(result, 'action_result')[0];
    if (actionResult === undefined) {
      throw new Error('expected an action_result delivery');
    }
    expect(actionResult).toMatchObject({
      type: 'action_result',
      roomId: room.roomId,
      matchId: room.match.matchId,
      actionId: 'host-reveal',
      seq: before.seq + 1,
      turnId: 1,
      accepted: true,
      reason: null,
      turnPlayerId: guestId,
      deadlineAt: NOW + 1_000,
    });
    expect(actionResult.revealedCells.length).toBeGreaterThan(0);
    expect(actionResult.flaggedCell).toBeNull();

    const snapshots = messagesOfType(result, 'snapshot');
    expect(snapshots).toHaveLength(2);
    // The accepted-action snapshot must reach both seats, not twice the actor.
    expectSeatBroadcast(result, 'snapshot', [room.hostToken, room.guestToken]);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0]).toMatchObject({
      type: 'snapshot',
      roomId: room.roomId,
      matchId: room.match.matchId,
      seq: before.seq + 1,
      turnId: 1,
      turnPlayerId: guestId,
      deadlineAt: NOW + 1_000,
      matchDeadlineAt: NOW + 60_000,
      seedHash: beforeMatch.state.seedHash,
    });

    const after = snapshot(room.manager, room.roomId);
    expect(after).toMatchObject({
      state: 'playing',
      seq: before.seq + 1,
      turnPlayerId: guestId,
      deadlineAt: NOW + 1_000,
    });
    const afterMatch = matchOf(room.manager, room.roomId);
    expect(afterMatch.state.seq).toBe(before.seq + 1);
    expect(afterMatch.state.turnId).toBe(1);
    expect(afterMatch.state.turnPlayerId).toBe(guestId);
    expect(afterMatch.state.actions).toHaveLength(1);
    expect(afterMatch.state.digests).toHaveLength(1);
    expect(afterMatch.state.engine.state.board[0]?.[0]?.revealed).toBe(true);
  });

  it('returns the cached action_result for a repeated actionId without moving seq/turn', () => {
    const room = playingRoom();
    const message = actionFor(room.manager, room.roomId, { actionId: 'retry-me' });
    expectOk(room.manager.action(connection(room.hostToken), message));
    const before = snapshot(room.manager, room.roomId);
    const beforeMatch = matchOf(room.manager, room.roomId);

    // The host's turn has already passed when the retry arrives; idempotency
    // must win and return the cached verdict without applying a second step.
    const duplicate = room.manager.action(connection(room.hostToken), message);
    const success = expectOk(duplicate);
    expect(success.deliveries).toHaveLength(1);
    expect(success.deliveries[0]?.playerToken).toBe(room.hostToken);
    expect(success.deliveries[0]?.message.type).toBe('action_result');
    const cached = messagesOfType(duplicate, 'action_result')[0];
    if (cached === undefined) {
      throw new Error('expected the cached action_result');
    }
    expect(cached).toMatchObject({
      actionId: 'retry-me',
      accepted: true,
      seq: before.seq,
      turnId: beforeMatch.state.turnId,
    });

    expect(room.manager.getRoom(room.roomId)).toEqual(before);
    expect(matchOf(room.manager, room.roomId)).toBe(beforeMatch);
  });

  it('rejects another player reusing an accepted actionId without moving seq/turn', () => {
    const room = playingRoom();
    const message = actionFor(room.manager, room.roomId, { actionId: 'shared-id' });
    expectOk(room.manager.action(connection(room.hostToken), message));

    expectMatchRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.action(connection(room.guestToken), message),
      'invalid-action',
    );
  });

  it('rejects non-current, stale, expired, out-of-bounds and foreign actions unchanged', () => {
    const room = playingRoom({ turnTimeoutMs: 1_000, matchTimeoutMs: 60_000 });
    const manager = room.manager;
    const host = connection(room.hostToken);
    const guest = connection(room.guestToken);

    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.action(guest, actionFor(manager, room.roomId, { actionId: 'not-my-turn' })),
      'not-your-turn',
    );
    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, {
            actionId: 'stale-seq',
            seq: (manager.getRoom(room.roomId)?.seq ?? 1) - 1,
          }),
        ),
      'stale-state',
    );
    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, { actionId: 'stale-turn', turnId: 99 }),
        ),
      'stale-state',
    );
    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, {
            actionId: 'out-of-bounds',
            row: CONFIG.rows,
            col: 0,
          }),
        ),
      'invalid-action',
    );
    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, { actionId: 'other-match', matchId: 'match_other' }),
        ),
      'invalid-action',
    );
    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.action(connection('stale-token'), actionFor(manager, room.roomId)),
      'invalid-action',
    );

    expectMatchError(
      manager.action(host, {
        ...actionFor(manager, room.roomId, { actionId: 'missing-room' }),
        roomId: 'room_missing',
      }),
      'room-not-found',
    );

    // A cell that is already revealed is not a legal target, and the rejected
    // attempt must not consume the guest's turn either.
    expectOk(
      manager.action(host, actionFor(manager, room.roomId, { actionId: 'open-corner' })),
    );
    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          guest,
          actionFor(manager, room.roomId, { actionId: 'already-revealed', row: 0, col: 0 }),
        ),
      'invalid-action',
    );

    // The deadline is exclusive: arriving exactly at it is already too late.
    let now = NOW;
    const timed = playingRoom({
      now: () => now,
      turnTimeoutMs: 1_000,
      matchTimeoutMs: 60_000,
    });
    now += 1_000;
    expectMatchRejectedWithoutChange(
      timed.manager,
      timed.roomId,
      () =>
        timed.manager.action(
          connection(timed.hostToken),
          actionFor(timed.manager, timed.roomId, { actionId: 'too-late' }),
        ),
      'deadline-passed',
    );

    // No action is valid before start; the lobby has no match at all.
    const lobby = readyRoom();
    expectMatchRejectedWithoutChange(
      lobby.manager,
      lobby.roomId,
      () =>
        lobby.manager.action(connection(lobby.hostToken), {
          type: 'action',
          roomId: lobby.roomId,
          matchId: 'match_missing',
          actionId: 'lobby-action',
          seq: 0,
          turnId: 0,
          kind: 'reveal',
          row: 0,
          col: 0,
          clientTimeMs: NOW,
        }),
      'invalid-action',
    );
  });

  it('broadcasts end and finishes the room when the current player hits a mine', () => {
    const room = playingRoom({ createSeed: () => 2_024 });
    const manager = room.manager;
    const { hostId, guestId } = seatIds(manager, room.roomId);
    const before = snapshot(manager, room.roomId);

    expectOk(
      manager.action(connection(room.hostToken), actionFor(manager, room.roomId, {
        actionId: 'first-reveal',
      })),
    );
    const mine = matchOf(manager, room.roomId)
      .state.engine.state.board.flat()
      .find((cell) => cell.mine && !cell.revealed && !cell.flagged);
    if (mine === undefined) {
      throw new Error('expected a hidden mine after the first reveal');
    }

    const result = manager.action(
      connection(room.guestToken),
      actionFor(manager, room.roomId, {
        actionId: 'hit-the-mine',
        row: mine.row,
        col: mine.col,
      }),
    );
    const success = expectOk(result);
    expect(success.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'action_result',
      'snapshot',
      'snapshot',
      'end',
      'end',
      'room_state',
      'room_state',
    ]);

    // The terminal snapshot and end are broadcasts: both seats must receive
    // one copy each, not two copies to the actor.
    expectSeatBroadcast(result, 'snapshot', [room.hostToken, room.guestToken]);
    expectSeatBroadcast(result, 'end', [room.hostToken, room.guestToken]);

    const ends = messagesOfType(result, 'end');
    expect(ends).toHaveLength(2);
    expect(ends[0]).toEqual(ends[1]);
    if (ends[0] === undefined) {
      throw new Error('expected an end delivery');
    }
    expect(ends[0]).toMatchObject({
      type: 'end',
      roomId: room.roomId,
      matchId: room.match.matchId,
      reason: 'mine-hit',
      winnerId: hostId,
      loserId: guestId,
      seed: room.match.seed,
      // Two accepted actions: the host's opening reveal and the fatal reveal.
      seq: before.seq + 2,
    });
    expect(countMines(ends[0])).toBe(CONFIG.mines);

    expectRoomStateMessages(messagesOfType(result, 'room_state'), {
      state: 'finished',
      seq: before.seq + 2,
      ready: [true, true],
      stateReason: 'mine-hit',
      matchId: room.match.matchId,
      turnPlayerId: null,
    });

    const record = manager.getRoom(room.roomId);
    expect(record).toMatchObject({
      state: 'finished',
      seq: before.seq + 2,
      turnPlayerId: null,
      deadlineAt: null,
      matchId: room.match.matchId,
    });
    const match = matchOf(manager, room.roomId);
    expect(match.state.finished).toBe(true);
    expect(match.state.end?.reason).toBe('mine-hit');
    expect(match.state.seq).toBe(before.seq + 2);

    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.action(connection(room.hostToken), actionFor(manager, room.roomId)),
      'invalid-action',
    );
  });

  it('forfeits into exactly one end per seat and a finished room', () => {
    const room = playingRoom();
    const manager = room.manager;
    const { guestId } = seatIds(manager, room.roomId);
    const before = snapshot(manager, room.roomId);

    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.forfeit(room.roomId, 'match_other', guestId),
      'invalid-action',
    );
    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.forfeit(room.roomId, room.match.matchId, 'player_missing'),
      'invalid-action',
    );

    const result = manager.forfeit(room.roomId, room.match.matchId, guestId);
    const success = expectOk(result);
    expect(success.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'end',
      'end',
      'room_state',
      'room_state',
    ]);

    // One end per seat, not two to the forfeiting seat.
    expectSeatBroadcast(result, 'end', [room.hostToken, room.guestToken]);

    const ends = messagesOfType(result, 'end');
    expect(ends).toHaveLength(2);
    expect(ends[0]).toEqual(ends[1]);
    if (ends[0] === undefined) {
      throw new Error('expected an end delivery');
    }
    expect(ends[0]).toMatchObject({
      type: 'end',
      roomId: room.roomId,
      matchId: room.match.matchId,
      reason: 'forfeit',
      winnerId: before.hostId,
      loserId: guestId,
      seed: room.match.seed,
      seq: before.seq + 1,
    });
    expect(countMines(ends[0])).toBe(CONFIG.mines);

    expectRoomStateMessages(messagesOfType(result, 'room_state'), {
      state: 'finished',
      seq: before.seq + 1,
      ready: [true, true],
      stateReason: 'forfeit',
      matchId: room.match.matchId,
      turnPlayerId: null,
    });

    expect(manager.getRoom(room.roomId)).toMatchObject({
      state: 'finished',
      turnPlayerId: null,
      deadlineAt: null,
    });
    const match = matchOf(manager, room.roomId);
    expect(match.state.finished).toBe(true);
    expect(match.state.end?.reason).toBe('forfeit');
    expect(match.state.seq).toBe(before.seq + 1);

    expectMatchRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.forfeit(room.roomId, room.match.matchId, guestId),
      'invalid-action',
    );
  });

  it('clears the match runtime state on rematch and starts a fresh match', () => {
    const room = playingRoom();
    const manager = room.manager;
    const { guestId } = seatIds(manager, room.roomId);
    const firstMatchId = room.match.matchId;
    expectOk(manager.forfeit(room.roomId, firstMatchId, guestId));

    expectOk(manager.rematch(connection(room.hostToken), rematchMessage(room.roomId, true)));
    expectOk(manager.rematch(connection(room.guestToken), rematchMessage(room.roomId, true)));

    expect(manager.getRoom(room.roomId)).toMatchObject({
      state: 'ready',
      matchId: null,
      turnPlayerId: null,
      deadlineAt: null,
    });
    expect(manager.getMatch(room.roomId)).toBeNull();
    expect(manager.getReplayRecord(room.roomId)).toBeNull();
    expect(manager.getReplayDigests(room.roomId)).toBeNull();

    const restarted = manager.start(
      connection(room.hostToken),
      startMessage(room.roomId),
    );
    expectOk(restarted);
    const second = matchOf(manager, room.roomId);
    expect(second.matchId).not.toBe(firstMatchId);
    expect(second.state.actions).toEqual([]);
    expect(second.state.digests).toEqual([]);
    expect(second.state.finished).toBe(false);
    expect(second.state.seq).toBe(manager.getRoom(room.roomId)?.seq);
    expect(messagesOfType(restarted, 'snapshot')[0]?.seq).toBe(
      manager.getRoom(room.roomId)?.seq,
    );
  });

  it('exposes the replay record and digests of the accepted actions', () => {
    const room = playingRoom({ turnTimeoutMs: 1_000, matchTimeoutMs: 60_000 });
    const manager = room.manager;
    const before = snapshot(manager, room.roomId);

    expect(manager.getReplayRecord('room_missing')).toBeNull();
    expect(manager.getReplayDigests('room_missing')).toBeNull();
    const empty = manager.getReplayRecord(room.roomId);
    if (empty === null) {
      throw new Error('a started match must expose a replay record');
    }
    expect(empty.actions).toEqual([]);
    expect(manager.getReplayDigests(room.roomId)).toEqual([]);

    expectOk(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'replay-reveal' }),
      ),
    );
    const hidden = firstHiddenCell(manager, room.roomId);
    expectOk(
      manager.action(
        connection(room.guestToken),
        actionFor(manager, room.roomId, {
          actionId: 'replay-flag',
          kind: 'flag',
          row: hidden.row,
          col: hidden.col,
        }),
      ),
    );

    const record = manager.getReplayRecord(room.roomId);
    const digests = manager.getReplayDigests(room.roomId);
    if (record === null || digests === null) {
      throw new Error('the accepted actions must be recorded for replay');
    }
    expect(record.matchId).toBe(room.match.matchId);
    expect(record.seed).toBe(room.match.seed);
    expect(record.config).toEqual(CONFIG);
    expect(record.actions.map((action) => action.seq)).toEqual([
      before.seq + 1,
      before.seq + 2,
    ]);
    expect(record.actions.map((action) => action.actionId)).toEqual([
      'replay-reveal',
      'replay-flag',
    ]);
    expect(record.actions.map((action) => action.kind)).toEqual(['reveal', 'flag']);
    expect(digests.map((digest) => digest.seq)).toEqual([before.seq + 1, before.seq + 2]);

    const outcome = replayMatch(record, digests);
    expect(outcome.digests).toEqual([...digests]);
    expect(outcome.status).toBe('playing');
  });
});

describe('online room isolation and source constraints', () => {
  it('returns room-not-found for every command against an unknown room', () => {
    const manager = makeManager();
    const missing = 'room_missing';
    const token = 'stale-token';
    const results: ReadonlyArray<readonly [string, RoomCommandResult]> = [
      ['join', manager.join(connection(), joinMessage(missing))],
      ['ready', manager.ready(connection(token), readyMessage(missing, true))],
      ['start', manager.start(connection(token), startMessage(missing))],
      ['leave', manager.leave(connection(token), leaveMessage(missing))],
      ['rematch', manager.rematch(connection(token), rematchMessage(missing))],
      ['dissolve', manager.dissolve(missing, 'server-shutdown')],
      ['timeout', manager.timeout(missing, 'join')],
      // Match-layer seam (#484): not a wire command, but it has its own
      // explicit room-not-found branch and must not throw on a missing room.
      ['finishMatch', manager.finishMatch(missing, 'match_missing', 'mine-hit')],
    ];

    for (const [name, result] of results) {
      expectError(result, 'room-not-found');
      if (!result.ok) {
        expect(result.error.code, name).toBe('room-not-found');
      }
      expect(result.ok, name).toBe(false);
    }
    expect(manager.roomCount).toBe(0);
  });

  it('cannot recover a live room from another manager instance', () => {
    const first = makeManager();
    const created = createRoom(first);
    joinRoom(first, created.roomId);
    expect(first.roomCount).toBe(1);

    const second = makeManager();
    expect(second.roomCount).toBe(0);
    expect(second.getRoom(created.roomId)).toBeUndefined();
    expectError(second.join(connection(), joinMessage(created.roomId)), 'room-not-found');
    expectError(
      second.rematch(
        connection('unknown-token'),
        rematchMessage(created.roomId),
      ),
      'room-not-found',
    );
  });

  it('keeps the room table free of filesystem and database imports', () => {
    expect(MANAGER_SOURCE).not.toMatch(/node:fs|from\s+['"]fs['"]|import\s*\(\s*['"]fs['"]/);
    expect(MANAGER_SOURCE).not.toMatch(/\b(readFile|writeFile|appendFile|createReadStream)\b/);
    expect(MANAGER_SOURCE).not.toMatch(
      /from\s+['"](?:node:)?(?:sqlite|better-sqlite3|pg|mysql|mysql2|mongodb|redis|ioredis|prisma|knex|typeorm)['"]/,
    );
  });
});
