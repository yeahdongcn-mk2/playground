import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createMatchEngine,
  createProtocolError,
  endPayload,
  engineAdapter,
  hashSeed,
  matchDigest,
  MESSAGE_SPECS,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_VERSION,
  ReplayMismatchError,
  replayMatch,
  validateServerMessage,
  type ActionKind,
  type EndMessage,
  type EngineMatch,
  type MatchStats,
  type ReplayAction,
  type ReplayDigest,
  type ReplayRecord,
  type SnapshotMessage,
} from '../../src/games/minesweeper/online/index';
import type { MinesweeperConfig } from '../../src/games/minesweeper/engine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLINE_DIR = join(ROOT, 'src', 'games', 'minesweeper', 'online');
const ADAPTER_PATH = join(ONLINE_DIR, 'adapter.ts');
const INDEX_PATH = join(ONLINE_DIR, 'index.ts');
const ADAPTER_SOURCE = readFileSync(ADAPTER_PATH, 'utf8');
const INDEX_SOURCE = readFileSync(INDEX_PATH, 'utf8');

const CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};
const SEED = 424242;

interface CellPosition {
  readonly row: number;
  readonly col: number;
}

function action(
  seq: number,
  kind: ActionKind,
  row: number,
  col: number,
  turnId: number = seq,
): ReplayAction {
  return { seq, turnId, actionId: `a-${seq}`, kind, row, col };
}

function createMatch(
  matchId: string,
  config: MinesweeperConfig = CONFIG,
  seed: number = SEED,
): EngineMatch {
  return engineAdapter.createMatch({ matchId, config, seed });
}

function applyAndRecord(match: EngineMatch, accepted: ReplayAction): void {
  engineAdapter.applyAction(match, accepted);
  engineAdapter.recordAction(match, accepted);
}

/** First hidden, unflagged cell visible in the redacted board. */
function nextHiddenCell(match: EngineMatch): CellPosition | null {
  for (const row of engineAdapter.projectSnapshot(match).board) {
    for (const cell of row) {
      if (!cell.revealed && !cell.flagged) {
        return { row: cell.row, col: cell.col };
      }
    }
  }
  return null;
}

/**
 * Play one deterministic opening and then reveal hidden cells until the match
 * ends or `maxActions` is reached. When `mirror` is supplied, the same actions
 * are applied to the second match so both stay in lockstep. When
 * `expectedDigests` is supplied, every step is digested from the live engine,
 * independently of the replay path under test.
 */
function playMatch(
  match: EngineMatch,
  options: {
    readonly maxActions: number;
    readonly flagFirst: boolean;
    readonly mirror?: EngineMatch;
    readonly expectedDigests?: ReplayDigest[];
  },
): ReplayAction[] {
  const actions: ReplayAction[] = [];
  const apply = (kind: ActionKind, row: number, col: number): void => {
    const accepted = action(actions.length + 1, kind, row, col);
    actions.push(accepted);
    applyAndRecord(match, accepted);
    options.expectedDigests?.push(
      matchDigest(match, accepted.seq, accepted.turnId),
    );
    if (options.mirror !== undefined) {
      applyAndRecord(options.mirror, accepted);
    }
  };

  if (options.flagFirst) {
    apply('flag', 0, 0);
  }
  apply('reveal', Math.floor(match.config.rows / 2), Math.floor(match.config.cols / 2));
  while (match.state.status === 'playing' && actions.length < options.maxActions) {
    const cell = nextHiddenCell(match);
    if (cell === null) {
      break;
    }
    apply('reveal', cell.row, cell.col);
  }
  return actions;
}

function statsFor(match: EngineMatch, turnCount: number): MatchStats {
  const board = match.state.board.flat();
  return {
    turnCount,
    revealedSafeCount: board.filter((cell) => cell.revealed && !cell.mine).length,
    flagsPlaced: board.filter((cell) => cell.flagged).length,
    durationMs: 0,
  };
}

function expectReplayMismatch(
  record: ReplayRecord,
  expected: readonly ReplayDigest[],
  seq: number,
): void {
  let mismatch: unknown;
  try {
    replayMatch(record, expected);
  } catch (caught) {
    mismatch = caught;
  }
  expect(mismatch).toBeInstanceOf(ReplayMismatchError);
  if (!(mismatch instanceof ReplayMismatchError)) {
    throw new Error('expected a ReplayMismatchError');
  }
  expect(mismatch.seq).toBe(seq);
}

describe('online minesweeper engine adapter', () => {
  it('creates a deterministic Node engine without pre-placing mines', () => {
    expect(hashSeed(42)).toBe(
      '73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049',
    );
    expect(hashSeed(42)).toMatch(/^[0-9a-f]{64}$/);

    const engine = createMatchEngine(CONFIG, SEED);
    expect(engine.currentStatus).toBe('ready');
    expect(engine.state.board.flat().every((cell) => !cell.mine)).toBe(true);

    const firstReveal = engine.reveal(4, 4);
    expect(firstReveal.hitMine).toBe(false);
    // The whole 3x3 first-click safe zone is mine-free, not just (4,4).
    for (let row = 3; row <= 5; row += 1) {
      for (let col = 3; col <= 5; col += 1) {
        expect(engine.state.board[row]?.[col]?.mine).toBe(false);
      }
    }
    expect(engine.currentStatus).not.toBe('ready');
    expect(engine.state.board.flat().filter((cell) => cell.mine)).toHaveLength(
      CONFIG.mines,
    );

    const first = createMatch('deterministic-a');
    const second = createMatch('deterministic-b');
    expect(first.seedHash).toBe(hashSeed(SEED));
    expect(first.seed).toBe(SEED);
    expect(first.config).toEqual(CONFIG);
    expect(engineAdapter.projectSnapshot(first).engineStatus).toBe('playing');

    const actions = playMatch(first, {
      maxActions: 8,
      flagFirst: true,
      mirror: second,
    });
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(engineAdapter.projectSnapshot(first)).toEqual(
      engineAdapter.projectSnapshot(second),
    );
    expect(engineAdapter.expandEndBoard(first)).toEqual(
      engineAdapter.expandEndBoard(second),
    );
    expect(engineAdapter.getReplayRecord(first).actions).toEqual(actions);
  });

  it('honours the first-click safe zone and passes firstClickSafe:false through', () => {
    const unsafeConfig: MinesweeperConfig = {
      rows: 5,
      cols: 5,
      mines: 8,
      firstClickSafe: false,
    };
    // At seed 7 the engine mines (1,3), a neighbour of the (2,2) first click,
    // when the safe zone is disabled. Keeping that mine proves the adapter
    // forwards firstClickSafe:false instead of forcing the safe policy on.
    const unsafe = createMatch('first-click-unsafe', unsafeConfig, 7);
    const unsafeResult = engineAdapter.applyAction(
      unsafe,
      action(1, 'reveal', 2, 2),
    );
    expect(unsafeResult.status).toBe('playing');
    const unsafeBoard = engineAdapter.expandEndBoard(unsafe);
    expect(unsafeBoard[1]?.[3]?.mine).toBe(true);

    const safe = createMatch(
      'first-click-safe',
      { ...unsafeConfig, firstClickSafe: true },
      7,
    );
    const safeResult = engineAdapter.applyAction(safe, action(1, 'reveal', 2, 2));
    expect(safeResult.status).toBe('playing');
    expect(safeResult.revealedCells).toContainEqual({ row: 2, col: 2 });
    const safeBoard = engineAdapter.expandEndBoard(safe);
    for (let row = 1; row <= 3; row += 1) {
      for (let col = 1; col <= 3; col += 1) {
        expect(safeBoard[row]?.[col]?.mine).toBe(false);
      }
    }
    // The eight neighbours around the first click are explicitly mine-free.
    const neighbours: readonly (readonly [number, number])[] = [
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 3],
      [3, 1],
      [3, 2],
      [3, 3],
    ];
    for (const [row, col] of neighbours) {
      expect(safeBoard[row]?.[col]?.mine).toBe(false);
    }
  });

  it('projects a redacted board without mine fields or hidden adjacency', () => {
    const match = createMatch('redacted');
    // Stop before a mine can be hit so the projection is a mid-match board.
    playMatch(match, { maxActions: 2, flagFirst: true });
    expect(match.state.status).toBe('playing');
    const snapshot = engineAdapter.projectSnapshot(match);

    expect(snapshot.seedHash).toBe(hashSeed(SEED));
    expect(Object.keys(snapshot)).not.toContain('seed');
    expect(Object.keys(snapshot)).not.toContain('finalSnapshot');
    expect(JSON.stringify(snapshot)).not.toContain('"seed"');
    expect(JSON.stringify(snapshot)).not.toContain('"mine"');

    let revealedCount = 0;
    for (const row of snapshot.board) {
      for (const cell of row) {
        expect(Object.keys(cell).sort()).toEqual([
          'adjacentMines',
          'col',
          'flagged',
          'revealed',
          'row',
        ]);
        if (cell.revealed) {
          revealedCount += 1;
        } else {
          expect(cell.adjacentMines).toBe(0);
        }
      }
    }
    expect(revealedCount).toBe(snapshot.revealedSafeCount);
    expect(revealedCount).toBeGreaterThan(0);
    expect(snapshot.mineCount).toBe(CONFIG.mines);
    expect(snapshot.remainingMines).toBe(CONFIG.mines - 1);
  });

  it('records ordered actions and rejects illegal or out-of-order input', () => {
    const match = createMatch('ordering');
    applyAndRecord(match, action(1, 'flag', 0, 0));
    applyAndRecord(match, action(2, 'reveal', 4, 4));

    expect(() => engineAdapter.recordAction(match, action(1, 'flag', 0, 1))).toThrow(
      /seq 1 must be greater than the last recorded seq 2/,
    );
    expect(() => engineAdapter.recordAction(match, action(2, 'flag', 0, 1))).toThrow(
      /seq 2 must be greater than the last recorded seq 2/,
    );
    expect(() => engineAdapter.applyAction(match, action(3, 'reveal', -1, 0))).toThrow(
      /out of bounds/,
    );
    expect(() =>
      engineAdapter.applyAction(match, {
        ...action(3, 'reveal', 0, 1),
        kind: 'explode' as ActionKind,
      }),
    ).toThrow(/kind/);
    expect(() => engineAdapter.applyAction(match, action(3, 'reveal', 4, 4))).toThrow(
      /already revealed or flagged/,
    );

    const record = engineAdapter.getReplayRecord(match);
    const first = record.actions[0];
    if (first === undefined) {
      throw new Error('expected the recorded log to contain an action');
    }
    const duplicate = { ...record, actions: [first, { ...first, actionId: 'dup' }] };
    expect(() => replayMatch(duplicate)).toThrow(/duplicate seq 1/);
    const outOfBounds = { ...record, actions: [{ ...first, row: 99 }] };
    expect(() => replayMatch(outOfBounds)).toThrow(/out of bounds/);
  });

  it('replays config, seed and ordered actions and compares every digest', () => {
    const match = createMatch('replay');
    // Sample digests while the original match plays instead of replaying it,
    // so rebuilding from a wrong config or seed cannot agree with itself.
    const expected: ReplayDigest[] = [];
    const actions = playMatch(match, {
      maxActions: 10,
      flagFirst: true,
      expectedDigests: expected,
    });
    const record = engineAdapter.getReplayRecord(match);
    expect(record.seed).toBe(SEED);
    expect(record.actions).toEqual(actions);
    expect(expected).toHaveLength(actions.length);

    const outcome = replayMatch(record, expected);
    expect(outcome.digests).toEqual(expected);
    expect(outcome.status).toBe(match.state.status);
    expect(outcome.finalDigest).toEqual(expected.at(-1));
    expect(engineAdapter.replay(record)).toEqual(expected);

    const reversed: ReplayRecord = {
      ...record,
      actions: [...record.actions].reverse(),
    };
    expect(replayMatch(reversed, expected).digests).toEqual(expected);

    const tampered = expected.map((digest, index) =>
      index === 1 ? { ...digest, snapshotHash: '0'.repeat(64) } : digest,
    );
    let mismatch: unknown;
    try {
      replayMatch(record, tampered);
    } catch (caught) {
      mismatch = caught;
    }
    expect(mismatch).toBeInstanceOf(ReplayMismatchError);
    if (!(mismatch instanceof ReplayMismatchError)) {
      throw new Error('expected a ReplayMismatchError');
    }
    expect(mismatch.seq).toBe(expected[1]?.seq);

    const firstSeq = expected[0]?.seq;
    if (firstSeq === undefined) {
      throw new Error('expected at least one replay digest');
    }
    // A changed seed or mine count must fail against live-match digests,
    // proving the expected values do not come from the replay path under test.
    expectReplayMismatch({ ...record, seed: record.seed + 1 }, expected, firstSeq);
    expectReplayMismatch(
      {
        ...record,
        config: { ...record.config, mines: record.config.mines - 1 },
      },
      expected,
      firstSeq,
    );

    const missing = expected.slice(0, 1);
    expect(() => replayMatch(record, missing)).toThrow(/Replay mismatch at seq/);
    const last = expected.at(-1);
    if (last === undefined) {
      throw new Error('expected at least one replay digest');
    }
    const extra: readonly ReplayDigest[] = [...expected, { ...last, seq: last.seq + 100 }];
    expect(() => replayMatch(record, extra)).toThrow(
      new RegExp(`Replay mismatch at seq ${last.seq + 100}`),
    );
  });

  it('publishes every mine and the seed only in the end payload', () => {
    const config: MinesweeperConfig = {
      rows: 5,
      cols: 5,
      mines: 3,
      firstClickSafe: true,
    };
    const match = createMatch('end', config, 987654321);
    const before = engineAdapter.projectSnapshot(match);
    expect(JSON.stringify(before)).not.toContain('"seed"');
    expect(JSON.stringify(before)).not.toContain('"mine"');

    const actions = playMatch(match, { maxActions: 30, flagFirst: false });
    expect(match.state.status).not.toBe('playing');

    const payload = endPayload(match, {
      reason:
        match.state.status === 'lost' ? 'mine-hit' : 'all-safe-revealed',
      winnerId: 'player-a',
      loserId: 'player-b',
      stats: statsFor(match, actions.length),
    });
    expect(payload.matchId).toBe('end');
    expect(payload.seed).toBe(987654321);
    expect(hashSeed(payload.seed)).toBe(before.seedHash);
    expect(payload.finalSnapshot.flat().filter((cell) => cell.mine)).toHaveLength(
      config.mines,
    );
    for (const row of payload.finalSnapshot) {
      for (const cell of row) {
        expect(Object.keys(cell).sort()).toEqual([
          'adjacentMines',
          'col',
          'flagged',
          'mine',
          'revealed',
          'row',
        ]);
      }
    }

    const after = engineAdapter.projectSnapshot(match);
    expect(after.engineStatus).not.toBe('playing');
    expect(JSON.stringify(after)).not.toContain('"seed"');
    expect(JSON.stringify(after)).not.toContain('"mine"');
  });

  it('keeps the adapter free of DOM and storage globals', () => {
    expect(ADAPTER_SOURCE).not.toMatch(/\b(?:document|window|localStorage)\b/);
  });
});

describe('online engine adapter action limits', () => {
  it('rejects an action after the match ended', () => {
    const config: MinesweeperConfig = {
      rows: 5,
      cols: 5,
      mines: 3,
      firstClickSafe: true,
    };
    const match = createMatch('finished', config, 99);
    playMatch(match, { maxActions: 30, flagFirst: false });
    expect(match.state.status).not.toBe('playing');
    expect(() => engineAdapter.applyAction(match, action(1, 'reveal', 0, 0))).toThrow(
      /already ended/,
    );
  });
});

describe('online minesweeper cross-module wiring through index.ts', () => {
  it('serves the version, message table and error codes from the single entry', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MESSAGE_SPECS).toHaveLength(14);
    for (const code of PROTOCOL_ERROR_CODES) {
      const validated = validateServerMessage(createProtocolError(code));
      expect(validated.ok, code).toBe(true);
    }
  });

  it('keeps index.ts a re-export surface instead of a second DTO layer', () => {
    // The entry may only forward the three internal modules; a local DTO,
    // function or constant here would be a second source of the contract.
    expect(INDEX_SOURCE).not.toMatch(
      /^(?:export\s+)?(?:interface|class|function|const|let|var)\s/m,
    );
    const reExported = [...INDEX_SOURCE.matchAll(/from\s+'(\.\/[^']+)'/g)].map(
      (match) => match[1],
    );
    expect(reExported.length).toBeGreaterThan(0);
    expect(new Set(reExported)).toEqual(
      new Set(['./types', './adapter', './protocol']),
    );
  });

  it('plays, projects, replays and ends one match through the single entry', () => {
    const config: MinesweeperConfig = {
      rows: 5,
      cols: 5,
      mines: 3,
      firstClickSafe: true,
    };
    const match = engineAdapter.createMatch({
      matchId: 'wired',
      config,
      seed: SEED,
    });
    expect(match.seedHash).toBe(hashSeed(SEED));
    expect(match.state.board.flat().some((cell) => cell.mine)).toBe(false);

    const expected: ReplayDigest[] = [];
    const applied: ReplayAction[] = [];
    const apply = (kind: ActionKind, row: number, col: number): void => {
      const accepted = action(applied.length + 1, kind, row, col);
      engineAdapter.applyAction(match, accepted);
      engineAdapter.recordAction(match, accepted);
      applied.push(accepted);
      expected.push(matchDigest(match, accepted.seq, accepted.turnId));
    };
    apply('flag', 0, 0);
    apply('reveal', 2, 2);
    expect(applied.map((accepted) => accepted.kind)).toEqual(['flag', 'reveal']);

    // The redacted projection is a valid server-to-client snapshot message.
    const snapshot = engineAdapter.projectSnapshot(match);
    const snapshotMessage: SnapshotMessage = {
      type: 'snapshot',
      roomId: 'room-1',
      matchId: match.matchId,
      seq: applied.length,
      turnPlayerId: 'player-a',
      turnId: applied.length,
      deadlineAt: 5_000,
      matchDeadlineAt: 60_000,
      ...snapshot,
    };
    const validatedSnapshot = validateServerMessage(snapshotMessage);
    expect(validatedSnapshot.ok).toBe(true);
    if (!validatedSnapshot.ok) {
      throw new Error(validatedSnapshot.message);
    }
    expect(validatedSnapshot.value).toEqual(snapshotMessage);
    expect(JSON.stringify(validatedSnapshot.value)).not.toContain('"seed"');
    expect(JSON.stringify(validatedSnapshot.value)).not.toContain('"mine"');

    // Rebuilding from the recorded replay input reproduces the same digests.
    const record = engineAdapter.getReplayRecord(match);
    expect(record.actions).toEqual(applied);
    const replayed = replayMatch(record, expected);
    expect(replayed.digests).toEqual(expected);
    expect(replayed.digests).toHaveLength(applied.length);
    expect(replayed.finalDigest).toEqual(expected.at(-1));
    expect(engineAdapter.replay(record)).toEqual(expected);

    // The end payload is the only value that publishes the seed and all mines,
    // and it also travels through the same validator from the same entry.
    const end: EndMessage = {
      type: 'end',
      roomId: 'room-1',
      seq: applied.length + 1,
      ...endPayload(match, {
        reason: match.state.status === 'lost' ? 'mine-hit' : 'forfeit',
        winnerId: 'player-a',
        loserId: 'player-b',
        stats: statsFor(match, applied.length),
      }),
    };
    const validatedEnd = validateServerMessage(end);
    expect(validatedEnd.ok).toBe(true);
    if (!validatedEnd.ok) {
      throw new Error(validatedEnd.message);
    }
    expect(end.seed).toBe(SEED);
    expect(hashSeed(end.seed)).toBe(snapshot.seedHash);
    expect(end.finalSnapshot.flat().filter((cell) => cell.mine)).toHaveLength(
      config.mines,
    );
    expect(end.finalSnapshot.flat().every((cell) => 'mine' in cell)).toBe(true);
  });
});
