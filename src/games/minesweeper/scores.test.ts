import { describe, expect, it } from 'vitest';
import { StorageService, type KeyValueStore } from '../../core/storage';
import { DIFFICULTY_PRESETS } from './difficulty';
import { DEFAULT_MINESWEEPER_CONFIG } from './engine';
import {
  bucketForConfig,
  createMinesweeperScores,
  MinesweeperScores,
  SCORES_STORAGE_KEY,
  SCORES_VERSION,
} from './scores';

const NAMESPACE = 'test:v1';
const RAW_KEY = `${NAMESPACE}:${SCORES_STORAGE_KEY}`;
const OTHER_KEY = `${NAMESPACE}:other.setting`;

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function createScores(): { store: MemoryStore; scores: MinesweeperScores } {
  const store = new MemoryStore();
  const scores = createMinesweeperScores(new StorageService(store, NAMESPACE));
  return { store, scores };
}

describe('bucketForConfig', () => {
  it('maps the three presets to their stable ids and labels', () => {
    for (const preset of DIFFICULTY_PRESETS) {
      expect(bucketForConfig(preset)).toEqual({
        id: preset.id,
        label: preset.label,
        config: {
          rows: preset.rows,
          cols: preset.cols,
          mines: preset.mines,
          firstClickSafe: true,
        },
      });
    }
  });

  it('groups a custom configuration that equals a preset in the preset bucket', () => {
    expect(bucketForConfig({ rows: 9, cols: 9, mines: 10, firstClickSafe: true }).id).toBe(
      'beginner',
    );
    expect(bucketForConfig({ rows: 16, cols: 16, mines: 40, firstClickSafe: true }).id).toBe(
      'intermediate',
    );
    expect(bucketForConfig({ rows: 16, cols: 30, mines: 99, firstClickSafe: true }).id).toBe(
      'expert',
    );
    expect(bucketForConfig({ rows: 9, cols: 9, mines: 10, firstClickSafe: false }).id).toBe(
      'custom:9x9x10:unsafe',
    );
  });

  it('keeps different custom boards in separate buckets with readable labels', () => {
    const safe = bucketForConfig({ rows: 12, cols: 12, mines: 20, firstClickSafe: true });
    const safeAgain = bucketForConfig({ rows: 12, cols: 12, mines: 20, firstClickSafe: true });
    const moreMines = bucketForConfig({ rows: 12, cols: 12, mines: 21, firstClickSafe: true });
    const unsafe = bucketForConfig({ rows: 12, cols: 12, mines: 20, firstClickSafe: false });

    expect(safe).toEqual(safeAgain);
    expect(new Set([safe.id, moreMines.id, unsafe.id]).size).toBe(3);
    expect(safe.label).toBe('自定义 12×12 / 20 雷');
    expect(unsafe.label).toBe('自定义 12×12 / 20 雷（首点不安全）');
  });
});

describe('MinesweeperScores', () => {
  it('starts from an empty board when storage is empty', () => {
    const { scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);

    expect(scores.best(beginner)).toBeNull();
    expect(scores.list()).toEqual([]);
  });

  it('records a time, reads it back and persists it across instances', () => {
    const { store, scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);

    expect(() => scores.record(beginner, 42_000)).not.toThrow();
    expect(scores.best(beginner)).toBe(42_000);
    expect(scores.list()).toEqual([{ bucket: beginner, elapsedMs: 42_000 }]);
    expect(JSON.parse(store.values.get(RAW_KEY) ?? '')).toEqual({
      version: SCORES_VERSION,
      records: { beginner: 42_000 },
    });

    const reloaded = createMinesweeperScores(new StorageService(store, NAMESPACE));
    expect(reloaded.best(beginner)).toBe(42_000);
  });

  it('keeps only the shortest time and ignores longer or equal ones', () => {
    const { scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);

    scores.record(beginner, 9_000);
    scores.record(beginner, 12_000);
    scores.record(beginner, 9_000);
    expect(scores.best(beginner)).toBe(9_000);

    scores.record(beginner, 5_000);
    expect(scores.best(beginner)).toBe(5_000);
  });

  it('round-trips an unsafe custom bucket and rebuilds its label', () => {
    const { store, scores } = createScores();
    const unsafe = bucketForConfig({ rows: 12, cols: 12, mines: 20, firstClickSafe: false });

    scores.record(unsafe, 7_500);
    const reloaded = createMinesweeperScores(new StorageService(store, NAMESPACE));

    expect(reloaded.best(unsafe)).toBe(7_500);
    expect(reloaded.list()).toEqual([{ bucket: unsafe, elapsedMs: 7_500 }]);
  });

  it('treats a valid empty table as an empty board', () => {
    const { store, scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);
    store.setItem(RAW_KEY, JSON.stringify({ version: SCORES_VERSION, records: {} }));

    expect(scores.best(beginner)).toBeNull();
    expect(scores.list()).toEqual([]);
    expect(store.values.has(RAW_KEY)).toBe(true);
  });

  it('ignores records for an unplayable board', () => {
    const { store, scores } = createScores();
    const unplayable = bucketForConfig({ rows: 0, cols: 9, mines: 10, firstClickSafe: true });

    scores.record(unplayable, 1_000);

    expect(scores.best(unplayable)).toBeNull();
    expect(store.values.has(RAW_KEY)).toBe(false);
  });

  it('ignores non-finite and negative times without writing anything', () => {
    const { store, scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(() => scores.record(beginner, invalid)).not.toThrow();
    }

    expect(scores.best(beginner)).toBeNull();
    expect(store.values.has(RAW_KEY)).toBe(false);
  });

  it('isolates buckets and lists presets before custom boards', () => {
    const { scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);
    const intermediate = bucketForConfig({
      rows: 16,
      cols: 16,
      mines: 40,
      firstClickSafe: true,
    });
    const expert = bucketForConfig({ rows: 16, cols: 30, mines: 99, firstClickSafe: true });
    const smallCustom = bucketForConfig({ rows: 10, cols: 10, mines: 15, firstClickSafe: true });
    const largeCustom = bucketForConfig({ rows: 12, cols: 12, mines: 20, firstClickSafe: true });

    scores.record(expert, 30_000);
    scores.record(beginner, 10_000);
    scores.record(largeCustom, 40_000);
    scores.record(intermediate, 20_000);
    scores.record(smallCustom, 15_000);

    expect(scores.best(beginner)).toBe(10_000);
    expect(scores.best(intermediate)).toBe(20_000);
    expect(scores.best(expert)).toBe(30_000);
    expect(scores.best(smallCustom)).toBe(15_000);
    expect(scores.best(largeCustom)).toBe(40_000);

    expect(scores.list().map((entry) => entry.bucket.id)).toEqual([
      'beginner',
      'intermediate',
      'expert',
      smallCustom.id,
      largeCustom.id,
    ]);
  });

  it('clears every Minesweeper score and leaves other keys untouched', () => {
    const { store, scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);
    store.setItem(OTHER_KEY, 'keep');

    scores.record(beginner, 7_000);
    scores.clear();

    expect(scores.best(beginner)).toBeNull();
    expect(scores.list()).toEqual([]);
    expect(store.values.has(RAW_KEY)).toBe(false);
    expect(store.values.get(OTHER_KEY)).toBe('keep');
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['an empty value', ''],
    ['an unknown version', JSON.stringify({ version: 2, records: { beginner: 1_000 } })],
    ['missing records', JSON.stringify({ version: 1 })],
    ['a non-object records field', JSON.stringify({ version: 1, records: [1_000] })],
    ['a negative score', JSON.stringify({ version: 1, records: { beginner: -1 } })],
    ['a non-number score', JSON.stringify({ version: 1, records: { beginner: 'fast' } })],
    ['a non-finite score', '{"version":1,"records":{"beginner":1e999}}'],
    ['an unknown bucket', JSON.stringify({ version: 1, records: { nightmare: 1_000 } })],
    [
      'a non-canonical custom bucket',
      JSON.stringify({ version: 1, records: { 'custom:09x9x10:safe': 1_000 } }),
    ],
    [
      'an unplayable custom bucket',
      JSON.stringify({ version: 1, records: { 'custom:0x9x10:safe': 1_000 } }),
    ],
    [
      'a custom bucket with too many mines',
      JSON.stringify({ version: 1, records: { 'custom:5x5x30:safe': 1_000 } }),
    ],
  ])('clears %s and keeps other keys', (_label, raw) => {
    const { store, scores } = createScores();
    store.setItem(RAW_KEY, raw);
    store.setItem(OTHER_KEY, 'keep');

    expect(scores.list()).toEqual([]);
    expect(store.values.has(RAW_KEY)).toBe(false);
    expect(store.values.get(OTHER_KEY)).toBe('keep');
  });

  it('deletes corrupt data when read through best()', () => {
    const { store, scores } = createScores();
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);
    store.setItem(RAW_KEY, '{not-json');
    store.setItem(OTHER_KEY, 'keep');

    expect(scores.best(beginner)).toBeNull();
    expect(store.values.has(RAW_KEY)).toBe(false);
    expect(store.values.get(OTHER_KEY)).toBe('keep');
  });

  it('never throws when the underlying store throws', () => {
    const broken: KeyValueStore = {
      getItem() {
        throw new Error('private mode');
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {
        throw new Error('denied');
      },
    };
    const scores = createMinesweeperScores(new StorageService(broken, NAMESPACE));
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);

    expect(scores.best(beginner)).toBeNull();
    expect(scores.list()).toEqual([]);
    expect(() => scores.record(beginner, 1_000)).not.toThrow();
    expect(() => scores.clear()).not.toThrow();
  });

  it('works without a store at all', () => {
    const scores = createMinesweeperScores(new StorageService(null, NAMESPACE));
    const beginner = bucketForConfig(DEFAULT_MINESWEEPER_CONFIG);

    expect(() => scores.record(beginner, 1_000)).not.toThrow();
    expect(scores.best(beginner)).toBeNull();
    expect(scores.list()).toEqual([]);
  });
});
