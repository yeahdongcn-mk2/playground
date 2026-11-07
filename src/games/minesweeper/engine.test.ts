import { describe, expect, it } from 'vitest';
import {
  COLS,
  createSeededRng,
  DEFAULT_MINESWEEPER_CONFIG,
  isInBounds,
  MAX_COLS,
  MAX_ROWS,
  MINE_COUNT,
  MIN_ROWS,
  MinesweeperEngine,
  ROWS,
  validateConfig,
  type Cell,
  type MinesweeperBoard,
  type MinesweeperCell,
  type MinesweeperConfig,
  type MinesweeperOptions,
} from './engine';

function makeEngine(options: MinesweeperOptions = {}): MinesweeperEngine {
  return new MinesweeperEngine({ rng: createSeededRng(1), ...options });
}

function boardCell(
  engine: MinesweeperEngine,
  row: number,
  col: number,
): MinesweeperCell {
  const cell = engine.state.board[row]?.[col];
  if (!cell) {
    throw new Error(`Expected a cell at (${row}, ${col}).`);
  }
  return cell;
}

function boardCells(engine: MinesweeperEngine): MinesweeperCell[] {
  return engine.state.board.flatMap((row) => [...row]);
}

function mineCells(engine: MinesweeperEngine): Cell[] {
  return boardCells(engine)
    .filter((cell) => cell.mine)
    .map(({ row, col }) => ({ row, col }));
}

function mineKeys(engine: MinesweeperEngine): string[] {
  return mineCells(engine)
    .map(({ row, col }) => `${row},${col}`)
    .sort();
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function neighbours(row: number, col: number): Cell[] {
  const cells: Cell[] = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      if (rowOffset === 0 && colOffset === 0) {
        continue;
      }
      const neighbourRow = row + rowOffset;
      const neighbourCol = col + colOffset;
      if (isInBounds(neighbourRow, neighbourCol)) {
        cells.push({ row: neighbourRow, col: neighbourCol });
      }
    }
  }
  return cells;
}

/** The clicked cell plus its eight neighbours, where mines must never sit. */
function safeZone(row: number, col: number): Cell[] {
  return [{ row, col }, ...neighbours(row, col)];
}

function safeZoneKeys(row: number, col: number): Set<string> {
  return new Set(safeZone(row, col).map((cell) => key(cell.row, cell.col)));
}

function visibleCells(engine: MinesweeperEngine): MinesweeperCell[] {
  return boardCells(engine).filter((cell) => cell.revealed);
}

function adjacentMatrix(engine: MinesweeperEngine): number[][] {
  return engine.state.board.map((row) => row.map((cell) => cell.adjacentMines));
}

/**
 * Nine mines wall off row 3 from the bottom half and one mine sits in the
 * bottom-right corner. Revealing (0,0) therefore floods exactly rows 0-3.
 */
const WALL_MINES: readonly Cell[] = [
  ...Array.from({ length: COLS }, (_, col) => ({ row: 4, col })),
  { row: 8, col: 8 },
];

/**
 * Eight mines ring the safe cell (4,4), so a flood from the top-left corner
 * leaves that cell hidden and the game cannot win in one move. The last two
 * mines sit in opposite corners.
 */
const RING_MINES: readonly Cell[] = [
  { row: 3, col: 3 },
  { row: 3, col: 4 },
  { row: 3, col: 5 },
  { row: 4, col: 3 },
  { row: 4, col: 5 },
  { row: 5, col: 3 },
  { row: 5, col: 4 },
  { row: 5, col: 5 },
  { row: 0, col: 8 },
  { row: 8, col: 0 },
];

describe('initial state', () => {
  it('starts as a ready 9x9 beginner board without planted mines', () => {
    const engine = makeEngine();
    const snapshot = engine.state;

    expect(snapshot.rows).toBe(ROWS);
    expect(snapshot.cols).toBe(COLS);
    expect(snapshot.mineCount).toBe(MINE_COUNT);
    expect(snapshot.flaggedCount).toBe(0);
    expect(snapshot.remainingMines).toBe(MINE_COUNT);
    expect(snapshot.status).toBe('ready');
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.explodedCell).toBeNull();
    expect(snapshot.board).toHaveLength(ROWS);
    for (const row of snapshot.board) {
      expect(row).toHaveLength(COLS);
    }

    // Mines are placed lazily on the first reveal.
    expect(mineCells(engine)).toEqual([]);
    expect(visibleCells(engine)).toEqual([]);
  });

  it('exposes every cell field a renderer needs', () => {
    const engine = makeEngine();
    const cell = boardCell(engine, 4, 4);

    expect(cell).toEqual({
      row: 4,
      col: 4,
      mine: false,
      revealed: false,
      flagged: false,
      adjacentMines: 0,
    });
  });
});

describe('first reveal', () => {
  it('plants ten mines and keeps every first click and its neighbours safe', () => {
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const engine = new MinesweeperEngine({
          rng: createSeededRng(row * COLS + col + 1),
        });
        const result = engine.reveal(row, col);

        expect(result.hitMine).toBe(false);
        expect(result.cell).toEqual({ row, col });
        expect(result.revealed.length).toBeGreaterThan(0);
        expect(boardCell(engine, row, col).revealed).toBe(true);
        expect(boardCell(engine, row, col).adjacentMines).toBe(0);

        const mines = mineCells(engine);
        expect(mines).toHaveLength(MINE_COUNT);
        const zone = safeZoneKeys(row, col);
        for (const mine of mines) {
          expect(zone.has(key(mine.row, mine.col))).toBe(false);
        }
      }
    }
  });

  it('relocates injected mines that fall inside the safe zone', () => {
    const injected: Cell[] = [
      { row: 3, col: 3 },
      { row: 3, col: 4 },
      { row: 3, col: 5 },
      { row: 4, col: 3 },
      { row: 4, col: 4 },
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 0, col: 3 },
      { row: 0, col: 4 },
    ];
    const engine = makeEngine({ initialMines: injected });
    const result = engine.reveal(4, 4);

    expect(result.hitMine).toBe(false);
    expect(mineCells(engine)).toHaveLength(MINE_COUNT);
    const zone = safeZoneKeys(4, 4);
    for (const mine of mineCells(engine)) {
      expect(zone.has(key(mine.row, mine.col))).toBe(false);
    }
  });

  it('keeps a safe injected layout exactly', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    engine.reveal(0, 0);

    expect(mineKeys(engine)).toEqual(
      RING_MINES.map((cell) => key(cell.row, cell.col)).sort(),
    );
  });

  it('does not plant mines or start the clock when the click is a no-op', () => {
    const engine = makeEngine();

    expect(engine.toggleFlag(0, 0).changed).toBe(true);
    expect(engine.reveal(0, 0).revealed).toEqual([]);
    expect(engine.state.status).toBe('ready');
    expect(mineCells(engine)).toEqual([]);
    expect(engine.tick(500)).toBe(0);

    engine.toggleFlag(0, 0);
    engine.reveal(0, 0);
    expect(engine.state.status).toBe('playing');
    expect(mineCells(engine)).toHaveLength(MINE_COUNT);
  });

  it('produces the same board for the same seed and click', () => {
    const first = makeEngine({ rng: createSeededRng(42) });
    const second = makeEngine({ rng: createSeededRng(42) });

    first.reveal(2, 6);
    second.reveal(2, 6);

    expect(mineKeys(first)).toEqual(mineKeys(second));
    expect(first.state).toEqual(second.state);
  });

  it('draws the mine layout from the injected random source', () => {
    let calls = 0;
    const engine = new MinesweeperEngine({
      rng: () => {
        calls += 1;
        return 0;
      },
    });
    // Lazy placement: construction and flagging must not consume randomness.
    expect(calls).toBe(0);
    engine.toggleFlag(0, 0);
    expect(calls).toBe(0);

    engine.reveal(4, 4);
    expect(calls).toBe(MINE_COUNT);

    const low = new MinesweeperEngine({ rng: () => 0 });
    const high = new MinesweeperEngine({ rng: () => 1 - Number.EPSILON });
    low.reveal(4, 4);
    high.reveal(4, 4);
    expect(mineKeys(low)).not.toEqual(mineKeys(high));
  });

  it('clamps out-of-range and non-finite random values', () => {
    const engines = {
      // `roll()` maps a broken source to 0.5.
      broken: new MinesweeperEngine({ rng: () => Number.NaN }),
      half: new MinesweeperEngine({ rng: () => 0.5 }),
      // `roll()` clamps negatives to 0 and values above 1 to just below 1.
      negative: new MinesweeperEngine({ rng: () => -5 }),
      zero: new MinesweeperEngine({ rng: () => 0 }),
      aboveOne: new MinesweeperEngine({ rng: () => 5 }),
      belowOne: new MinesweeperEngine({ rng: () => 1 - Number.EPSILON }),
    };
    for (const engine of Object.values(engines)) {
      expect(engine.reveal(4, 4).hitMine).toBe(false);
      expect(mineCells(engine)).toHaveLength(MINE_COUNT);
    }

    expect(mineKeys(engines.broken)).toEqual(mineKeys(engines.half));
    expect(mineKeys(engines.negative)).toEqual(mineKeys(engines.zero));
    expect(mineKeys(engines.aboveOne)).toEqual(mineKeys(engines.belowOne));
  });
});

describe('numbers and flood fill', () => {
  it('counts adjacent mines on revealed number cells', () => {
    const engine = makeEngine({ initialMines: WALL_MINES });
    engine.reveal(0, 0);

    expect(boardCell(engine, 2, 0).adjacentMines).toBe(0);
    expect(boardCell(engine, 3, 0).adjacentMines).toBe(2);
    expect(boardCell(engine, 3, 4).adjacentMines).toBe(3);
    expect(boardCell(engine, 3, 8).adjacentMines).toBe(2);
  });

  it('reveals every connected blank cell and the numbers bordering it', () => {
    const engine = makeEngine({ initialMines: WALL_MINES });
    const result = engine.reveal(0, 0);

    expect(result.status).toBe('playing');
    expect(result.revealed).toHaveLength(36);
    for (const cell of boardCells(engine)) {
      const expected = cell.row < 4;
      expect(cell.revealed).toBe(expected);
    }
    expect(boardCell(engine, 3, 4).revealed).toBe(true);
    expect(boardCell(engine, 4, 4).mine).toBe(true);
    expect(boardCell(engine, 4, 4).revealed).toBe(false);
  });

  it('reveals only the numbered cell when the cascade stops there', () => {
    const engine = makeEngine({ initialMines: WALL_MINES });
    engine.reveal(0, 0);

    const result = engine.reveal(8, 7);

    expect(result.hitMine).toBe(false);
    expect(result.revealed).toEqual([{ row: 8, col: 7 }]);
    expect(boardCell(engine, 8, 7)).toMatchObject({ revealed: true, adjacentMines: 1 });
    // Numbered cells do not cascade into their hidden neighbours.
    expect(boardCell(engine, 7, 7)).toMatchObject({ revealed: false });
    expect(boardCell(engine, 8, 6)).toMatchObject({ revealed: false });
  });

  it('does not flood through flagged cells', () => {
    const engine = makeEngine({ initialMines: WALL_MINES });
    engine.toggleFlag(3, 0);
    const result = engine.reveal(0, 0);

    expect(result.revealed).toHaveLength(35);
    expect(boardCell(engine, 3, 0)).toMatchObject({
      revealed: false,
      flagged: true,
      adjacentMines: 2,
    });
    expect(boardCell(engine, 3, 1).revealed).toBe(true);
  });
});

describe('flags', () => {
  it('toggles flags, protects cells and tracks the remaining mine count', () => {
    const engine = makeEngine();

    const flagged = engine.toggleFlag(2, 3);
    expect(flagged).toMatchObject({
      changed: true,
      flagged: true,
      remainingMines: MINE_COUNT - 1,
      status: 'ready',
    });
    expect(boardCell(engine, 2, 3).flagged).toBe(true);
    expect(engine.remainingMines).toBe(MINE_COUNT - 1);

    const unflagged = engine.toggleFlag(2, 3);
    expect(unflagged).toMatchObject({
      changed: true,
      flagged: false,
      remainingMines: MINE_COUNT,
    });
    expect(boardCell(engine, 2, 3).flagged).toBe(false);
  });

  it('counts flags beyond the mine count, keeping the remaining count negative', () => {
    const engine = makeEngine();
    for (let index = 0; index < 11; index += 1) {
      engine.toggleFlag(Math.floor(index / COLS), index % COLS);
    }

    expect(engine.state.flaggedCount).toBe(11);
    expect(engine.remainingMines).toBe(-1);
    expect(engine.toggleFlag(0, 0).remainingMines).toBe(0);
  });

  it('protects a flagged mine from being revealed', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    engine.reveal(0, 0);
    engine.toggleFlag(3, 3);

    const result = engine.reveal(3, 3);

    expect(result.hitMine).toBe(false);
    expect(result.revealed).toEqual([]);
    expect(engine.state.status).toBe('playing');
    expect(boardCell(engine, 3, 3)).toMatchObject({ mine: true, revealed: false, flagged: true });
  });

  it('rejects flags on revealed cells and after the game ends', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    engine.reveal(0, 0);

    expect(engine.toggleFlag(0, 0).changed).toBe(false);
    expect(boardCell(engine, 0, 0).flagged).toBe(false);

    engine.reveal(3, 3);
    expect(engine.state.status).toBe('lost');
    expect(engine.toggleFlag(8, 8).changed).toBe(false);
    expect(engine.toggleFlag(8, 8).flagged).toBe(false);
  });
});

describe('losing', () => {
  it('ends the game, marks the exploded cell and freezes the clock', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    engine.reveal(0, 0);
    expect(engine.state.status).toBe('playing');
    expect(engine.tick(1500)).toBe(1500);

    const result = engine.reveal(3, 3);

    expect(result.hitMine).toBe(true);
    expect(result.status).toBe('lost');
    expect(result.revealed).toEqual([{ row: 3, col: 3 }]);
    expect(engine.state.status).toBe('lost');
    expect(engine.state.explodedCell).toEqual({ row: 3, col: 3 });
    expect(boardCell(engine, 3, 3)).toMatchObject({
      mine: true,
      revealed: true,
      adjacentMines: 0,
    });

    expect(engine.tick(10_000)).toBe(1500);
    expect(engine.reveal(0, 0).revealed).toEqual([]);
    expect(engine.state.status).toBe('lost');
  });
});

describe('winning', () => {
  it('wins when every non-mine cell is revealed and then ignores input', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    engine.reveal(0, 0);
    engine.tick(1000);

    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const cell = boardCell(engine, row, col);
        if (!cell.mine && !cell.revealed) {
          engine.reveal(row, col);
        }
      }
    }

    expect(engine.state.status).toBe('won');
    const safeCells = boardCells(engine).filter((cell) => !cell.mine);
    expect(safeCells).toHaveLength(ROWS * COLS - MINE_COUNT);
    expect(safeCells.every((cell) => cell.revealed)).toBe(true);
    expect(engine.state.explodedCell).toBeNull();
    expect(engine.tick(500)).toBe(1000);
    expect(engine.reveal(3, 3).revealed).toEqual([]);
    expect(engine.toggleFlag(8, 0).changed).toBe(false);
  });

  it('does not win while a safe cell is still flagged and hidden', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    expect(engine.toggleFlag(8, 8).changed).toBe(true);
    engine.reveal(0, 0);

    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const cell = boardCell(engine, row, col);
        if (!cell.mine && !cell.flagged && !cell.revealed) {
          engine.reveal(row, col);
        }
      }
    }

    // Every other safe cell is open, but the flag still hides one of them.
    expect(engine.state.status).toBe('playing');
    expect(boardCell(engine, 8, 8)).toMatchObject({ revealed: false, flagged: true });

    engine.toggleFlag(8, 8);
    expect(engine.reveal(8, 8).status).toBe('won');
    expect(engine.state.status).toBe('won');
  });
});

describe('clock', () => {
  it('only runs while playing and resets on restart', () => {
    const engine = makeEngine({ initialMines: WALL_MINES });

    expect(engine.tick(1000)).toBe(0);
    engine.reveal(0, 0);
    expect(engine.tick(250)).toBe(250);
    expect(engine.tick(750)).toBe(1000);
    expect(engine.state.elapsedMs).toBe(1000);

    engine.restart();

    expect(engine.state.status).toBe('ready');
    expect(engine.state.elapsedMs).toBe(0);
    expect(engine.state.flaggedCount).toBe(0);
    expect(engine.state.remainingMines).toBe(MINE_COUNT);
    expect(engine.state.explodedCell).toBeNull();
    expect(mineCells(engine)).toEqual([]);

    engine.reveal(0, 0);
    expect(engine.tick(400)).toBe(400);
  });

  it('reports status and clock through the direct getters', () => {
    const engine = makeEngine({ initialMines: WALL_MINES });
    expect(engine.currentStatus).toBe('ready');
    expect(engine.elapsedMs).toBe(0);

    engine.reveal(0, 0);
    engine.tick(1250);
    expect(engine.currentStatus).toBe('playing');
    expect(engine.elapsedMs).toBe(1250);

    engine.reveal(8, 8);
    expect(engine.currentStatus).toBe('lost');
    expect(engine.elapsedMs).toBe(1250);

    engine.restart();
    expect(engine.currentStatus).toBe('ready');
    expect(engine.elapsedMs).toBe(0);
  });

  it('does not start when flagging', () => {
    const engine = makeEngine();
    engine.toggleFlag(4, 4);
    engine.tick(750);
    expect(engine.state.elapsedMs).toBe(0);
    expect(engine.state.status).toBe('ready');
  });

  it('rejects invalid deltas', () => {
    const engine = makeEngine();
    expect(() => engine.tick(-1)).toThrow(RangeError);
    expect(() => engine.tick(Number.NaN)).toThrow(RangeError);
    expect(() => engine.tick(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('restart', () => {
  it('restores a fresh board after a loss', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    // Flag a hidden safe cell before the first reveal: flooding from (0, 0)
    // reveals (8, 8), so flagging it afterwards would be a silent no-op and
    // the reset assertions below could not fail.
    expect(engine.toggleFlag(8, 8)).toMatchObject({ changed: true, flagged: true });
    engine.reveal(0, 0);
    expect(engine.state.flaggedCount).toBe(1);
    expect(engine.state.remainingMines).toBe(MINE_COUNT - 1);

    engine.tick(2500);
    engine.reveal(3, 3);
    expect(engine.state.status).toBe('lost');

    engine.restart();

    expect(engine.state).toMatchObject({
      status: 'ready',
      elapsedMs: 0,
      flaggedCount: 0,
      remainingMines: MINE_COUNT,
      explodedCell: null,
    });
    expect(mineCells(engine)).toEqual([]);
    expect(visibleCells(engine)).toEqual([]);

    engine.reveal(0, 0);
    expect(engine.state.status).toBe('playing');
    expect(mineKeys(engine)).toEqual(
      RING_MINES.map((cell) => key(cell.row, cell.col)).sort(),
    );
  });
});

describe('snapshots', () => {
  it('returns defensive copies instead of internal state', () => {
    const engine = makeEngine();
    engine.toggleFlag(0, 0);
    const snapshot = engine.state;
    const original = snapshot.board.map((row) => row.map((cell) => ({ ...cell })));

    const mutableRow = snapshot.board[0] as unknown as MinesweeperCell[] | undefined;
    if (mutableRow) {
      mutableRow[1] = {
        row: 0,
        col: 1,
        mine: true,
        revealed: true,
        flagged: true,
        adjacentMines: 8,
      };
    }

    expect(engine.state.board).toEqual(original);
    expect(boardCell(engine, 0, 1)).toMatchObject({ mine: false, revealed: false });
  });

  it('copies the exploded cell so callers cannot rewrite the loss', () => {
    const engine = makeEngine({ initialMines: RING_MINES });
    engine.reveal(0, 0);
    engine.reveal(3, 3);

    const exploded = engine.state.explodedCell as unknown as
      | { row: number; col: number }
      | null;
    if (exploded) {
      exploded.row = 8;
      exploded.col = 8;
    }

    expect(engine.state.explodedCell).toEqual({ row: 3, col: 3 });
  });

  it('exposes the board through the exported board type', () => {
    const engine = makeEngine();
    const board: MinesweeperBoard = engine.state.board;

    expect(board).toHaveLength(ROWS);
    expect(board[0]).toHaveLength(COLS);
  });
});

describe('validation', () => {
  it('rejects out-of-bounds and fractional coordinates', () => {
    const engine = makeEngine();
    expect(() => engine.reveal(-1, 0)).toThrow(RangeError);
    expect(() => engine.reveal(ROWS, 0)).toThrow(RangeError);
    expect(() => engine.reveal(0, -1)).toThrow(RangeError);
    expect(() => engine.reveal(0, COLS)).toThrow(RangeError);
    expect(() => engine.reveal(1.5, 0)).toThrow(RangeError);
    expect(() => engine.toggleFlag(0, COLS)).toThrow(RangeError);
  });

  it('validates injected mine layouts', () => {
    expect(
      () => new MinesweeperEngine({ initialMines: RING_MINES.slice(0, 9) }),
    ).toThrow(RangeError);
    expect(
      () => new MinesweeperEngine({ initialMines: [RING_MINES[0]!, ...RING_MINES.slice(0, 9)] }),
    ).toThrow(RangeError);
    expect(
      () =>
        new MinesweeperEngine({
          initialMines: [...RING_MINES.slice(0, 9), { row: ROWS, col: 0 }],
        }),
    ).toThrow(RangeError);
  });

  it('does not mutate caller-provided mine layouts', () => {
    const safeLayout: Cell[] = RING_MINES.map((cell) => ({ ...cell }));
    const safeCopy = safeLayout.map((cell) => ({ ...cell }));
    const safeEngine = makeEngine({ initialMines: safeLayout });
    safeEngine.reveal(0, 0);
    expect(safeLayout).toEqual(safeCopy);

    // Every injected mine sits inside the first-click safe zone, so all of them
    // are relocated; the caller's array must stay untouched.
    const overlapping: Cell[] = [
      ...RING_MINES.slice(0, 6),
      { row: 4, col: 4 },
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 1 },
    ];
    const overlappingCopy = overlapping.map((cell) => ({ ...cell }));
    const relocated = makeEngine({ initialMines: overlapping });
    relocated.reveal(4, 4);

    expect(mineCells(relocated)).toHaveLength(MINE_COUNT);
    expect(overlapping).toEqual(overlappingCopy);
  });

  it('accepts boundary coordinates', () => {
    expect(isInBounds(0, 0)).toBe(true);
    expect(isInBounds(ROWS - 1, COLS - 1)).toBe(true);
    expect(isInBounds(ROWS, 0)).toBe(false);
    expect(isInBounds(-1, 0)).toBe(false);
    expect(isInBounds(0, 1.5)).toBe(false);
  });
});

/**
 * Golden board captured from the pre-parameterisation beginner engine with
 * seed 20241107 and the first reveal at (4,4). These exact mine positions and
 * adjacent numbers must survive the switch to configurable board sizes.
 */
const GOLDEN_RANDOM_MINE_KEYS = [
  '0,2',
  '0,3',
  '1,3',
  '1,5',
  '3,0',
  '4,2',
  '4,6',
  '6,1',
  '7,3',
  '8,7',
];

const GOLDEN_RANDOM_ADJACENT = [
  [0, 1, 0, 0, 3, 1, 1, 0, 0],
  [0, 1, 3, 0, 3, 0, 1, 0, 0],
  [1, 1, 1, 1, 2, 1, 1, 0, 0],
  [0, 2, 1, 1, 0, 1, 1, 1, 0],
  [1, 2, 0, 1, 0, 1, 0, 1, 0],
  [1, 2, 2, 1, 0, 1, 1, 1, 0],
  [1, 0, 2, 1, 1, 0, 0, 0, 0],
  [1, 1, 2, 0, 1, 0, 1, 1, 1],
  [0, 0, 1, 1, 1, 0, 1, 0, 1],
];

/**
 * Golden board for the injected WALL_MINES layout with the same seed and a
 * first reveal at (0,0); relocation must keep the injected mines in place.
 */
const GOLDEN_INJECTED_MINE_KEYS = [
  '4,0',
  '4,1',
  '4,2',
  '4,3',
  '4,4',
  '4,5',
  '4,6',
  '4,7',
  '4,8',
  '8,8',
];

const GOLDEN_INJECTED_ADJACENT = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 3, 3, 3, 3, 3, 3, 3, 2],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 3, 3, 3, 3, 3, 3, 3, 2],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 1, 0],
];

describe('default beginner golden boards', () => {
  it('keeps the exact seeded mine layout and adjacent numbers', () => {
    const engine = new MinesweeperEngine({ rng: createSeededRng(20241107) });
    engine.reveal(4, 4);

    expect(mineKeys(engine)).toEqual(GOLDEN_RANDOM_MINE_KEYS);
    expect(adjacentMatrix(engine)).toEqual(GOLDEN_RANDOM_ADJACENT);
    expect(engine.state).toMatchObject({
      rows: 9,
      cols: 9,
      mineCount: 10,
      status: 'playing',
      explodedCell: null,
    });
  });

  it('keeps the exact injected layout and adjacent numbers', () => {
    const engine = new MinesweeperEngine({
      rng: createSeededRng(20241107),
      initialMines: WALL_MINES,
    });
    engine.reveal(0, 0);

    expect(mineKeys(engine)).toEqual(GOLDEN_INJECTED_MINE_KEYS);
    expect(adjacentMatrix(engine)).toEqual(GOLDEN_INJECTED_ADJACENT);
    expect(engine.state.status).toBe('playing');
  });
});

const BEGINNER_CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

const INTERMEDIATE_CONFIG: MinesweeperConfig = {
  rows: 16,
  cols: 16,
  mines: 40,
  firstClickSafe: true,
};

const EXPERT_CONFIG: MinesweeperConfig = {
  rows: 16,
  cols: 30,
  mines: 99,
  firstClickSafe: true,
};

const PRESET_CONFIGS: ReadonlyArray<readonly [string, MinesweeperConfig]> = [
  ['beginner', BEGINNER_CONFIG],
  ['intermediate', INTERMEDIATE_CONFIG],
  ['expert', EXPERT_CONFIG],
];

function configuredCells(config: MinesweeperConfig): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < config.rows; row += 1) {
    for (let col = 0; col < config.cols; col += 1) {
      cells.push({ row, col });
    }
  }
  return cells;
}

/** The clicked cell plus its neighbours, clipped to the configured board. */
function configuredSafeZoneKeys(
  config: MinesweeperConfig,
  row: number,
  col: number,
): Set<string> {
  const keys = new Set<string>([key(row, col)]);
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      if (rowOffset === 0 && colOffset === 0) {
        continue;
      }
      const neighbourRow = row + rowOffset;
      const neighbourCol = col + colOffset;
      if (
        neighbourRow >= 0 &&
        neighbourRow < config.rows &&
        neighbourCol >= 0 &&
        neighbourCol < config.cols
      ) {
        keys.add(key(neighbourRow, neighbourCol));
      }
    }
  }
  return keys;
}

describe('configured boards', () => {
  it('exports the classic beginner setup as the default config', () => {
    expect(DEFAULT_MINESWEEPER_CONFIG).toEqual({
      rows: 9,
      cols: 9,
      mines: 10,
      firstClickSafe: true,
    });
    expect(Object.isFrozen(DEFAULT_MINESWEEPER_CONFIG)).toBe(true);
    expect([ROWS, COLS, MINE_COUNT]).toEqual([9, 9, 10]);
  });

  it('keeps isInBounds on the default beginner board', () => {
    expect(isInBounds(0, 0)).toBe(true);
    expect(isInBounds(ROWS - 1, COLS - 1)).toBe(true);
    expect(isInBounds(15, 15)).toBe(false);
    expect(isInBounds(MAX_ROWS - 1, 0)).toBe(false);
    expect(isInBounds(0, -1)).toBe(false);
  });

  it('treats an omitted config exactly like the default config', () => {
    const implicit = new MinesweeperEngine({ rng: createSeededRng(20241107) });
    const explicit = new MinesweeperEngine({
      config: DEFAULT_MINESWEEPER_CONFIG,
      rng: createSeededRng(20241107),
    });

    implicit.reveal(4, 4);
    explicit.reveal(4, 4);

    expect(explicit.state).toEqual(implicit.state);
  });

  for (const [label, config] of PRESET_CONFIGS) {
    it(`builds the ${label} board from config`, () => {
      const engine = makeEngine({ config });
      const snapshot = engine.state;

      expect(snapshot).toMatchObject({
        rows: config.rows,
        cols: config.cols,
        mineCount: config.mines,
        flaggedCount: 0,
        remainingMines: config.mines,
        status: 'ready',
        elapsedMs: 0,
        explodedCell: null,
      });
      expect(snapshot.board).toHaveLength(config.rows);
      for (const row of snapshot.board) {
        expect(row).toHaveLength(config.cols);
      }

      expect(engine.toggleFlag(0, 0).changed).toBe(true);
      expect(engine.remainingMines).toBe(config.mines - 1);
      expect(engine.toggleFlag(0, 0).changed).toBe(true);

      const result = engine.reveal(0, 0);
      expect(result.hitMine).toBe(false);
      expect(['playing', 'won']).toContain(engine.state.status);
      expect(engine.state.rows).toBe(config.rows);
      expect(engine.state.cols).toBe(config.cols);
      expect(mineCells(engine)).toHaveLength(config.mines);
      const zone = configuredSafeZoneKeys(config, 0, 0);
      for (const mine of mineCells(engine)) {
        expect(zone.has(key(mine.row, mine.col))).toBe(false);
      }

      expect(() => engine.reveal(config.rows, 0)).toThrow(RangeError);
      expect(() => engine.reveal(0, config.cols)).toThrow(RangeError);
      expect(() => engine.reveal(-1, 0)).toThrow(RangeError);
      expect(() => engine.reveal(0, -1)).toThrow(RangeError);
      expect(() => engine.toggleFlag(config.rows - 1, config.cols)).toThrow(RangeError);

      engine.restart();
      expect(engine.state).toMatchObject({
        rows: config.rows,
        cols: config.cols,
        mineCount: config.mines,
        status: 'ready',
        elapsedMs: 0,
        explodedCell: null,
      });
      expect(engine.state.board).toHaveLength(config.rows);
    });
  }
});

describe('first-click safety policy', () => {
  it('keeps an injected layout exactly when firstClickSafe is false', () => {
    const layout: Cell[] = [{ row: 0, col: 1 }, ...RING_MINES.slice(1)];
    const engine = makeEngine({
      config: { ...BEGINNER_CONFIG, firstClickSafe: false },
      initialMines: layout,
    });

    const result = engine.reveal(0, 0);

    expect(result.hitMine).toBe(false);
    expect(mineKeys(engine)).toEqual(
      layout.map((cell) => key(cell.row, cell.col)).sort(),
    );
    expect(boardCell(engine, 0, 1).mine).toBe(true);
  });

  it('explodes on the clicked cell when the layout puts a mine there', () => {
    const layout: Cell[] = [{ row: 4, col: 4 }, ...RING_MINES.slice(0, 9)];
    const engine = makeEngine({
      config: { ...BEGINNER_CONFIG, firstClickSafe: false },
      initialMines: layout,
    });

    const result = engine.reveal(4, 4);

    expect(result.hitMine).toBe(true);
    expect(engine.state.status).toBe('lost');
    expect(engine.state.explodedCell).toEqual({ row: 4, col: 4 });
    expect(mineKeys(engine)).toEqual(
      layout.map((cell) => key(cell.row, cell.col)).sort(),
    );
  });

  it('may plant a mine under the first click when safety is off', () => {
    const engine = new MinesweeperEngine({
      config: { ...BEGINNER_CONFIG, firstClickSafe: false },
      rng: () => 0,
    });

    const result = engine.reveal(0, 0);

    expect(result.hitMine).toBe(true);
    expect(boardCell(engine, 0, 0).mine).toBe(true);
    expect(mineCells(engine)).toHaveLength(MINE_COUNT);
  });

  it('relocates injected safe-zone mines when safety is on', () => {
    // Nine of the ten mines sit in the safe zone of (4,4); one stays outside.
    const layout: Cell[] = [...RING_MINES.slice(0, 9), { row: 4, col: 4 }];
    const engine = makeEngine({ config: BEGINNER_CONFIG, initialMines: layout });

    const result = engine.reveal(4, 4);

    expect(result.hitMine).toBe(false);
    expect(mineCells(engine)).toHaveLength(MINE_COUNT);
    const zone = configuredSafeZoneKeys(BEGINNER_CONFIG, 4, 4);
    for (const mine of mineCells(engine)) {
      expect(zone.has(key(mine.row, mine.col))).toBe(false);
    }
  });

  it('clips the safe zone to the edges of a wide configured board', () => {
    const click = { row: EXPERT_CONFIG.rows - 1, col: EXPERT_CONFIG.cols - 1 };
    const zone = configuredSafeZoneKeys(EXPERT_CONFIG, click.row, click.col);
    const zoneMines: Cell[] = [
      { row: click.row, col: click.col - 1 },
      { row: click.row - 1, col: click.col - 1 },
      { row: click.row - 1, col: click.col },
    ];
    const outside = configuredCells(EXPERT_CONFIG).filter(
      (cell) => !zone.has(key(cell.row, cell.col)),
    );
    const layout: Cell[] = [
      ...outside.slice(0, EXPERT_CONFIG.mines - zoneMines.length),
      ...zoneMines,
    ];
    const engine = makeEngine({ config: EXPERT_CONFIG, initialMines: layout });

    const result = engine.reveal(click.row, click.col);

    expect(result.hitMine).toBe(false);
    expect(mineCells(engine)).toHaveLength(EXPERT_CONFIG.mines);
    for (const mine of mineCells(engine)) {
      expect(zone.has(key(mine.row, mine.col))).toBe(false);
    }
  });
});

describe('config validation', () => {
  it('accepts the three classic presets and returns a frozen copy', () => {
    for (const [, config] of PRESET_CONFIGS) {
      const validated = validateConfig(config);

      expect(validated).toEqual(config);
      expect(validated).not.toBe(config);
      expect(Object.isFrozen(validated)).toBe(true);
    }
  });

  it('accepts the largest safe-first mine count and skips that cap when safety is off', () => {
    expect(validateConfig({ rows: 5, cols: 5, mines: 16, firstClickSafe: true })).toEqual({
      rows: 5,
      cols: 5,
      mines: 16,
      firstClickSafe: true,
    });
    expect(validateConfig({ rows: 5, cols: 5, mines: 20, firstClickSafe: false })).toEqual({
      rows: 5,
      cols: 5,
      mines: 20,
      firstClickSafe: false,
    });
    expect(validateConfig({ ...BEGINNER_CONFIG, mines: 72 })).toMatchObject({ mines: 72 });
  });

  it('rejects unplayable values with a field and value in the message', () => {
    const cases: ReadonlyArray<readonly [MinesweeperConfig, RegExp]> = [
      [{ ...BEGINNER_CONFIG, rows: 9.5 }, /rows must be an integer between 5 and 30, received 9\.5\./],
      [{ ...BEGINNER_CONFIG, rows: 0 }, /rows must be an integer between 5 and 30, received 0\./],
      [{ ...BEGINNER_CONFIG, rows: -3 }, /rows must be an integer between 5 and 30, received -3\./],
      [{ ...BEGINNER_CONFIG, rows: MIN_ROWS - 1 }, /rows must be an integer between 5 and 30, received 4\./],
      [{ ...BEGINNER_CONFIG, rows: MAX_ROWS + 1 }, /rows must be an integer between 5 and 30, received 31\./],
      [{ ...BEGINNER_CONFIG, cols: 4.5 }, /cols must be an integer between 5 and 30, received 4\.5\./],
      [{ ...BEGINNER_CONFIG, cols: 0 }, /cols must be an integer between 5 and 30, received 0\./],
      [{ ...BEGINNER_CONFIG, cols: MAX_COLS + 1 }, /cols must be an integer between 5 and 30, received 31\./],
      [{ ...BEGINNER_CONFIG, mines: 2.5 }, /mines must be a positive integer, received 2\.5\./],
      [{ ...BEGINNER_CONFIG, mines: 0 }, /mines must be a positive integer, received 0\./],
      [{ ...BEGINNER_CONFIG, mines: -1 }, /mines must be a positive integer, received -1\./],
      [
        { ...BEGINNER_CONFIG, mines: ROWS * COLS },
        /mines must be smaller than the 81 board cells, received 81\./,
      ],
      [
        { ...BEGINNER_CONFIG, mines: ROWS * COLS + 1 },
        /mines must be smaller than the 81 board cells, received 82\./,
      ],
      [
        { ...BEGINNER_CONFIG, mines: 73 },
        /mines must fit outside the 9-cell first-click safe zone \(at most 72\), received 73\./,
      ],
      [
        { rows: 5, cols: 5, mines: 17, firstClickSafe: true },
        /mines must fit outside the 9-cell first-click safe zone \(at most 16\), received 17\./,
      ],
      [
        { ...BEGINNER_CONFIG, firstClickSafe: 'yes' as unknown as boolean },
        /firstClickSafe must be a boolean, received "yes"\./,
      ],
    ];

    for (const [config, message] of cases) {
      expect(() => validateConfig(config)).toThrow(RangeError);
      expect(() => validateConfig(config)).toThrow(message);
    }
  });

  it('rejects a non-object config', () => {
    expect(() => validateConfig(null as unknown as MinesweeperConfig)).toThrow(
      /config must be an object, received null\./,
    );
  });

  it('rejects invalid configs at the engine constructor entry point', () => {
    expect(
      () => new MinesweeperEngine({ config: { ...BEGINNER_CONFIG, rows: 2 } }),
    ).toThrow(RangeError);
    expect(
      () => new MinesweeperEngine({ config: { ...BEGINNER_CONFIG, mines: 81 } }),
    ).toThrow(RangeError);
    expect(
      () =>
        new MinesweeperEngine({
          config: { ...BEGINNER_CONFIG, firstClickSafe: false },
          initialMines: [{ row: -1, col: 0 }],
        }),
    ).toThrow(RangeError);
  });

  it('validates injected layouts against the configured board', () => {
    const fullLayout: readonly Cell[] = Array.from(
      { length: INTERMEDIATE_CONFIG.mines },
      (_, index) => ({
        row: Math.floor(index / INTERMEDIATE_CONFIG.cols),
        col: index % INTERMEDIATE_CONFIG.cols,
      }),
    );

    expect(
      () => new MinesweeperEngine({ config: INTERMEDIATE_CONFIG, initialMines: RING_MINES }),
    ).toThrow(/exactly 40/);
    expect(
      () => new MinesweeperEngine({ config: INTERMEDIATE_CONFIG, initialMines: fullLayout }),
    ).not.toThrow();
    expect(
      () =>
        new MinesweeperEngine({
          config: INTERMEDIATE_CONFIG,
          initialMines: [...fullLayout.slice(0, 39), { row: 16, col: 0 }],
        }),
    ).toThrow(/out of bounds/);
  });
});
