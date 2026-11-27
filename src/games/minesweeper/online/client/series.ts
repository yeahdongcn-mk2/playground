/**
 * Client-only display contract for the best-of-three room series (#556).
 *
 * This module is pure presentation: it never touches the DOM, the store, the
 * transport or the wire. The wire shape stays optional in
 * `../types.ts` (`room_state.series`), so every value here also covers the
 * pre-series state: an absent series renders as 0 : 0 in round 1 and keeps the
 * "next round" button.
 *
 * The score is always shown from this seat's point of view: `scoreText` is
 * `<self wins> : <opponent wins>`, and `statusText` spells the same score out
 * with "你" / "对手" labels. A decided series adds the final score and the
 * winner, and swaps the rematch button to a new-series label.
 */

import type { RoomStateMessage } from '../types';

/** The optional `room_state.series` payload, without changing the wire DTO. */
type RoomSeriesState = NonNullable<RoomStateMessage['series']>;

/** Everything the room screen renders for one series state. */
export interface RoomSeriesView {
  /** Self-first score line, for example `1 : 0`. */
  readonly scoreText: string;
  /** Current round plus the match rule, for example `第 2 局 / 三局两胜`. */
  readonly roundText: string;
  /** Readable status; a decided series includes the final score and winner. */
  readonly statusText: string;
  /** Rematch button label: `下一局`, or `再来一轮系列赛` once decided. */
  readonly rematchText: string;
  /** True once the series has a winner or is drawn out. */
  readonly decided: boolean;
}

const DEFAULT_ROUND = 1;
const DEFAULT_RULE_TEXT = '三局两胜';

/** Best-of labels for the supported series sizes; the contract fixes three. */
const RULE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  3: DEFAULT_RULE_TEXT,
  5: '五局三胜',
  7: '七局四胜',
});

function ruleText(series: RoomSeriesState | undefined): string {
  if (series === undefined) {
    return DEFAULT_RULE_TEXT;
  }
  return RULE_TEXT[series.bestOf] ?? `${series.bestOf} 局 ${series.winsRequired} 胜`;
}

function roundNumber(series: RoomSeriesState | undefined): number {
  if (series === undefined) {
    return DEFAULT_ROUND;
  }
  const round = series.round;
  if (!Number.isInteger(round) || round < 1) {
    return DEFAULT_ROUND;
  }
  const maxRounds =
    Number.isInteger(series.maxRounds) && series.maxRounds >= 1
      ? series.maxRounds
      : round;
  return Math.min(round, maxRounds);
}

function winsFor(series: RoomSeriesState | undefined, playerId: string | null): number {
  if (series === undefined || playerId === null) {
    return 0;
  }
  return series.wins[playerId] ?? 0;
}

interface SeriesSeats {
  readonly selfId: string | null;
  readonly opponentId: string | null;
}

/**
 * Resolve this seat and its opponent without trusting array order blindly.
 *
 * `playerIds` is the room's player order, so the first id is also the fallback
 * seat when the caller has no identity yet. When the room list is missing, the
 * `wins` keys still name the opponent, which keeps a late or partial
 * `room_state` from breaking the score line.
 */
function resolveSeats(
  series: RoomSeriesState | undefined,
  selfId: string | null,
  playerIds: readonly string[],
): SeriesSeats {
  const ids = playerIds.filter(
    (playerId, index, all) => playerId !== '' && all.indexOf(playerId) === index,
  );
  const self =
    selfId !== null && selfId !== '' && (ids.length === 0 || ids.includes(selfId))
      ? selfId
      : (ids[0] ?? null);
  const opponentFromRoom = ids.find((playerId) => playerId !== self) ?? null;
  const opponentFromWins =
    series === undefined
      ? null
      : (Object.keys(series.wins).find((playerId) => playerId !== self) ?? null);
  return {
    selfId: self,
    opponentId: opponentFromRoom ?? opponentFromWins,
  };
}

function winnerText(winnerId: string | null, selfId: string | null): string {
  if (winnerId === null) {
    return '平局';
  }
  return winnerId === selfId ? '你获胜' : '对手获胜';
}

/**
 * Build every series string the room screen needs from one wire value.
 *
 * `series` may be absent (old server messages), `selfId` may still be `null`
 * before the first room state, and `playerIds` may be empty; none of those
 * cases throw. The result is a frozen, self-contained value: it never aliases
 * the mutable wire object and never derives anything from local timers.
 */
export function seriesView(
  series: RoomStateMessage['series'],
  selfId: string | null,
  playerIds: readonly string[],
): RoomSeriesView {
  const seats = resolveSeats(series, selfId, playerIds);
  const selfWins = winsFor(series, seats.selfId);
  const opponentWins = winsFor(series, seats.opponentId);
  const decided = series?.decided ?? false;
  const scoreText = `${selfWins} : ${opponentWins}`;
  const scoreWithLabels = `你 ${scoreText} 对手`;
  const statusText = decided
    ? `系列赛结束：${scoreWithLabels}，${winnerText(series?.winnerId ?? null, seats.selfId)}`
    : scoreWithLabels;

  return Object.freeze({
    scoreText,
    roundText: `第 ${roundNumber(series)} 局 / ${ruleText(series)}`,
    statusText,
    rematchText: decided ? '再来一轮系列赛' : '下一局',
    decided,
  });
}
