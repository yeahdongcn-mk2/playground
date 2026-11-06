import { describe, expect, it } from 'vitest';
import {
  COLS,
  createSeededRng,
  isInBounds,
  MINE_COUNT,
  MinesweeperEngine,
  ROWS,
  type Cell,
  type MinesweeperBoard,
  type MinesweeperCell,
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
