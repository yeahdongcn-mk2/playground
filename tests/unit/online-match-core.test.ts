import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyMatchAction,
  createMatchState,
  forfeitMatch,
  MATCH_PLAYER_COUNT,
  matchReplayRecord,
  projectMatchSnapshot,
  toActionResultMessage,
  toEndMessage,
  toSnapshotMessage,
  verifyMatchReplay,
  type CreateMatchStateInput,
  type ForfeitReason,
  type MatchAction,
  type MatchActionOutcome,
  type MatchActionSuccess,
  type MatchState,
} from '../../server/room/match';
import {
  engineAdapter,
  hashSeed,
  replayMatch,
  validateServerMessage,
  type ProtocolErrorCode,
  type RevealedBoard,
} from '../../src/games/minesweeper/online/index';
import type { MinesweeperCell, MinesweeperConfig } from '../../src/games/minesweeper/engine';

const CONFIG = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
} satisfies MinesweeperConfig;

const SEATS = [
  { playerId: 'host', isHost: true },
  { playerId: 'guest', isHost: false },
] as const;

const START_MS = 1_000;

const MATCH_SOURCE = readFileSync(
  new URL('../../server/room/match.ts', import.meta.url),
  'utf8',
);

function start(overrides: Partial<CreateMatchStateInput> = {}): MatchState {
  return createMatchState({
    matchId: 'match_test',
    config: CONFIG,
    seed: 2_024,
    seats: SEATS,
    nowMs: START_MS,
    turnDurationMs: 1_000,
    matchDurationMs: 60_000,
    ...overrides,
  });
}

interface ActionOverrides {
  readonly actionId?: string;
  readonly seq?: number;
  readonly turnId?: number;
  readonly kind?: 'reveal' | 'flag';
  readonly row?: number;
  readonly col?: number;
}

/** Build one action against the current state, defaulting to a safe reveal. */
function actionFor(
  state: MatchState,
  overrides: ActionOverrides = {},
): MatchAction {
  return {
    actionId: `action-${state.seq + 1}`,
    seq: state.seq,
    turnId: state.turnId,
    kind: 'reveal',
    row: 0,
    col: 0,
    ...overrides,
  };
}

function act(
  state: MatchState,
  overrides: ActionOverrides = {},
  actor: string = state.turnPlayerId,
  nowMs: number = state.turnDeadlineAt - 1,
): MatchActionOutcome {
  return applyMatchAction(state, actor, actionFor(state, overrides), nowMs);
}

function accepted(outcome: MatchActionOutcome): MatchActionSuccess {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    throw new Error(`expected acceptance, got ${outcome.code}: ${outcome.message}`);
  }
  expect(outcome.status).toBe('accepted');
  return outcome;
}

function rejected(
  outcome: MatchActionOutcome,
  code: ProtocolErrorCode,
): Extract<MatchActionOutcome, { readonly ok: false }> {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error(`expected ${code}, but the action was accepted.`);
  }
  expect(outcome.code).toBe(code);
  return outcome;
}

/** First hidden, unflagged cell matching `predicate`, or null. */
function findHidden(
  state: MatchState,
  predicate: (cell: MinesweeperCell) => boolean = () => true,
): MinesweeperCell | null {
  return (
    state.engine.state.board
      .flat()
      .find((cell) => !cell.revealed && !cell.flagged && predicate(cell)) ?? null
  );
}

/** Number of mine cells in an end-only board. */
function countMines(board: RevealedBoard): number {
  return board.flat().filter((cell) => cell.mine).length;
}

/** Assert every redacted cell hides its mine flag and unrevealed count. */
function expectRedacted(state: MatchState): void {
  expect('seed' in state.snapshot).toBe(false);
  expect(state.snapshot.seedHash).toMatch(/^[0-9a-f]{64}$/);
  for (const row of state.snapshot.board) {
    for (const cell of row) {
      expect('mine' in cell).toBe(false);
      if (!cell.revealed) {
        expect(cell.adjacentMines).toBe(0);
      }
    }
  }
}

describe('online match core: start and redaction', () => {
  it('starts with the host on turn, a seed commitment and a redacted snapshot', () => {
    const state = start();
    expect(state.matchId).toBe('match_test');
    expect(state.seed).toBe(2_024);
    expect(state.seedHash).toBe(hashSeed(2_024));
    expect(state.seq).toBe(0);
    expect(state.turnId).toBe(0);
    expect(state.turnPlayerId).toBe('host');
    expect(state.playerIds).toEqual(['host', 'guest']);
    expect(MATCH_PLAYER_COUNT).toBe(2);
    expect(state.finished).toBe(false);
    expect(state.end).toBeNull();
    expect(state.actions).toEqual([]);
    expect(state.digests).toEqual([]);
    expect(state.stats).toEqual({
      turnCount: 0,
      revealedSafeCount: 0,
      flagsPlaced: 0,
      durationMs: 0,
    });
    expect(state.snapshot).toMatchObject({
      matchId: 'match_test',
      seq: 0,
      turnId: 0,
      turnPlayerId: 'host',
      deadlineAt: START_MS + 1_000,
      matchDeadlineAt: START_MS + 60_000,
      engineStatus: 'playing',
    });
    expectRedacted(state);
  });

  it('rejects a malformed seat list and invalid durations', () => {
    expect(() =>
      createMatchState({
        matchId: 'm',
        config: CONFIG,
        seed: 1,
        seats: [{ playerId: 'only', isHost: true }],
        nowMs: 0,
        turnDurationMs: 1,
        matchDurationMs: 1,
      }),
    ).toThrow(/exactly 2 players/);
    expect(() =>
      start({ seats: [SEATS[0], SEATS[0]] }),
    ).toThrow(/duplicate playerId/);
    expect(() => start({ turnDurationMs: 0 })).toThrow(/turnDurationMs/);
    expect(() => start({ matchDurationMs: 0 })).toThrow(/matchDurationMs/);
  });
});

describe('online match core: action admission', () => {
  it('rejects a player who is not on turn without changing state', () => {
    const state = start();
    const outcome = act(state, {}, 'guest');
    rejected(outcome, 'not-your-turn');
    expect(state.seq).toBe(0);
    expect(state.turnId).toBe(0);
    expect(state.actions).toEqual([]);
  });

  it('rejects stale seq and stale turnId without changing state', () => {
    const state = start();
    const staleSeq = rejected(act(state, { seq: state.seq + 1 }), 'stale-state');
    expect(staleSeq.currentSeq).toBe(0);
    expect(staleSeq.retryable).toBe(true);
    const staleTurn = rejected(act(state, { turnId: state.turnId + 1 }), 'stale-state');
    expect(staleTurn.currentSeq).toBe(0);
    expect(state.seq).toBe(0);
    expect(state.turnId).toBe(0);
    expect(state.turnDeadlineAt).toBe(state.snapshot.deadlineAt);
    expect(state.actions).toEqual([]);
  });

  it('rejects an action at the turn or match deadline', () => {
    const state = start({ seed: 11 });
    rejected(act(state, {}, 'host', state.turnDeadlineAt), 'deadline-passed');
    const matchBound = start({
      seed: 12,
      turnDurationMs: 5_000,
      matchDurationMs: 500,
    });
    rejected(
      act(matchBound, {}, 'host', matchBound.matchDeadlineAt),
      'deadline-passed',
    );
    expect(matchBound.seq).toBe(0);
  });

  it('rejects out-of-bounds coordinates and unchanged board cells', () => {
    const state = start({ seed: 13 });
    rejected(act(state, { row: CONFIG.rows }), 'invalid-action');
    rejected(act(state, { col: -1 }), 'invalid-action');

    const first = accepted(act(state, { actionId: 'reveal-1' }, 'host', 1_500));
    const revealed = first.state.snapshot.board
      .flat()
      .find((cell) => cell.revealed);
    expect(revealed).toBeDefined();
    if (revealed === undefined) {
      throw new Error('the first reveal exposed no cell');
    }
    // The guest is now on turn: a revealed cell and a flagged cell are both
    // outside the admission gate and must not consume the turn.
    rejected(
      act(
        first.state,
        { actionId: 'reveal-same', row: revealed.row, col: revealed.col },
        'guest',
        1_600,
      ),
      'invalid-action',
    );

    const target = findHidden(first.state);
    expect(target).not.toBeNull();
    if (target === null) {
      throw new Error('the board has no hidden cell to flag');
    }
    const flag = accepted(
      act(
        first.state,
        { actionId: 'flag-1', kind: 'flag', row: target.row, col: target.col },
        'guest',
        1_600,
      ),
    );
    const beforeRejects = {
      seq: flag.state.seq,
      turnId: flag.state.turnId,
      turnPlayerId: flag.state.turnPlayerId,
      board: JSON.stringify(flag.snapshot.board),
    };
    rejected(
      act(
        flag.state,
        { actionId: 'reveal-flagged', row: target.row, col: target.col },
        'host',
        1_700,
      ),
      'invalid-action',
    );
    rejected(
      act(
        flag.state,
        { actionId: 'flag-again', kind: 'flag', row: target.row, col: target.col },
        'host',
        1_700,
      ),
      'invalid-action',
    );
    expect(flag.state.seq).toBe(beforeRejects.seq);
    expect(flag.state.turnId).toBe(beforeRejects.turnId);
    expect(flag.state.turnPlayerId).toBe(beforeRejects.turnPlayerId);
    expect(JSON.stringify(flag.snapshot.board)).toBe(beforeRejects.board);
  });

  it('returns the cached action result for a retried action id', () => {
    const state = start({ seed: 21 });
    const firstAction = actionFor(state, { actionId: 'retry-me' });
    const first = accepted(
      applyMatchAction(state, 'host', firstAction, 1_500),
    );
    const cached = applyMatchAction(first.state, 'host', firstAction, 1_600);
    expect(cached.ok).toBe(true);
    if (!cached.ok) {
      throw new Error(`expected a duplicate, got ${cached.code}`);
    }
    expect(cached.status).toBe('duplicate');
    expect(cached.actionResult).toEqual(first.actionResult);
    expect(cached.state).toBe(first.state);
    expect(cached.state.seq).toBe(1);
    expect(cached.state.turnId).toBe(1);
    expect(cached.snapshot).toBe(first.snapshot);
    expect(cached.end).toBeNull();

    // Same id from the opponent while it is their turn must not receive the
    // other player's cached verdict.
    rejected(
      applyMatchAction(first.state, 'guest', { ...firstAction, seq: first.state.seq, turnId: first.state.turnId }, 1_700),
      'invalid-action',
    );
  });

  it('rejects an empty action id instead of throwing', () => {
    const state = start({ seed: 22 });
    const outcome = applyMatchAction(
      state,
      'host',
      { actionId: '', seq: 0, turnId: 0, kind: 'reveal', row: 0, col: 0 },
      1_500,
    );
    rejected(outcome, 'invalid-action');
    expect(state.seq).toBe(0);
    expect(state.actions).toEqual([]);
  });

  it('rejects a non-object action instead of throwing', () => {
    const state = start({ seed: 23 });
    for (const action of [null, 'reveal', 42, undefined]) {
      rejected(
        applyMatchAction(state, 'host', action as unknown as MatchAction, 1_500),
        'invalid-action',
      );
    }
    expect(state.seq).toBe(0);
    expect(state.turnId).toBe(0);
    expect(state.actions).toEqual([]);
    expect(state.actionResults.size).toBe(0);
  });
});

describe('online match core: caller-owned sequence', () => {
  it('uses the room seq passed at start for actions and replay', () => {
    const state = start({ seed: 24, initialSeq: 5 });
    expect(state.snapshot.seq).toBe(5);
    rejected(act(state, { seq: 4 }), 'stale-state');
    const first = accepted(act(state, { actionId: 'room-seq-1' }, 'host', 1_500));
    expect(first.state.seq).toBe(6);
    expect(first.actionResult.seq).toBe(6);
    expect(first.state.actions[0]).toMatchObject({ seq: 6 });
    expect(first.state.digests[0]).toMatchObject({ seq: 6 });
    expect(toSnapshotMessage(first.snapshot, 'room_1').seq).toBe(6);
    expect(replayMatch(matchReplayRecord(first.state), first.state.digests).digests).toEqual(
      first.state.digests,
    );
  });
});

describe('online match core: accepted actions', () => {
  it('rotates the turn in seat order and records replay + digests', () => {
    const state = start({ seed: 31 });
    const first = accepted(act(state, { actionId: 'reveal-1' }, 'host', 1_500));
    expect(first.state.seq).toBe(1);
    expect(first.state.turnId).toBe(1);
    expect(first.state.turnPlayerId).toBe('guest');
    expect(first.state.turnDeadlineAt).toBe(2_500);
    expect(first.state.stats).toMatchObject({ turnCount: 1, durationMs: 500 });
    expect(first.state.actions).toEqual([
      { seq: 1, turnId: 0, actionId: 'reveal-1', kind: 'reveal', row: 0, col: 0 },
    ]);
    expect(first.state.digests).toHaveLength(1);
    expect(first.state.digests[0]).toMatchObject({ seq: 1, turnId: 0 });
    expect(first.actionResult).toMatchObject({
      actionId: 'reveal-1',
      seq: 1,
      turnId: 1,
      accepted: true,
      reason: null,
      turnPlayerId: 'guest',
      deadlineAt: 2_500,
    });
    expect(first.actionResult.revealedCells.length).toBeGreaterThan(0);
    expect(first.snapshot).toMatchObject({
      matchId: 'match_test',
      seq: 1,
      turnId: 1,
      turnPlayerId: 'guest',
      deadlineAt: 2_500,
      matchDeadlineAt: START_MS + 60_000,
    });
    expect(first.end).toBeNull();
    expectRedacted(first.state);
    // The state wrapper and its frozen snapshot are new values; the engine is
    // the one server-side handle the room ticks.
    expect(first.state.engine).toBe(state.engine);
    expect(first.state.snapshot).not.toBe(state.snapshot);
    expect(state.snapshot).toMatchObject({ seq: 0, turnId: 0, turnPlayerId: 'host' });
    expect(state.turnDeadlineAt).toBe(state.snapshot.deadlineAt);

    const second = accepted(act(first.state, { actionId: 'flag-1', kind: 'flag', row: 8, col: 8 }, 'guest', 2_000));
    expect(second.state.seq).toBe(2);
    expect(second.state.turnId).toBe(2);
    expect(second.state.turnPlayerId).toBe('host');
    expect(second.state.actions.map((recorded) => recorded.seq)).toEqual([1, 2]);
    expect(second.state.digests.map((digest) => digest.seq)).toEqual([1, 2]);
  });

  it('keeps adapter clock ticks across actions and refreshes on demand', () => {
    const state = start({ seed: 32 });
    const first = accepted(act(state, { actionId: 'clock-1' }, 'host', 1_500));
    const ticked = engineAdapter.tick(first.state.engine, 500);
    expect(ticked).toBe(500);
    expect(first.state.snapshot.elapsedMs).toBe(0);
    expect(projectMatchSnapshot(first.state).elapsedMs).toBe(500);
    const hidden = findHidden(first.state);
    expect(hidden).not.toBeNull();
    if (hidden === null) {
      throw new Error('no hidden cell for the flag action');
    }
    const second = accepted(
      act(
        first.state,
        { actionId: 'clock-2', kind: 'flag', row: hidden.row, col: hidden.col },
        'guest',
        1_600,
      ),
    );
    expect(second.snapshot.elapsedMs).toBe(500);
  });

  it('keeps the action id cache bounded and evicts the oldest result', () => {
    let state = start({ seed: 41, actionCacheLimit: 2 });
    state = accepted(act(state, { actionId: 'first' }, 'host', 1_500)).state;
    const hidden = state.engine.state.board
      .flat()
      .filter((cell) => !cell.revealed && !cell.flagged)
      .slice(0, 2);
    expect(hidden).toHaveLength(2);
    const [one, two] = hidden;
    if (one === undefined || two === undefined) {
      throw new Error('not enough hidden cells');
    }
    state = accepted(
      act(state, { actionId: 'second', kind: 'flag', row: one.row, col: one.col }, 'guest', 1_600),
    ).state;
    state = accepted(
      act(state, { actionId: 'third', kind: 'flag', row: two.row, col: two.col }, 'host', 1_700),
    ).state;
    expect(state.actionResults.size).toBe(2);
    expect(state.actionResults.has('first')).toBe(false);
    expect(state.actionResults.has('second')).toBe(true);
    expect(state.actionResults.has('third')).toBe(true);
    // The evicted id is no longer a retry: its old seq is stale now.
    rejected(
      applyMatchAction(
        state,
        state.turnPlayerId,
        { actionId: 'first', seq: 0, turnId: 0, kind: 'reveal', row: 0, col: 0 },
        1_800,
      ),
      'stale-state',
    );
  });
});

describe('online match core: endings', () => {
  it('ends once with every mine revealed and the committed seed on a mine hit', () => {
    const state = start({ seed: 51 });
    const first = accepted(act(state, { actionId: 'reveal-1' }, 'host', 1_500));
    const hiddenMine = findHidden(first.state, (cell) => cell.mine);
    expect(hiddenMine).not.toBeNull();
    if (hiddenMine === null) {
      throw new Error('the first reveal exposed every mine');
    }
    const actor = first.state.turnPlayerId;
    const hit = accepted(
      act(
        first.state,
        {
          actionId: 'reveal-mine',
          row: hiddenMine.row,
          col: hiddenMine.col,
        },
        actor,
        1_600,
      ),
    );
    expect(hit.end).not.toBeNull();
    if (hit.end === null) {
      throw new Error('mine hit produced no end payload');
    }
    expect(hit.end.reason).toBe('mine-hit');
    expect(hit.end.winnerId).toBe('host');
    expect(hit.end.loserId).toBe(actor);
    expect(hit.end.seed).toBe(51);
    expect(hit.end.stats.turnCount).toBe(2);
    expect(hit.state.finished).toBe(true);
    expect(hit.state.end).toBe(hit.end);
    // The ending action still advances seq, but the turn does not rotate.
    expect(hit.state.seq).toBe(2);
    expect(hit.state.turnId).toBe(1);
    expect(hit.state.turnPlayerId).toBe(actor);
    expect(hit.snapshot.engineStatus).toBe('lost');

    expect(countMines(hit.end.finalSnapshot)).toBe(CONFIG.mines);
    // The end board must be the post-action board: the exploded mine is shown
    // revealed, not the pre-action projection captured in `state`.
    expect(hit.end.finalSnapshot).toEqual(hit.state.engine.state.board);
    expect(
      hit.end.finalSnapshot[hiddenMine.row]?.[hiddenMine.col]?.revealed,
    ).toBe(true);
    expect(
      createHash('sha256').update(String(hit.end.seed)).digest('hex'),
    ).toBe(hit.state.seedHash);

    const afterEnd = act(hit.state, { actionId: 'after-end' }, hit.state.turnPlayerId, 1_700);
    rejected(afterEnd, 'invalid-action');
    expect(hit.state.end).toBe(hit.end);
  });

  it('ends once when every safe cell is revealed', () => {
    let state = start({ seed: 61 });
    let nowMs = 1_500;
    let result = accepted(act(state, { actionId: 'reveal-1' }, 'host', nowMs));
    state = result.state;
    nowMs += 100;
    let guard = 0;
    while (!state.finished && guard < 200) {
      const safe = findHidden(state, (cell) => !cell.mine);
      if (safe === null) {
        break;
      }
      result = accepted(
        act(
          state,
          {
            actionId: `reveal-${state.seq + 1}`,
            row: safe.row,
            col: safe.col,
          },
          state.turnPlayerId,
          nowMs,
        ),
      );
      state = result.state;
      nowMs += 100;
      guard += 1;
    }
    expect(state.finished).toBe(true);
    expect(state.end).not.toBeNull();
    expect(state.end?.reason).toBe('all-safe-revealed');
    expect(state.snapshot.engineStatus).toBe('won');
    if (state.end === null) {
      throw new Error('the won match has no end payload');
    }
    expect(countMines(state.end.finalSnapshot)).toBe(CONFIG.mines);
    expect(state.end.finalSnapshot).toEqual(state.engine.state.board);
    expect(state.end?.winnerId).toBe(state.turnPlayerId);
  });

  it('ends once on an explicit forfeit and rejects a second ending', () => {
    const state = start({ seed: 71 });
    const first = accepted(act(state, { actionId: 'reveal-1' }, 'host', 1_500));
    const outcome = forfeitMatch(first.state, 'guest', 2_000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`forfeit was rejected: ${outcome.code}`);
    }
    expect(outcome.end.reason).toBe('forfeit');
    expect(outcome.end.winnerId).toBe('host');
    expect(outcome.end.loserId).toBe('guest');
    expect(outcome.end.seed).toBe(71);
    expect(outcome.end.stats).toMatchObject({ turnCount: 1, durationMs: 1_000 });
    expect(outcome.state.finished).toBe(true);
    expect(outcome.state.seq).toBe(2);
    expect(countMines(outcome.end.finalSnapshot)).toBe(CONFIG.mines);

    const again = forfeitMatch(outcome.state, 'host', 2_100);
    expect(again.ok).toBe(false);
    if (again.ok) {
      throw new Error('a finished match produced a second forfeit end');
    }
    expect(again.code).toBe('invalid-action');
    expect(outcome.state.end).toBe(outcome.end);
    expect(outcome.state.seq).toBe(2);
  });

  it('publishes a complete mine layout when the match ends before the first reveal', () => {
    const state = start({ seed: 74 });
    const outcome = forfeitMatch(state, 'host', 1_500);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`forfeit was rejected: ${outcome.code}`);
    }
    expect(outcome.end.reason).toBe('forfeit');
    expect(countMines(outcome.end.finalSnapshot)).toBe(CONFIG.mines);
    expect(outcome.end.stats.turnCount).toBe(0);
    // The real board never revealed a cell, so the published board keeps every
    // cell hidden while still exposing the committed mine layout.
    expect(outcome.end.finalSnapshot.flat().every((cell) => !cell.revealed)).toBe(true);
    expect(outcome.end.finalSnapshot).toHaveLength(CONFIG.rows);
  });

  it('keeps the real flags when a flag-only match is forfeited before any reveal', () => {
    const state = start({ seed: 2_024 });
    const hostFlag = accepted(
      act(state, { actionId: 'flag-host', kind: 'flag', row: 0, col: 0 }, 'host', 1_500),
    );
    const guestFlag = accepted(
      act(
        hostFlag.state,
        { actionId: 'flag-guest', kind: 'flag', row: 0, col: 1 },
        'guest',
        1_600,
      ),
    );
    // No reveal happened, so the engine still has no mine layout of its own;
    // the two flags are real public actions, though.
    expect(guestFlag.state.engine.state.status).toBe('ready');
    expect(guestFlag.state.stats.flagsPlaced).toBe(2);
    expect(guestFlag.state.snapshot.board.flat().filter((cell) => cell.flagged)).toHaveLength(2);

    const outcome = forfeitMatch(guestFlag.state, 'guest', 2_000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`forfeit was rejected: ${outcome.code}`);
    }
    expect(outcome.end.stats.flagsPlaced).toBe(2);
    const flags = outcome.end.finalSnapshot
      .flat()
      .filter((cell) => cell.flagged)
      .map((cell) => `${cell.row},${cell.col}`)
      .sort();
    expect(flags).toEqual(['0,0', '0,1']);
    expect(outcome.end.finalSnapshot.flat().filter((cell) => cell.revealed)).toHaveLength(0);
    expect(countMines(outcome.end.finalSnapshot)).toBe(CONFIG.mines);
    // The end board and the same-state snapshot must agree on every public
    // cell, so `end.finalSnapshot` never contradicts the last snapshot.
    for (const [rowIndex, row] of outcome.end.finalSnapshot.entries()) {
      for (const [colIndex, cell] of row.entries()) {
        const publicCell = outcome.snapshot.board[rowIndex]?.[colIndex];
        expect(publicCell).toBeDefined();
        expect(cell.flagged).toBe(publicCell?.flagged);
        expect(cell.revealed).toBe(publicCell?.revealed);
      }
    }
    expect(outcome.end.seed).toBe(2_024);
  });

  it('uses the timer end reasons the reconnect layer needs', () => {
    const state = start({ seed: 72 });
    const turnTimeout = forfeitMatch(state, state.turnPlayerId, 1_500, 'turn-timeout');
    expect(turnTimeout.ok).toBe(true);
    if (!turnTimeout.ok) {
      throw new Error(`turn timeout was rejected: ${turnTimeout.code}`);
    }
    expect(turnTimeout.end.reason).toBe('turn-timeout');
    expect(turnTimeout.end.winnerId).toBe('guest');
    expect(turnTimeout.end.loserId).toBe('host');
  });

  it('rejects an unseated player and the unsupported match-timeout reason', () => {
    const state = start({ seed: 75 });
    const unknown = forfeitMatch(state, 'stranger', 1_500);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      throw new Error('an unseated player ended the match');
    }
    expect(unknown.code).toBe('invalid-action');
    expect(unknown.currentSeq).toBe(0);
    expect(unknown.message).toContain('not seated');
    expect(state.finished).toBe(false);
    expect(state.seq).toBe(0);

    // Design 3.4 decides a match timeout by revealed-safe-cell progress and
    // allows a draw, so this player-loses entry point must not fake a winner.
    expect(() =>
      forfeitMatch(state, 'host', 1_500, 'match-timeout' as unknown as ForfeitReason),
    ).toThrow(/reason must be "forfeit" or "turn-timeout"/);
    expect(state.finished).toBe(false);
    expect(state.seq).toBe(0);
  });
});

describe('online match core: wire mapping', () => {
  it('stamps caller-owned room fields and passes server-message validation', () => {
    const state = start({ seed: 73 });
    const first = accepted(act(state, { actionId: 'reveal-1' }, 'host', 1_500));

    expect(toSnapshotMessage(first.snapshot, 'room_1').seq).toBe(first.snapshot.seq);
    const snapshot = toSnapshotMessage(first.snapshot, 'room_1', 7);
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      roomId: 'room_1',
      seq: 7,
      matchId: 'match_test',
    });
    expect(snapshot).not.toHaveProperty('seed');
    expect(validateServerMessage(snapshot).ok).toBe(true);

    const actionResult = toActionResultMessage(first.actionResult, 'room_1', 8);
    expect(actionResult).toMatchObject({
      type: 'action_result',
      roomId: 'room_1',
      seq: 8,
      actionId: 'reveal-1',
    });
    expect(validateServerMessage(actionResult).ok).toBe(true);

    const ended = forfeitMatch(first.state, 'guest', 2_000);
    if (!ended.ok) {
      throw new Error(`forfeit was rejected: ${ended.code}`);
    }
    const end = toEndMessage(ended.end, 'room_1', 9);
    expect(end).toMatchObject({ type: 'end', roomId: 'room_1', seq: 9 });
    expect(validateServerMessage(end).ok).toBe(true);
  });

  it('rejects an empty room id and a negative room seq in every wire helper', () => {
    const state = start({ seed: 76 });
    const first = accepted(act(state, { actionId: 'wire-guard' }, 'host', 1_500));
    const ended = forfeitMatch(first.state, 'guest', 1_600);
    if (!ended.ok) {
      throw new Error(`forfeit was rejected: ${ended.code}`);
    }
    const stampers: ReadonlyArray<(roomId: string, roomSeq: number) => unknown> = [
      (roomId, roomSeq) => toSnapshotMessage(first.snapshot, roomId, roomSeq),
      (roomId, roomSeq) => toActionResultMessage(first.actionResult, roomId, roomSeq),
      (roomId, roomSeq) => toEndMessage(ended.end, roomId, roomSeq),
    ];
    for (const stamp of stampers) {
      expect(() => stamp('', 1)).toThrow(/roomId must be a non-empty string/);
      expect(() => stamp('room_1', -1)).toThrow(/roomSeq/);
    }
  });
});

describe('online match core: module boundaries', () => {
  it('reuses the shared online helpers and stays out of room/socket/timer code', () => {
    for (const helper of [
      "from '../../src/games/minesweeper/online/index'",
      'endPayload',
      'engineAdapter',
      'evaluateAction',
      'hashSeed',
      'matchDigest',
      'replayMatch',
    ]) {
      expect(MATCH_SOURCE).toContain(helper);
    }
    for (const forbidden of [
      "from 'ws'",
      "from './contracts'",
      "from './room-manager'",
      "from './ws-server'",
      "from 'node:http'",
      "from 'node:fs'",
      'setTimeout(',
      'setInterval(',
      'Date.now(',
    ]) {
      expect(MATCH_SOURCE).not.toContain(forbidden);
    }
  });
});

describe('online match core: replay', () => {
  it('replays the same seed/config/actions to identical digests and results', () => {
    let state = start({ seed: 81 });
    let result = accepted(act(state, { actionId: 'reveal-1' }, 'host', 1_500));
    state = result.state;
    let nowMs = 1_600;
    for (let index = 0; index < 3 && !state.finished; index += 1) {
      const cell = findHidden(state);
      if (cell === null) {
        break;
      }
      result = accepted(
        act(
          state,
          {
            actionId: `flag-${index}`,
            kind: 'flag',
            row: cell.row,
            col: cell.col,
          },
          state.turnPlayerId,
          nowMs,
        ),
      );
      state = result.state;
      nowMs += 100;
    }
    expect(state.actions.length).toBeGreaterThan(1);

    const record = matchReplayRecord(state);
    expect(record.matchId).toBe(state.matchId);
    expect(record.seed).toBe(81);
    expect(record.config).toEqual(CONFIG);
    expect(record.actions).toEqual(state.actions);

    const firstReplay = replayMatch(record, state.digests);
    const secondReplay = replayMatch(record, state.digests);
    expect(secondReplay).toEqual(firstReplay);
    expect(firstReplay.digests).toEqual(state.digests);
    expect(verifyMatchReplay(state)).toEqual(firstReplay);
    expect(firstReplay.digests).toHaveLength(state.actions.length);
  });
});
