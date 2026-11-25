import { describe, expect, it } from 'vitest';
import {
  CONNECTION_ERROR_CODES,
  connectionClientError,
  createInitialRoomClientState,
  deriveSelfId,
  ONLINE_MINESWEEPER_HREF,
  ONLINE_ROOM_QUERY_PARAM,
  onlineRoomHref,
  parseOnlineRoomHref,
  ROOM_CLIENT_ERROR_CODES,
  ROOM_CLIENT_ERROR_TEXT,
  roomClientErrorFromWire,
  roomClientErrorText,
  type BoardRenderer,
  type BoardViewModel,
  type ClientTransport,
  type ConnectionErrorCode,
  type OnlineBoardCellView,
  type OnlineRoomHandle,
  type RoomClientErrorCode,
  type RoomClientRoom,
  type RoomClientState,
  type RoomClientStateListener,
  type RoomClientStore,
  type RoomClientStoreOptions,
  type RoomConnectionStatus,
  type RoomSelectors,
  type SeatSession,
  type TokenStore,
  type Unsubscribe,
} from '../../src/games/minesweeper/online/client/contracts';
import type {
  ActionKind,
  ClientToServerMessage,
  ErrorMessage,
  PlayerView,
  RedactedCell,
  RoomState,
  RoomStateMessage,
  ServerToClientMessage,
} from '../../src/games/minesweeper/online/types';

// ---------------------------------------------------------------------------
// Compile-time contract assertions
// ---------------------------------------------------------------------------

/** The type argument must be exactly `true`; a false one fails the build. */
type Assert<T extends true> = T;
type IsAssignable<A, B> = A extends B ? true : false;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * A hidden board cell has no `mine` field. `Exclude` returning the same keys
 * only type-checks while `mine` is absent from the view model.
 */
type BoardCellHasNoMine = Assert<
  Equal<Exclude<keyof OnlineBoardCellView, 'mine'>, keyof OnlineBoardCellView>
>;
type RedactedCellHasNoMine = Assert<
  Equal<Exclude<keyof RedactedCell, 'mine'>, keyof RedactedCell>
>;

/** The room kept in render state must not retain the owner-only bearer token. */
type RoomClientRoomHasNoToken = Assert<
  Equal<Exclude<keyof RoomClientRoom, 'playerToken'>, keyof RoomClientRoom>
>;

/** The client phase is exactly the wire room lifecycle, not a second enum. */
type PhaseMatchesWireRoomState = Assert<Equal<RoomClientPhaseEquals, RoomState>>;
type RoomClientPhaseEquals = RoomClientState['phase'];

/** The transport and store exchange the shared wire messages, nothing else. */
type TransportSendsClientMessages = Assert<
  Equal<Parameters<ClientTransport['send']>[0], ClientToServerMessage>
>;
type TransportReceivesServerMessages = Assert<
  Equal<Parameters<Parameters<ClientTransport['onMessage']>[0]>[0], ServerToClientMessage>
>;
type StoreAppliesServerMessages = Assert<
  Equal<Parameters<RoomClientStore['applyServerMessage']>[0], ServerToClientMessage>
>;
type StoreSubscribeReturnsUnsubscribe = Assert<
  Equal<ReturnType<RoomClientStore['subscribe']>, Unsubscribe>
>;
type TransportReceivesConnectionErrors = Assert<
  Equal<Parameters<Parameters<ClientTransport['onError']>[0]>[0], ConnectionErrorCode>
>;

/** The selectors take an `ActionKind`; they never accept an arbitrary string. */
type SelectorsGateUsesActionKind = Assert<
  Equal<Parameters<RoomSelectors['actionGate']>[3], ActionKind>
>;

/** `selfId` is always a public id or absent, never a seat object. */
type SelfIdIsPublicString = Assert<
  Equal<RoomClientState['selfId'], string | null>
>;

/** A connection status is not a room lifecycle value. */
type ConnectionStatusIsNotRoomState = Assert<
  IsAssignable<RoomConnectionStatus, RoomState> extends true ? false : true
>;

const boardCellHasNoMine: BoardCellHasNoMine = true;
const redactedCellHasNoMine: RedactedCellHasNoMine = true;
const roomClientRoomHasNoToken: RoomClientRoomHasNoToken = true;
const phaseMatchesWireRoomState: PhaseMatchesWireRoomState = true;
const transportSendsClientMessages: TransportSendsClientMessages = true;
const transportReceivesServerMessages: TransportReceivesServerMessages = true;
const storeAppliesServerMessages: StoreAppliesServerMessages = true;
const storeSubscribeReturnsUnsubscribe: StoreSubscribeReturnsUnsubscribe = true;
const transportReceivesConnectionErrors: TransportReceivesConnectionErrors = true;
const selectorsGateUsesActionKind: SelectorsGateUsesActionKind = true;
const selfIdIsPublicString: SelfIdIsPublicString = true;
const connectionStatusIsNotRoomState: ConnectionStatusIsNotRoomState = true;

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

const HOST: PlayerView = {
  playerId: 'player_host',
  displayName: 'Ada',
  ready: true,
  presence: 'online',
  isHost: true,
};

const GUEST: PlayerView = {
  playerId: 'player_guest',
  displayName: 'Grace',
  ready: false,
  presence: 'online',
  isHost: false,
};

const ROOM: RoomStateMessage = {
  type: 'room_state',
  roomId: 'room_contract_test',
  seq: 4,
  state: 'ready',
  hostId: HOST.playerId,
  capacity: 2,
  players: [HOST, GUEST],
  playerToken: 'owner_only_token',
  config: { rows: 9, cols: 9, mines: 10, firstClickSafe: true },
  matchId: null,
  turnPlayerId: null,
  joinDeadlineAt: 1_700_000_120_000,
  deadlineAt: null,
  stateReason: 'all-ready',
};

const SESSION: SeatSession = {
  roomId: ROOM.roomId,
  playerToken: 'owner_only_token',
  displayName: HOST.displayName,
  role: 'host',
};

/**
 * Independent expectation for the complete readable-error surface. It is
 * hand-written on purpose: deriving it from `PROTOCOL_ERROR_CODES` would keep
 * a dropped or renamed wire code green.
 */
const EXPECTED_ERROR_CODES: readonly RoomClientErrorCode[] = [
  'unsupported-version',
  'room-not-found',
  'not-your-turn',
  'stale-state',
  'invalid-action',
  'deadline-passed',
  'bad-request',
  'session-replaced',
  'connection-lost',
];

function makeRoom(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return { ...ROOM, ...overrides };
}

interface FakeTransport extends ClientTransport {
  readonly sent: ClientToServerMessage[];
  readonly statuses: RoomConnectionStatus[];
  readonly errors: ConnectionErrorCode[];
  emitMessage(message: ServerToClientMessage): void;
  emitStatus(status: RoomConnectionStatus): void;
  emitError(code: ConnectionErrorCode): void;
}

/**
 * In-memory transport seam. It records calls and lets a test push messages and
 * statuses, proving the contract can be implemented without a real socket.
 */
function createFakeTransport(): FakeTransport {
  const sent: ClientToServerMessage[] = [];
  const statuses: RoomConnectionStatus[] = [];
  const errors: ConnectionErrorCode[] = [];
  const messageListeners = new Set<(message: ServerToClientMessage) => void>();
  const statusListeners = new Set<(status: RoomConnectionStatus) => void>();
  const errorListeners = new Set<(code: ConnectionErrorCode) => void>();

  function emitStatus(status: RoomConnectionStatus): void {
    statuses.push(status);
    for (const listener of statusListeners) {
      listener(status);
    }
  }

  return {
    sent,
    statuses,
    errors,
    connect() {
      emitStatus('connecting');
      emitStatus('connected');
    },
    send(message) {
      sent.push(message);
    },
    close() {
      emitStatus('closed');
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    emitMessage(message) {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
    emitStatus,
    emitError(code) {
      errors.push(code);
      for (const listener of errorListeners) {
        listener(code);
      }
    },
  };
}

interface FakeStore extends RoomClientStore {
  readonly applied: ServerToClientMessage[];
}

/**
 * Store seam fake. It intentionally contains no reducer: it shows that the
 * interface is implementable, while the real reducer is a later task.
 */
function createFakeStore(initial: RoomClientState): FakeStore {
  let state = initial;
  const listeners = new Set<RoomClientStateListener>();
  const applied: ServerToClientMessage[] = [];

  return {
    applied,
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applyServerMessage(message) {
      applied.push(message);
    },
    reset() {
      state = createInitialRoomClientState();
    },
  };
}

function createFakeTokenStore(): TokenStore & {
  readonly records: Map<string, SeatSession>;
} {
  const records = new Map<string, SeatSession>();
  return {
    records,
    load(roomId) {
      return records.get(roomId) ?? null;
    },
    save(session) {
      records.set(session.roomId, session);
    },
    clear(roomId) {
      records.delete(roomId);
    },
  };
}

interface FakeBoardRenderer extends BoardRenderer {
  readonly views: BoardViewModel[];
  readonly destroyed: boolean[];
}

/** Renderer seam fake; it records the view model and never touches the DOM. */
function createFakeBoardRenderer(): FakeBoardRenderer {
  const views: BoardViewModel[] = [];
  const destroyed: boolean[] = [];
  return {
    views,
    destroyed,
    render(_container, view) {
      views.push(view);
    },
    destroy() {
      destroyed.push(true);
    },
  };
}

/** A complete board view built from redacted cells only. */
function makeBoardView(state: RoomClientState = createInitialRoomClientState(SESSION)): BoardViewModel {
  const hidden: OnlineBoardCellView = {
    row: 0,
    col: 0,
    revealed: false,
    flagged: false,
    adjacentMines: 0,
    pending: false,
  };
  return {
    roomId: ROOM.roomId,
    matchId: 'match_contract_test',
    selfId: state.selfId,
    turnPlayerId: HOST.playerId,
    turnId: 1,
    status: 'playing',
    seedHash: 'seed-hash',
    deadlineAt: 1_700_000_030_000,
    matchDeadlineAt: 1_700_000_900_000,
    elapsedMs: 0,
    mineCount: 10,
    remainingMines: 10,
    revealedSafeCount: 0,
    rows: 1,
    cols: 1,
    cells: [[hidden]],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('online client initial state', () => {
  it('starts idle, disconnected and empty before the first room_state', () => {
    const state = createInitialRoomClientState();

    expect(state).toEqual({
      phase: 'idle',
      connection: 'idle',
      lastSeq: 0,
      role: null,
      selfId: null,
      room: null,
      snapshot: null,
      end: null,
      error: null,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.keys(state).sort()).toEqual(
      [
        'connection',
        'end',
        'error',
        'lastSeq',
        'phase',
        'role',
        'room',
        'selfId',
        'snapshot',
      ].sort(),
    );
  });

  it('restores only the seat role from a stored session', () => {
    const state = createInitialRoomClientState(SESSION);

    expect(state.role).toBe('host');
    expect(state.phase).toBe('idle');
    expect(state.connection).toBe('idle');
    expect(state.selfId).toBeNull();
    expect(state.room).toBeNull();
    expect(createInitialRoomClientState({ ...SESSION, role: 'guest' }).role).toBe('guest');
  });
});

describe('online client self identity', () => {
  it('maps host and guest roles onto the public room players', () => {
    expect(deriveSelfId('host', ROOM)).toBe(HOST.playerId);
    expect(deriveSelfId('guest', ROOM)).toBe(GUEST.playerId);
  });

  it('returns null when the matching seat is not in the broadcast', () => {
    const hostOnly = makeRoom({ players: [HOST] });
    expect(deriveSelfId('guest', hostOnly)).toBeNull();
    expect(deriveSelfId('host', hostOnly)).toBe(HOST.playerId);
  });

  it('ignores the owner-only token and derives from hostId/players only', () => {
    const withoutToken = makeRoom({ players: [HOST, GUEST], playerToken: undefined });
    expect(deriveSelfId('guest', withoutToken)).toBe(GUEST.playerId);
    expect(deriveSelfId('host', withoutToken)).toBe(HOST.playerId);
  });
});

describe('online client error text', () => {
  it('covers every wire ProtocolErrorCode plus both connection outcomes', () => {
    expect(CONNECTION_ERROR_CODES).toEqual(['session-replaced', 'connection-lost']);
    expect(ROOM_CLIENT_ERROR_CODES).toEqual(EXPECTED_ERROR_CODES);
    expect(ROOM_CLIENT_ERROR_CODES).toHaveLength(9);
    for (const code of EXPECTED_ERROR_CODES) {
      const text = roomClientErrorText(code);
      expect(typeof text, `text for ${code}`).toBe('string');
      expect(text.trim().length, `non-empty text for ${code}`).toBeGreaterThan(0);
      expect(text).toBe(ROOM_CLIENT_ERROR_TEXT[code]);
    }
  });

  it('keeps one distinct readable sentence per code', () => {
    const texts = ROOM_CLIENT_ERROR_CODES.map((code) => roomClientErrorText(code));
    expect(new Set(texts).size).toBe(texts.length);
    expect(Object.isFrozen(ROOM_CLIENT_ERROR_TEXT)).toBe(true);
  });

  it("uses stale-state for the issue's stale-seq wording without inventing a code", () => {
    expect(Object.hasOwn(ROOM_CLIENT_ERROR_TEXT, 'stale-seq')).toBe(false);
    expect(roomClientErrorText('stale-state')).toContain('状态已更新');
    expect(ROOM_CLIENT_ERROR_CODES as readonly string[]).not.toContain('stale-seq');
  });

  it('turns a wire error into readable text while keeping diagnostics', () => {
    const wire: ErrorMessage = {
      type: 'error',
      requestId: 'req_42',
      roomId: ROOM.roomId,
      code: 'stale-state',
      message: 'stale seq 3; current seq is 4',
      retryable: true,
      currentSeq: 4,
    };

    expect(roomClientErrorFromWire(wire)).toEqual({
      code: 'stale-state',
      message: ROOM_CLIENT_ERROR_TEXT['stale-state'],
      detail: 'stale seq 3; current seq is 4',
      retryable: true,
      requestId: 'req_42',
      currentSeq: 4,
    });
  });

  it('marks only connection-lost as retryable', () => {
    const replaced = connectionClientError('session-replaced');
    const lost = connectionClientError('connection-lost');

    expect(replaced.retryable).toBe(false);
    expect(replaced.message).toBe(ROOM_CLIENT_ERROR_TEXT['session-replaced']);
    expect(replaced.detail).toBeNull();
    expect(replaced.requestId).toBeNull();
    expect(replaced.currentSeq).toBeNull();

    expect(lost.retryable).toBe(true);
    expect(lost.message).toBe(ROOM_CLIENT_ERROR_TEXT['connection-lost']);
  });
});

describe('online room href', () => {
  it('points at the create/join screen when there is no room id', () => {
    expect(ONLINE_MINESWEEPER_HREF).toBe('#/online/minesweeper');
    expect(ONLINE_ROOM_QUERY_PARAM).toBe('room');
    expect(onlineRoomHref()).toBe(ONLINE_MINESWEEPER_HREF);
    expect(onlineRoomHref(null)).toBe(ONLINE_MINESWEEPER_HREF);
    expect(onlineRoomHref('')).toBe(ONLINE_MINESWEEPER_HREF);
  });

  it('round-trips room ids through the hash', () => {
    const roomIds = [
      'room_123',
      'room with space',
      'room/slash?question&equals=one',
      '房间-42',
      'room+plus%percent',
    ];

    for (const roomId of roomIds) {
      const href = onlineRoomHref(roomId);
      expect(href.startsWith(`${ONLINE_MINESWEEPER_HREF}?room=`)).toBe(true);
      expect(parseOnlineRoomHref(href)).toEqual({ roomId });
    }
  });

  it('parses the canonical room entry with optional hash, slash and query noise', () => {
    expect(parseOnlineRoomHref('#/online/minesweeper')).toEqual({ roomId: null });
    expect(parseOnlineRoomHref('/online/minesweeper/')).toEqual({ roomId: null });
    expect(parseOnlineRoomHref('#/online/minesweeper/')).toEqual({ roomId: null });
    expect(parseOnlineRoomHref('#/online/minesweeper?room=room_1')).toEqual({ roomId: 'room_1' });
    expect(parseOnlineRoomHref('#/online/minesweeper/?room=room_1')).toEqual({
      roomId: 'room_1',
    });
    expect(parseOnlineRoomHref('#/online/minesweeper?room=room_1&from=hub')).toEqual({
      roomId: 'room_1',
    });
    expect(parseOnlineRoomHref('#/online/minesweeper?from=hub&room=room_1')).toEqual({
      roomId: 'room_1',
    });
    expect(parseOnlineRoomHref('#/online/minesweeper?room=')).toEqual({ roomId: null });
    expect(parseOnlineRoomHref('#/online/minesweeper?room=%E6%88%BF%E9%97%B4')).toEqual({
      roomId: '房间',
    });
  });

  it('rejects every other route instead of guessing a room', () => {
    expect(parseOnlineRoomHref('#/games/minesweeper')).toBeNull();
    expect(parseOnlineRoomHref('#/online/minesweeper-extra')).toBeNull();
    expect(parseOnlineRoomHref('#/online/2048?room=room_1')).toBeNull();
    expect(parseOnlineRoomHref('#/')).toBeNull();
    expect(parseOnlineRoomHref('')).toBeNull();
    expect(() => parseOnlineRoomHref('#/online/minesweeper?room=%')).not.toThrow();
  });
});

describe('online board view contract', () => {
  it('never puts a mine field on a hidden board cell', () => {
    const view = makeBoardView();
    const hidden = view.cells[0]?.[0];

    expect(hidden?.revealed).toBe(false);
    expect(hidden === undefined ? null : Object.hasOwn(hidden, 'mine')).toBe(false);
    expect(JSON.stringify(view)).not.toContain('"mine"');
    expect(boardCellHasNoMine).toBe(true);
    expect(redactedCellHasNoMine).toBe(true);
  });

  it('keeps hidden cells redacted at the type level', () => {
    const leaked: OnlineBoardCellView = {
      row: 0,
      col: 0,
      revealed: false,
      flagged: false,
      adjacentMines: 0,
      pending: true,
      // @ts-expect-error a board view cell must not carry a hidden mine flag.
      mine: false,
    };
    expect('mine' in leaked).toBe(true);
  });

  it('keeps the owner-only token out of render state', () => {
    expect(roomClientRoomHasNoToken).toBe(true);
    expect(Object.hasOwn(ROOM, 'playerToken')).toBe(true);
    // The runtime projection is the store's job; this proves the type contract
    // itself excludes the token even when the wire payload carries it.
    const { playerToken: token, ...room }: RoomStateMessage = ROOM;
    const clientRoom: RoomClientRoom = room;
    expect(token).toBe('owner_only_token');
    expect(Object.hasOwn(clientRoom, 'playerToken')).toBe(false);
  });
});

describe('online client injection seams', () => {
  it('implements the transport and store contracts with in-memory fakes', () => {
    const transport = createFakeTransport();
    const store = createFakeStore(createInitialRoomClientState(SESSION));
    const received: ServerToClientMessage[] = [];
    const statuses: RoomConnectionStatus[] = [];
    const errors: ConnectionErrorCode[] = [];

    const stopMessages = transport.onMessage((message) => received.push(message));
    const stopStatus = transport.onStatus((status) => statuses.push(status));
    const stopErrors = transport.onError((code) => errors.push(code));
    transport.connect(SESSION);
    transport.emitMessage(ROOM);
    transport.emitError('connection-lost');
    transport.send({ type: 'leave', roomId: ROOM.roomId, requestId: 'req_leave' });
    transport.close();

    expect(transport.sent).toEqual([
      { type: 'leave', roomId: ROOM.roomId, requestId: 'req_leave' },
    ]);
    expect(received).toEqual([ROOM]);
    expect(statuses).toEqual(['connecting', 'connected', 'closed']);
    expect(errors).toEqual(['connection-lost']);

    store.applyServerMessage(ROOM);
    expect(store.applied).toEqual([ROOM]);
    expect(store.getState().phase).toBe('idle');

    stopMessages();
    stopStatus();
    stopErrors();
    transport.emitMessage(ROOM);
    transport.emitError('session-replaced');
    expect(received).toEqual([ROOM]);
    expect(errors).toEqual(['connection-lost']);
  });

  it('implements the token store and board renderer seams', () => {
    const tokens = createFakeTokenStore();
    tokens.save(SESSION);
    expect(tokens.load(ROOM.roomId)).toEqual(SESSION);
    expect(tokens.load('missing')).toBeNull();
    tokens.clear(ROOM.roomId);
    expect(tokens.load(ROOM.roomId)).toBeNull();

    const renderer = createFakeBoardRenderer();
    const view = makeBoardView(createInitialRoomClientState(SESSION));
    renderer.render({} as HTMLElement, view, () => undefined);
    renderer.destroy();
    expect(renderer.views).toEqual([view]);
    expect(renderer.destroyed).toEqual([true]);
  });

  it('keeps the view dependency and handle seams implementable', () => {
    const state = createInitialRoomClientState(SESSION);
    const options: RoomClientStoreOptions = {
      session: SESSION,
      transport: createFakeTransport(),
    };
    const handle: OnlineRoomHandle = {
      roomId: SESSION.roomId,
      getState: () => state,
      destroy: () => undefined,
    };

    expect(options.session).toBe(SESSION);
    expect(options.transport).toBeDefined();
    expect(handle.getState()).toBe(state);
    expect(handle.roomId).toBe(ROOM.roomId);
    expect(transportSendsClientMessages).toBe(true);
    expect(transportReceivesServerMessages).toBe(true);
    expect(storeAppliesServerMessages).toBe(true);
    expect(storeSubscribeReturnsUnsubscribe).toBe(true);
    expect(transportReceivesConnectionErrors).toBe(true);
    expect(selectorsGateUsesActionKind).toBe(true);
    expect(selfIdIsPublicString).toBe(true);
    expect(connectionStatusIsNotRoomState).toBe(true);
    expect(phaseMatchesWireRoomState).toBe(true);
  });
});
