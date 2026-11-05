import { describe, expect, it } from 'vitest';
import { createSeededRng, SnakeEngine, type Cell, type Direction } from './engine';

function makeEngine(
  options: ConstructorParameters<typeof SnakeEngine>[0] = {},
): SnakeEngine {
  return new SnakeEngine({ rng: () => 0, ...options });
}

function headOf(engine: SnakeEngine): Cell {
  const head = engine.state.snake[0];
  if (!head) {
    throw new Error('Snake has no head');
  }
  return head;
}

describe('SnakeEngine', () => {
  it('starts ready with a three-cell snake and food off the snake', () => {
    const engine = makeEngine({ width: 10, height: 10 });

    expect(engine.state.status).toBe('ready');
    expect(engine.state.score).toBe(0);
    expect(engine.state.direction).toBe('right');
    expect(engine.state.snake).toEqual([
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    expect(engine.state.food).toEqual({ x: 0, y: 0 });
  });

  it('moves one cell per step once started', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    engine.start();

    expect(engine.step()).toBe('moved');
    expect(headOf(engine)).toEqual({ x: 6, y: 5 });
    expect(engine.step()).toBe('moved');
    expect(headOf(engine)).toEqual({ x: 7, y: 5 });
  });

  it('rejects a 180-degree reversal', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    engine.start();

    expect(engine.turn('left')).toBe(false);
    expect(engine.state.direction).toBe('right');
    engine.step();
    expect(headOf(engine)).toEqual({ x: 6, y: 5 });
  });

  it('queues quick turns and applies one direction per tick', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    engine.start();

    expect(engine.turn('up')).toBe(true);
    expect(engine.turn('left')).toBe(true);
    expect(engine.turn('down')).toBe(false);

    engine.step();
    expect(headOf(engine)).toEqual({ x: 5, y: 4 });
    engine.step();
    expect(headOf(engine)).toEqual({ x: 4, y: 4 });
  });

  it('ignores turns while not running', () => {
    const engine = makeEngine({ width: 10, height: 10 });

    expect(engine.turn('up')).toBe(false);
    engine.start();
    engine.pause();
    expect(engine.turn('up')).toBe(false);
    engine.resume();
    expect(engine.turn('up')).toBe(true);
  });

  it('eats food, grows, scores and increases speed', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    engine.start();
    expect(engine.turn('up')).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      expect(engine.step()).toBe('moved');
    }
    expect(headOf(engine)).toEqual({ x: 5, y: 0 });
    expect(engine.turn('left')).toBe(true);

    for (let i = 0; i < 4; i += 1) {
      expect(engine.step()).toBe('moved');
    }
    expect(engine.step()).toBe('ate');

    expect(engine.state.score).toBe(10);
    expect(engine.state.snake).toHaveLength(4);
    expect(engine.state.stepMs).toBe(144);
    expect(engine.state.food).toEqual({ x: 4, y: 0 });
  });

  it('dies against a wall and keeps the score', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    engine.start();

    for (let i = 0; i < 4; i += 1) {
      expect(engine.step()).toBe('moved');
    }
    expect(headOf(engine)).toEqual({ x: 9, y: 5 });
    expect(engine.step()).toBe('died');
    expect(engine.state.status).toBe('gameover');
    expect(engine.state.snake).toHaveLength(3);
    expect(engine.state.score).toBe(0);
    expect(engine.step()).toBe('idle');
  });

  it('derives the starting direction from a custom layout', () => {
    const engine = makeEngine({
      width: 10,
      height: 10,
      initialSnake: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
        { x: 7, y: 5 },
      ],
      initialFood: { x: 9, y: 9 },
    });
    engine.start();

    expect(engine.state.direction).toBe('left');
    expect(engine.step()).toBe('moved');
    expect(headOf(engine)).toEqual({ x: 4, y: 5 });
  });

  it('dies when a turn sends the head into its own body', () => {
    const engine = makeEngine({
      width: 5,
      height: 5,
      initialSnake: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 3, y: 3 },
        { x: 2, y: 3 },
        { x: 1, y: 3 },
        { x: 1, y: 2 },
      ],
      initialDirection: 'up',
      initialFood: { x: 4, y: 4 },
    });
    engine.start();

    expect(engine.step()).toBe('moved');
    expect(engine.turn('right')).toBe(true);
    expect(engine.step()).toBe('moved');
    expect(engine.turn('down')).toBe(true);
    expect(engine.step()).toBe('died');
    expect(engine.state.status).toBe('gameover');
  });

  it('rejects a starting direction that is off the board or hits the body', () => {
    expect(() =>
      makeEngine({
        width: 5,
        height: 5,
        initialSnake: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
      }),
    ).toThrow(/points off the board/);
    expect(() =>
      makeEngine({
        width: 5,
        height: 5,
        initialSnake: [
          { x: 2, y: 2 },
          { x: 2, y: 3 },
          { x: 3, y: 3 },
          { x: 3, y: 2 },
          { x: 3, y: 1 },
        ],
        initialDirection: 'right',
      }),
    ).toThrow(/points into the snake/);
  });

  it('fits a large starting snake for each starting direction', () => {
    for (const direction of ['up', 'right', 'down', 'left'] satisfies Direction[]) {
      const engine = makeEngine({
        width: 8,
        height: 8,
        initialLength: 6,
        initialDirection: direction,
      });
      expect(engine.state.status).toBe('ready');
      expect(engine.state.snake).toHaveLength(6);
      for (const cell of engine.state.snake) {
        expect(cell.x).toBeGreaterThanOrEqual(0);
        expect(cell.x).toBeLessThan(8);
        expect(cell.y).toBeGreaterThanOrEqual(0);
        expect(cell.y).toBeLessThan(8);
      }
    }
  });

  it('clamps an rng that returns exactly 1 to the last free cell', () => {
    const engine = makeEngine({ width: 4, height: 4, rng: () => 1 });
    expect(engine.state.food).not.toBeNull();
    expect(engine.state.food).not.toEqual({ x: 1, y: 1 });
  });

  it('allows the head to follow the vacating tail', () => {
    const engine = makeEngine({
      width: 5,
      height: 5,
      initialSnake: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
        { x: 2, y: 3 },
      ],
      initialDirection: 'down',
      initialFood: { x: 4, y: 4 },
    });
    engine.start();

    expect(engine.step()).toBe('moved');
    expect(headOf(engine)).toEqual({ x: 2, y: 3 });
    expect(engine.state.status).toBe('running');
    expect(engine.state.snake).toHaveLength(4);
  });

  it('wins when the snake fills the board', () => {
    const engine = makeEngine({
      width: 5,
      height: 5,
      initialSnake: [
        { x: 0, y: 1 },
        { x: 0, y: 2 },
        { x: 0, y: 3 },
        { x: 0, y: 4 },
        { x: 1, y: 4 },
        { x: 2, y: 4 },
        { x: 3, y: 4 },
        { x: 4, y: 4 },
        { x: 4, y: 3 },
        { x: 3, y: 3 },
        { x: 2, y: 3 },
        { x: 1, y: 3 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 1 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
        { x: 4, y: 0 },
      ],
      initialDirection: 'up',
      initialFood: { x: 0, y: 0 },
    });
    engine.start();

    expect(engine.step()).toBe('won');
    expect(engine.state.status).toBe('won');
    expect(engine.state.snake).toHaveLength(25);
    expect(engine.state.score).toBe(10);
  });

  it('pauses and resumes without advancing the simulation', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    engine.start();
    engine.step();
    const before = engine.state;

    engine.pause();
    expect(engine.state.status).toBe('paused');
    expect(engine.step()).toBe('idle');
    expect(engine.state.snake).toEqual(before.snake);

    engine.resume();
    expect(engine.state.status).toBe('running');
    expect(engine.step()).toBe('moved');
  });

  it('toggles pause only between running and paused', () => {
    const engine = makeEngine({ width: 10, height: 10 });

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

  it('resets score, speed, layout and status on restart', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    engine.start();
    engine.step();
    engine.step();
    engine.togglePause();

    engine.restart();

    expect(engine.state.status).toBe('ready');
    expect(engine.state.score).toBe(0);
    expect(engine.state.stepMs).toBe(150);
    expect(engine.state.snake).toEqual([
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    expect(engine.state.food).toEqual({ x: 0, y: 0 });
  });

  it('returns defensive snapshots', () => {
    const engine = makeEngine({ width: 10, height: 10 });
    const snapshot = engine.state;
    const head = snapshot.snake[0] as { x: number; y: number };
    head.x = 99;

    expect(headOf(engine)).toEqual({ x: 5, y: 5 });
  });

  it('rejects invalid boards and starting layouts', () => {
    expect(() => makeEngine({ width: 3, height: 10 })).toThrow(/at least 4x4/);
    expect(() => makeEngine({ initialLength: 1 })).toThrow(/at least 2 segments/);
    expect(() =>
      makeEngine({
        width: 5,
        height: 5,
        initialSnake: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      }),
    ).toThrow(/contiguous/);
    expect(() => makeEngine({ width: 5, height: 5, initialFood: { x: 5, y: 0 } })).toThrow(
      /food is out of bounds/,
    );
    expect(() => makeEngine({ initialLength: 21 })).toThrow(/layout is out of bounds/);
    expect(() => makeEngine({ initialSnake: [] })).toThrow(/at least two cells/);
    expect(() =>
      makeEngine({
        initialSnake: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
          { x: 7, y: 5 },
        ],
        initialDirection: 'right',
      }),
    ).toThrow(/points into the snake/);
    expect(() =>
      makeEngine({
        initialSnake: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
          { x: 7, y: 5 },
        ],
        initialFood: { x: 5, y: 5 },
      }),
    ).toThrow(/overlap the snake/);
  });

  it('produces the same food placement with the same seed', () => {
    const first = createSeededRng(7);
    const second = createSeededRng(7);
    const a = new SnakeEngine({ rng: first });
    const b = new SnakeEngine({ rng: second });

    expect(a.state.food).toEqual(b.state.food);
    expect(a.state.food).not.toBeNull();
  });

  it('keeps the snake fully inside the board for each starting direction', () => {
    for (const direction of ['up', 'right', 'down', 'left'] satisfies Direction[]) {
      const engine = makeEngine({
        width: 8,
        height: 8,
        initialLength: 4,
        initialDirection: direction,
      });
      for (const cell of engine.state.snake) {
        expect(cell.x).toBeGreaterThanOrEqual(0);
        expect(cell.x).toBeLessThan(8);
        expect(cell.y).toBeGreaterThanOrEqual(0);
        expect(cell.y).toBeLessThan(8);
      }
    }
  });
});
