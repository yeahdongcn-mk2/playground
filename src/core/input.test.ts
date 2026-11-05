import { describe, expect, it } from 'vitest';
import {
  clampPoint,
  DirectionState,
  directionFromCode,
  normalizeVector,
} from './input';

describe('directionFromCode', () => {
  it('maps arrows and WASD to directions', () => {
    expect(directionFromCode('ArrowUp')).toBe('up');
    expect(directionFromCode('ArrowDown')).toBe('down');
    expect(directionFromCode('KeyA')).toBe('left');
    expect(directionFromCode('KeyD')).toBe('right');
    expect(directionFromCode('KeyW')).toBe('up');
    expect(directionFromCode('Space')).toBeNull();
    expect(directionFromCode('Enter')).toBeNull();
  });
});

describe('DirectionState', () => {
  it('cancels opposite directions instead of using last-write-wins', () => {
    const state = new DirectionState();
    state.press('left');
    state.press('right');
    expect(state.vector()).toEqual({ x: 0, y: 0 });
    state.release('left');
    expect(state.vector()).toEqual({ x: 1, y: 0 });
  });

  it('normalises diagonals and reports activity', () => {
    const state = new DirectionState();
    state.press('up');
    state.press('right');
    const vector = state.vector();
    expect(Math.hypot(vector.x, vector.y)).toBeCloseTo(1);
    expect(state.active).toBe(true);
    state.clear();
    expect(state.active).toBe(false);
    expect(state.vector()).toEqual({ x: 0, y: 0 });
  });
});

describe('normalizeVector', () => {
  it('keeps zero vectors at rest and normalises non-zero vectors', () => {
    expect(normalizeVector(0, 0)).toEqual({ x: 0, y: 0 });
    expect(normalizeVector(3, 4)).toEqual({ x: 0.6, y: 0.8 });
    expect(normalizeVector(Number.NaN, 1)).toEqual({ x: 0, y: 0 });
  });
});

describe('clampPoint', () => {
  it('keeps a point inside the playfield margin', () => {
    expect(clampPoint({ x: -10, y: -10 }, { width: 100, height: 80 }, 5)).toEqual({
      x: 5,
      y: 5,
    });
    expect(clampPoint({ x: 110, y: 90 }, { width: 100, height: 80 }, 5)).toEqual({
      x: 95,
      y: 75,
    });
    expect(clampPoint({ x: 50, y: 40 }, { width: 100, height: 80 }, 5)).toEqual({
      x: 50,
      y: 40,
    });
  });
});
