import { describe, expect, it } from 'vitest';
import {
  canMove,
  createEmptyBoard,
  createSeededRng,
  DIRECTIONS,
  Game2048Engine,
  type Board,
  type BoardCell,
  type Direction,
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

/** Full checkerboard with no equal neighbours and no empty cells. */
const STUCK_BOARD: Board = [
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 2],
];

/**
 * Full board with no equal horizontal neighbours; the only equal pair is the
 * vertical (0,0)/(1,0).
 */
const VERTICAL_ONLY_BOARD: Board = [
  [2, 4, 2, 4],
  [2, 8, 4, 8],
  [4, 2, 8, 2],
  [8, 4, 2, 4],
];

describe('board helpers', () => {
  it('creates an empty 4x4 board', () => {
    const board = createEmptyBoard();
    expect(board).toHaveLength(4);
    for (const row of board) {
      expect(row).toEqual([null, null, null, null]);
    }
  });

  it('detects whether any move is still possible', () => {
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

    expect(canMove(STUCK_BOARD)).toBe(false);
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

  it('places a starting tile in the randomly chosen cell, not just the first empty one', () => {
    // One spawn on an empty board: the index roll 0.5 chooses empty[8] = (2, 0),
    // and the value roll 0.5 is above the default 10% four chance, so it is a 2.
    const rolls = [0.5, 0.5];
    let index = 0;
    const engine = new Game2048Engine({
      initialTiles: 1,
      rng: () => rolls[index++] ?? 0.5,
    });

    expect(engine.board).toEqual([
      EMPTY_ROW,
      EMPTY_ROW,
      [2, null, null, null],
      EMPTY_ROW,
    ]);
  });

  it('places a custom number of starting tiles on an empty board', () => {
    const one = new Game2048Engine({ rng: createSeededRng(5), initialTiles: 1 });
    const three = new Game2048Engine({ rng: createSeededRng(5), initialTiles: 3 });

    expect(tileValues(one.board)).toHaveLength(1);
    expect(tileValues(three.board)).toHaveLength(3);
  });

  it('rejects invalid configuration instead of silently correcting it', () => {
    expect(() => new Game2048Engine({ fourChance: 1.5 })).toThrow(RangeError);
    expect(() => new Game2048Engine({ initialTiles: 0 })).toThrow(RangeError);
    expect(() => new Game2048Engine({ initialTiles: 17 })).toThrow(RangeError);
    expect(() => new Game2048Engine({ initialBoard: boardFrom([[2]]) })).toThrow(RangeError);
    expect(() =>
      new Game2048Engine({
        initialBoard: boardFrom([[3, null, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
      }),
    ).toThrow(RangeError);
    // 2 ** 53 - 1 is not a power of two even though Math.log2 rounds it to 53.
    expect(() =>
      new Game2048Engine({
        initialBoard: boardFrom([[2 ** 53 - 1, null, null, null], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
      }),
    ).toThrow(RangeError);
    expect(() =>
      new Game2048Engine({
        initialBoard: boardFrom([EMPTY_ROW, EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
      }),
    ).toThrow(RangeError);
  });
});

describe('invalid runtime input', () => {
  it('keeps spawning when the random source returns non-finite values', () => {
    const engine = new Game2048Engine({ rng: () => Number.NaN });

    expect(tileValues(engine.board)).toHaveLength(2);
    expect(engine.board[0]).toEqual([4, 4, null, null]);

    const result = engine.move('left');

    expect(result.moved).toBe(true);
    expect(result.spawned).not.toBeNull();
    expect(tileValues(engine.board)).toHaveLength(2);
  });

  it('rejects an unknown direction at runtime', () => {
    const engine = makeEngine();

    expect(() => engine.move('sideways' as Direction)).toThrow(RangeError);
    // Object.prototype names must not pass as directions.
    expect(() => engine.move('constructor' as Direction)).toThrow(RangeError);
  });

  it('rejects an unknown direction after game over instead of ignoring it', () => {
    const engine = makeEngine({ initialBoard: STUCK_BOARD });
    expect(engine.currentStatus).toBe('gameover');

    expect(() => engine.move('sideways' as Direction)).toThrow(RangeError);
    expect(() => engine.move('constructor' as Direction)).toThrow(RangeError);
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
      gameOver: false,
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

  it('moves a centred tile to the destination edge of every direction', () => {
    const destinations: Record<Direction, { row: number; col: number }> = {
      up: { row: 0, col: 1 },
      right: { row: 1, col: 3 },
      down: { row: 3, col: 1 },
      left: { row: 1, col: 0 },
    };

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
      const clean = withoutSpawned(engine.board, result.spawned);
      const tiles: Array<{ row: number; col: number; value: number }> = [];
      for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 4; col += 1) {
          const value = clean[row]?.[col];
          if (typeof value === 'number') {
            tiles.push({ row, col, value });
          }
        }
      }

      expect(result.direction).toBe(direction);
      expect(result.moved).toBe(true);
      expect(result.spawned).not.toBeNull();
      expect(tiles).toEqual([{ ...destinations[direction], value: 2 }]);
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
      if (engine.currentStatus === 'gameover') {
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

    expect(result).toMatchObject({
      moved: false,
      scoreGained: 0,
      spawned: null,
      gameOver: false,
    });
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

  it('spawns a 2 after a move when fourChance is 0', () => {
    const engine = new Game2048Engine({
      fourChance: 0,
      initialBoard: boardFrom([
        [null, 2, null, null],
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
      ]),
    });

    const result = engine.move('right');

    expect(result.spawned?.value).toBe(2);
  });
});

describe('game over', () => {
  it('is over on a full board without equal neighbours', () => {
    const engine = makeEngine({ initialBoard: STUCK_BOARD });

    expect(engine.currentStatus).toBe('gameover');
    expect(engine.state.status).toBe('gameover');

    const result = engine.move('left');
    expect(result).toMatchObject({
      moved: false,
      spawned: null,
      scoreGained: 0,
      gameOver: true,
    });
    expect(engine.state.board).toEqual(STUCK_BOARD);
  });

  it('stays playable while an empty cell exists', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, null, 4, 2],
      ]),
    });

    expect(engine.currentStatus).toBe('playing');
  });

  it('stays playable on a full board with one equal neighbour', () => {
    const engine = makeEngine({
      initialBoard: boardFrom([
        [2, 2, 4, 8],
        [4, 8, 16, 32],
        [8, 16, 32, 64],
        [16, 32, 64, 128],
      ]),
    });

    expect(engine.currentStatus).toBe('playing');
  });

  it('stays playable when the only equal neighbour is vertical', () => {
    // Dropping the `down` branch in canMove would wrongly report game over here.
    const engine = makeEngine({ initialBoard: VERTICAL_ONLY_BOARD });

    expect(canMove(VERTICAL_ONLY_BOARD)).toBe(true);
    expect(engine.currentStatus).toBe('playing');
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
    expect(engine.currentStatus).toBe('playing');

    const result = engine.move('left');

    expect(result).toMatchObject({ moved: true, scoreGained: 4, gameOver: true });
    expect(result.spawned).toEqual({ row: 0, col: 3, value: 4 });
    expect(engine.currentStatus).toBe('gameover');
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
    expect(engine.currentStatus).toBe('playing');
    expect(engine.board).toEqual([
      [2, 2, null, null],
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
    ]);
    expect(engine.move('left').scoreGained).toBe(4);
  });

  it('restores the injected starting board after a game over', () => {
    const initial = boardFrom([
      [2, 2, 8, 16],
      [8, 16, 4, 2],
      [16, 4, 2, 8],
      [4, 8, 16, 4],
    ]);
    const engine = new Game2048Engine({ fourChance: 1, initialBoard: initial });

    engine.move('left');
    expect(engine.currentStatus).toBe('gameover');
    expect(engine.score).toBe(4);

    engine.restart();

    expect(engine.score).toBe(0);
    expect(engine.currentStatus).toBe('playing');
    expect(engine.board).toEqual(initial);
    expect(engine.move('left').gameOver).toBe(true);
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

    expect(initial).toEqual([
      [2, 2, null, null],
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
    ]);
  });
});

/**
 * The screenshot script pins these two boards, seed 135 and ArrowLeft. The
 * expected boards below are what `npm run screenshots:2048` therefore draws;
 * changing the engine's spawn order without re-capturing the committed PNGs
 * fails here.
 */
describe('deterministic screenshot scenario', () => {
  const MERGE_BOARD: Board = [
    [2, 2, 4, 4],
    [8, 8, 16, 16],
    [null, null, null, null],
    [null, null, null, null],
  ];
  const STUCK_BOARD_WITH_MERGE: Board = [
    [2, 2, 16, 8],
    [8, 4, 2, 16],
    [4, 8, 16, 2],
    [16, 2, 4, 8],
  ];

  function screenshotEngine(board: Board): Game2048Engine {
    return new Game2048Engine({ rng: createSeededRng(135), initialBoard: board });
  }

  it('spawns the same playing tile on the same board, seed and direction', () => {
    const first = screenshotEngine(MERGE_BOARD);
    const second = screenshotEngine(MERGE_BOARD);

    const firstMove = first.move('left');
    const secondMove = second.move('left');

    expect(firstMove.spawned).toEqual({ row: 0, col: 3, value: 2 });
    expect(secondMove.spawned).toEqual(firstMove.spawned);
    expect(first.state).toEqual(second.state);
    expect(first.state.board).toEqual([
      [4, 8, null, 2],
      [16, 32, null, null],
      EMPTY_ROW,
      EMPTY_ROW,
    ]);
    expect(first.score).toBe(60);
    expect(first.currentStatus).toBe('playing');
  });

  it('reaches the same game-over board on the same seed and direction', () => {
    const first = screenshotEngine(STUCK_BOARD_WITH_MERGE);
    const second = screenshotEngine(STUCK_BOARD_WITH_MERGE);

    const firstMove = first.move('left');
    const secondMove = second.move('left');

    expect(firstMove.gameOver).toBe(true);
    expect(firstMove.spawned).toEqual({ row: 0, col: 3, value: 2 });
    expect(secondMove.spawned).toEqual(firstMove.spawned);
    expect(first.state).toEqual(second.state);
    expect(first.state.board).toEqual([
      [4, 16, 8, 2],
      [8, 4, 2, 16],
      [4, 8, 16, 2],
      [16, 2, 4, 8],
    ]);
    expect(first.score).toBe(4);
  });
});
