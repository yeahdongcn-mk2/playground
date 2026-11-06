import { describe, expect, it } from 'vitest';
import {
  canMove,
  createEmptyBoard,
  createSeededRng,
  DIRECTIONS,
  Game2048Engine,
  type Board,
  type BoardCell,
  type Game2048Options,
  type SpawnedTile,
} from './engine';

function boardFrom(rows: ReadonlyArray<ReadonlyArray<BoardCell>>): BoardCell[][] {
  return rows.map((row) => [...row]);
}

function makeEngine(options: Game2048Options = {}): Game2048Engine {
  return new Game2048Engine({ rng: createSeededRng(1), ...options });
}

function tileValues(board: Board): number[] {
  return board.flat().filter((value): value is number => value !== null);
}

function tileSum(board: Board): number {
  return tileValues(board).reduce((total, value) => total + value, 0);
}

/**
 * Remove the tile a valid move spawned so a test can assert the merged board.
 * Tests that care about the spawn itself read `result.spawned` directly.
 */
function withoutSpawned(board: Board, spawned: SpawnedTile | null): BoardCell[][] {
  const copy = board.map((row) => [...row]);
  if (spawned) {
    const row = copy[spawned.row];
    if (row) {
      row[spawned.col] = null;
    }
  }
  return copy;
}

const EMPTY_ROW: readonly BoardCell[] = [null, null, null, null];

describe('board helpers', () => {
  it('creates an empty 4x4 board', () => {
    const board = createEmptyBoard();
    expect(board).toHaveLength(4);
    for (const row of board) {
      expect(row).toEqual([null, null, null, null]);
    }
  });

  it('detects whether any move is still possible', () => {
    const stuck = boardFrom([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    const withGap = boardFrom([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, null, 4, 2],
    ]);
    const withNeighbours = boardFrom([
      [2, 2, 4, 8],
      [4, 2, 16, 2],
      [8, 4, 2, 4],
      [16, 2, 4, 2],
    ]);

    expect(canMove(stuck)).toBe(false);
    expect(canMove(withGap)).toBe(true);
    expect(canMove(withNeighbours)).toBe(true);
  });
});

describe('fresh game', () => {
  it('starts with two random tiles, score zero and playing status', () => {
    const engine = makeEngine();
    const state = engine.state;

    expect(state.size).toBe(4);
    expect(state.board).toHaveLength(4);
    expect(tileValues(state.board)).toHaveLength(2);
    for (const value of tileValues(state.board)) {
      expect([2, 4]).toContain(value);
    }
    expect(state.score).toBe(0);
    expect(state.status).toBe('playing');
  });

  it('uses the injected random source for the starting tiles', () => {
    // Each spawn consumes two rolls: cell index then tile value. Roll 0 picks
    // the first empty cell; 0.5 is above the 10% four chance, so both are 2s.
    const rolls = [0, 0.5, 0, 0.5];
    let index = 0;
    const engine = new Game2048Engine({ rng: () => rolls[index++] ?? 0.5 });

    expect(engine.board).toEqual([
      [2, 2, null, null],
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
    ]);
  });

  it('rejects invalid configuration instead of silently correcting it', () => {
    expect(() => new Game2048Engine({ fourChance: 1.5 })).toThrow(RangeError);
    expect(() => new Game2048Engine({ initialTiles: 17 })).toThrow(RangeError);
    expect(() => new Game2048Engine({ initialBoard: boardFrom([[2]]) })).toThrow(RangeError);
  });
});

describe('moving and merging', () => {
  it('moves left, compressing and merging equal tiles', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, null, 2, 4],
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
      ]),
    });

    const result = engine.move('left');

    expect(result).toMatchObject({
      direction: 'left',
      moved: true,
      scoreGained: 4,
    });
    expect(result.spawned).not.toBeNull();
    expect(result.mergedTiles).toEqual([{ row: 0, col: 0, value: 4 }]);
    expect(withoutSpawned(engine.board, result.spawned)[0]).toEqual([4, 4, null, null]);
  });

  it('moves right, compressing and merging equal tiles', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, null, 2, 4],
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
      ]),
    });

    const result = engine.move('right');

    expect(result).toMatchObject({ moved: true, scoreGained: 4 });
    expect(withoutSpawned(engine.board, result.spawned)[0]).toEqual([null, null, 4, 4]);
  });

  it('moves up, compressing and merging equal tiles', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, null, null, null],
        [null, null, null, null],
        [2, null, null, null],
        [4, null, null, null],
      ]),
    });

    const result = engine.move('up');
    const column = withoutSpawned(engine.board, result.spawned).map((row) => row[0]);

    expect(result).toMatchObject({ moved: true, scoreGained: 4 });
    expect(column).toEqual([4, 4, null, null]);
  });

  it('moves down, compressing and merging equal tiles', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, null, null, null],
        [null, null, null, null],
        [2, null, null, null],
        [4, null, null, null],
      ]),
    });

    const result = engine.move('down');
    const column = withoutSpawned(engine.board, result.spawned).map((row) => row[0]);

    expect(result).toMatchObject({ moved: true, scoreGained: 4 });
    expect(column).toEqual([null, null, 4, 4]);
  });

  it('accepts every direction for a tile in the middle', () => {
    for (const direction of DIRECTIONS) {
      const engine = makeEngine({
        initialBoard: boardFrom([
          EMPTY_ROW,
          [null, 2, null, null],
          EMPTY_ROW,
          EMPTY_ROW,
        ]),
      });

      const result = engine.move(direction);

      expect(result.direction).toBe(direction);
      expect(result.moved).toBe(true);
      expect(result.spawned).not.toBeNull();
    }
  });

  it('merges each tile at most once per move', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([[2, 2, 2, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
    });

    const result = engine.move('left');

    expect(result.scoreGained).toBe(8);
    expect(withoutSpawned(engine.board, result.spawned)[0]).toEqual([4, 4, null, null]);
  });

  it('does not merge a tile that was just created by a merge', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([[4, 4, 8, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
    });

    const result = engine.move('left');

    expect(result.scoreGained).toBe(8);
    expect(withoutSpawned(engine.board, result.spawned)[0]).toEqual([8, 8, null, null]);
  });

  it('scores every merge in one move and reports the merged destinations', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([[2, 2, 4, 4], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
    });

    const result = engine.move('left');

    expect(result.scoreGained).toBe(12);
    expect(result.mergedTiles).toEqual([
      { row: 0, col: 0, value: 4 },
      { row: 0, col: 1, value: 8 },
    ]);
    expect(withoutSpawned(engine.board, result.spawned)[0]).toEqual([4, 8, null, null]);
  });

  it('compresses gaps without merging or scoring', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [null, 2, null, 4],
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
      ]),
    });

    const result = engine.move('left');

    expect(result).toMatchObject({ moved: true, scoreGained: 0 });
    expect(result.mergedTiles).toEqual([]);
    expect(withoutSpawned(engine.board, result.spawned)[0]).toEqual([2, 4, null, null]);
  });

  it('preserves total tile value across random moves and adds only spawned tiles', () => {
    const engine = new Game2048Engine({ rng: createSeededRng(42) });

    for (let step = 0; step < 500; step += 1) {
      const before = tileSum(engine.board);
      const direction = DIRECTIONS[step % DIRECTIONS.length] ?? 'left';
      const result = engine.move(direction);
      const spawnedValue = result.moved ? (result.spawned?.value ?? 0) : 0;

      expect(tileSum(engine.board)).toBe(before + spawnedValue);
      for (const value of tileValues(engine.board)) {
        expect(Number.isInteger(Math.log2(value))).toBe(true);
      }
      if (engine.status === 'gameover') {
        break;
      }
    }
  });
});

describe('scoring', () => {
  it('accumulates merge points across moves', () => {
    // Spawn rolls: pick the first empty cell (0, 1) and a 4, so the next left
    // move merges the fresh 4 with the previous one.
    const rolls = [0, 0, 0, 0];
    let index = 0;
    const engine = makeEngine({
      initialBoard: boardFrom([[2, 2, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
      rng: () => rolls[index++] ?? 0,
    });

    const first = engine.move('left');
    expect(first.scoreGained).toBe(4);
    expect(engine.score).toBe(4);
    expect(engine.board[0]).toEqual([4, 4, null, null]);

    const second = engine.move('left');
    expect(second.scoreGained).toBe(8);
    expect(engine.score).toBe(12);
    expect(engine.board[0]).toEqual([8, 4, null, null]);
  });
});

describe('spawning', () => {
  it('does not spawn or score after a move that changes nothing', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, 4, 8, 16],
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
      ]),
    });
    const before = engine.state.board;

    const result = engine.move('left');

    expect(result).toMatchObject({ moved: false, scoreGained: 0, spawned: null });
    expect(result.mergedTiles).toEqual([]);
    expect(engine.state.board).toEqual(before);
  });

  it('spawns exactly one new tile after a valid move', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [null, 2, null, 4],
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
      ]),
    });

    const result = engine.move('left');

    expect(result.moved).toBe(true);
    expect(result.spawned).not.toBeNull();
    expect(tileValues(engine.board)).toHaveLength(3);
    const spawned = result.spawned;
    if (!spawned) {
      throw new Error('Expected a spawned tile.');
    }
    expect([2, 4]).toContain(spawned.value);
    expect(engine.board[spawned.row]?.[spawned.col]).toBe(spawned.value);
  });

  it('spawns mostly 2s but also 4s by default', () => {
    const engine = new Game2048Engine({ rng: createSeededRng(7) });
    let twos = 0;
    let fours = 0;

    for (let round = 0; round < 300; round += 1) {
      engine.restart();
      for (const value of tileValues(engine.board)) {
        if (value === 2) {
          twos += 1;
        } else if (value === 4) {
          fours += 1;
        } else {
          throw new Error(`Unexpected tile value: ${value}`);
        }
      }
    }

    expect(twos + fours).toBe(600);
    expect(twos).toBeGreaterThan(fours);
    expect(fours).toBeGreaterThan(0);
  });

  it('honours an injected four probability', () => {
    const alwaysFour = new Game2048Engine({
      rng: createSeededRng(3),
      fourChance: 1,
    });
    const alwaysTwo = new Game2048Engine({
      rng: createSeededRng(3),
      fourChance: 0,
    });

    expect(tileValues(alwaysFour.board).every((value) => value === 4)).toBe(true);
    expect(tileValues(alwaysTwo.board).every((value) => value === 2)).toBe(true);
  });
});

describe('game over', () => {
  it('is over on a full board without equal neighbours', () => {
    const stuck = boardFrom([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    const engine = makeEngine({ initialBoard: stuck });

    expect(engine.status).toBe('gameover');
    expect(engine.state.status).toBe('gameover');

    const result = engine.move('left');
    expect(result).toMatchObject({ moved: false, spawned: null, scoreGained: 0 });
    expect(engine.state.board).toEqual(stuck);
  });

  it('stays playable while an empty cell or an equal neighbour exists', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, null, 4, 2],
      ]),
    });

    expect(engine.status).toBe('playing');
  });

  it('ends the game when the post-move spawn fills the last cell', () => {
    const engine = new Game2048Engine({
      fourChance: 1,
      initialBoard: boardFrom([
        [2, 2, 8, 16],
        [8, 16, 4, 2],
        [16, 4, 2, 8],
        [4, 8, 16, 4],
      ]),
    });
    expect(engine.status).toBe('playing');

    const result = engine.move('left');

    expect(result).toMatchObject({ moved: true, scoreGained: 4 });
    expect(result.spawned).toEqual({ row: 0, col: 3, value: 4 });
    expect(engine.status).toBe('gameover');
  });
});

describe('restart', () => {
  it('resets score and tiles into a fresh playable game', () => {
    // Five spawns: two initial tiles, one after the merge and two after restart.
    const rolls = Array.from({ length: 5 }, () => [0, 0.5]).flat();
    let index = 0;
    const engine = new Game2048Engine({ rng: () => rolls[index++] ?? 0.5 });

    engine.move('left');
    expect(engine.score).toBe(4);

    engine.restart();

    expect(engine.score).toBe(0);
    expect(engine.status).toBe('playing');
    expect(engine.board).toEqual([
      [2, 2, null, null],
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
    ]);
    expect(engine.move('left').scoreGained).toBe(4);
  });
});

describe('snapshots', () => {
  it('returns defensive copies instead of its internal board', () => {
    const engine = makeEngine();
    const snapshot = engine.state.board;
    const expected = snapshot.map((row) => [...row]);

    const firstRow = snapshot[0] as BoardCell[] | undefined;
    if (firstRow) {
      firstRow[0] = 1024;
    }

    expect(engine.state.board).toEqual(expected);
  });

  it('does not mutate a caller-provided initial board', () => {
    const initial = boardFrom([
      [2, 2, null, null],
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
    ]);
    const engine = makeEngine({ initialBoard: initial });

    engine.move('left');

    expect(initial[0]).toEqual([2, 2, null, null]);
  });
});
