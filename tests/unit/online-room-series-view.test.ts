import { describe, expect, it } from 'vitest';
import {
  seriesView,
  type RoomSeriesView,
} from '../../src/games/minesweeper/online/client/series';
import type { RoomStateMessage } from '../../src/games/minesweeper/online/types';

// This suite is the contract for the client-side series display introduced by
// #556 t1. It deliberately does not mount the room view or the store: the
// strings below are the seam the later room-render task consumes, so every
// score, round, outcome and button label is pinned here.

type RoomSeries = NonNullable<RoomStateMessage['series']>;

const HOST_ID = 'player_host';
const GUEST_ID = 'player_guest';
const PLAYER_IDS = [HOST_ID, GUEST_ID] as const;

/** The in-progress 0 : 0 series the server sends before the first round. */
function series(overrides: Partial<RoomSeries> = {}): RoomSeries {
  return {
    bestOf: 3,
    winsRequired: 2,
    maxRounds: 3,
    round: 1,
    wins: { [HOST_ID]: 0, [GUEST_ID]: 0 },
    firstMoverId: HOST_ID,
    decided: false,
    winnerId: null,
    history: [],
    ...overrides,
  };
}

describe('seriesView', () => {
  it('renders the self-first score and current round for 1 : 0 and 1 : 1', () => {
    const oneNilInput: RoomStateMessage['series'] = series({
      round: 2,
      wins: { [HOST_ID]: 1, [GUEST_ID]: 0 },
    });
    const oneNil: RoomSeriesView = seriesView(oneNilInput, HOST_ID, PLAYER_IDS);

    expect(Object.keys(oneNil).sort()).toEqual([
      'decided',
      'rematchText',
      'roundText',
      'scoreText',
      'statusText',
    ]);
    expect(oneNil.scoreText).toBe('1 : 0');
    expect(oneNil.roundText).toBe('第 2 局 / 三局两胜');
    expect(oneNil.statusText).toBe('你 1 : 0 对手');
    expect(oneNil.decided).toBe(false);
    expect(oneNil.rematchText).toBe('下一局');
    expect(Object.isFrozen(oneNil)).toBe(true);

    // The same wire value is read from the opponent's seat: only the score
    // labels flip; the round and the button stay the same.
    const guestOneNil = seriesView(oneNilInput, GUEST_ID, PLAYER_IDS);
    expect(guestOneNil.scoreText).toBe('0 : 1');
    expect(guestOneNil.roundText).toBe('第 2 局 / 三局两胜');
    expect(guestOneNil.statusText).toBe('你 0 : 1 对手');
    expect(guestOneNil.rematchText).toBe('下一局');

    const oneAll = seriesView(
      series({ round: 3, wins: { [HOST_ID]: 1, [GUEST_ID]: 1 } }),
      HOST_ID,
      PLAYER_IDS,
    );
    expect(oneAll.scoreText).toBe('1 : 1');
    expect(oneAll.roundText).toBe('第 3 局 / 三局两胜');
    expect(oneAll.statusText).toBe('你 1 : 1 对手');
    expect(oneAll.decided).toBe(false);
    expect(oneAll.rematchText).toBe('下一局');
  });

  it('announces the decided 2 : 1 series with the final score and winner', () => {
    const decidedInput = series({
      round: 3,
      wins: { [HOST_ID]: 2, [GUEST_ID]: 1 },
      decided: true,
      winnerId: HOST_ID,
    });

    const hostView = seriesView(decidedInput, HOST_ID, PLAYER_IDS);
    expect(hostView.scoreText).toBe('2 : 1');
    expect(hostView.roundText).toBe('第 3 局 / 三局两胜');
    expect(hostView.decided).toBe(true);
    expect(hostView.rematchText).toBe('再来一轮系列赛');
    expect(hostView.statusText).toContain('系列赛结束');
    expect(hostView.statusText).toContain('你 2 : 1 对手');
    expect(hostView.statusText).toContain('你获胜');

    // The losing seat still sees the same final score, but from its side and
    // with the opponent named as the winner.
    const guestView = seriesView(decidedInput, GUEST_ID, PLAYER_IDS);
    expect(guestView.scoreText).toBe('1 : 2');
    expect(guestView.decided).toBe(true);
    expect(guestView.rematchText).toBe('再来一轮系列赛');
    expect(guestView.statusText).toContain('系列赛结束');
    expect(guestView.statusText).toContain('你 1 : 2 对手');
    expect(guestView.statusText).toContain('对手获胜');
  });

  it('reports a drawn series when the rounds are exhausted without a winner', () => {
    const drawn = seriesView(
      series({
        round: 3,
        wins: { [HOST_ID]: 1, [GUEST_ID]: 1 },
        decided: true,
        winnerId: null,
      }),
      HOST_ID,
      PLAYER_IDS,
    );

    expect(drawn.scoreText).toBe('1 : 1');
    expect(drawn.decided).toBe(true);
    expect(drawn.rematchText).toBe('再来一轮系列赛');
    expect(drawn.statusText).toContain('系列赛结束');
    expect(drawn.statusText).toContain('你 1 : 1 对手');
    expect(drawn.statusText).toContain('平局');
  });

  it('falls back to 0 : 0 and round 1 when room_state.series is absent', () => {
    const fallback = seriesView(undefined, HOST_ID, PLAYER_IDS);

    expect(fallback.scoreText).toBe('0 : 0');
    expect(fallback.roundText).toBe('第 1 局 / 三局两胜');
    expect(fallback.statusText).toBe('你 0 : 0 对手');
    expect(fallback.decided).toBe(false);
    expect(fallback.rematchText).toBe('下一局');

    // Before the first room state there is no seat id and no player list; the
    // fallback must still be renderable instead of throwing.
    const noIdentity = seriesView(undefined, null, []);
    expect(noIdentity.scoreText).toBe('0 : 0');
    expect(noIdentity.roundText).toBe('第 1 局 / 三局两胜');
    expect(noIdentity.statusText).toBe('你 0 : 0 对手');
    expect(noIdentity.decided).toBe(false);
    expect(noIdentity.rematchText).toBe('下一局');
  });

  it('resolves the opponent from the wins map when the player list is missing', () => {
    const oneNilInput = series({
      round: 2,
      wins: { [HOST_ID]: 1, [GUEST_ID]: 0 },
    });

    const hostView = seriesView(oneNilInput, HOST_ID, []);
    expect(hostView.scoreText).toBe('1 : 0');
    expect(hostView.statusText).toBe('你 1 : 0 对手');

    const guestView = seriesView(oneNilInput, GUEST_ID, []);
    expect(guestView.scoreText).toBe('0 : 1');
    expect(guestView.statusText).toBe('你 0 : 1 对手');
  });

  it('keeps the round text inside the series bounds when the wire round is invalid', () => {
    const beforeFirstRound = seriesView(
      series({ round: 0, maxRounds: 3 }),
      HOST_ID,
      PLAYER_IDS,
    );
    expect(beforeFirstRound.roundText).toBe('第 1 局 / 三局两胜');

    const pastLastRound = seriesView(
      series({ round: 4, maxRounds: 3 }),
      HOST_ID,
      PLAYER_IDS,
    );
    expect(pastLastRound.roundText).toBe('第 3 局 / 三局两胜');
  });

  it('does not mutate the wire series value', () => {
    const input = series({
      round: 2,
      wins: { [HOST_ID]: 1, [GUEST_ID]: 0 },
    });
    const copy = structuredClone(input);

    seriesView(input, HOST_ID, PLAYER_IDS);

    expect(input).toEqual(copy);
  });
});
