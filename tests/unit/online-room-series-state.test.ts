import { describe, expect, it } from 'vitest';
import type { RoomStateMessage } from '../../src/games/minesweeper/online/index';
import {
  advanceSeries,
  createSeries,
  recordSeriesRound,
  resetSeries,
  type SeriesState,
} from '../../server/room/series';

/**
 * The wire type of `room_state.series`, taken from the exported DTO exactly as
 * the server module does. Keeping the alias here proves the helpers return the
 * contract's `SeriesState` rather than a local lookalike.
 */
type WireSeriesState = NonNullable<RoomStateMessage['series']>;
type WireSeriesRound = WireSeriesState['history'][number];

const SEATS = { hostId: 'host', opponentId: 'guest' } as const;

const SERIES_FIELDS = [
  'bestOf',
  'winsRequired',
  'maxRounds',
  'round',
  'wins',
  'firstMoverId',
  'decided',
  'winnerId',
  'history',
] as const;

const ROUND_FIELDS = [
  'round',
  'matchId',
  'winnerId',
  'loserId',
  'reason',
  'firstMoverId',
] as const;

/** Record the winner of the current round; the loser and draw are derived. */
function playRound(
  series: SeriesState,
  matchId: string,
  winnerId: string | null,
  reason: WireSeriesRound['reason'] = 'mine-hit',
): SeriesState {
  return recordSeriesRound(series, { matchId, winnerId, reason });
}

/** A decided 2:1 series with host, guest and host opening the three rounds. */
function playHostWinsSeries(): SeriesState {
  const round1 = playRound(createSeries(SEATS), 'match-1', SEATS.hostId);
  const round2 = playRound(
    advanceSeries(round1, SEATS),
    'match-2',
    SEATS.opponentId,
  );
  return playRound(
    advanceSeries(round2, SEATS),
    'match-3',
    SEATS.hostId,
    'all-safe-revealed',
  );
}

describe('series state machine', () => {
  it('creates a fresh best-of-three series with the host opening round 1', () => {
    const series: WireSeriesState = createSeries(SEATS);

    expect(series).toEqual({
      bestOf: 3,
      winsRequired: 2,
      maxRounds: 3,
      round: 1,
      wins: { host: 0, guest: 0 },
      firstMoverId: 'host',
      decided: false,
      winnerId: null,
      history: [],
    });
  });

  it('rejects seat pairs that are not two distinct players', () => {
    expect(() => createSeries({ hostId: 'host', opponentId: 'host' })).toThrow(
      TypeError,
    );
    expect(() => createSeries({ hostId: '', opponentId: 'guest' })).toThrow(TypeError);
    expect(() => createSeries({ hostId: 'host', opponentId: '' })).toThrow(TypeError);
  });

  it('rejects a winner outside the series and a swapped host/opponent', () => {
    const series = createSeries(SEATS);

    expect(() => playRound(series, 'match-1', 'intruder')).toThrow(TypeError);

    // Round 1 is opened by the host, so the swapped pair cannot be the seats.
    expect(() =>
      advanceSeries(series, { hostId: 'guest', opponentId: 'host' }),
    ).toThrow(TypeError);

    const decided = playHostWinsSeries();
    // Round 3 is opened by the host as well; the same swap must be rejected.
    expect(() =>
      resetSeries(decided, { hostId: 'guest', opponentId: 'host' }),
    ).toThrow(TypeError);
  });

  it('scores each round once and refuses a second result for the same round', () => {
    const round1 = playRound(createSeries(SEATS), 'match-1', SEATS.hostId);

    // Retrying the same end path is idempotent.
    expect(playRound(round1, 'match-1', SEATS.hostId)).toBe(round1);
    expect(round1.wins).toEqual({ host: 1, guest: 0 });
    expect(round1.history).toHaveLength(1);

    // A new matchId cannot score round 1 twice.
    expect(() => playRound(round1, 'match-1-retry', SEATS.hostId)).toThrow(TypeError);
    expect(round1.wins).toEqual({ host: 1, guest: 0 });
  });

  it('does not advance before a round is recorded or advance twice', () => {
    const fresh = createSeries(SEATS);
    expect(advanceSeries(fresh, SEATS)).toBe(fresh);

    const round1 = playRound(fresh, 'match-1', SEATS.hostId);
    const round2Start = advanceSeries(round1, SEATS);
    expect(round2Start.round).toBe(2);

    // The current round is still unplayed, so a second advance cannot skip it.
    expect(advanceSeries(round2Start, SEATS)).toBe(round2Start);
  });

  it('scores 1:0, 1:1, 2:1 with first movers host, opponent, host', () => {
    const round1 = playRound(createSeries(SEATS), 'match-1', SEATS.hostId);
    expect(round1.wins).toEqual({ host: 1, guest: 0 });
    expect(round1.decided).toBe(false);
    expect(round1.winnerId).toBeNull();
    expect(round1.history).toHaveLength(1);
    expect(round1.history[0]).toMatchObject({
      round: 1,
      matchId: 'match-1',
      winnerId: 'host',
      loserId: 'guest',
      reason: 'mine-hit',
      firstMoverId: 'host',
    });

    const round2Start = advanceSeries(round1, SEATS);
    expect(round2Start.round).toBe(2);
    expect(round2Start.firstMoverId).toBe(SEATS.opponentId);
    const round2 = playRound(round2Start, 'match-2', SEATS.opponentId);
    expect(round2.wins).toEqual({ host: 1, guest: 1 });
    expect(round2.decided).toBe(false);
    expect(round2.history[1]).toMatchObject({
      round: 2,
      matchId: 'match-2',
      winnerId: 'guest',
      loserId: 'host',
      firstMoverId: 'guest',
    });

    const round3Start = advanceSeries(round2, SEATS);
    expect(round3Start.round).toBe(3);
    expect(round3Start.firstMoverId).toBe(SEATS.hostId);
    const round3 = playRound(
      round3Start,
      'match-3',
      SEATS.hostId,
      'all-safe-revealed',
    );
    expect(round3.wins).toEqual({ host: 2, guest: 1 });
    expect(round3.decided).toBe(true);
    expect(round3.winnerId).toBe(SEATS.hostId);
    expect(round3.history.map((entry) => entry.round)).toEqual([1, 2, 3]);
    expect(round3.history.map((entry) => entry.firstMoverId)).toEqual([
      'host',
      'guest',
      'host',
    ]);
    expect(round3.history.map((entry) => entry.winnerId)).toEqual([
      'host',
      'guest',
      'host',
    ]);
    expect(round3.history.map((entry) => entry.loserId)).toEqual([
      'guest',
      'host',
      'guest',
    ]);
    expect(round3.history.map((entry) => entry.matchId)).toEqual([
      'match-1',
      'match-2',
      'match-3',
    ]);
    expect(round3.history.map((entry) => entry.reason)).toEqual([
      'mine-hit',
      'mine-hit',
      'all-safe-revealed',
    ]);
  });

  it('decides as soon as one seat reaches the required wins', () => {
    const round1 = playRound(createSeries(SEATS), 'match-1', SEATS.opponentId);
    expect(round1.wins).toEqual({ host: 0, guest: 1 });
    expect(round1.decided).toBe(false);

    const round2 = playRound(advanceSeries(round1, SEATS), 'match-2', SEATS.opponentId);
    expect(round2.round).toBe(2);
    expect(round2.wins).toEqual({ host: 0, guest: 2 });
    expect(round2.decided).toBe(true);
    expect(round2.winnerId).toBe(SEATS.opponentId);

    // A decided series neither advances nor scores another round.
    expect(advanceSeries(round2, SEATS)).toBe(round2);
    expect(playRound(round2, 'match-3', SEATS.hostId)).toBe(round2);

    const reset = resetSeries(round2, SEATS);
    expect(reset).toEqual(createSeries(SEATS));
    expect(reset.wins).toEqual({ host: 0, guest: 0 });
    expect(reset.round).toBe(1);
    expect(reset.firstMoverId).toBe(SEATS.hostId);
    expect(reset.decided).toBe(false);
    expect(reset.history).toEqual([]);

    // Resetting does not mutate the finished series it started from.
    expect(round2.wins).toEqual({ host: 0, guest: 2 });
    expect(round2.winnerId).toBe(SEATS.opponentId);
    expect(round2.history).toHaveLength(2);
  });

  it('records drawn rounds in history without awarding wins', () => {
    // Host takes round 1; rounds 2 and 3 draw, so the exhausted series ends 1:0
    // without a two-win seat and therefore without a series winner.
    const round1 = playRound(createSeries(SEATS), 'match-1', SEATS.hostId);
    const round2 = playRound(
      advanceSeries(round1, SEATS),
      'match-2',
      null,
      'match-timeout',
    );
    expect(round2.wins).toEqual({ host: 1, guest: 0 });
    expect(round2.decided).toBe(false);
    expect(round2.history[1]).toMatchObject({
      round: 2,
      winnerId: null,
      loserId: null,
      reason: 'match-timeout',
    });

    const round3 = playRound(
      advanceSeries(round2, SEATS),
      'match-3',
      null,
      'match-timeout',
    );
    expect(round3.round).toBe(3);
    expect(round3.wins).toEqual({ host: 1, guest: 0 });
    expect(round3.decided).toBe(true);
    expect(round3.winnerId).toBeNull();
    expect(round3.history).toHaveLength(3);
    expect(round3.history.map((entry) => entry.winnerId)).toEqual([
      'host',
      null,
      null,
    ]);
    expect(round3.history.map((entry) => entry.loserId)).toEqual(['guest', null, null]);
  });

  it('ends a fully drawn three-round series with winnerId null and resets it', () => {
    let series = createSeries(SEATS);
    series = playRound(series, 'draw-1', null, 'match-timeout');
    series = playRound(advanceSeries(series, SEATS), 'draw-2', null, 'match-timeout');
    series = playRound(advanceSeries(series, SEATS), 'draw-3', null, 'match-timeout');

    expect(series.round).toBe(3);
    expect(series.wins).toEqual({ host: 0, guest: 0 });
    expect(series.decided).toBe(true);
    expect(series.winnerId).toBeNull();
    expect(series.history).toHaveLength(3);
    expect(series.history.every((entry) => entry.reason === 'match-timeout')).toBe(
      true,
    );
    expect(series.history.every((entry) => entry.winnerId === null)).toBe(true);
    expect(series.history.every((entry) => entry.loserId === null)).toBe(true);
    expect(series.history.map((entry) => entry.firstMoverId)).toEqual([
      'host',
      'guest',
      'host',
    ]);

    // A capped series is decided even though it has no winner, so rematch
    // resets it like any other decided series.
    const reset = resetSeries(series, SEATS);
    expect(reset).toEqual(createSeries(SEATS));
    expect(series.history).toHaveLength(3);
    expect(series.decided).toBe(true);
    expect(series.winnerId).toBeNull();
  });

  it('only advances the round while the series is undecided', () => {
    const decided = playHostWinsSeries();
    let undecided = createSeries(SEATS);
    undecided = playRound(undecided, 'match-1', SEATS.hostId);

    const advanced = advanceSeries(undecided, SEATS);
    expect(advanced.round).toBe(2);
    expect(advanced.wins).toEqual(undecided.wins);
    expect(advanced.history).toEqual(undecided.history);
    expect(advanced.decided).toBe(false);
    expect(advanced.winnerId).toBeNull();

    // The input is untouched and a new value is returned.
    expect(undecided.round).toBe(1);
    expect(undecided.firstMoverId).toBe('host');
    expect(advanced).not.toBe(undecided);

    // A premature reset cannot wipe live scores.
    expect(resetSeries(undecided, SEATS)).toBe(undecided);

    // Advancing a decided series is a no-op; the room resets it instead.
    expect(advanceSeries(decided, SEATS)).toBe(decided);
    expect(decided.history).toHaveLength(3);
  });

  it('does not mutate the input state or score a match twice', () => {
    const initial = createSeries(SEATS);
    const round1 = playRound(initial, 'match-1', SEATS.hostId);

    expect(initial).toEqual({
      bestOf: 3,
      winsRequired: 2,
      maxRounds: 3,
      round: 1,
      wins: { host: 0, guest: 0 },
      firstMoverId: 'host',
      decided: false,
      winnerId: null,
      history: [],
    });
    expect(round1.wins).not.toBe(initial.wins);
    expect(round1.history).not.toBe(initial.history);

    // Retrying an end path with the same matchId neither appends nor scores.
    expect(playRound(round1, 'match-1', SEATS.hostId)).toBe(round1);
    expect(round1.wins).toEqual({ host: 1, guest: 0 });
    expect(round1.history).toHaveLength(1);
  });

  it('serializes only the public series contract, without seed or board data', () => {
    const decided = playHostWinsSeries();
    const json = JSON.stringify(decided);

    // Acceptance criterion: the public series JSON never carries the seed.
    expect(json).not.toMatch(/seed/i);

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...SERIES_FIELDS].sort());
    const history = parsed.history as Record<string, unknown>[];
    expect(history).toHaveLength(3);
    for (const entry of history) {
      expect(Object.keys(entry).sort()).toEqual([...ROUND_FIELDS].sort());
    }
  });
});
