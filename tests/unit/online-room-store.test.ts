import { describe, expect, it } from 'vitest';
import {
  CONNECTION_ERROR_CODES,
  createInitialRoomClientState,
  ROOM_CLIENT_ERROR_CODES,
  ROOM_CLIENT_ERROR_TEXT,
  type ClientTransport,
  type ConnectionErrorCode,
  type RoomClientState,
  type RoomConnectionStatus,
  type SeatSession,
} from '../../src/games/minesweeper/online/client/contracts';
import {
  createRoomClientStore,
  roomSelectors,
} from '../../src/games/minesweeper/online/client/store';
import type { MinesweeperConfig } from '../../src/games/minesweeper/engine';
import type {
  ActionResultMessage,
  ClientToServerMessage,
  EndMessage,
  ErrorMessage,
  PlayerView,
  ProtocolErrorCode,
  RedactedCell,
  RoomClosedMessage,
  RoomStateMessage,
  ServerToClientMessage,
  SnapshotMessage,
  TimeoutMessage,
} from '../../src/games/minesweeper/online/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM_ID = 'room_store_test';
const MATCH_ID = 'match_store_test';
const HOST_ID = 'player_host';
const GUEST_ID = 'player_guest';
const NOW = 1_700_000_000_000;
const END_SEED = 20_261_126;

const CONFIG: MinesweeperConfig = {
  rows: 3,
  cols: 3,
  mines: 2,
  firstClickSafe: true,
};

const HOST: PlayerView = {
  playerId: HOST_ID,
  displayName: 'Ada',
  ready: true,
  presence: 'online',
  isHost: true,
};

const GUEST: PlayerView = {
  playerId: GUEST_ID,
  displayName: 'Grace',
  ready: true,
  presence: 'online',
  isHost: false,
};

const HOST_SESSION: SeatSession = {
  roomId: ROOM_ID,
  playerToken: 'host-token',
  displayName: HOST.displayName,
  role: 'host',
};

const GUEST_SESSION: SeatSession = {
  roomId: ROOM_ID,
  playerToken: 'guest-token',
  displayName: GUEST.displayName,
  role: 'guest',
};

function makeRoomState(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return {
    type: 'room_state',
    roomId: ROOM_ID,
    seq: 1,
    state: 'waiting',
    hostId: HOST_ID,
    capacity: 2,
    players: [HOST, GUEST],
    config: CONFIG,
    matchId: null,
    turnPlayerId: null,
    joinDeadlineAt: NOW + 120_000,
    deadlineAt: null,
    stateReason: null,
    ...overrides,
  };
}

function redactedCell(row: number, col: number): RedactedCell {
  return { row, col, revealed: false, flagged: false, adjacentMines: 0 };
}

function makeBoard(): RedactedCell[][] {
  return [
    [redactedCell(0, 0), redactedCell(0, 1), redactedCell(0, 2)],
    [redactedCell(1, 0), redactedCell(1, 1), redactedCell(1, 2)],
    [redactedCell(2, 0), redactedCell(2, 1), redactedCell(2, 2)],
  ];
}

interface CellChange {
  readonly row: number;
  readonly col: number;
  readonly revealed?: boolean;
  readonly flagged?: boolean;
  readonly adjacentMines?: number;
}

function boardWith(changes: readonly CellChange[]): RedactedCell[][] {
  const board = makeBoard();
  for (const change of changes) {
    const row = board[change.row];
    const current = row?.[change.col];
    if (row === undefined || current === undefined) continue;
    row[change.col] = {
      ...current,
      revealed: change.revealed ?? current.revealed,
      flagged: change.flagged ?? current.flagged,
      adjacentMines: change.adjacentMines ?? current.adjacentMines,
    };
  }
  return board;
}

function makeSnapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: 'snapshot',
    roomId: ROOM_ID,
    matchId: MATCH_ID,
    seq: 2,
    turnPlayerId: HOST_ID,
    turnId: 1,
    deadlineAt: NOW + 30_000,
    matchDeadlineAt: NOW + 900_000,
    seedHash: 'seed-hash',
    engineStatus: 'playing',
    mineCount: 2,
    remainingMines: 2,
    revealedSafeCount: 0,
    elapsedMs: 0,
    board: makeBoard(),
    ...overrides,
  };
}

function makeEnd(overrides: Partial<EndMessage> = {}): EndMessage {
  return {
    type: 'end',
    roomId: ROOM_ID,
    seq: 4,
    matchId: MATCH_ID,
    reason: 'mine-hit',
    winnerId: HOST_ID,
    loserId: GUEST_ID,
    finalSnapshot: [
      [
        { row: 0, col: 0, mine: false, revealed: true, flagged: false, adjacentMines: 1 },
        { row: 0, col: 1, mine: true, revealed: false, flagged: false, adjacentMines: 0 },
        { row: 0, col: 2, mine: false, revealed: false, flagged: false, adjacentMines: 1 },
      ],
      [
        { row: 1, col: 0, mine: false, revealed: false, flagged: true, adjacentMines: 1 },
        { row: 1, col: 1, mine: true, revealed: false, flagged: false, adjacentMines: 0 },
        { row: 1, col: 2, mine: false, revealed: false, flagged: false, adjacentMines: 1 },
      ],
      [
        { row: 2, col: 0, mine: false, revealed: false, flagged: false, adjacentMines: 1 },
        { row: 2, col: 1, mine: false, revealed: false, flagged: false, adjacentMines: 1 },
        { row: 2, col: 2, mine: false, revealed: false, flagged: false, adjacentMines: 0 },
      ],
    ],
    seed: END_SEED,
    stats: {
      turnCount: 4,
      revealedSafeCount: 3,
      flagsPlaced: 1,
      durationMs: 12_000,
    },
    ...overrides,
  };
}

function makeTimeout(overrides: Partial<TimeoutMessage> = {}): TimeoutMessage {
  return {
    type: 'timeout',
    roomId: ROOM_ID,
    matchId: null,
    seq: 2,
    timer: 'join',
    subjectId: null,
    deadlineAt: NOW,
    resultingState: 'dissolved',
    reason: 'join-timeout',
    ...overrides,
  };
}

function makeRoomClosed(overrides: Partial<RoomClosedMessage> = {}): RoomClosedMessage {
  return {
    type: 'room_closed',
    roomId: ROOM_ID,
    seq: 3,
    reason: 'join-timeout',
    finalState: 'dissolved',
    ...overrides,
  };
}

function makeError(overrides: Partial<ErrorMessage> = {}): ErrorMessage {
  return {
    type: 'error',
    requestId: 'req_store_test',
    roomId: ROOM_ID,
    code: 'stale-state',
    message: 'stale state; resync and retry',
    retryable: true,
    currentSeq: null,
    ...overrides,
  };
}

function makeActionResult(overrides: Partial<ActionResultMessage> = {}): ActionResultMessage {
  return {
    type: 'action_result',
    roomId: ROOM_ID,
    matchId: MATCH_ID,
    actionId: 'action_1',
    seq: 2,
    turnId: 2,
    accepted: true,
    reason: null,
    revealedCells: [{ row: 0, col: 0 }],
    flaggedCell: null,
    turnPlayerId: GUEST_ID,
    deadlineAt: NOW + 30_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

interface FakeTransport extends ClientTransport {
  readonly sent: ClientToServerMessage[];
  emitStatus(status: RoomConnectionStatus): void;
  emitError(code: ConnectionErrorCode): void;
}

/**
 * In-memory transport seam. The store only observes status and connection
 * errors (messages go through `applyServerMessage`), so the fake records what
 * it sends and lets a test drive the connection lifecycle deterministically.
 */
function createFakeTransport(initialStatus: RoomConnectionStatus = 'idle'): FakeTransport {
  const sent: ClientToServerMessage[] = [];
  let status = initialStatus;
  const messageListeners = new Set<(message: ServerToClientMessage) => void>();
  const statusListeners = new Set<(next: RoomConnectionStatus) => void>();
  const errorListeners = new Set<(code: ConnectionErrorCode) => void>();

  function notifyStatus(next: RoomConnectionStatus): void {
    status = next;
    for (const listener of Array.from(statusListeners)) listener(next);
  }

  return {
    sent,
    connect() {
      notifyStatus('connecting');
      notifyStatus('connected');
    },
    send(message) {
      sent.push(message);
    },
    close() {
      notifyStatus('closed');
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      // The contract requires the current status on subscription.
      listener(status);
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
    emitStatus: notifyStatus,
    emitError(code) {
      for (const listener of Array.from(errorListeners)) listener(code);
    },
  };
}

function setup(role: SeatSession['role'] = 'host', initialStatus: RoomConnectionStatus = 'idle') {
  const transport = createFakeTransport(initialStatus);
  const session = role === 'host' ? HOST_SESSION : GUEST_SESSION;
  const store = createRoomClientStore({ session, transport });
  return { store, transport };
}

function playingRoom(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return makeRoomState({
    seq: 2,
    state: 'playing',
    matchId: MATCH_ID,
    turnPlayerId: HOST_ID,
    deadlineAt: NOW + 30_000,
    ...overrides,
  });
}

/** Reach a playing state whose snapshot says it is the host's turn. */
function startPlaying(overrides: Partial<SnapshotMessage> = {}) {
  const { store, transport } = setup('host');
  const seq = overrides.seq ?? 2;
  store.applyServerMessage(playingRoom({ seq }));
  store.applyServerMessage(makeSnapshot({ seq, ...overrides }));
  return { store, transport };
}

// ---------------------------------------------------------------------------
// Initial state, subscription and reset
// ---------------------------------------------------------------------------

describe('room client store initial state', () => {
  it('starts from the shared frozen initial state and keeps the seat role', () => {
    const { store, transport } = setup('guest');
    const state = store.getState();

    expect(state).toEqual(createInitialRoomClientState(GUEST_SESSION));
    expect(state.role).toBe('guest');
    expect(state.phase).toBe('idle');
    expect(state.connection).toBe('idle');
    expect(state.lastSeq).toBe(0);
    expect(state.selfId).toBeNull();
    expect(Object.isFrozen(state)).toBe(true);
    expect(transport.sent).toEqual([]);
  });

  it('notifies once per committed message and ignores an identical repeat', () => {
    const { store } = setup('host');
    const seen: RoomClientState[] = [];
    const unsubscribe = store.subscribe((state) => seen.push(state));

    store.applyServerMessage(playingRoom());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(store.getState());

    // Same seq and same room payload: no new state, no second notification.
    store.applyServerMessage(playingRoom());
    expect(seen).toHaveLength(1);

    store.applyServerMessage(makeSnapshot({ seq: 2 }));
    expect(seen).toHaveLength(2);

    unsubscribe();
    store.applyServerMessage(makeRoomState({ seq: 3, state: 'ready' }));
    expect(seen).toHaveLength(2);
    expect(store.getState().phase).toBe('ready');
  });

  it('resets to the initial state, preserving the stored seat role', () => {
    const { store } = setup('host');
    store.applyServerMessage(playingRoom());
    store.applyServerMessage(makeSnapshot({ seq: 2 }));
    expect(store.getState().snapshot).not.toBeNull();

    const seen: RoomClientState[] = [];
    store.subscribe((state) => seen.push(state));
    store.reset();

    expect(store.getState()).toEqual(createInitialRoomClientState(HOST_SESSION));
    expect(seen).toHaveLength(1);

    // Resetting an already initial store is not a state change.
    store.reset();
    expect(seen).toHaveLength(1);
  });

  it('never mutates the applied message or the transport payload', () => {
    const { store } = setup('host');
    const message = playingRoom();
    const before = JSON.stringify(message);

    store.applyServerMessage(message);

    expect(JSON.stringify(message)).toBe(before);
    expect(Object.isFrozen(store.getState())).toBe(true);
    expect(Object.isFrozen(store.getState().room)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Room lifecycle and sequence merge
// ---------------------------------------------------------------------------

describe('room client store sequence merge', () => {
  it('merges room_state, snapshot, action_result, end and room_state at one seq', () => {
    const { store } = setup('host');
    store.applyServerMessage(makeRoomState({ seq: 1, state: 'ready' }));
    store.applyServerMessage(playingRoom({ seq: 2 }));

    // One accepted action publishes action_result + snapshot at the match's
    // new seq; the action_result alone must already advance lastSeq.
    store.applyServerMessage(makeActionResult({ seq: 3 }));
    expect(store.getState().lastSeq).toBe(3);
    // A cached retry at the applied seq is not another facet of this seq.
    store.applyServerMessage(makeActionResult({ seq: 3, actionId: 'action_1_retry' }));
    expect(store.getState().lastSeq).toBe(3);
    store.applyServerMessage(makeSnapshot({ seq: 3 }));
    let state = store.getState();
    expect(state.lastSeq).toBe(3);
    expect(state.phase).toBe('playing');
    expect(state.snapshot).not.toBeNull();
    expect(roomSelectors.actionGate(state, 0, 0, 'reveal').allowed).toBe(true);

    // A terminal action publishes action_result + snapshot + end + room_state
    // at one seq; all four are facets of the same state change.
    store.applyServerMessage(makeActionResult({ seq: 4 }));
    store.applyServerMessage(makeSnapshot({ seq: 4, engineStatus: 'lost' }));
    store.applyServerMessage(makeEnd({ seq: 4 }));
    store.applyServerMessage(
      makeRoomState({ seq: 4, state: 'finished', matchId: MATCH_ID, turnPlayerId: null }),
    );
    state = store.getState();
    expect(state.lastSeq).toBe(4);
    expect(state.phase).toBe('finished');
    expect(state.end?.seed).toBe(END_SEED);
    expect(state.room?.state).toBe('finished');
  });

  it('gates actions until the snapshot paired with action_result arrives', () => {
    const { store } = startPlaying();
    store.applyServerMessage(makeActionResult({ seq: 3 }));

    expect(store.getState().lastSeq).toBe(3);
    expect(roomSelectors.actionGate(store.getState(), 0, 0, 'reveal').reason).toBe(
      'awaiting-server',
    );

    store.applyServerMessage(makeSnapshot({ seq: 3 }));
    expect(store.getState().lastSeq).toBe(3);
    expect(roomSelectors.actionGate(store.getState(), 0, 0, 'reveal').allowed).toBe(true);
  });

  it('drops a message older than the applied seq without notifying', () => {
    const { store } = setup('host');
    store.applyServerMessage(makeRoomState({ seq: 5, state: 'ready' }));
    store.applyServerMessage(makeSnapshot({ seq: 5 }));
    const state = store.getState();

    const seen: RoomClientState[] = [];
    store.subscribe((next) => seen.push(next));

    store.applyServerMessage(makeRoomState({ seq: 4, state: 'waiting' }));
    store.applyServerMessage(makeSnapshot({ seq: 4 }));

    expect(store.getState()).toBe(state);
    expect(store.getState().phase).toBe('playing');
    expect(store.getState().lastSeq).toBe(5);
    expect(seen).toEqual([]);
  });

  it('drops a duplicated facet but merges a same-seq presence update', () => {
    const { store } = setup('host');
    store.applyServerMessage(playingRoom({ seq: 5 }));
    store.applyServerMessage(makeSnapshot({ seq: 5 }));

    const seen: RoomClientState[] = [];
    store.subscribe((next) => seen.push(next));

    store.applyServerMessage(makeSnapshot({ seq: 5 }));
    expect(seen).toEqual([]);

    // Presence changes do not advance the room seq; the repeated room_state
    // must still replace the player list.
    store.applyServerMessage(
      playingRoom({
        seq: 5,
        players: [{ ...HOST, presence: 'reconnecting' }, { ...GUEST, presence: 'online' }],
      }),
    );
    expect(seen).toHaveLength(1);
    expect(store.getState().lastSeq).toBe(5);
    expect(store.getState().room?.players[0]?.presence).toBe('reconnecting');
  });

  it('walks waiting → ready → playing → finished → rematch without stale data', () => {
    const { store } = setup('host');

    store.applyServerMessage(makeRoomState({ seq: 1, state: 'waiting' }));
    expect(store.getState().phase).toBe('waiting');
    expect(roomSelectors.canToggleReady(store.getState())).toBe(true);
    expect(roomSelectors.canStart(store.getState())).toBe(false);

    store.applyServerMessage(makeRoomState({ seq: 2, state: 'ready' }));
    expect(store.getState().phase).toBe('ready');
    expect(roomSelectors.canStart(store.getState())).toBe(true);

    store.applyServerMessage(playingRoom({ seq: 3 }));
    store.applyServerMessage(makeSnapshot({ seq: 3 }));
    expect(store.getState().phase).toBe('playing');
    expect(roomSelectors.board(store.getState())).not.toBeNull();

    store.applyServerMessage(makeEnd({ seq: 4 }));
    expect(store.getState().phase).toBe('finished');
    expect(store.getState().end).not.toBeNull();

    // Rematch returns to the lobby and invalidates the previous match board.
    // A rematch-pending room_state at a newer seq keeps the result visible.
    store.applyServerMessage(
      makeRoomState({ seq: 5, state: 'finished', matchId: MATCH_ID, turnPlayerId: null }),
    );
    expect(store.getState().end).not.toBeNull();
    expect(store.getState().snapshot).not.toBeNull();

    store.applyServerMessage(makeRoomState({ seq: 6, state: 'ready' }));
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().end).toBeNull();
  });

  it('invalidates the previous match when a different matchId starts', () => {
    const { store } = startPlaying();
    store.applyServerMessage(makeEnd({ seq: 3 }));
    expect(store.getState().end).not.toBeNull();

    store.applyServerMessage(playingRoom({ seq: 4, matchId: 'match_next' }));
    expect(store.getState().phase).toBe('playing');
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().end).toBeNull();

    store.applyServerMessage(makeSnapshot({ seq: 4, matchId: 'match_next' }));
    expect(store.getState().snapshot?.matchId).toBe('match_next');
  });

  it('keeps a finished phase when a snapshot shares the end seq', () => {
    const { store } = startPlaying();
    store.applyServerMessage(makeEnd({ seq: 3 }));
    store.applyServerMessage(makeSnapshot({ seq: 3 }));

    expect(store.getState().phase).toBe('finished');
    expect(store.getState().end).not.toBeNull();
  });

  it('keeps the redacted snapshot on a non-dissolved timeout', () => {
    const { store } = startPlaying();
    const snapshot = store.getState().snapshot;

    store.applyServerMessage(
      makeTimeout({ seq: 3, matchId: MATCH_ID, timer: 'turn', resultingState: 'finished' }),
    );

    expect(store.getState().phase).toBe('finished');
    expect(store.getState().snapshot).toBe(snapshot);
  });

  it('keeps the end result when the room closes after the match', () => {
    const { store } = startPlaying();
    store.applyServerMessage(makeEnd({ seq: 3 }));
    store.applyServerMessage(makeRoomClosed({ seq: 4, reason: 'finished' }));

    const state = store.getState();
    expect(state.phase).toBe('dissolved');
    expect(state.room).toBeNull();
    expect(state.snapshot).toBeNull();
    expect(state.end).not.toBeNull();
  });

  it('applies timeout and room_closed in order and clears the dead room', () => {
    const { store } = setup('host');
    store.applyServerMessage(makeRoomState({ seq: 1, state: 'waiting' }));
    store.applyServerMessage(makeTimeout({ seq: 2 }));
    expect(store.getState().phase).toBe('dissolved');
    expect(store.getState().lastSeq).toBe(2);

    store.applyServerMessage(makeRoomClosed({ seq: 3 }));
    const state = store.getState();
    expect(state.phase).toBe('dissolved');
    expect(state.lastSeq).toBe(3);
    expect(state.room).toBeNull();
    expect(state.snapshot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconnect recovery
// ---------------------------------------------------------------------------

describe('room client store reconnect recovery', () => {
  it('replaces room and snapshot at the current seq and drops older ones', () => {
    const { store, transport } = startPlaying({
      board: boardWith([{ row: 0, col: 0, revealed: true, adjacentMines: 1 }]),
    });
    expect(store.getState().snapshot?.seq).toBe(2);

    transport.emitStatus('reconnecting');
    expect(store.getState().connection).toBe('reconnecting');

    // The server's resync carries the current room_state plus the full
    // redacted snapshot at the same (new) seq.
    store.applyServerMessage(
      playingRoom({
        seq: 9,
        turnPlayerId: GUEST_ID,
        players: [
          { ...HOST, presence: 'online' },
          { ...GUEST, presence: 'online' },
        ],
      }),
    );
    store.applyServerMessage(
      makeSnapshot({
        seq: 9,
        turnPlayerId: GUEST_ID,
        turnId: 4,
        board: boardWith([{ row: 2, col: 2, revealed: true, adjacentMines: 2 }]),
      }),
    );

    let state = store.getState();
    expect(state.lastSeq).toBe(9);
    expect(state.room?.seq).toBe(9);
    expect(state.snapshot?.seq).toBe(9);
    expect(state.snapshot?.turnPlayerId).toBe(GUEST_ID);
    expect(state.snapshot?.turnId).toBe(4);
    // The old board is gone, not merged with the resync board.
    expect(state.snapshot?.board[0]?.[0]?.revealed).toBe(false);
    expect(state.snapshot?.board[2]?.[2]?.revealed).toBe(true);

    // An in-flight broadcast from before the reconnect is discarded.
    store.applyServerMessage(
      makeSnapshot({ seq: 6, board: boardWith([{ row: 1, col: 1, revealed: true }]) }),
    );
    expect(store.getState().snapshot?.seq).toBe(9);

    transport.emitStatus('connected');
    expect(store.getState().connection).toBe('connected');
  });

  it('aligns lastSeq with error.currentSeq and resyncs without replaying actions', () => {
    const { store, transport } = startPlaying({ seq: 2 });
    const staleSnapshot = store.getState().snapshot;

    store.applyServerMessage(makeError({ code: 'stale-state', currentSeq: 9 }));

    let state = store.getState();
    expect(state.lastSeq).toBe(9);
    expect(state.error?.code).toBe('stale-state');
    expect(roomSelectors.errorText(state)).toBe(ROOM_CLIENT_ERROR_TEXT['stale-state']);
    expect(roomSelectors.actionGate(state, 0, 0, 'reveal').reason).toBe('awaiting-server');
    // stale-state is a hint to wait; the store never re-sends an action.
    expect(transport.sent).toEqual([]);

    // Older than the server's aligned seq: dropped, the stale board stays.
    store.applyServerMessage(makeSnapshot({ seq: 8 }));
    expect(store.getState().snapshot).toBe(staleSnapshot);

    // A presence-only repeat at the aligned seq must not hide the resync hint.
    store.applyServerMessage(
      playingRoom({
        seq: 9,
        turnPlayerId: GUEST_ID,
        players: [{ ...HOST, presence: 'reconnecting' }, { ...GUEST, presence: 'online' }],
      }),
    );
    state = store.getState();
    expect(state.error?.code).toBe('stale-state');
    expect(state.snapshot).toBe(staleSnapshot);
    expect(roomSelectors.actionGate(state, 0, 0, 'reveal').reason).toBe('awaiting-server');

    // The resync snapshot at the aligned seq replaces the view and clears it.
    store.applyServerMessage(makeSnapshot({ seq: 9, turnPlayerId: GUEST_ID }));
    state = store.getState();
    expect(state.lastSeq).toBe(9);
    expect(state.error).toBeNull();
    expect(state.snapshot?.turnPlayerId).toBe(GUEST_ID);
    expect(transport.sent).toEqual([]);
  });

  it('admits the resync snapshot when stale-state arrives at the applied seq', () => {
    const { store } = startPlaying();
    store.applyServerMessage(makeError({ code: 'stale-state', currentSeq: 2 }));

    expect(store.getState().lastSeq).toBe(2);
    expect(store.getState().error?.code).toBe('stale-state');
    expect(roomSelectors.actionGate(store.getState(), 0, 0, 'reveal').reason).toBe(
      'awaiting-server',
    );

    // The snapshot facet was already applied at seq 2; the stale resync still
    // needs to be admitted so the hint can clear.
    store.applyServerMessage(makeSnapshot({ seq: 2 }));

    expect(store.getState().error).toBeNull();
    expect(roomSelectors.actionGate(store.getState(), 0, 0, 'reveal').allowed).toBe(true);
  });

  it('surfaces errors regardless of seq but never moves lastSeq backwards', () => {
    const { store } = startPlaying({ seq: 5 });

    store.applyServerMessage(makeError({ code: 'not-your-turn', currentSeq: 2 }));
    expect(store.getState().error?.code).toBe('not-your-turn');
    expect(store.getState().lastSeq).toBe(5);

    store.applyServerMessage(makeError({ code: 'bad-request', currentSeq: null }));
    expect(store.getState().error?.code).toBe('bad-request');
    expect(store.getState().lastSeq).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Connection status and readable errors
// ---------------------------------------------------------------------------

describe('room client store connection state', () => {
  it('mirrors the transport status and clears a recovered connection error', () => {
    const { store, transport } = setup('host');

    transport.emitStatus('connecting');
    expect(store.getState().connection).toBe('connecting');

    transport.emitStatus('reconnecting');
    transport.emitError('connection-lost');
    expect(store.getState().connection).toBe('reconnecting');
    expect(store.getState().error?.code).toBe('connection-lost');
    expect(store.getState().error?.retryable).toBe(true);

    transport.emitStatus('connected');
    expect(store.getState().connection).toBe('connected');
    expect(store.getState().error).toBeNull();

    // session-replaced is terminal and is not cleared by a status change.
    transport.emitError('session-replaced');
    transport.emitStatus('connected');
    expect(store.getState().error?.code).toBe('session-replaced');
    expect(store.getState().error?.retryable).toBe(false);

    // A late queued broadcast from the old socket must not revive the view.
    store.applyServerMessage(playingRoom({ seq: 3 }));
    store.applyServerMessage(makeSnapshot({ seq: 3 }));
    expect(store.getState().error?.code).toBe('session-replaced');
  });

  it('starts from the transport current status and lets a listener unsubscribe', () => {
    const { store, transport } = setup('host', 'reconnecting');
    expect(store.getState().connection).toBe('reconnecting');

    const seen: string[] = [];
    let removeSecond = () => {};
    const first = (): void => {
      seen.push('first');
      removeSecond();
    };
    store.subscribe(first);
    removeSecond = store.subscribe(() => seen.push('second'));

    store.applyServerMessage(makeRoomState({ seq: 1, state: 'waiting' }));

    // Dispatch iterates a copy, so removing a not-yet-visited listener during
    // the notification does not skip it.
    expect(seen).toEqual(['first', 'second']);
    expect(transport.sent).toEqual([]);
  });

  it('renders one readable text for every client error code', () => {
    const { store, transport } = setup('host');

    for (const code of ROOM_CLIENT_ERROR_CODES) {
      if ((CONNECTION_ERROR_CODES as readonly string[]).includes(code)) {
        transport.emitError(code as ConnectionErrorCode);
      } else {
        store.applyServerMessage(
          makeError({ code: code as ProtocolErrorCode, currentSeq: null, message: 'server detail' }),
        );
      }
      expect(store.getState().error?.code).toBe(code);
      expect(roomSelectors.errorText(store.getState())).toBe(ROOM_CLIENT_ERROR_TEXT[code]);
    }

    store.reset();
    expect(roomSelectors.errorText(store.getState())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Self identity and selectors
// ---------------------------------------------------------------------------

describe('room client selectors identity', () => {
  it('derives selfId from the host/guest seat and room_state', () => {
    const host = setup('host');
    host.store.applyServerMessage(playingRoom());
    expect(host.store.getState().selfId).toBe(HOST_ID);
    expect(roomSelectors.isHost(host.store.getState())).toBe(true);

    const guest = setup('guest');
    guest.store.applyServerMessage(playingRoom());
    expect(guest.store.getState().selfId).toBe(GUEST_ID);
    expect(roomSelectors.isHost(guest.store.getState())).toBe(false);

    const hostOnly = setup('guest');
    hostOnly.store.applyServerMessage(playingRoom({ players: [HOST] }));
    expect(hostOnly.store.getState().selfId).toBeNull();
    hostOnly.store.applyServerMessage(playingRoom({ seq: 3, players: [HOST, GUEST] }));
    expect(hostOnly.store.getState().selfId).toBe(GUEST_ID);
  });

  it('gates start and ready by phase and seat', () => {
    const host = setup('host');
    host.store.applyServerMessage(makeRoomState({ seq: 1, state: 'waiting' }));
    expect(roomSelectors.canStart(host.store.getState())).toBe(false);
    expect(roomSelectors.canToggleReady(host.store.getState())).toBe(true);

    host.store.applyServerMessage(makeRoomState({ seq: 2, state: 'ready' }));
    expect(roomSelectors.canStart(host.store.getState())).toBe(true);

    const guest = setup('guest');
    guest.store.applyServerMessage(makeRoomState({ seq: 2, state: 'ready' }));
    expect(roomSelectors.canStart(guest.store.getState())).toBe(false);
    expect(roomSelectors.canToggleReady(guest.store.getState())).toBe(true);

    guest.store.applyServerMessage(makeRoomState({ seq: 3, state: 'ready', players: [HOST] }));
    expect(guest.store.getState().selfId).toBeNull();
    expect(roomSelectors.canToggleReady(guest.store.getState())).toBe(false);

    host.store.applyServerMessage(playingRoom({ seq: 3 }));
    expect(roomSelectors.canStart(host.store.getState())).toBe(false);
    expect(roomSelectors.canToggleReady(host.store.getState())).toBe(false);
  });

  it('reports isMyTurn only for this seat on its own turn', () => {
    const host = startPlaying({ turnPlayerId: HOST_ID });
    expect(roomSelectors.isMyTurn(host.store.getState())).toBe(true);

    host.store.applyServerMessage(
      makeSnapshot({ seq: 3, turnPlayerId: GUEST_ID, turnId: 2 }),
    );
    expect(roomSelectors.isMyTurn(host.store.getState())).toBe(false);

    const guest = setup('guest');
    guest.store.applyServerMessage(playingRoom({ turnPlayerId: GUEST_ID }));
    guest.store.applyServerMessage(makeSnapshot({ seq: 2, turnPlayerId: GUEST_ID }));
    expect(roomSelectors.isMyTurn(guest.store.getState())).toBe(true);
  });
});

describe('room client actionGate', () => {
  function gatedState(): RoomClientState {
    const { store } = startPlaying({
      board: boardWith([
        { row: 0, col: 1, revealed: true, adjacentMines: 1 },
        { row: 1, col: 0, flagged: true },
      ]),
    });
    return store.getState();
  }

  it('allows reveal and flag only on an actionable cell of my turn', () => {
    const state = gatedState();
    expect(roomSelectors.actionGate(state, 0, 0, 'reveal')).toEqual({
      allowed: true,
      reason: null,
      message: null,
    });
    expect(roomSelectors.actionGate(state, 0, 0, 'flag')).toEqual({
      allowed: true,
      reason: null,
      message: null,
    });
  });

  it('blocks a cell that is already revealed or flagged', () => {
    const state = gatedState();
    for (const kind of ['reveal', 'flag'] as const) {
      expect(roomSelectors.actionGate(state, 0, 1, kind).reason).toBe('cell-revealed');
      expect(roomSelectors.actionGate(state, 1, 0, kind).reason).toBe('cell-flagged');
    }
    expect(roomSelectors.actionGate(state, 0, 1, 'reveal').message).not.toBeNull();
  });

  it('blocks out-of-bounds, non-playing and missing-board intents', () => {
    const playing = gatedState();
    expect(roomSelectors.actionGate(playing, -1, 0, 'reveal').reason).toBe('out-of-bounds');
    expect(roomSelectors.actionGate(playing, 0, 3, 'flag').reason).toBe('out-of-bounds');
    expect(roomSelectors.actionGate(playing, 0.5, 0, 'reveal').reason).toBe('out-of-bounds');

    const lobby = setup('host');
    lobby.store.applyServerMessage(makeRoomState({ seq: 1, state: 'ready' }));
    expect(roomSelectors.actionGate(lobby.store.getState(), 0, 0, 'reveal').reason).toBe(
      'room-not-playing',
    );

    const noBoard = setup('host');
    noBoard.store.applyServerMessage(playingRoom());
    expect(roomSelectors.actionGate(noBoard.store.getState(), 0, 0, 'reveal').reason).toBe(
      'missing-board',
    );
  });

  it('blocks every intent when it is not my turn', () => {
    const { store } = startPlaying({ turnPlayerId: GUEST_ID });
    const state = store.getState();
    expect(roomSelectors.actionGate(state, 0, 0, 'reveal').reason).toBe('not-your-turn');
    expect(roomSelectors.actionGate(state, 1, 1, 'flag').reason).toBe('not-your-turn');
  });

  it('exposes a pending-safe, mine-free board view', () => {
    const state = gatedState();
    const view = roomSelectors.board(state);
    expect(view).not.toBeNull();
    if (view === null) return;

    expect(view.rows).toBe(3);
    expect(view.cols).toBe(3);
    expect(view.selfId).toBe(HOST_ID);
    expect(view.turnPlayerId).toBe(HOST_ID);
    expect(view.cells).toHaveLength(3);
    expect(view.cells[0]).toHaveLength(3);

    expect(view).toEqual({
      roomId: ROOM_ID,
      matchId: MATCH_ID,
      selfId: HOST_ID,
      turnPlayerId: HOST_ID,
      turnId: 1,
      status: 'playing',
      seedHash: 'seed-hash',
      deadlineAt: NOW + 30_000,
      matchDeadlineAt: NOW + 900_000,
      elapsedMs: 0,
      mineCount: 2,
      remainingMines: 2,
      revealedSafeCount: 0,
      rows: 3,
      cols: 3,
      cells: [
        [
          { row: 0, col: 0, revealed: false, flagged: false, adjacentMines: 0, pending: false },
          { row: 0, col: 1, revealed: true, flagged: false, adjacentMines: 1, pending: false },
          { row: 0, col: 2, revealed: false, flagged: false, adjacentMines: 0, pending: false },
        ],
        [
          { row: 1, col: 0, revealed: false, flagged: true, adjacentMines: 0, pending: false },
          { row: 1, col: 1, revealed: false, flagged: false, adjacentMines: 0, pending: false },
          { row: 1, col: 2, revealed: false, flagged: false, adjacentMines: 0, pending: false },
        ],
        [
          { row: 2, col: 0, revealed: false, flagged: false, adjacentMines: 0, pending: false },
          { row: 2, col: 1, revealed: false, flagged: false, adjacentMines: 0, pending: false },
          { row: 2, col: 2, revealed: false, flagged: false, adjacentMines: 0, pending: false },
        ],
      ],
    });
    const revealed = view.cells[0]?.[1];
    expect(Object.keys(revealed ?? {})).not.toContain('mine');
    expect(Object.keys(view.cells[1]?.[0] ?? {})).not.toContain('mine');
  });

  it('returns a null board before the first snapshot', () => {
    const { store } = setup('host');
    expect(roomSelectors.board(store.getState())).toBeNull();
    store.applyServerMessage(playingRoom());
    expect(roomSelectors.board(store.getState())).toBeNull();
  });
});

describe('room client countdown', () => {
  it('follows the join deadline in the lobby', () => {
    const { store } = setup('host');
    store.applyServerMessage(
      makeRoomState({ seq: 1, state: 'waiting', joinDeadlineAt: NOW + 500 }),
    );

    const countdown = roomSelectors.countdown(store.getState(), NOW);
    expect(countdown).toEqual({
      kind: 'join',
      deadlineAt: NOW + 500,
      remainingMs: 500,
      expired: false,
      label: '加入倒计时',
    });

    const expired = roomSelectors.countdown(store.getState(), NOW + 800);
    expect(expired.remainingMs).toBe(0);
    expect(expired.expired).toBe(true);
  });

  it('picks the earlier of the turn and match deadlines while playing', () => {
    const { store } = startPlaying({
      deadlineAt: NOW + 30_000,
      matchDeadlineAt: NOW + 20_000,
    });

    const match = roomSelectors.countdown(store.getState(), NOW);
    expect(match.kind).toBe('match');
    expect(match.deadlineAt).toBe(NOW + 20_000);
    expect(match.remainingMs).toBe(20_000);
    expect(match.label).toBe('对局倒计时');

    store.applyServerMessage(
      makeSnapshot({ seq: 3, deadlineAt: NOW + 10_000, matchDeadlineAt: NOW + 20_000 }),
    );
    const turn = roomSelectors.countdown(store.getState(), NOW);
    expect(turn.kind).toBe('turn');
    expect(turn.deadlineAt).toBe(NOW + 10_000);
    expect(turn.remainingMs).toBe(10_000);
    expect(turn.label).toBe('回合倒计时');
  });

  it('has no countdown while playing without a server deadline', () => {
    const { store } = setup('host');
    store.applyServerMessage(playingRoom({ deadlineAt: null }));
    expect(roomSelectors.countdown(store.getState(), NOW).kind).toBe('none');
  });

  it('has no countdown outside a live phase', () => {
    const { store } = setup('host');
    expect(roomSelectors.countdown(store.getState(), NOW)).toEqual({
      kind: 'none',
      deadlineAt: null,
      remainingMs: 0,
      expired: false,
      label: '',
    });

    store.applyServerMessage(makeRoomState({ seq: 1, state: 'finished' }));
    expect(roomSelectors.countdown(store.getState(), NOW).kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('room client redaction', () => {
  it('strips the owner-only playerToken and never renders hidden mines', () => {
    const { store } = setup('host');
    store.applyServerMessage(
      playingRoom({ playerToken: 'owner-only-token' }),
    );
    store.applyServerMessage(makeSnapshot({ seq: 2 }));

    const state = store.getState();
    expect(state.room).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(state.room, 'playerToken')).toBe(false);
    expect(JSON.stringify(state)).not.toContain('owner-only-token');
    expect(state.end).toBeNull();

    const cell = state.snapshot?.board[0]?.[0];
    expect(cell).toBeDefined();
    expect(Object.keys(cell ?? {})).not.toContain('mine');
    expect(Object.keys(cell ?? {}).sort()).toEqual([
      'adjacentMines',
      'col',
      'flagged',
      'revealed',
      'row',
    ]);
  });

  it('publishes mines and the seed only through the end payload', () => {
    const { store } = startPlaying({ seq: 2 });
    expect(store.getState().end).toBeNull();
    expect(JSON.stringify(store.getState())).not.toContain('"seed":');

    store.applyServerMessage(makeEnd({ seq: 3 }));
    const end = store.getState().end;
    expect(end?.seed).toBe(END_SEED);
    expect(end?.finalSnapshot[0]?.[1]?.mine).toBe(true);
  });
});
