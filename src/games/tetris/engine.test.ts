import { describe, expect, it } from 'vitest';
import {
  createSeededRng,
  gravityMsForLevel,
  levelForLines,
  lineClearScore,
  ROTATIONS,
  TETROMINO_TYPES,
  TetrisEngine,
  tetrominoCells,
  type ActivePieceSnapshot,
  type BoardCell,
  type Cell,
  type Rotation,
  type TetrominoType,
  type TetrisEngineOptions,
} from './engine';

const WIDTH = 10;
const HEIGHT = 20;

function emptyBoard(width = WIDTH, height = HEIGHT): BoardCell[][] {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, (): BoardCell => null),
  );
}

function filledRow(width = WIDTH, holes: readonly number[] = []): BoardCell[] {
  return Array.from({ length: width }, (_, x): BoardCell =>
    holes.includes(x) ? null : 'I',
  );
}

function boardWithFilledRows(
  rows: readonly number[],
  holes: readonly number[] = [],
): BoardCell[][] {
  const board = emptyBoard();
  for (const y of rows) {
    board[y] = filledRow(WIDTH, holes);
  }
  return board;
}

function makeEngine(options: TetrisEngineOptions = {}): TetrisEngine {
  return new TetrisEngine({ rng: createSeededRng(1), ...options });
}

function activePiece(engine: TetrisEngine): ActivePieceSnapshot {
  const active = engine.state.active;
  if (!active) {
    throw new Error('Expected an active piece.');
  }
  return active;
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function sortedCellKeys(cells: readonly Cell[]): string[] {
  return cells.map(cellKey).sort();
}

/** Pure geometric rotation inside a square box, used to cross-check shape tables. */
function rotateCW(cells: readonly Cell[], box: number): Cell[] {
  return cells.map((cell) => ({ x: box - 1 - cell.y, y: cell.x }));
}

const SPAWN_X: Readonly<Record<TetrominoType, number>> = {
  I: 3,
  O: 4,
  T: 3,
  S: 3,
  Z: 3,
  J: 3,
  L: 3,
};

const PIECE_BOX: Readonly<Record<TetrominoType, number>> = {
  I: 4,
  O: 2,
  T: 3,
  S: 3,
  Z: 3,
  J: 3,
  L: 3,
};

describe('tetromino definitions', () => {
  it('defines all seven pieces with four unique cells in each rotation', () => {
    expect(TETROMINO_TYPES).toEqual(['I', 'O', 'T', 'S', 'Z', 'J', 'L']);

    for (const type of TETROMINO_TYPES) {
      for (const rotation of ROTATIONS) {
        const cells = tetrominoCells(type, rotation);
        expect(cells).toHaveLength(4);
        expect(new Set(cells.map(cellKey)).size).toBe(4);
        for (const cell of cells) {
          expect(cell.x).toBeGreaterThanOrEqual(0);
          expect(cell.x).toBeLessThan(PIECE_BOX[type]);
          expect(cell.y).toBeGreaterThanOrEqual(0);
          expect(cell.y).toBeLessThan(PIECE_BOX[type]);
        }
      }
    }
  });

  it('spawns every piece at the top centre', () => {
    for (const type of TETROMINO_TYPES) {
      const engine = makeEngine({ initialPiece: type });
      const active = activePiece(engine);
      const x = SPAWN_X[type];

      expect(engine.state.status).toBe('ready');
      expect(active.type).toBe(type);
      expect(active.rotation).toBe(0);
      expect({ x: active.x, y: active.y }).toEqual({ x, y: 0 });
      expect(active.cells).toEqual(
        tetrominoCells(type, 0).map((cell) => ({ x: cell.x + x, y: cell.y })),
      );
    }
  });

  it('matches the conventional spawn cells for every piece', () => {
    const expected: Readonly<Record<TetrominoType, readonly Cell[]>> = {
      I: [
        { x: 3, y: 1 },
        { x: 4, y: 1 },
        { x: 5, y: 1 },
        { x: 6, y: 1 },
      ],
      O: [
        { x: 4, y: 0 },
        { x: 5, y: 0 },
        { x: 4, y: 1 },
        { x: 5, y: 1 },
      ],
      T: [
        { x: 4, y: 0 },
        { x: 3, y: 1 },
        { x: 4, y: 1 },
        { x: 5, y: 1 },
      ],
      S: [
        { x: 4, y: 0 },
        { x: 5, y: 0 },
        { x: 3, y: 1 },
        { x: 4, y: 1 },
      ],
      Z: [
        { x: 3, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 1 },
        { x: 5, y: 1 },
      ],
      J: [
        { x: 3, y: 0 },
        { x: 3, y: 1 },
        { x: 4, y: 1 },
        { x: 5, y: 1 },
      ],
      L: [
        { x: 5, y: 0 },
        { x: 3, y: 1 },
        { x: 4, y: 1 },
        { x: 5, y: 1 },
      ],
    };

    for (const type of TETROMINO_TYPES) {
      const engine = makeEngine({ initialPiece: type });
      expect(sortedCellKeys(activePiece(engine).cells)).toEqual(
        sortedCellKeys(expected[type]),
      );
    }
  });

  it('rotates every piece with a consistent clockwise transform', () => {
    for (const type of TETROMINO_TYPES) {
      const box = PIECE_BOX[type];
      let expected = tetrominoCells(type, 0);
      for (const rotation of ROTATIONS.slice(1)) {
        expected = rotateCW(expected, box);
        expect(sortedCellKeys(tetrominoCells(type, rotation))).toEqual(
          sortedCellKeys(expected),
        );
      }

      let fullTurn = tetrominoCells(type, 0);
      for (let step = 0; step < 4; step += 1) {
        fullTurn = rotateCW(fullTurn, box);
      }
      expect(sortedCellKeys(fullTurn)).toEqual(sortedCellKeys(tetrominoCells(type, 0)));
    }
  });
});

describe('TetrisEngine lifecycle', () => {
  it('stays idle until started', () => {
    const engine = makeEngine({ initialPiece: 'T' });

    expect(engine.state.status).toBe('ready');
    expect(engine.state.score).toBe(0);
    expect(engine.state.lines).toBe(0);
    expect(engine.state.level).toBe(1);
    expect(engine.moveLeft()).toBe(false);
    expect(engine.softDrop()).toBe(false);
    expect(engine.rotate()).toBe(false);
    expect(engine.step()).toBe('idle');
    expect(engine.hardDrop()).toBeNull();

    engine.start();
    expect(engine.state.status).toBe('running');
    expect(engine.step()).toBe('moved');
  });

  it('toggles pause only between running and paused', () => {
    const engine = makeEngine({ initialPiece: 'T' });

    engine.togglePause();
    expect(engine.state.status).toBe('ready');
    engine.start();
    engine.togglePause();
    expect(engine.state.status).toBe('paused');
    expect(engine.step()).toBe('idle');
    engine.togglePause();
    expect(engine.state.status).toBe('running');
    expect(engine.step()).toBe('moved');
  });

  it('freezes movement, rotation and dropping while paused', () => {
    const engine = makeEngine({ initialPiece: 'T' });
    engine.start();
    expect(engine.softDrop()).toBe(true);
    const activeBefore = activePiece(engine);

    engine.pause();
    expect(engine.state.status).toBe('paused');
    expect(engine.moveLeft()).toBe(false);
    expect(engine.moveRight()).toBe(false);
    expect(engine.rotate()).toBe(false);
    expect(engine.softDrop()).toBe(false);
    expect(engine.hardDrop()).toBeNull();
    expect(engine.step()).toBe('idle');
    expect(engine.state.active).toEqual(activeBefore);

    engine.resume();
    expect(engine.state.status).toBe('running');
    expect(engine.softDrop()).toBe(true);
  });

  it('resets score, lines, level, gravity and board on restart', () => {
    const initial = boardWithFilledRows([19], [5]);
    const engine = makeEngine({
      initialBoard: initial,
      initialPiece: { type: 'I', rotation: 1, x: 3 },
      linesPerLevel: 1,
    });
    engine.start();

    expect(engine.hardDrop()?.scoreGained).toBe(100);
    expect(engine.state.score).toBe(100);
    expect(engine.state.lines).toBe(1);
    expect(engine.state.level).toBe(2);
    engine.pause();

    engine.restart();
    const state = engine.state;
    expect(state.status).toBe('ready');
    expect(state.score).toBe(0);
    expect(state.lines).toBe(0);
    expect(state.level).toBe(1);
    expect(state.gravityMs).toBe(800);
    expect(state.board).toEqual(initial);
    expect(state.active?.type).toBe('I');
    expect(state.active?.rotation).toBe(1);
    expect(state.active?.x).toBe(3);

    engine.start();
    expect(engine.state.status).toBe('running');
  });

  it('returns defensive snapshots', () => {
    const engine = makeEngine({ initialPiece: 'T' });
    const snapshot = engine.state;
    const row = snapshot.board[19] as unknown as BoardCell[];
    row[0] = 'I';
    const cells = (snapshot.active as ActivePieceSnapshot).cells as unknown as Cell[];
    cells[0] = { x: 99, y: 99 };

    expect(engine.state.board[19]?.[0]).toBeNull();
    expect(activePiece(engine).cells[0]?.x).not.toBe(99);
  });
});

describe('TetrisEngine movement and rotation', () => {
  it('moves left and right and stops at the walls', () => {
    const engine = makeEngine({ initialPiece: 'T' });
    engine.start();

    for (let i = 0; i < 3; i += 1) {
      expect(engine.moveLeft()).toBe(true);
    }
    expect(activePiece(engine).x).toBe(0);
    expect(engine.moveLeft()).toBe(false);

    for (let i = 0; i < 7; i += 1) {
      expect(engine.moveRight()).toBe(true);
    }
    expect(activePiece(engine).x).toBe(7);
    expect(engine.moveRight()).toBe(false);
  });

  it('blocks horizontal movement against locked cells', () => {
    const board = emptyBoard();
    board[1]![2] = 'J';
    const engine = makeEngine({ initialBoard: board, initialPiece: 'T' });
    engine.start();

    expect(engine.moveLeft()).toBe(false);
    expect(activePiece(engine).x).toBe(3);
  });

  it('rotates clockwise and counter-clockwise through all four states', () => {
    const engine = makeEngine({ initialPiece: 'T' });
    engine.start();

    const seen = new Set<number>();
    for (let i = 0; i < 4; i += 1) {
      expect(engine.rotate('cw')).toBe(true);
      seen.add(activePiece(engine).rotation);
    }
    expect(seen.size).toBe(4);
    expect(activePiece(engine).rotation).toBe(0);

    expect(engine.rotate('ccw')).toBe(true);
    expect(activePiece(engine).rotation).toBe(3);
  });

  it('leaves the O piece footprint unchanged when rotated', () => {
    const engine = makeEngine({ initialPiece: 'O' });
    engine.start();
    const before = sortedCellKeys(activePiece(engine).cells);

    expect(engine.rotate()).toBe(true);
    expect(sortedCellKeys(activePiece(engine).cells)).toEqual(before);
  });

  it('kicks an I piece away from the left wall when rotating', () => {
    const engine = makeEngine({
      initialPiece: { type: 'I', rotation: 1, x: -2, y: 5 },
    });
    engine.start();
    expect(activePiece(engine).cells.every((cell) => cell.x === 0)).toBe(true);

    expect(engine.rotate('ccw')).toBe(true);
    const after = activePiece(engine);
    expect(after.rotation).toBe(0);
    expect(after.x).toBe(0);
    expect(after.cells.map((cell) => cell.x)).toEqual([0, 1, 2, 3]);
  });

  it('kicks an I piece away from the right wall when rotating', () => {
    const engine = makeEngine({
      initialPiece: { type: 'I', rotation: 3, x: 8, y: 5 },
    });
    engine.start();
    expect(activePiece(engine).cells.every((cell) => cell.x === 9)).toBe(true);

    expect(engine.rotate('cw')).toBe(true);
    const after = activePiece(engine);
    expect(after.rotation).toBe(0);
    expect(after.x).toBe(6);
  });

  it('kicks a flat I piece up two rows off the floor when rotating', () => {
    for (const direction of ['cw', 'ccw'] as const) {
      const engine = makeEngine({
        initialPiece: { type: 'I', rotation: 0, x: 3, y: 18 },
      });
      engine.start();
      expect(activePiece(engine).cells.map((cell) => cell.y)).toEqual([19, 19, 19, 19]);

      expect(engine.rotate(direction)).toBe(true);
      const after = activePiece(engine);
      expect(after.rotation).toBe(direction === 'cw' ? 1 : 3);
      expect(after.y).toBe(16);
      expect(after.cells.map((cell) => cell.y)).toEqual([16, 17, 18, 19]);
    }
  });

  it('keeps the piece unchanged when rotation and every kick are blocked', () => {
    const board = emptyBoard();
    for (let y = 4; y <= 9; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        board[y]![x] = 'I';
      }
    }
    // Carve out the active T piece so the starting position itself is legal.
    for (const cell of tetrominoCells('T', 0)) {
      board[5 + cell.y]![3 + cell.x] = null;
    }

    const engine = makeEngine({
      initialBoard: board,
      initialPiece: { type: 'T', x: 3, y: 5 },
    });
    engine.start();
    const before = activePiece(engine);

    expect(engine.rotate()).toBe(false);
    expect(activePiece(engine)).toEqual(before);
  });
});

describe('TetrisEngine dropping', () => {
  it('soft drops one cell at a time and stops on the floor', () => {
    const engine = makeEngine({ initialPiece: 'T' });
    engine.start();

    expect(engine.softDrop()).toBe(true);
    expect(activePiece(engine).y).toBe(1);

    while (activePiece(engine).y < 18) {
      expect(engine.softDrop()).toBe(true);
    }
    expect(activePiece(engine).y).toBe(18);
    expect(engine.softDrop()).toBe(false);
    expect(engine.state.status).toBe('running');

    const preview = engine.state.next;
    expect(engine.step()).toBe('locked');
    expect(engine.state.active?.type).toBe(preview);
    expect(engine.state.board[19]?.[3]).toBe('T');
    expect(engine.state.board[19]?.[4]).toBe('T');
    expect(engine.state.board[19]?.[5]).toBe('T');
  });

  it('hard drops to the floor, locks and spawns the previewed piece', () => {
    const engine = makeEngine({ initialPiece: 'O' });
    engine.start();
    const preview = engine.state.next;

    const result = engine.hardDrop();
    expect(result).not.toBeNull();
    expect(result?.rowsDropped).toBe(18);
    expect(result?.clearedLines).toBe(0);
    expect(result?.scoreGained).toBe(0);
    expect(result?.gameOver).toBe(false);
    expect(engine.state.active?.type).toBe(preview);
    expect(engine.state.board[18]?.[4]).toBe('O');
    expect(engine.state.board[18]?.[5]).toBe('O');
    expect(engine.state.board[19]?.[4]).toBe('O');
    expect(engine.state.board[19]?.[5]).toBe('O');
  });

  it('stops a hard drop on top of the locked stack', () => {
    const board = emptyBoard();
    board[19]![4] = 'Z';
    const engine = makeEngine({ initialBoard: board, initialPiece: 'O' });
    engine.start();

    expect(engine.hardDrop()?.rowsDropped).toBe(17);
    expect(engine.state.board[17]?.[4]).toBe('O');
    expect(engine.state.board[18]?.[4]).toBe('O');
    expect(engine.state.board[18]?.[5]).toBe('O');
    expect(engine.state.board[19]?.[4]).toBe('Z');
  });
});

describe('TetrisEngine line clears and scoring', () => {
  it.each([
    { cleared: 1, rows: [19], score: 100 },
    { cleared: 2, rows: [18, 19], score: 300 },
    { cleared: 3, rows: [17, 18, 19], score: 500 },
    { cleared: 4, rows: [16, 17, 18, 19], score: 800 },
  ])('clears $cleared row(s) for $score points', ({ cleared, rows, score }) => {
    const engine = makeEngine({
      initialBoard: boardWithFilledRows(rows, [5]),
      initialPiece: { type: 'I', rotation: 1, x: 3 },
    });
    engine.start();

    const result = engine.hardDrop();
    expect(result?.clearedLines).toBe(cleared);
    expect(result?.scoreGained).toBe(score);
    expect(engine.state.lines).toBe(cleared);
    expect(engine.state.score).toBe(score);
    expect(engine.state.level).toBe(1);
    if (cleared === 4) {
      expect(
        engine.state.board.every((row) => row.every((cell) => cell === null)),
      ).toBe(true);
    }
  });

  it('reports a line clear from a gravity lock and shifts rows above it', () => {
    const board = boardWithFilledRows([19], [5]);
    board[18]![0] = 'J';
    const engine = makeEngine({
      initialBoard: board,
      initialPiece: { type: 'I', rotation: 1, x: 3, y: 16 },
    });
    engine.start();

    expect(engine.step()).toBe('cleared');
    expect(engine.state.lines).toBe(1);
    expect(engine.state.score).toBe(100);
    expect(engine.state.level).toBe(1);
    expect(engine.state.board[19]?.[0]).toBe('J');
    expect(engine.state.board[19]?.[5]).toBe('I');
    expect(engine.state.board[18]?.[5]).toBe('I');
  });

  it('compacts multiple cleared rows and preserves blocks above them', () => {
    const board = boardWithFilledRows([17, 18, 19], [5]);
    board[15]![0] = 'J';
    board[16]![1] = 'L';
    const engine = makeEngine({
      initialBoard: board,
      initialPiece: { type: 'I', rotation: 1, x: 3, y: 16 },
    });
    engine.start();

    expect(engine.step()).toBe('cleared');
    expect(engine.state.lines).toBe(3);
    expect(engine.state.score).toBe(500);
    // Rows 15 and 16 move down by three once rows 17-19 disappear.
    expect(engine.state.board[18]?.[0]).toBe('J');
    expect(engine.state.board[19]?.[1]).toBe('L');
    expect(engine.state.board[19]?.[5]).toBe('I');
    expect(
      engine.state.board
        .slice(0, 18)
        .every((row) => row.every((cell) => cell === null)),
    ).toBe(true);
  });

  it('raises the level and speeds up gravity as lines clear', () => {
    const engine = makeEngine({
      initialBoard: boardWithFilledRows([19], [5]),
      initialPiece: { type: 'I', rotation: 1, x: 3 },
      linesPerLevel: 1,
    });
    engine.start();
    expect(engine.state.gravityMs).toBe(800);

    const result = engine.hardDrop();
    expect(result?.levelUp).toBe(true);
    expect(engine.state.lines).toBe(1);
    expect(engine.state.level).toBe(2);
    expect(engine.state.gravityMs).toBe(730);
  });

  it('derives levels, gravity and scores from cleared lines', () => {
    expect(levelForLines(0, 10)).toBe(1);
    expect(levelForLines(9, 10)).toBe(1);
    expect(levelForLines(10, 10)).toBe(2);
    expect(levelForLines(25, 10)).toBe(3);

    const gravity = { initialGravityMs: 800, gravityStepMs: 70, minGravityMs: 80 };
    expect(gravityMsForLevel(1, gravity)).toBe(800);
    expect(gravityMsForLevel(2, gravity)).toBe(730);
    expect(gravityMsForLevel(20, gravity)).toBe(80);

    expect(lineClearScore(0, 5)).toBe(0);
    expect(lineClearScore(1, 1)).toBe(100);
    expect(lineClearScore(2, 1)).toBe(300);
    expect(lineClearScore(3, 1)).toBe(500);
    expect(lineClearScore(4, 1)).toBe(800);
    expect(lineClearScore(4, 3)).toBe(2_400);
    expect(lineClearScore(5, 5)).toBe(0);
  });

  it('scores a clear with the level that was active before the clear', () => {
    const board = emptyBoard();
    board[19] = filledRow(WIDTH, [0, 1]);
    for (let x = 2; x <= 8; x += 1) {
      board[18]![x] = 'I';
    }

    const engine = makeEngine({
      initialBoard: board,
      initialPiece: { type: 'O', x: 0, y: 0 },
      nextQueue: ['I'],
      linesPerLevel: 1,
    });
    engine.start();

    const first = engine.hardDrop();
    expect(first?.clearedLines).toBe(1);
    expect(first?.scoreGained).toBe(100);
    expect(engine.state.level).toBe(2);
    expect(engine.state.active?.type).toBe('I');

    // Place the next I in column 9 to complete the shifted bottom row.
    expect(engine.rotate('cw')).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      expect(engine.moveRight()).toBe(true);
    }
    const second = engine.hardDrop();
    expect(second?.clearedLines).toBe(1);
    expect(second?.scoreGained).toBe(200);
    expect(engine.state.score).toBe(300);
    expect(engine.state.lines).toBe(2);
    expect(engine.state.level).toBe(3);
  });
});

describe('TetrisEngine game over', () => {
  it('ends the game when the next piece cannot spawn at the top', () => {
    const board = emptyBoard();
    // Leave the T spawn cells open, fill the row below the spawn area so the
    // piece locks immediately, and block the following O spawn via the lock.
    board[1] = filledRow(WIDTH, [0, 3, 4, 5]);
    board[2]![3] = 'I';
    board[2]![4] = 'I';
    board[2]![5] = 'I';

    const engine = makeEngine({
      initialBoard: board,
      initialPiece: { type: 'T', x: 3, y: 0 },
      nextQueue: ['O'],
    });
    engine.start();

    expect(engine.step()).toBe('gameover');
    expect(engine.state.status).toBe('gameover');
    expect(engine.state.active).toBeNull();
    expect(engine.state.lines).toBe(0);

    expect(engine.moveLeft()).toBe(false);
    expect(engine.rotate()).toBe(false);
    expect(engine.softDrop()).toBe(false);
    expect(engine.step()).toBe('idle');
    expect(engine.hardDrop()).toBeNull();
    engine.start();
    expect(engine.state.status).toBe('gameover');

    engine.restart();
    expect(engine.state.status).toBe('ready');
    expect(engine.state.active?.type).toBe('T');
    expect(engine.state.lines).toBe(0);
  });

  it('treats a starting stack that blocks spawn as game over', () => {
    const board = emptyBoard();
    board[0]![4] = 'I';
    board[1]![3] = 'I';
    board[1]![4] = 'I';
    board[1]![5] = 'I';

    const engine = makeEngine({ initialBoard: board, initialPiece: 'T' });
    expect(engine.state.status).toBe('gameover');
    expect(engine.state.active).toBeNull();

    engine.start();
    expect(engine.state.status).toBe('gameover');
  });
});

describe('TetrisEngine piece sequence', () => {
  it('deals each of the seven pieces exactly once per bag', () => {
    const engine = makeEngine();
    engine.start();

    const drawn: TetrominoType[] = [];
    for (let i = 0; i < 7; i += 1) {
      drawn.push(activePiece(engine).type);
      expect(engine.hardDrop()).not.toBeNull();
    }

    expect(drawn).toHaveLength(7);
    expect(new Set(drawn).size).toBe(7);
    for (const type of TETROMINO_TYPES) {
      expect(drawn).toContain(type);
    }
  });

  it('spawns exactly the previewed piece', () => {
    const engine = makeEngine();
    engine.start();

    for (let i = 0; i < 4; i += 1) {
      const preview = engine.state.next;
      expect(engine.hardDrop()).not.toBeNull();
      expect(engine.state.active?.type).toBe(preview);
    }
  });

  it('honours an injected next queue and falls back to the bag when it runs out', () => {
    const engine = new TetrisEngine({
      initialPiece: 'I',
      nextQueue: ['T', 'O', 'S'],
      rng: createSeededRng(4),
    });
    expect(engine.state.active?.type).toBe('I');
    expect(engine.state.next).toBe('T');

    engine.start();
    engine.hardDrop();
    expect(engine.state.active?.type).toBe('T');
    expect(engine.state.next).toBe('O');

    engine.hardDrop();
    expect(engine.state.active?.type).toBe('O');
    expect(engine.state.next).toBe('S');

    engine.hardDrop();
    expect(engine.state.active?.type).toBe('S');
    expect(TETROMINO_TYPES).toContain(engine.state.next);
    const fromBag = engine.state.next;

    engine.hardDrop();
    expect(engine.state.active?.type).toBe(fromBag);
  });

  it('restores the injected queue on restart', () => {
    const engine = new TetrisEngine({
      initialPiece: 'I',
      nextQueue: ['T', 'O', 'S'],
      rng: createSeededRng(4),
    });
    engine.start();
    engine.hardDrop();
    expect(engine.state.active?.type).toBe('T');
    expect(engine.state.next).toBe('O');

    engine.restart();
    expect(engine.state.status).toBe('ready');
    expect(engine.state.active?.type).toBe('I');
    expect(engine.state.next).toBe('T');
  });

  it('produces the same sequence for the same seed', () => {
    const first = new TetrisEngine({ rng: createSeededRng(42) });
    const second = new TetrisEngine({ rng: createSeededRng(42) });
    first.start();
    second.start();

    for (let i = 0; i < 8; i += 1) {
      expect(first.state.active?.type).toBe(second.state.active?.type);
      expect(first.state.next).toBe(second.state.next);
      first.hardDrop();
      second.hardDrop();
    }
  });

  it('rejects invalid boards and configuration', () => {
    expect(() => new TetrisEngine({ width: 3 })).toThrow(/at least 4/);
    expect(() => new TetrisEngine({ linesPerLevel: 0 })).toThrow(/positive integer/);
    expect(() => new TetrisEngine({ minGravityMs: 1_000 })).toThrow(/cannot exceed/);
    expect(() => new TetrisEngine({ initialBoard: [] })).toThrow(/height/);
    expect(() => new TetrisEngine({ initialBoard: emptyBoard(9, 20) })).toThrow(/width/);
  });

  it('rejects invalid injected board, queue and piece data', () => {
    const board = emptyBoard();
    board[0]![0] = 'X' as unknown as BoardCell;
    expect(() => new TetrisEngine({ initialBoard: board })).toThrow(
      /Unknown tetromino type/,
    );
    expect(
      () => new TetrisEngine({ nextQueue: ['X' as unknown as TetrominoType] }),
    ).toThrow(/Unknown tetromino type/);
    expect(
      () => new TetrisEngine({ initialPiece: { type: 'T', rotation: 4 as Rotation } }),
    ).toThrow(/rotation/);
    expect(
      () => new TetrisEngine({ initialPiece: { type: 'T', x: 1.5 } }),
    ).toThrow(/integers/);
  });
});
