/**
 * Client room store for online Minesweeper (#486 t2).
 *
 * This module is the reducer behind {@link RoomClientStore} plus the read-only
 * {@link RoomSelectors}: it owns no DOM, no socket and no wire message. Server
 * messages arrive through {@link RoomClientStore.applyServerMessage} (the
 * composition root forwards `ClientTransport.onMessage`) and the connection
 * lifecycle is mirrored from the injected transport's status/error callbacks.
 *
 * Sequence rules, from `design:protocol` and `design:reconnect`:
 *
 * - `room_state`, `snapshot`, `action_result`, `end`, `timeout` and
 *   `room_closed` are ordered by their server `seq`. A message older than
 *   `lastSeq` is dropped.
 * - One state change can publish several facets with the same `seq`
 *   (`room_state` + `snapshot` on start, `action_result` + `snapshot` +
 *   `end` + `room_state` on a terminal action), so a same-`seq` message is
 *   merged once per message type instead of being dropped wholesale.
 * - Presence changes do not advance `seq`, so a repeated `room_state` at the
 *   applied `seq` is merged when its room data actually changed. The coarse
 *   "not newer than lastSeq" wording in `contracts.ts` is about duplicate
 *   state changes, not about dropping the other same-seq facets below.
 * - Terminal errors (`unsupported-version`, `room-not-found`,
 *   `session-replaced`) survive an authoritative message; a late queued
 *   broadcast must not hide that the seat is gone.
 * - `error` is not sequence-gated. Its `currentSeq` aligns `lastSeq` so the
 *   resync `room_state`/`snapshot` at that seq can replace the whole view,
 *   and the store never replays an unconfirmed action. `stale-state` is only
 *   a "wait for the server resync" hint.
 * - Reconnect recovery is `snapshot-at-current-seq`: the server's current
 *   `room_state` and `snapshot` replace the room and board wholesale; nothing
 *   from the pre-disconnect sequence is merged back in.
 *
 * `room_state` has no per-recipient `playerId`; the seat role from the stored
 * `SeatSession` plus `hostId`/`players` derives `selfId`, and the
 * owner-only `playerToken` is stripped before the room reaches render state.
 */

import {
  connectionClientError,
  createInitialRoomClientState,
  deriveSelfId,
  roomClientErrorFromWire,
  roomClientErrorText,
  type BoardActionBlockReason,
  type BoardActionGate,
  type BoardViewModel,
  type CountdownKind,
  type OnlineBoardCellView,
  type RoomClientError,
  type RoomClientErrorCode,
  type RoomClientRoom,
  type RoomClientState,
  type RoomClientStateListener,
  type RoomClientStore,
  type RoomClientStoreOptions,
  type RoomConnectionStatus,
  type RoomCountdown,
  type RoomSelectors,
} from './contracts';
import type {
  ActionKind,
  ActionResultMessage,
  EndMessage,
  ErrorMessage,
  PlayerView,
  RoomClosedMessage,
  RoomStateMessage,
  ServerToClientMessage,
  SnapshotMessage,
  TimeoutMessage,
} from '../types';

/** Every server message that carries a monotonic room `seq`. */
type SequencedServerMessage = Exclude<ServerToClientMessage, ErrorMessage>;

const COUNTDOWN_LABELS: Readonly<Record<CountdownKind, string>> = Object.freeze({
  join: '加入倒计时',
  turn: '回合倒计时',
  match: '对局倒计时',
  none: '',
});

const NO_COUNTDOWN: RoomCountdown = Object.freeze({
  kind: 'none',
  deadlineAt: null,
  remainingMs: 0,
  expired: false,
  label: COUNTDOWN_LABELS.none,
});

const BLOCKED_MESSAGES: Readonly<Record<BoardActionBlockReason, string>> = Object.freeze({
  'room-not-playing': '对局尚未开始或已结束。',
  'missing-board': '棋盘还没有加载完成，请稍候。',
  'not-your-turn': roomClientErrorText('not-your-turn'),
  'out-of-bounds': '这个格子不在棋盘内。',
  'cell-revealed': '这个格子已经翻开。',
  'cell-flagged': '这个格子已插旗，请先取消插旗。',
  'awaiting-server': '正在等待服务器同步最新棋盘，请稍候。',
});

/** A locked gate for one board intent; the message is already readable. */
function blocked(reason: BoardActionBlockReason): BoardActionGate {
  return Object.freeze({
    allowed: false,
    reason,
    message: BLOCKED_MESSAGES[reason],
  });
}

/** The gate used when one reveal/flag intent is currently allowed. */
const ALLOWED_GATE: BoardActionGate = Object.freeze({
  allowed: true,
  reason: null,
  message: null,
});

/**
 * The latest room broadcast without the owner-only bearer token.
 *
 * Built field by field instead of `{ ...message }` so the token can never be
 * reintroduced by a future wire field that has not been classified yet, and
 * so the returned value is typed as {@link RoomClientRoom}.
 */
function stripPlayerToken(message: RoomStateMessage): RoomClientRoom {
  return {
    type: 'room_state',
    roomId: message.roomId,
    seq: message.seq,
    state: message.state,
    hostId: message.hostId,
    capacity: message.capacity,
    players: message.players,
    config: message.config,
    matchId: message.matchId,
    turnPlayerId: message.turnPlayerId,
    joinDeadlineAt: message.joinDeadlineAt,
    deadlineAt: message.deadlineAt,
    stateReason: message.stateReason,
  };
}

function samePlayer(left: PlayerView, right: PlayerView): boolean {
  return (
    left.playerId === right.playerId &&
    left.displayName === right.displayName &&
    left.ready === right.ready &&
    left.presence === right.presence &&
    left.isHost === right.isHost
  );
}

/**
 * Structural comparison used to ignore an identical `room_state` repeated at
 * the already-applied `seq`. Presence is part of the comparison, so a genuine
 * presence-only change still commits.
 */
function sameRoom(left: RoomClientRoom, right: RoomClientRoom | null): boolean {
  if (right === null) return false;
  if (
    left.roomId !== right.roomId ||
    left.seq !== right.seq ||
    left.state !== right.state ||
    left.hostId !== right.hostId ||
    left.capacity !== right.capacity ||
    left.matchId !== right.matchId ||
    left.turnPlayerId !== right.turnPlayerId ||
    left.joinDeadlineAt !== right.joinDeadlineAt ||
    left.deadlineAt !== right.deadlineAt ||
    left.stateReason !== right.stateReason ||
    left.players.length !== right.players.length ||
    left.config.rows !== right.config.rows ||
    left.config.cols !== right.config.cols ||
    left.config.mines !== right.config.mines ||
    left.config.firstClickSafe !== right.config.firstClickSafe
  ) {
    return false;
  }
  return left.players.every((player, index) => {
    const other = right.players[index];
    return other !== undefined && samePlayer(player, other);
  });
}

function sameError(left: RoomClientError, right: RoomClientError | null): boolean {
  if (right === null) return false;
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.detail === right.detail &&
    left.retryable === right.retryable &&
    left.requestId === right.requestId &&
    left.currentSeq === right.currentSeq
  );
}

/**
 * Errors an authoritative message cannot resolve: the seat or protocol is
 * unusable, so a late queued broadcast must not make the UI look healthy again.
 */
const TERMINAL_ERROR_CODES: ReadonlySet<RoomClientErrorCode> = new Set([
  'unsupported-version',
  'room-not-found',
  'session-replaced',
]);

/** Keep a terminal error; clear a recoverable one on an authoritative message. */
function errorAfterState(error: RoomClientError | null): RoomClientError | null {
  return error !== null && TERMINAL_ERROR_CODES.has(error.code) ? error : null;
}

/**
 * A room broadcast is not board-authoritative: a presence-only repeat must not
 * hide a `stale-state` hint while the playing snapshot is still behind, and a
 * buffered broadcast must not revive a terminal error. `connection-lost` is
 * resolved by any delivered message; other recoverable errors clear here
 * because the following snapshot/end clears them anyway.
 */
function errorAfterRoomState(
  error: RoomClientError | null,
  state: RoomStateMessage['state'],
): RoomClientError | null {
  if (error === null) return null;
  if (TERMINAL_ERROR_CODES.has(error.code)) return error;
  if (error.code === 'connection-lost') return null;
  if (error.code === 'stale-state' && state === 'playing') return error;
  return null;
}

/** The turn owner as currently rendered: the snapshot is ahead of room_state. */
function currentTurnPlayerId(state: RoomClientState): string | null {
  return state.snapshot?.turnPlayerId ?? state.room?.turnPlayerId ?? null;
}

/** True only while playing and this seat owns the current turn. */
function isMyTurn(state: RoomClientState): boolean {
  return (
    state.phase === 'playing' &&
    state.selfId !== null &&
    currentTurnPlayerId(state) === state.selfId
  );
}

/** True when this seat is the host of the current room. */
function isHost(state: RoomClientState): boolean {
  return state.room !== null && state.selfId !== null && state.room.hostId === state.selfId;
}

/** Build the redacted board view from the latest server snapshot. */
function board(state: RoomClientState): BoardViewModel | null {
  const snapshot = state.snapshot;
  if (snapshot === null) return null;

  // The store has no in-flight submission field, so `pending` stays false;
  // the view can overlay its own submit state without changing this board.
  const cells: OnlineBoardCellView[][] = snapshot.board.map((row, rowIndex) =>
    row.map((cell, colIndex) => ({
      row: rowIndex,
      col: colIndex,
      revealed: cell.revealed,
      flagged: cell.flagged,
      adjacentMines: cell.adjacentMines,
      pending: false,
    })),
  );

  return {
    roomId: snapshot.roomId,
    matchId: snapshot.matchId,
    selfId: state.selfId,
    turnPlayerId: snapshot.turnPlayerId,
    turnId: snapshot.turnId,
    status: snapshot.engineStatus,
    seedHash: snapshot.seedHash,
    deadlineAt: snapshot.deadlineAt,
    matchDeadlineAt: snapshot.matchDeadlineAt,
    elapsedMs: snapshot.elapsedMs,
    mineCount: snapshot.mineCount,
    remainingMines: snapshot.remainingMines,
    revealedSafeCount: snapshot.revealedSafeCount,
    rows: cells.length,
    cols: cells[0]?.length ?? 0,
    cells,
  };
}

/**
 * Decide whether one reveal/flag intent may be submitted right now.
 *
 * After `stale-state` the board is stale until the server resync arrives, so
 * the gate reports `awaiting-server` instead of letting the view submit on an
 * outdated snapshot. `kind` does not widen the gate: the server rejects both
 * intents on a non-hidden cell, so the cell state decides first.
 */
function actionGate(
  state: RoomClientState,
  row: number,
  col: number,
  _kind: ActionKind,
): BoardActionGate {
  if (state.phase !== 'playing') return blocked('room-not-playing');
  if (state.error?.code === 'stale-state') return blocked('awaiting-server');

  const snapshot = state.snapshot;
  if (snapshot === null) return blocked('missing-board');
  // `action_result` advances `lastSeq` before the paired snapshot is applied;
  // a click in that gap would submit against the previous board.
  if (snapshot.seq < state.lastSeq) return blocked('awaiting-server');
  if (!isMyTurn(state)) return blocked('not-your-turn');

  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) {
    return blocked('out-of-bounds');
  }
  const rowCells = snapshot.board[row];
  if (rowCells === undefined) return blocked('out-of-bounds');
  const cell = rowCells[col];
  if (cell === undefined) return blocked('out-of-bounds');

  // Reveal and flag are both disabled on a cell that is already open or
  // already carries a flag; the view shows the matching reason. `kind` does
  // not widen the gate: an intent that cannot change this cell is blocked by
  // the cell state first.
  if (cell.revealed) return blocked('cell-revealed');
  if (cell.flagged) return blocked('cell-flagged');

  return ALLOWED_GATE;
}

function countdownFor(
  kind: Exclude<CountdownKind, 'none'>,
  deadlineAt: number,
  nowMs: number,
): RoomCountdown {
  return {
    kind,
    deadlineAt,
    remainingMs: Math.max(0, deadlineAt - nowMs),
    expired: nowMs >= deadlineAt,
    label: COUNTDOWN_LABELS[kind],
  };
}

/**
 * Estimate the relevant server deadline at `nowMs`.
 *
 * The deadline is the server's; this value is display-only and never decides
 * whether an action is legal. While playing the earlier of the turn and match
 * deadlines wins; in the lobby the join deadline applies.
 */
function countdown(state: RoomClientState, nowMs: number): RoomCountdown {
  if (state.phase === 'playing') {
    const turnDeadlineAt = state.snapshot?.deadlineAt ?? state.room?.deadlineAt ?? null;
    const matchDeadlineAt = state.snapshot?.matchDeadlineAt ?? null;

    if (turnDeadlineAt !== null && (matchDeadlineAt === null || turnDeadlineAt <= matchDeadlineAt)) {
      return countdownFor('turn', turnDeadlineAt, nowMs);
    }
    if (matchDeadlineAt !== null) {
      return countdownFor('match', matchDeadlineAt, nowMs);
    }
    return NO_COUNTDOWN;
  }

  if (state.phase === 'waiting' || state.phase === 'ready') {
    const joinDeadlineAt = state.room?.joinDeadlineAt ?? null;
    return joinDeadlineAt === null ? NO_COUNTDOWN : countdownFor('join', joinDeadlineAt, nowMs);
  }

  return NO_COUNTDOWN;
}

/** Readable text for the current error, or `null` when there is none. */
function errorText(state: RoomClientState): string | null {
  return state.error?.message ?? null;
}

/** Read-only derivations shared by the room view and its tests. */
export const roomSelectors: RoomSelectors = Object.freeze({
  isMyTurn,
  isHost,
  canStart(state: RoomClientState): boolean {
    return state.phase === 'ready' && isHost(state);
  },
  canToggleReady(state: RoomClientState): boolean {
    return (state.phase === 'waiting' || state.phase === 'ready') && state.selfId !== null;
  },
  board,
  actionGate,
  countdown,
  errorText,
});

/**
 * Create the client state machine for one seat.
 *
 * The store subscribes to the transport's connection status and connection
 * errors because those are the only client-side sources for `connection` and
 * the two connection-layer error codes. Wire messages are applied through the
 * public `applyServerMessage` seam so the composition root can forward
 * `transport.onMessage` without opening a second reducer.
 */
export function createRoomClientStore(options: RoomClientStoreOptions): RoomClientStore {
  const { session, transport } = options;

  let state = createInitialRoomClientState(session);
  /**
   * Facets already applied at `state.lastSeq`. Several messages can share one
   * seq, but the same facet must not be applied twice.
   */
  let appliedTypesAtSeq = new Set<SequencedServerMessage['type']>();
  const listeners = new Set<RoomClientStateListener>();

  // The state object is frozen; the wire payloads it references are treated
  // as immutable and never rewritten (freezing them would mutate the
  // transport's objects, which `applyServerMessage` must not do).
  function publish(next: RoomClientState): void {
    state = Object.freeze(next);
    // Copy so a listener may unsubscribe while the state is being delivered.
    for (const listener of Array.from(listeners)) {
      listener(state);
    }
  }

  /**
   * Gate one sequenced message and record its type for the current seq.
   *
   * Returns `false` for an older message or a duplicate facet. A same-seq
   * `room_state` is always allowed through so a presence-only change that
   * does not advance `seq` is not lost; {@link sameRoom} drops an identical
   * repeat after the merge.
   */
  function acceptSequenced(message: SequencedServerMessage): boolean {
    if (message.seq < state.lastSeq) return false;

    if (message.seq > state.lastSeq) {
      appliedTypesAtSeq = new Set<SequencedServerMessage['type']>([message.type]);
      return true;
    }

    if (appliedTypesAtSeq.has(message.type)) {
      return message.type === 'room_state';
    }
    appliedTypesAtSeq.add(message.type);
    return true;
  }

  function applyRoomState(message: RoomStateMessage): void {
    if (!acceptSequenced(message)) return;

    const room = stripPlayerToken(message);
    const selfId = state.role === null ? null : deriveSelfId(state.role, message);
    const nextError = errorAfterRoomState(state.error, message.state);
    const matchId = message.matchId;
    // A lobby (including rematch) carries no board; a broadcast for a
    // different match also invalidates the previous result. Dissolving keeps
    // a result that was already shown, like `room_closed`, but drops the board.
    const isLobby = matchId === null || message.state === 'waiting' || message.state === 'ready';
    let snapshot = state.snapshot;
    let end = state.end;
    if (isLobby) {
      snapshot = null;
      end = null;
    } else {
      if (message.state === 'dissolved') snapshot = null;
      if (snapshot !== null && snapshot.matchId !== matchId) snapshot = null;
      if (end !== null && end.matchId !== matchId) end = null;
    }

    // Presence updates reuse the current seq, so only a fully identical
    // repeat is ignored. `nextError` keeps a terminal error and a playing
    // `stale-state` hint, so a presence repeat cannot hide either.
    if (
      message.seq === state.lastSeq &&
      state.phase === message.state &&
      state.selfId === selfId &&
      state.error === nextError &&
      snapshot === state.snapshot &&
      end === state.end &&
      sameRoom(room, state.room)
    ) {
      return;
    }

    publish({
      ...state,
      phase: message.state,
      lastSeq: message.seq,
      selfId,
      room: Object.freeze(room),
      snapshot,
      end,
      error: nextError,
    });
  }

  function applySnapshot(message: SnapshotMessage): void {
    // `stale-state` at the already-applied seq means the board may be current
    // but the verdict is not: a resync snapshot at that seq is a deliberate
    // replay and must be admitted to clear the hint, even though a snapshot
    // facet was already applied at this seq.
    const staleResync =
      message.seq === state.lastSeq &&
      state.error?.code === 'stale-state' &&
      appliedTypesAtSeq.has('snapshot');
    if (!staleResync && !acceptSequenced(message)) return;

    // A dissolved room has no live board; a late same-seq snapshot must not
    // repopulate it. Any other phase accepts the snapshot, but `end` may share
    // this seq and always follows the snapshot, so a finished/dissolved view
    // must not move back to playing.
    if (state.phase === 'dissolved') {
      publish({ ...state, lastSeq: message.seq, error: errorAfterState(state.error) });
      return;
    }
    const phase = state.phase === 'finished' ? 'finished' : 'playing';
    publish({
      ...state,
      phase,
      lastSeq: message.seq,
      snapshot: message,
      error: errorAfterState(state.error),
    });
  }

  function applyActionResult(message: ActionResultMessage): void {
    if (!acceptSequenced(message)) return;

    // The action result and the following snapshot share one seq. The
    // snapshot carries the board, so this facet only commits the sequence and
    // clears a previous error; a rejected verdict changes no server state.
    publish({
      ...state,
      lastSeq: message.seq,
      error: errorAfterState(state.error),
    });
  }

  function applyEnd(message: EndMessage): void {
    if (!acceptSequenced(message)) return;

    publish({
      ...state,
      phase: 'finished',
      lastSeq: message.seq,
      end: message,
      error: errorAfterState(state.error),
    });
  }

  function applyTimeout(message: TimeoutMessage): void {
    if (!acceptSequenced(message)) return;

    const dissolved = message.resultingState === 'dissolved';
    publish({
      ...state,
      phase: message.resultingState,
      lastSeq: message.seq,
      snapshot: dissolved ? null : state.snapshot,
      error: errorAfterState(state.error),
    });
  }

  function applyRoomClosed(message: RoomClosedMessage): void {
    if (!acceptSequenced(message)) return;

    // The room is gone. Keep `end` so a result that was already shown stays
    // readable, but clear the room/board so selectors cannot act on them.
    publish({
      ...state,
      phase: message.finalState,
      lastSeq: message.seq,
      room: null,
      snapshot: null,
      error: errorAfterState(state.error),
    });
  }

  function applyError(message: ErrorMessage): void {
    const error = roomClientErrorFromWire(message);
    let lastSeq = state.lastSeq;
    if (message.currentSeq !== null && message.currentSeq > lastSeq) {
      // The server is ahead of this client: align so the resync payload at
      // `currentSeq` is applied, and so older in-flight broadcasts are
      // dropped rather than merged into a state the server already replaced.
      lastSeq = message.currentSeq;
      appliedTypesAtSeq = new Set();
    }
    if (lastSeq === state.lastSeq && sameError(error, state.error)) return;
    // A terminal error already reported is not replaced by a late queued
    // frame: the seat or protocol is still unusable, and a recoverable wire
    // error would make the UI look like a normal turn/validation failure
    // again. The frame may still align `lastSeq` (above) so the resync payload
    // at that seq is admitted.
    if (state.error !== null && TERMINAL_ERROR_CODES.has(state.error.code)) {
      if (lastSeq === state.lastSeq) return;
      publish({ ...state, lastSeq });
      return;
    }
    publish({ ...state, lastSeq, error });
  }

  function applyServerMessage(message: ServerToClientMessage): void {
    switch (message.type) {
      case 'room_state':
        applyRoomState(message);
        break;
      case 'snapshot':
        applySnapshot(message);
        break;
      case 'action_result':
        applyActionResult(message);
        break;
      case 'end':
        applyEnd(message);
        break;
      case 'timeout':
        applyTimeout(message);
        break;
      case 'room_closed':
        applyRoomClosed(message);
        break;
      case 'error':
        applyError(message);
        break;
    }
  }

  // The transport reports the current status once on subscription, so a store
  // created before `connect` still starts from the real status.
  transport.onStatus((connection: RoomConnectionStatus) => {
    // A recovered socket resolves the connection-layer error it reported.
    const error =
      connection === 'connected' && state.error?.code === 'connection-lost'
        ? null
        : state.error;
    if (connection === state.connection && error === state.error) return;
    publish({ ...state, connection, error });
  });

  transport.onError((code) => {
    const error = connectionClientError(code);
    if (sameError(error, state.error)) return;
    publish({ ...state, error });
  });

  return {
    getState(): RoomClientState {
      return state;
    },
    subscribe(listener: RoomClientStateListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applyServerMessage,
    reset(): void {
      appliedTypesAtSeq = new Set();
      const next = createInitialRoomClientState(session);
      if (
        state.phase === next.phase &&
        state.connection === next.connection &&
        state.lastSeq === next.lastSeq &&
        state.role === next.role &&
        state.selfId === next.selfId &&
        state.room === next.room &&
        state.snapshot === next.snapshot &&
        state.end === next.end &&
        state.error === next.error
      ) {
        return;
      }
      publish(next);
    },
  };
}
