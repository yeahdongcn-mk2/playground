/**
 * Server-side state machine for one authoritative Minesweeper match.
 *
 * This module is deliberately pure with respect to the room layer: it never
 * touches the room table, a socket, a timer or storage. `createMatchState`
 * starts a match from a server-chosen id/seed and the seat order, every later
 * function takes the previous immutable state plus an explicit `nowMs`, and a
 * returned wrapper is a new value. The caller owns the room-level broadcast
 * sequence: it passes the starting snapshot's room seq as `initialSeq`
 * (standalone tests default to 0), every accepted action and an end-only
 * forfeit advances it by one, so a client can echo the `seq` it last applied in
 * `action.seq`. The `to…Message` helpers stamp or override that value when they
 * build wire messages. Rejections never advance `seq` or `turnId` and never
 * mutate the engine.
 *
 * The match reuses the shared contract from `src/games/minesweeper/online`:
 * the engine instance, redacted projection, end-only payload and replay log
 * all come from `engineAdapter`, action admission is `evaluateAction`, and the
 * seed commitment is `hashSeed`. The single-player engine is untouched.
 *
 * Wire semantics implemented here (design 4.5 and 4.6):
 *
 * - the host moves first; after an action that does not end the match the turn
 *   passes to the next seat in seat order and the turn deadline is reset;
 * - a client sends `seq` (its last applied broadcast seq) and `turnId`; both
 *   must equal the current state, and an action at/after `turnDeadlineAt` or
 *   `matchDeadlineAt` is rejected with `deadline-passed`;
 * - one accepted action consumes one turn (`flag` included);
 * - a retried `actionId` of the same player returns the cached
 *   `action_result` and changes nothing, even after the turn has passed;
 * - `mine-hit`, `all-safe-revealed` and an explicit `forfeit` each produce one
 *   `end` and mark the match finished; a second end is never produced.
 */

import {
  endPayload,
  engineAdapter,
  evaluateAction,
  hashSeed,
  matchDigest,
  replayMatch,
  type ActionMessage,
  type ActionResultMessage,
  type EndMessage,
  type EngineMatch,
  type MatchEndPayload,
  type MatchEndReason,
  type MatchStats,
  type ProtocolValidationFailure,
  type RedactedSnapshot,
  type RevealedBoard,
  type ReplayAction,
  type SnapshotMessage,
  type ReplayDigest,
  type ReplayOutcome,
  type ReplayRecord,
} from '../../src/games/minesweeper/online/index';
import {
  validateConfig,
  type Cell,
  type MinesweeperConfig,
} from '../../src/games/minesweeper/engine';

/** Players in one match; the room capacity is fixed at two (design 3.4). */
export const MATCH_PLAYER_COUNT = 2;

/** Default window of `actionId` results kept for idempotent retries. */
export const DEFAULT_ACTION_CACHE_LIMIT = 64;

/** One seat, in the order used for turn rotation. */
export interface MatchSeat {
  readonly playerId: string;
  readonly isHost: boolean;
}

/** Inputs for a fresh authoritative match. Durations are in milliseconds. */
export interface CreateMatchStateInput {
  /** Opaque match id; the room layer mints it at `start`. */
  readonly matchId: string;
  /**
   * Room-level broadcast `seq` of the starting snapshot. The match keeps using
   * this sequence for its actions, so a client can echo the wire `seq` back in
   * `action.seq`. Defaults to 0 for a standalone match (tests).
   */
  readonly initialSeq?: number;
  /** Validated board setup shared by both seats. */
  readonly config: MinesweeperConfig;
  /** Server-chosen integer seed, committed as `seedHash` before play. */
  readonly seed: number;
  /** Both seats in turn-rotation order; exactly one is the host. */
  readonly seats: readonly MatchSeat[];
  /** Clock used for deadlines and stats; no timer is created here. */
  readonly nowMs: number;
  /** Length of one turn; the deadline resets after every accepted action. */
  readonly turnDurationMs: number;
  /** Length of the whole match from `nowMs`; never extended. */
  readonly matchDurationMs: number;
  /** Retained `actionId` results; defaults to {@link DEFAULT_ACTION_CACHE_LIMIT}. */
  readonly actionCacheLimit?: number;
}

/** The subset of an `action` message the match needs; room fields stay outside. */
export type MatchAction = Pick<
  ActionMessage,
  'actionId' | 'seq' | 'turnId' | 'kind' | 'row' | 'col'
>;

/**
 * One accepted action's client-visible verdict, i.e. the cached
 * `action_result` body. The room layer adds `type`, `roomId` and its own
 * broadcast `seq`.
 */
export interface MatchActionResult {
  readonly matchId: string;
  readonly actionId: string;
  readonly seq: number;
  readonly turnId: number;
  readonly accepted: true;
  readonly reason: null;
  readonly revealedCells: readonly Cell[];
  readonly flaggedCell: Cell | null;
  readonly turnPlayerId: string;
  readonly deadlineAt: number;
}

/** One cache entry; the actor keeps a retry from receiving another player's result. */
export interface CachedActionResult {
  readonly actorId: string;
  readonly result: MatchActionResult;
}

/**
 * Redacted snapshot plus turn bookkeeping.
 *
 * This is the body of a `snapshot` message without its room fields
 * (`type`/`roomId`). `seq` is the authoritative sequence (see the module
 * header); {@link toSnapshotMessage} stamps the caller's room id and seq. It
 * never contains the seed, an unrevealed mine or a hidden cell's adjacent
 * count.
 */
export interface MatchSnapshot extends RedactedSnapshot {
  readonly matchId: string;
  readonly seq: number;
  readonly turnId: number;
  readonly turnPlayerId: string;
  /** Absolute deadline of the current turn. */
  readonly deadlineAt: number;
  /** Absolute deadline of the whole match. */
  readonly matchDeadlineAt: number;
}

/**
 * End-only result plus the authoritative sequence it was published at.
 *
 * `MatchEndPayload` is the adapter's revealed board + seed + stats; `seq` lets
 * the room layer place `end` on the wire. The wire `seq` stays caller-owned,
 * so {@link toEndMessage} replaces it with the room sequence.
 */
export interface MatchEnd extends MatchEndPayload {
  readonly seq: number;
}

/** Immutable authoritative state of one running or finished match. */
export interface MatchState {
  readonly matchId: string;
  readonly config: MinesweeperConfig;
  /** Server-only seed. Never copy this into a snapshot; `end.seed` reveals it. */
  readonly seed: number;
  /** `sha256(String(seed))`, the only seed-derived value a snapshot carries. */
  readonly seedHash: string;
  /** Opaque server-only engine handle; the room may tick it between actions. */
  readonly engine: EngineMatch;
  /** Clock value passed to `createMatchState`. */
  readonly startedAtMs: number;
  readonly turnDurationMs: number;
  readonly matchDurationMs: number;
  /** Retained `actionId` results; used by the bounded insertion-order cache. */
  readonly actionCacheLimit: number;
  /** Seat ids in seat order; the host may sit anywhere and moves first. */
  readonly playerIds: readonly string[];
  /** Last broadcast seq; `initialSeq` after start, advanced by actions/forfeit. */
  readonly seq: number;
  /** Current turn id; unchanged when an action ends the match. */
  readonly turnId: number;
  readonly turnPlayerId: string;
  readonly turnDeadlineAt: number;
  readonly matchDeadlineAt: number;
  /** Accepted actions in `seq` order, as recorded for replay. */
  readonly actions: readonly ReplayAction[];
  /** One digest per accepted action, in the same order as `actions`. */
  readonly digests: readonly ReplayDigest[];
  /** Bounded idempotency cache, in insertion order. */
  readonly actionResults: ReadonlyMap<string, CachedActionResult>;
  readonly stats: MatchStats;
  readonly finished: boolean;
  /** Set exactly when `finished` is true. */
  readonly end: MatchEnd | null;
  /** Redacted projection at the state's `seq`/`turnId`. */
  readonly snapshot: MatchSnapshot;
}

/** Accepted or duplicate action: the new state plus the messages it produced. */
export interface MatchActionSuccess {
  readonly ok: true;
  readonly status: 'accepted' | 'duplicate';
  readonly state: MatchState;
  readonly actionResult: MatchActionResult;
  readonly snapshot: MatchSnapshot;
  readonly end: MatchEnd | null;
}

/** Action admission: exactly `evaluateAction`'s failure shape on rejection. */
export type MatchActionOutcome = MatchActionSuccess | ProtocolValidationFailure;

/**
 * Non-action endings the room layer can request through {@link forfeitMatch}.
 *
 * `match-timeout` is deliberately absent: design 3.4 decides that ending by
 * revealed-safe-cell progress, with a draw when both players are tied, so it
 * cannot be expressed as "this player lost". #485 owns that rule.
 */
export type ForfeitReason = Extract<MatchEndReason, 'forfeit' | 'turn-timeout'>;

/** Non-action ending outcome; a finished match or an unknown player is rejected. */
export type MatchForfeitOutcome =
  | {
      readonly ok: true;
      readonly state: MatchState;
      readonly end: MatchEnd;
      readonly snapshot: MatchSnapshot;
    }
  | ProtocolValidationFailure;

/** Render an untrusted value in an error without losing its identity. */
function formatValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function assertSafeInteger(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} must be a safe integer >= ${minimum}, received ${formatValue(value)}.`,
    );
  }
  return value;
}

function assertSeats(seats: readonly MatchSeat[]): readonly MatchSeat[] {
  if (!Array.isArray(seats) || seats.length !== MATCH_PLAYER_COUNT) {
    throw new RangeError(
      `seats must contain exactly ${MATCH_PLAYER_COUNT} players, received ${String(
        Array.isArray(seats) ? seats.length : seats,
      )}.`,
    );
  }
  const ids = new Set<string>();
  let hosts = 0;
  for (const [index, seat] of seats.entries()) {
    if (seat === null || typeof seat !== 'object') {
      throw new TypeError(`seats[${index}] must be an object.`);
    }
    if (typeof seat.playerId !== 'string' || seat.playerId.length === 0) {
      throw new TypeError(`seats[${index}].playerId must be a non-empty string.`);
    }
    if (typeof seat.isHost !== 'boolean') {
      throw new TypeError(`seats[${index}].isHost must be a boolean.`);
    }
    if (ids.has(seat.playerId)) {
      throw new RangeError(`duplicate playerId ${formatValue(seat.playerId)} in seats.`);
    }
    ids.add(seat.playerId);
    if (seat.isHost) {
      hosts += 1;
    }
  }
  if (hosts !== 1) {
    throw new RangeError(`seats must contain exactly one host, received ${hosts}.`);
  }
  return seats;
}

function seatIndex(state: MatchState, playerId: string): number {
  const index = state.playerIds.indexOf(playerId);
  if (index === -1) {
    throw new RangeError(`unknown player ${formatValue(playerId)}.`);
  }
  return index;
}

/** Next player in seat order, wrapping around at the end. */
function nextPlayerId(state: MatchState, playerId: string): string {
  const index = seatIndex(state, playerId);
  const next = state.playerIds[(index + 1) % state.playerIds.length];
  if (next === undefined) {
    throw new TypeError('match has no seats.');
  }
  return next;
}

function opponentOf(state: MatchState, playerId: string): string {
  const opponent = state.playerIds.find((candidate) => candidate !== playerId);
  if (opponent === undefined) {
    throw new TypeError(`player ${formatValue(playerId)} has no opponent.`);
  }
  return opponent;
}

/** A rejected match call in the same shape `evaluateAction` returns. */
function failure(
  code: ProtocolValidationFailure['code'],
  message: string,
  currentSeq: number | null,
): ProtocolValidationFailure {
  return { ok: false, code, message, retryable: false, currentSeq };
}

function projectSnapshot(
  state: Pick<
    MatchState,
    'matchId' | 'engine' | 'seq' | 'turnId' | 'turnPlayerId' | 'turnDeadlineAt' | 'matchDeadlineAt'
  >,
): MatchSnapshot {
  return Object.freeze({
    ...engineAdapter.projectSnapshot(state.engine),
    matchId: state.matchId,
    seq: state.seq,
    turnId: state.turnId,
    turnPlayerId: state.turnPlayerId,
    deadlineAt: state.turnDeadlineAt,
    matchDeadlineAt: state.matchDeadlineAt,
  });
}

/** Stats for the current engine state at `nowMs`. */
function projectStats(
  engine: EngineMatch,
  startedAtMs: number,
  nowMs: number,
  turnCount: number,
): MatchStats {
  const snapshot = engineAdapter.projectSnapshot(engine);
  return Object.freeze({
    turnCount,
    revealedSafeCount: snapshot.revealedSafeCount,
    flagsPlaced: snapshot.mineCount - snapshot.remainingMines,
    durationMs: Math.max(0, nowMs - startedAtMs),
  });
}

function buildEnd(
  engine: EngineMatch,
  reason: MatchEndReason,
  winnerId: string | null,
  loserId: string | null,
  stats: MatchStats,
  seq: number,
  finalSnapshot?: RevealedBoard,
): MatchEnd {
  const payload = endPayload(engine, {
    reason,
    winnerId,
    loserId,
    stats,
  });
  return Object.freeze({
    ...payload,
    finalSnapshot: finalSnapshot ?? payload.finalSnapshot,
    seq,
  });
}

/**
 * Complete end board for a match that ended before its first reveal.
 *
 * The engine plants mines on the first reveal, so an unplayed match has no
 * layout yet; its seed commitment alone cannot define one. To still publish
 * every mine position, the server probes the canonical opening at (0, 0) on a
 * throwaway engine with the same seed/config and takes the mine layout from
 * that probe. The real engine is still authoritative for what players did:
 * flags placed before the first reveal are public actions and consume turns,
 * so every cell keeps the real `revealed`/`flagged` values (the match never
 * revealed anything, so the published board is still fully hidden).
 */
function unplayedEndBoard(state: MatchState): RevealedBoard {
  const probe = engineAdapter.createMatch({
    matchId: state.matchId,
    config: state.config,
    seed: state.seed,
  });
  engineAdapter.applyAction(probe, {
    seq: 1,
    turnId: state.turnId,
    actionId: 'end-probe',
    kind: 'reveal',
    row: 0,
    col: 0,
  });
  const probeBoard = engineAdapter.expandEndBoard(probe);
  return state.engine.state.board.map((row, rowIndex) =>
    Object.freeze(
      row.map((cell, colIndex) => {
        // Both engines share the same validated config, so the probe has a
        // cell for every real one; only the secret layout comes from it.
        const probeCell = probeBoard[rowIndex]![colIndex]!;
        return Object.freeze({
          ...cell,
          mine: probeCell.mine,
          adjacentMines: probeCell.adjacentMines,
        });
      }),
    ),
  );
}

/**
 * Start one authoritative match.
 *
 * The returned state contains the initial redacted snapshot. Mines have not
 * been planted yet (the engine does that on the first reveal), so no cell can
 * leak a mine flag or a hidden adjacency count, and the snapshot exposes only
 * `seedHash`, never `seed`.
 *
 * `initialSeq` is the room sequence the starting snapshot will carry; the
 * match keeps using that sequence for its actions.
 */
export function createMatchState(input: CreateMatchStateInput): MatchState {
  const matchId = input.matchId;
  if (typeof matchId !== 'string' || matchId.length === 0) {
    throw new TypeError('matchId must be a non-empty string.');
  }
  const config = validateConfig(input.config);
  const seats = assertSeats(input.seats);
  const startedAtMs = assertSafeInteger('nowMs', input.nowMs, 0);
  const turnDurationMs = assertSafeInteger('turnDurationMs', input.turnDurationMs, 1);
  const matchDurationMs = assertSafeInteger('matchDurationMs', input.matchDurationMs, 1);
  const actionCacheLimit = assertSafeInteger(
    'actionCacheLimit',
    input.actionCacheLimit ?? DEFAULT_ACTION_CACHE_LIMIT,
    1,
  );
  const initialSeq = assertSafeInteger('initialSeq', input.initialSeq ?? 0, 0);
  const engine = engineAdapter.createMatch({ matchId, config, seed: input.seed });
  const seedHash = hashSeed(input.seed);
  if (seedHash !== engine.seedHash) {
    throw new Error('the adapter seed commitment does not match hashSeed(seed).');
  }

  const matchDeadlineAt = startedAtMs + matchDurationMs;
  const turnDeadlineAt = Math.min(startedAtMs + turnDurationMs, matchDeadlineAt);
  const host = seats.find((seat) => seat.isHost);
  if (host === undefined) {
    throw new TypeError('seats must contain a host.');
  }

  const playerIds = Object.freeze(seats.map((seat) => seat.playerId));
  const base = {
    matchId,
    config,
    seed: input.seed,
    seedHash,
    engine,
    startedAtMs,
    turnDurationMs,
    matchDurationMs,
    actionCacheLimit,
    playerIds,
    seq: initialSeq,
    turnId: 0,
    turnPlayerId: host.playerId,
    turnDeadlineAt,
    matchDeadlineAt,
    actions: Object.freeze([] as ReplayAction[]),
    digests: Object.freeze([] as ReplayDigest[]),
    actionResults: new Map<string, CachedActionResult>(),
    finished: false,
    end: null,
  } satisfies Omit<MatchState, 'stats' | 'snapshot'>;

  const snapshot = projectSnapshot(base);
  const stats: MatchStats = Object.freeze({
    turnCount: 0,
    revealedSafeCount: snapshot.revealedSafeCount,
    flagsPlaced: snapshot.mineCount - snapshot.remainingMines,
    durationMs: 0,
  });
  return Object.freeze({ ...base, stats, snapshot });
}

/** Current cell state for the admission gate, matching design 4.5 step 4. */
function cellStateOf(engine: EngineMatch, row: number, col: number): 'hidden' | 'revealed' | 'flagged' {
  const cell = engine.state.board[row]?.[col];
  if (cell === undefined) {
    return 'hidden';
  }
  if (cell.revealed) {
    return 'revealed';
  }
  return cell.flagged ? 'flagged' : 'hidden';
}

/**
 * Submit one action for one player.
 *
 * `action.seq` is the client's last applied match seq and must equal
 * `state.seq`; `action.turnId` must equal `state.turnId`. A retried
 * `actionId` of the same player returns the cached result before any other
 * check, so a lost `action_result` can be recovered after the turn has passed
 * without applying the action twice. Every rejection returns without touching
 * the engine, `seq` or `turnId`.
 */
export function applyMatchAction(
  state: MatchState,
  actorId: string,
  action: MatchAction,
  nowMs: number,
): MatchActionOutcome {
  assertSafeInteger('nowMs', nowMs, 0);
  if (action === null || typeof action !== 'object') {
    return failure('invalid-action', 'action must be an object.', state.seq);
  }
  if (typeof action.actionId !== 'string' || action.actionId.length === 0) {
    return failure('invalid-action', 'actionId must be a non-empty string.', state.seq);
  }

  const cached = state.actionResults.get(action.actionId);
  if (cached !== undefined && cached.actorId === actorId) {
    return {
      ok: true,
      status: 'duplicate',
      state,
      actionResult: cached.result,
      snapshot: state.snapshot,
      end: state.end,
    };
  }

  if (state.finished) {
    return failure(
      'invalid-action',
      `match ${formatValue(state.matchId)} has already ended; no action can be applied.`,
      state.seq,
    );
  }

  const wireAction: ActionMessage = {
    type: 'action',
    // The match layer never reads room fields; the caller derived `actorId`
    // from its own connection and the room id only matters on the wire.
    roomId: '',
    matchId: state.matchId,
    clientTimeMs: nowMs,
    actionId: action.actionId,
    seq: action.seq,
    turnId: action.turnId,
    kind: action.kind,
    row: action.row,
    col: action.col,
  };
  const gate = evaluateAction(wireAction, {
    actorId,
    turnPlayerId: state.turnPlayerId,
    currentSeq: state.seq,
    currentTurnId: state.turnId,
    deadlineAt: Math.min(state.turnDeadlineAt, state.matchDeadlineAt),
    nowMs,
    recentActionIds: new Set(state.actionResults.keys()),
    rows: state.config.rows,
    cols: state.config.cols,
    cellState: (row, col) => cellStateOf(state.engine, row, col),
  });
  if (!gate.ok) {
    return gate;
  }
  if (gate.status === 'duplicate') {
    // The id belongs to another player's cached result. It must not be
    // replayed into this player's turn or leak that result.
    return failure(
      'invalid-action',
      `actionId ${formatValue(action.actionId)} was already used by another player.`,
      state.seq,
    );
  }

  const seq = state.seq + 1;
  // Replay actions are 1-based, while the client's `seq` is the broadcast seq
  // it last applied (0 before the first action).
  const replayAction: ReplayAction = Object.freeze({
    seq,
    turnId: action.turnId,
    actionId: action.actionId,
    kind: action.kind,
    row: action.row,
    col: action.col,
  });
  // The adapter engine is the one authoritative board for the match. The room
  // may tick this same handle between actions, so accepted actions advance it
  // in place; the surrounding state object is still replaced immutably.
  const applied = engineAdapter.applyAction(state.engine, replayAction);
  engineAdapter.recordAction(state.engine, replayAction);
  const digest = matchDigest(state.engine, seq, action.turnId);
  const projected = engineAdapter.projectSnapshot(state.engine);
  const stats = projectStats(
    state.engine,
    state.startedAtMs,
    nowMs,
    state.stats.turnCount + 1,
  );

  const ended = projected.engineStatus === 'won' || projected.engineStatus === 'lost';
  const turnId = ended ? state.turnId : state.turnId + 1;
  const turnPlayerId = ended ? state.turnPlayerId : nextPlayerId(state, state.turnPlayerId);
  const turnDeadlineAt = ended
    ? state.turnDeadlineAt
    : Math.min(nowMs + state.turnDurationMs, state.matchDeadlineAt);

  let end: MatchEnd | null = null;
  if (projected.engineStatus === 'lost') {
    end = buildEnd(
      state.engine,
      'mine-hit',
      opponentOf(state, actorId),
      actorId,
      stats,
      seq,
    );
  } else if (projected.engineStatus === 'won') {
    end = buildEnd(
      state.engine,
      'all-safe-revealed',
      actorId,
      opponentOf(state, actorId),
      stats,
      seq,
    );
  }

  const snapshot = projectSnapshot({
    matchId: state.matchId,
    engine: state.engine,
    seq,
    turnId,
    turnPlayerId,
    turnDeadlineAt,
    matchDeadlineAt: state.matchDeadlineAt,
  });
  const actionResult: MatchActionResult = Object.freeze({
    matchId: state.matchId,
    actionId: action.actionId,
    seq,
    turnId,
    accepted: true,
    reason: null,
    revealedCells: Object.freeze([...applied.revealedCells]),
    flaggedCell: applied.flaggedCell === null ? null : Object.freeze({ ...applied.flaggedCell }),
    turnPlayerId,
    deadlineAt: turnDeadlineAt,
  });

  const actionResults = new Map(state.actionResults);
  actionResults.set(action.actionId, Object.freeze({ actorId, result: actionResult }));
  while (actionResults.size > state.actionCacheLimit) {
    const oldest = actionResults.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    actionResults.delete(oldest);
  }

  const next: MatchState = Object.freeze({
    ...state,
    seq,
    turnId,
    turnPlayerId,
    turnDeadlineAt,
    actions: Object.freeze([...state.actions, replayAction]),
    digests: Object.freeze([...state.digests, digest]),
    actionResults,
    stats,
    finished: ended,
    end,
    snapshot,
  });

  return {
    ok: true,
    status: 'accepted',
    state: next,
    actionResult,
    snapshot,
    end,
  };
}

/**
 * End a match without applying a board action.
 *
 * This is the server-side ending for a concession (`reason` defaults to
 * `forfeit`) and for the turn timer path #485 will call with `turn-timeout`.
 * A whole-match timeout is not accepted here: design 3.4 ranks the players by
 * revealed safe cells (a tie is a draw), which this player-loses API cannot
 * express; #485 owns that computation. The engine is only expanded into the
 * end payload, never advanced, and repeated calls after `finished` cannot
 * produce a second end.
 */
export function forfeitMatch(
  state: MatchState,
  forfeitingPlayerId: string,
  nowMs: number,
  reason: ForfeitReason = 'forfeit',
): MatchForfeitOutcome {
  assertSafeInteger('nowMs', nowMs, 0);
  if (reason !== 'forfeit' && reason !== 'turn-timeout') {
    throw new TypeError(
      `reason must be "forfeit" or "turn-timeout", received ${formatValue(reason)}.`,
    );
  }

  if (state.finished) {
    return failure(
      'invalid-action',
      `match ${formatValue(state.matchId)} has already ended; it cannot be forfeited again.`,
      state.seq,
    );
  }
  if (!state.playerIds.includes(forfeitingPlayerId)) {
    return failure(
      'invalid-action',
      `player ${formatValue(forfeitingPlayerId)} is not seated in this match.`,
      state.seq,
    );
  }

  const seq = state.seq + 1;
  const stats = projectStats(
    state.engine,
    state.startedAtMs,
    nowMs,
    state.stats.turnCount,
  );
  const finalSnapshot =
    state.engine.state.status === 'ready' ? unplayedEndBoard(state) : undefined;
  const end = buildEnd(
    state.engine,
    reason,
    opponentOf(state, forfeitingPlayerId),
    forfeitingPlayerId,
    stats,
    seq,
    finalSnapshot,
  );
  const snapshot = projectSnapshot({
    matchId: state.matchId,
    engine: state.engine,
    seq,
    turnId: state.turnId,
    turnPlayerId: state.turnPlayerId,
    turnDeadlineAt: state.turnDeadlineAt,
    matchDeadlineAt: state.matchDeadlineAt,
  });
  const next: MatchState = Object.freeze({
    ...state,
    engine: state.engine,
    seq,
    stats,
    finished: true,
    end,
    snapshot,
  });
  return { ok: true, state: next, end, snapshot };
}

/**
 * Re-project the current engine, e.g. after the room ticks `state.engine`.
 *
 * `MatchState.snapshot` is a frozen projection of the last accepted action;
 * this returns a fresh one with the current `elapsedMs` while keeping the
 * state's seq/turn bookkeeping.
 */
export function projectMatchSnapshot(state: MatchState): MatchSnapshot {
  return projectSnapshot(state);
}

/** Replay input recorded for a match: seed, config and ordered actions. */
export function matchReplayRecord(state: MatchState): ReplayRecord {
  return engineAdapter.getReplayRecord(state.engine);
}

/**
 * Replay the recorded actions and compare every step against the live digests.
 *
 * Two calls over the same state are deterministic, which is the replay
 * guarantee the design asks for. A mismatch throws `ReplayMismatchError`.
 */
export function verifyMatchReplay(state: MatchState): ReplayOutcome {
  return replayMatch(matchReplayRecord(state), state.digests);
}

/** Stamp a match snapshot with its room id and room-level broadcast seq. */
export function toSnapshotMessage(
  snapshot: MatchSnapshot,
  roomId: string,
  roomSeq: number = snapshot.seq,
): SnapshotMessage {
  assertRoomFields(roomId, roomSeq);
  return Object.freeze({
    type: 'snapshot',
    roomId,
    ...snapshot,
    seq: roomSeq,
  });
}

/** Stamp an accepted action result with its room id and room-level seq. */
export function toActionResultMessage(
  actionResult: MatchActionResult,
  roomId: string,
  roomSeq: number = actionResult.seq,
): ActionResultMessage {
  assertRoomFields(roomId, roomSeq);
  return Object.freeze({
    type: 'action_result',
    roomId,
    ...actionResult,
    seq: roomSeq,
  });
}

/** Stamp an end payload with its room id and room-level seq. */
export function toEndMessage(
  end: MatchEnd,
  roomId: string,
  roomSeq: number = end.seq,
): EndMessage {
  assertRoomFields(roomId, roomSeq);
  return Object.freeze({
    type: 'end',
    roomId,
    ...end,
    seq: roomSeq,
  });
}

/** Shared guard for the two caller-owned wire fields. */
function assertRoomFields(roomId: string, roomSeq: number): void {
  if (typeof roomId !== 'string' || roomId.length === 0) {
    throw new TypeError('roomId must be a non-empty string.');
  }
  assertSafeInteger('roomSeq', roomSeq, 0);
}
