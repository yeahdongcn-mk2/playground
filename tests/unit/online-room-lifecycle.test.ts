import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JOIN_TIMEOUT_MS,
  ROOM_CAPACITY,
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
  validateServerMessage,
  type CreateMessage,
  type JoinMessage,
  type LeaveMessage,
  type ReadyMessage,
  type RematchMessage,
  type RoomStateMessage,
  type StartMessage,
} from '../../src/games/minesweeper/online/index';
import type { MinesweeperConfig } from '../../src/games/minesweeper/engine';

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
  result: RoomCommandResult,
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
  },
): void {
  const success = expectOk(result);
  expect(success.deliveries).toHaveLength(expected.ready.length);
  expect(new Set(success.deliveries.map((delivery) => delivery.playerToken)).size).toBe(
    expected.ready.length,
  );
  for (const delivery of success.deliveries) {
    const message = delivery.message;
    if (message.type !== 'room_state') {
      throw new Error(`expected a room_state delivery, got ${message.type}`);
    }
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
  }
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
    const joined = joinRoom(manager, created.roomId);
    const room = manager.getRoom(created.roomId);

    expect(room?.state).toBe('waiting');
    expect(room?.seats).toHaveLength(2);
    expect(room?.seats.map((seat) => seat.isHost)).toEqual([true, false]);
    expect(room?.seats.map((seat) => seat.ready)).toEqual([false, false]);
    expect(new Set(room?.seats.map((seat) => seat.playerToken)).size).toBe(2);

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

  it('rejects an invalid config or protocol version without creating a room', () => {
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

    createRoom(manager);
    expect(manager.roomCount).toBe(1);
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

    const started = expectOk(
      room.manager.start(connection(room.hostToken), startMessage(room.roomId)),
    );
    const record = room.manager.getRoom(room.roomId);
    const match = room.manager.getMatch(room.roomId);

    expect(record).toMatchObject({
      state: 'playing',
      seq: before.seq + 1,
      hostId: before.hostId,
      turnPlayerId: before.hostId,
      stateReason: 'match-started',
    });
    expect(record?.matchId).toMatch(/^match_[0-9a-f-]{36}$/);
    expect(record?.matchId).not.toBeNull();
    expect(record?.deadlineAt).toBeNull();

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

    expect(started.deliveries).toHaveLength(2);
    for (const delivery of started.deliveries) {
      expect(delivery.message).toMatchObject({
        type: 'room_state',
        state: 'playing',
        matchId: record?.matchId,
        turnPlayerId: record?.hostId,
      });
    }
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

    const left = expectOk(
      manager.leave(connection(joined.guestToken), leaveMessage(created.roomId)),
    );
    const room = manager.getRoom(created.roomId);
    expect(room?.state).toBe('waiting');
    expect(room?.seats).toHaveLength(1);
    expect(room?.seats[0]?.playerId).toBe(room?.hostId);
    expect(room?.stateReason).toBe('player-left');
    expect(left.deliveries.map((delivery) => delivery.playerToken)).toEqual([
      created.hostToken,
    ]);

    // A fresh guest joins the same waiting room; the stale leave reason must
    // not survive into the new full-lobby broadcast.
    const rejoined = joinRoom(manager, created.roomId);
    expect(rejoined.guestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manager.getRoom(created.roomId)?.stateReason).toBe('guest-joined');
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

      const left = expectOk(
        manager.leave(connection(created.hostToken), leaveMessage(created.roomId)),
      );
      expect(left.deliveries).toHaveLength(2);
      for (const delivery of left.deliveries) {
        expect(delivery.message).toMatchObject({
          type: 'room_closed',
          roomId: created.roomId,
          reason: 'host-left',
          finalState: 'dissolved',
        });
      }
      expect(left.deliveries.map((delivery) => delivery.playerToken)).toEqual([
        created.hostToken,
        joined.guestToken,
      ]);
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
    const closed = expectOk(playing.manager.dissolve(playing.roomId, 'server-shutdown'));
    expect(closed.deliveries).toHaveLength(2);
    expect(closed.deliveries[0]?.message).toMatchObject({
      type: 'room_closed',
      reason: 'server-shutdown',
      finalState: 'dissolved',
    });
    expect(playing.manager.getRoom(playing.roomId)).toBeUndefined();
    expectError(playing.manager.dissolve(playing.roomId, 'again'), 'room-not-found');

    const finished = playingRoom();
    expectOk(finished.manager.finishMatch(finished.roomId, finished.match.matchId, 'mine-hit'));
    const afterFinish = expectOk(finished.manager.dissolve(finished.roomId, 'host-closed'));
    expect(afterFinish.deliveries).toHaveLength(2);
    expect(finished.manager.getRoom(finished.roomId)).toBeUndefined();

    // A blank server reason falls back to the neutral default instead of
    // broadcasting an empty room_closed reason.
    const blankReason = playingRoom();
    const blankClosed = expectOk(blankReason.manager.dissolve(blankReason.roomId, '   '));
    expect(blankClosed.deliveries[0]?.message).toMatchObject({
      type: 'room_closed',
      reason: 'dissolved',
      finalState: 'dissolved',
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

  it('rejects turn and match timers because the match layer owns them', () => {
    const room = playingRoom();
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.timeout(room.roomId, 'turn'),
      'invalid-state',
    );
    expectRejectedWithoutChange(
      room.manager,
      room.roomId,
      () => room.manager.timeout(room.roomId, 'match'),
      'invalid-state',
    );
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
    const declined = expectOk(
      room.manager.rematch(connection(room.guestToken), rematchMessage(room.roomId, false)),
    );
    expect(declined.deliveries).toHaveLength(2);
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
    expect(firstStart.deliveries).toHaveLength(2);
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
