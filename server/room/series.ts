/**
 * Pure best-of-three series state machine for the room service.
 *
 * The wire shape is fixed by `design:series` (docs/minesweeper-online-design.md)
 * and lives in `SeriesState`, which is private to
 * `src/games/minesweeper/online/types.ts`. This module therefore derives it
 * through the exported `room_state` DTO
 * (`NonNullable<RoomStateMessage['series']>`) instead of declaring a second
 * copy; the room manager only has to carry the returned value.
 *
 * The helpers are referentially transparent: they never mutate or reuse the
 * state they are given, and a changed series is always a fresh readonly value.
 * They own only the cross-round bookkeeping (round counter, wins, first-mover
 * alternation and the final verdict); starting one authoritative match, ending
 * it and replaying it stay with `server/room/match.ts`.
 *
 * Rules implemented here (design 3.3 `design:series`):
 *
 * - a series is best-of-three: first to two wins takes it, otherwise all three
 *   rounds are played; `round` is the current (or just finished) round;
 * - the host opens round 1 and every odd round, the other seat opens every even
 *   round;
 * - each completed round appends one `history` entry and awards the winner one
 *   win; a drawn round is recorded but awards none;
 * - the series is decided as soon as a player reaches `winsRequired` wins or
 *   `maxRounds` rounds have been played. An exhausted series without two wins
 *   ends with `winnerId: null`, so `decided` and `winnerId` are independent;
 * - recording a round is idempotent per `matchId`, rejects a second result for
 *   an already recorded round, and is a no-op once the series is decided, so
 *   the room manager cannot double-score one match or one round;
 * - an advance needs the current round to be recorded and cannot skip it, so
 *   the `round` counter and `history` length stay in step.
 *
 * The state contains no seed, mine layout or replay log: those belong to the
 * per-match server records and never enter the public `room_state.series`.
 */

import type { RoomStateMessage } from '../../src/games/minesweeper/online/index';

/** Best-of-three parameters, fixed by `design:series`. */
const SERIES_BEST_OF = 3;
/** Wins one seat needs to take the series. */
const SERIES_WINS_REQUIRED = 2;
/** Hard cap on played rounds; `bestOf` and `maxRounds` are the same number. */
const SERIES_MAX_ROUNDS = 3;

/**
 * The `room_state.series` wire type, derived from the exported DTO.
 *
 * `SeriesState` / `SeriesRoundResult` are not exported from
 * `src/games/minesweeper/online/types.ts`, so these aliases keep the room layer
 * on the single source of truth without adding a second DTO.
 */
export type SeriesState = NonNullable<RoomStateMessage['series']>;
/** One completed round as carried in `SeriesState.history`. */
export type SeriesRoundResult = SeriesState['history'][number];

/**
 * The two seats of a series.
 *
 * `firstMoverId` inside the published state only says who opens the current
 * round; the helpers need the host explicitly to derive the next mover from the
 * round parity. The ids are also the keys of `wins`.
 */
export interface SeriesPlayers {
  readonly hostId: string;
  readonly opponentId: string;
}

/**
 * The outcome of one finished round.
 *
 * `reason` is the match's own `MatchEndReason`; a drawn round (for example an
 * expired match timer) passes `winnerId: null`. The loser is not part of the
 * input: it is always the other seat, so deriving it keeps `history` consistent
 * with the two-seat `wins` table instead of trusting a second id from the
 * caller.
 */
export type SeriesRoundInput = Pick<
  SeriesRoundResult,
  'matchId' | 'winnerId' | 'reason'
>;

/** Reject seat pairs that cannot produce a two-player series. */
function assertPlayers(players: SeriesPlayers): void {
  if (players.hostId.length === 0 || players.opponentId.length === 0) {
    throw new TypeError('series seats need non-empty player ids');
  }
  if (players.hostId === players.opponentId) {
    throw new TypeError('series needs two distinct player ids');
  }
}

/**
 * Reject a seat pair that does not belong to the series' `wins` table.
 *
 * `wins` is initialized with both seats and only those seats, so it is the
 * series' own record of who plays. The first mover is checked against the round
 * parity too: an odd round must be opened by the supplied host and an even
 * round by the supplied opponent, so swapping the two seats is rejected instead
 * of silently reversing the alternation.
 */
function assertSeriesPlayers(series: SeriesState, players: SeriesPlayers): void {
  assertPlayers(players);
  const seats = new Set(Object.keys(series.wins));
  if (!seats.has(players.hostId) || !seats.has(players.opponentId)) {
    throw new TypeError('series players must be the seats recorded in wins');
  }
  const expectedFirstMover =
    series.round % 2 === 1 ? players.hostId : players.opponentId;
  if (series.firstMoverId !== expectedFirstMover) {
    throw new TypeError(
      'series host/opponent does not match the first mover of the round',
    );
  }
}

/**
 * Return the seat that lost to `winnerId`, rejecting a winner outside the
 * series. A round always has exactly two seats, so the loser is derived rather
 * than taken from the caller.
 */
function loserOf(series: SeriesState, winnerId: string): string {
  const seats = Object.keys(series.wins);
  if (!seats.includes(winnerId)) {
    throw new TypeError('series round winner must be one of the seats');
  }
  const loser = seats.find((playerId) => playerId !== winnerId);
  if (loser === undefined) {
    throw new TypeError('series needs exactly two seats');
  }
  return loser;
}

/** Build a fresh, undecided series with the host opening round 1. */
export function createSeries(players: SeriesPlayers): SeriesState {
  assertPlayers(players);
  return {
    bestOf: SERIES_BEST_OF,
    winsRequired: SERIES_WINS_REQUIRED,
    maxRounds: SERIES_MAX_ROUNDS,
    round: 1,
    wins: {
      [players.hostId]: 0,
      [players.opponentId]: 0,
    },
    firstMoverId: players.hostId,
    decided: false,
    winnerId: null,
    history: [],
  };
}

/**
 * Record one finished round: append its history entry, award the win and update
 * the series verdict for the current `round`.
 *
 * A series records each round exactly once: `history` must still end at
 * `round - 1`, otherwise the call rejects the duplicate instead of scoring the
 * same round twice under a new `matchId`. The history entry keeps the round's
 * first mover from the state, so the alternation stays auditable after a
 * reconnect; the loser is the other seat and a drawn round (`winnerId: null`)
 * records `loserId: null` and awards no win. The series is decided when a seat
 * reaches `winsRequired` or `round` reaches `maxRounds`; when the round cap
 * decides a series without a two-win seat, `winnerId` stays `null`.
 *
 * The call is a no-op (same value back) for a decided series or a `matchId`
 * already present in `history`, which keeps the room manager's multiple end
 * paths from scoring one match twice.
 */
export function recordSeriesRound(
  series: SeriesState,
  round: SeriesRoundInput,
): SeriesState {
  if (series.decided) {
    return series;
  }
  if (series.history.some((entry) => entry.matchId === round.matchId)) {
    return series;
  }
  if (series.history.length !== series.round - 1) {
    throw new TypeError(
      'series round already recorded; advance the series before recording the next round',
    );
  }

  const wins: Record<string, number> = { ...series.wins };
  if (round.winnerId !== null) {
    wins[round.winnerId] = (wins[round.winnerId] ?? 0) + 1;
  }

  // Only the winner of this round can newly reach the target: an earlier
  // two-win seat would already have decided the series and short-circuited.
  const reachedWins =
    round.winnerId !== null &&
    (wins[round.winnerId] ?? 0) >= series.winsRequired;
  const decided = reachedWins || series.round >= series.maxRounds;
  const historyEntry: SeriesRoundResult = {
    round: series.round,
    matchId: round.matchId,
    winnerId: round.winnerId,
    loserId: round.winnerId === null ? null : loserOf(series, round.winnerId),
    reason: round.reason,
    firstMoverId: series.firstMoverId,
  };

  return {
    ...series,
    wins,
    decided,
    winnerId: reachedWins ? round.winnerId : null,
    history: [...series.history, historyEntry],
  };
}

/**
 * Move an undecided series to its next round and alternate the first mover:
 * odd rounds (`1`, `3`) are opened by the host, even rounds by the opponent.
 *
 * The call is a no-op for a decided or exhausted series, for the wrong seat
 * pair (see {@link assertSeriesPlayers}), or before the current round has been
 * recorded, so a double or early advance cannot skip a round. Resetting is
 * {@link resetSeries}.
 */
export function advanceSeries(
  series: SeriesState,
  players: SeriesPlayers,
): SeriesState {
  assertSeriesPlayers(series, players);
  if (
    series.decided ||
    series.round >= series.maxRounds ||
    series.history.length !== series.round
  ) {
    return series;
  }

  const round = series.round + 1;
  return {
    ...series,
    round,
    firstMoverId: round % 2 === 1 ? players.hostId : players.opponentId,
  };
}

/**
 * Start a new series after a decided one: `0:0`, round 1, host moves first and
 * an empty history.
 *
 * The call is a no-op for an undecided series so a premature rematch cannot
 * wipe live scores. The seat pair is validated first, exactly like
 * {@link advanceSeries}, so a swapped host/opponent is rejected even when the
 * reset itself is a no-op.
 */
export function resetSeries(
  series: SeriesState,
  players: SeriesPlayers,
): SeriesState {
  assertSeriesPlayers(series, players);
  if (!series.decided) {
    return series;
  }
  return createSeries(players);
}
