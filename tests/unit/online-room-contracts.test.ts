import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  broadcastToSeats,
  createRoomId,
  DEFAULT_ROOM_SERVER_PORT,
  issuePlayerToken,
  JOIN_TIMEOUT_MS,
  publicRoomState,
  ROOM_CAPACITY,
  ROOM_ERROR_CODES,
  ROOM_ERROR_PROTOCOL_CODE,
  roomErrorMessage,
  roomStateDeliveries,
  seatedCommandSuccess,
  type PublicRoomState,
  type RoomCommandResult,
  type RoomConnection,
  type RoomManager,
  type RoomRecord,
  type RoomSeat,
} from '../../server/room/contracts';
import {
  validateClientMessage,
  validateServerMessage,
} from '../../src/games/minesweeper/online/index';
import type {
  CreateMessage,
  JoinMessage,
  LeaveMessage,
  ReadyMessage,
  RematchMessage,
  StartMessage,
  TimeoutMessage,
} from '../../src/games/minesweeper/online/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN = readFileSync(join(ROOT, 'docs', 'minesweeper-online-design.md'), 'utf8');

interface LifecycleTimer {
  readonly defaultMs: number;
}

interface LifecycleEvent {
  readonly name: string;
}

interface LifecycleDesign {
  readonly capacity: number;
  readonly timers: { readonly join: LifecycleTimer };
  readonly events: readonly LifecycleEvent[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse the JSON fenced block immediately after a design marker. */
function readJsonBlock(marker: string): unknown {
  const pattern = new RegExp(
    '<!--\\s*' + escapeRegExp(marker) + '\\s*-->\\s*```json\\s*\\n([\\s\\S]*?)\\n```',
  );
  const match = pattern.exec(DESIGN);
  if (match === null) {
    throw new Error(`Missing ${marker} JSON block in docs/minesweeper-online-design.md.`);
  }
  const block = match[1];
  if (block === undefined || block.trim().length === 0) {
    throw new Error(`Empty ${marker} JSON block in docs/minesweeper-online-design.md.`);
  }
  return JSON.parse(block) as unknown;
}

const LIFECYCLE = readJsonBlock('design:room-lifecycle') as LifecycleDesign;

const CONFIG = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
} as const satisfies CreateMessage['config'];

const JOINED_AT = 1_700_000_000_000;

function hostSeat(): RoomSeat {
  return {
    playerId: 'player_host',
    playerToken: issuePlayerToken(),
    displayName: 'Ada',
    ready: true,
    presence: 'online',
    isHost: true,
    joinedAt: JOINED_AT,
  };
}

function guestSeat(): RoomSeat {
  return {
    playerId: 'player_guest',
    playerToken: issuePlayerToken(),
    displayName: 'Grace',
    ready: false,
    presence: 'online',
    isHost: false,
    joinedAt: JOINED_AT + 1,
  };
}

/** A complete room record; overrides replace whole fields, never mutate. */
function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  const seat = hostSeat();
  return {
    roomId: 'room_contract_test',
    config: CONFIG,
    capacity: ROOM_CAPACITY,
    state: 'waiting',
    seq: 3,
    hostId: seat.playerId,
    seats: [seat, guestSeat()],
    matchId: null,
    turnPlayerId: null,
    joinDeadlineAt: JOINED_AT + JOIN_TIMEOUT_MS,
    deadlineAt: null,
    stateReason: null,
    ...overrides,
  };
}

const CREATE_MESSAGE: CreateMessage = {
  type: 'create',
  requestId: 'req_create',
  protocolVersion: 1,
  config: CONFIG,
  displayName: 'Ada',
};

const JOIN_MESSAGE: JoinMessage = {
  type: 'join',
  requestId: 'req_join',
  protocolVersion: 1,
  roomId: 'room_contract_test',
  displayName: 'Grace',
};

const RESUME_JOIN_MESSAGE: JoinMessage = {
  ...JOIN_MESSAGE,
  playerToken: issuePlayerToken(),
};

const READY_MESSAGE: ReadyMessage = {
  type: 'ready',
  roomId: 'room_contract_test',
  requestId: 'req_ready',
  ready: true,
};

const START_MESSAGE: StartMessage = {
  type: 'start',
  roomId: 'room_contract_test',
  requestId: 'req_start',
};

const LEAVE_MESSAGE: LeaveMessage = {
  type: 'leave',
  roomId: 'room_contract_test',
  requestId: 'req_leave',
};

const REMATCH_MESSAGE: RematchMessage = {
  type: 'rematch',
  roomId: 'room_contract_test',
  requestId: 'req_rematch',
  accept: true,
};

const TIMEOUT_MESSAGE: TimeoutMessage = {
  type: 'timeout',
  roomId: 'room_contract_test',
  matchId: null,
  seq: 4,
  timer: 'join',
  subjectId: null,
  deadlineAt: JOINED_AT + JOIN_TIMEOUT_MS,
  resultingState: 'dissolved',
  reason: 'join-timeout',
};

const CONNECTION: RoomConnection = {
  connectionId: 'connection_1',
  playerToken: null,
};

/**
 * Every design event the room manager owns. The `satisfies` clause makes
 * deleting or renaming a `RoomManager` method a type error here too.
 */
const ROOM_MANAGER_EVENTS = [
  'create',
  'join',
  'ready',
  'start',
  'leave',
  'dissolve',
  'rematch',
  'timeout',
] as const satisfies readonly (keyof RoomManager)[];

/** Events owned by the authoritative match layer (#484), not the room manager. */
const MATCH_LAYER_EVENTS = ['action', 'end'] as const;
const ROOM_MANAGER_EVENT_SET: ReadonlySet<string> = new Set(ROOM_MANAGER_EVENTS);

/** Every lifecycle command answers with the same rejection shape. */
function stubManager(): RoomManager {
  const reject = (): RoomCommandResult => ({
    ok: false,
    code: 'room-not-found',
    error: roomErrorMessage('room-not-found'),
  });
  return {
    create: () => reject(),
    join: () => reject(),
    ready: () => reject(),
    start: () => reject(),
    leave: () => reject(),
    rematch: () => reject(),
    dissolve: () => reject(),
    timeout: () => reject(),
  };
}

describe('online room contracts constants', () => {
  it('pins the join timeout, capacity and default port', () => {
    expect(JOIN_TIMEOUT_MS).toBe(120_000);
    expect(ROOM_CAPACITY).toBe(2);
    expect(DEFAULT_ROOM_SERVER_PORT).toBe(8787);
  });

  it('matches the capacity and join timer in design:room-lifecycle', () => {
    expect(ROOM_CAPACITY).toBe(LIFECYCLE.capacity);
    expect(JOIN_TIMEOUT_MS).toBe(LIFECYCLE.timers.join.defaultMs);
  });

  it('declares every lifecycle event the room manager owns', () => {
    const events = LIFECYCLE.events.map((event) => event.name);
    for (const event of ROOM_MANAGER_EVENTS) {
      expect(events, `design:room-lifecycle should declare ${event}`).toContain(event);
    }
    const unmanaged = events.filter((event) => !ROOM_MANAGER_EVENT_SET.has(event));
    expect(unmanaged.sort()).toEqual([...MATCH_LAYER_EVENTS]);
  });
});

describe('online room identifiers', () => {
  it('mints unique room ids', () => {
    const ids = Array.from({ length: 500 }, () => createRoomId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^room_[0-9a-f-]{36}$/);
    }
  });

  it('mints unique, high-entropy player tokens', () => {
    const tokens = Array.from({ length: 500 }, () => issuePlayerToken());
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('does not derive a token from the room state it protects', () => {
    const room = makeRoom();
    const state = publicRoomState(room);
    const publicJson = JSON.stringify(state);
    for (const seat of room.seats) {
      expect(publicJson).not.toContain(seat.playerToken);
      expect(seat.playerToken).not.toContain(room.roomId);
    }
  });
});

describe('online room public state', () => {
  it('projects the client-safe room shape without a playerToken', () => {
    const room = makeRoom({ state: 'ready', stateReason: 'all-ready' });
    const state = publicRoomState(room);

    expect(state).toEqual({
      type: 'room_state',
      roomId: room.roomId,
      seq: room.seq,
      state: 'ready',
      hostId: room.hostId,
      capacity: ROOM_CAPACITY,
      players: [
        {
          playerId: 'player_host',
          displayName: 'Ada',
          ready: true,
          presence: 'online',
          isHost: true,
        },
        {
          playerId: 'player_guest',
          displayName: 'Grace',
          ready: false,
          presence: 'online',
          isHost: false,
        },
      ],
      config: CONFIG,
      matchId: null,
      turnPlayerId: null,
      joinDeadlineAt: JOINED_AT + JOIN_TIMEOUT_MS,
      deadlineAt: null,
      stateReason: 'all-ready',
    });
    expect(Object.hasOwn(state, 'playerToken')).toBe(false);
    expect(JSON.stringify(state)).not.toContain('playerToken');
  });

  it('cannot grow a playerToken field without a type error', () => {
    const room = makeRoom();
    // @ts-expect-error publicRoomState deliberately has no playerToken field.
    const leaked: PublicRoomState = { ...publicRoomState(room), playerToken: 'leaked' };
    expect(leaked.roomId).toBe(room.roomId);
  });

  it('produces a public state the #482 server validator accepts', () => {
    const state = publicRoomState(makeRoom());
    const validation = validateServerMessage(state);
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
  });

  it('keeps the room id and public player ids from the record', () => {
    const room = makeRoom();
    const state = publicRoomState(room);
    expect(state.roomId).toBe(room.roomId);
    expect(state.players.map((player) => player.playerId)).toEqual(
      room.seats.map((seat) => seat.playerId),
    );
  });
});

describe('online room delivery model', () => {
  it('sends each seat only its own token in a room_state broadcast', () => {
    const room = makeRoom();
    const deliveries = roomStateDeliveries(room);

    expect(deliveries).toHaveLength(room.seats.length);
    expect(deliveries.map((delivery) => delivery.playerToken)).toEqual(
      room.seats.map((seat) => seat.playerToken),
    );

    for (const delivery of deliveries) {
      expect(delivery.message).toMatchObject({
        type: 'room_state',
        playerToken: delivery.playerToken,
      });
      expect(validateServerMessage(delivery.message).ok).toBe(true);

      const json = JSON.stringify(delivery.message);
      for (const seat of room.seats) {
        if (seat.playerToken !== delivery.playerToken) {
          expect(json).not.toContain(seat.playerToken);
        }
      }
    }
  });

  it('binds the calling connection to the token of the seat it just took', () => {
    const room = makeRoom();
    const host = room.seats[0];
    expect(host).toBeDefined();
    if (host === undefined) {
      return;
    }

    const success = seatedCommandSuccess(room, host);
    expect(success.ok).toBe(true);
    expect(success.boundToken).toBe(host.playerToken);
    expect(success.deliveries).toEqual(roomStateDeliveries(room));
  });

  it('broadcasts one seat-independent message to every seat', () => {
    const room = makeRoom();
    expect(validateServerMessage(TIMEOUT_MESSAGE).ok).toBe(true);

    const deliveries = broadcastToSeats(room, TIMEOUT_MESSAGE);
    expect(deliveries.map((delivery) => delivery.playerToken)).toEqual(
      room.seats.map((seat) => seat.playerToken),
    );
    for (const delivery of deliveries) {
      expect(delivery.message).toBe(TIMEOUT_MESSAGE);
    }
  });

  it('delivers nothing to a room without seats', () => {
    const room = makeRoom({ seats: [] });
    expect(roomStateDeliveries(room)).toEqual([]);
    expect(broadcastToSeats(room, TIMEOUT_MESSAGE)).toEqual([]);
  });
});

describe('online room protocol reuse', () => {
  it('accepts every lifecycle message with the #482 client validator', () => {
    for (const message of [
      CREATE_MESSAGE,
      JOIN_MESSAGE,
      RESUME_JOIN_MESSAGE,
      READY_MESSAGE,
      START_MESSAGE,
      LEAVE_MESSAGE,
      REMATCH_MESSAGE,
    ]) {
      const validation = validateClientMessage(message);
      expect(validation.ok, `${message.type}: ${JSON.stringify(validation)}`).toBe(true);
    }
  });

  it('rejects malformed lifecycle messages with the #482 client validator', () => {
    const invalid: readonly unknown[] = [
      { ...CREATE_MESSAGE, displayName: undefined },
      { ...CREATE_MESSAGE, config: { ...CONFIG, mines: undefined } },
      { ...CREATE_MESSAGE, protocolVersion: 999 },
      { ...JOIN_MESSAGE, seat: 'player_guest' },
      { ...JOIN_MESSAGE, playerToken: 42 },
      { ...READY_MESSAGE, roomId: undefined },
      { ...START_MESSAGE, requestId: 7 },
      { ...LEAVE_MESSAGE, roomId: 42 },
      { ...REMATCH_MESSAGE, accept: 'yes' },
    ];
    for (const message of invalid) {
      const validation = validateClientMessage(message);
      expect(validation.ok, JSON.stringify(message)).toBe(false);
    }
  });

  it('rejects a server message sent in the client direction', () => {
    expect(validateClientMessage(TIMEOUT_MESSAGE).ok).toBe(false);
    expect(validateServerMessage(START_MESSAGE).ok).toBe(false);
  });

  it('maps every room failure onto a protocol error the server can send', () => {
    for (const code of ROOM_ERROR_CODES) {
      const error = roomErrorMessage(code, {
        requestId: 'req_create',
        roomId: 'room_contract_test',
        currentSeq: 3,
      });

      expect(error.type).toBe('error');
      expect(error.code).toBe(ROOM_ERROR_PROTOCOL_CODE[code]);
      expect(error.requestId).toBe('req_create');
      expect(error.roomId).toBe('room_contract_test');
      expect(error.currentSeq).toBe(3);
      expect(validateServerMessage(error).ok, `${code}: ${JSON.stringify(error)}`).toBe(true);
    }
  });

  it('keeps room-not-found and its retry policy stable', () => {
    const error = roomErrorMessage('room-not-found', { roomId: 'room_missing' });
    expect(error.code).toBe('room-not-found');
    expect(error.message).toBe('room not found');
    expect(error.retryable).toBe(false);
    expect(error.currentSeq).toBeNull();
  });

  it('lets a caller override the human-readable room error message', () => {
    const error = roomErrorMessage('room-full', { message: 'both seats are taken' });
    expect(error.code).toBe('bad-request');
    expect(error.message).toBe('both seats are taken');
  });
});

describe('online room manager contract', () => {
  it('returns one unified error result for every lifecycle command', () => {
    const manager = stubManager();
    const results = [
      manager.create(CONNECTION, CREATE_MESSAGE),
      manager.join(CONNECTION, JOIN_MESSAGE),
      manager.ready(CONNECTION, READY_MESSAGE),
      manager.start(CONNECTION, START_MESSAGE),
      manager.leave(CONNECTION, LEAVE_MESSAGE),
      manager.rematch(CONNECTION, REMATCH_MESSAGE),
      manager.dissolve('room_contract_test', 'host-closed'),
      manager.timeout('room_contract_test', 'join'),
    ];

    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.code).toBe('room-not-found');
      expect(result.error).toMatchObject({
        type: 'error',
        code: 'room-not-found',
        retryable: false,
      });
    }
  });
});
