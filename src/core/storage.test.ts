import { describe, expect, it } from 'vitest';
import { StorageService, type KeyValueStore } from './storage';

interface MemoryStore extends KeyValueStore {
  readonly data: Map<string, string>;
}

function createMemoryStore(initial: Record<string, string> = {}): MemoryStore {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe('StorageService', () => {
  it('writes namespaced keys and reads them back', () => {
    const store = createMemoryStore();
    const storage = new StorageService(store);

    storage.set('snake.highscore', 120);

    expect(store.data.get('playground:v1:snake.highscore')).toBe('120');
    expect(storage.getNumber('snake.highscore', 0)).toBe(120);
  });

  it('supports a custom namespace', () => {
    const store = createMemoryStore();
    const storage = new StorageService(store, 'test:v2');

    storage.set('sound', 'off');

    expect(store.data.get('test:v2:sound')).toBe('off');
    expect(storage.getString('sound', 'on')).toBe('off');
  });

  it('returns fallbacks for missing or invalid numbers', () => {
    const storage = new StorageService(
      createMemoryStore({
        'playground:v1:good': '12.5',
        'playground:v1:nan': 'NaN',
        'playground:v1:infinite': 'Infinity',
        'playground:v1:text': 'not-a-number',
      }),
    );

    expect(storage.getNumber('good', 0)).toBe(12.5);
    expect(storage.getNumber('nan', 7)).toBe(7);
    expect(storage.getNumber('infinite', 7)).toBe(7);
    expect(storage.getNumber('text', 7)).toBe(7);
    expect(storage.getNumber('missing', 7)).toBe(7);
  });

  it('removes keys and falls back to defaults afterwards', () => {
    const store = createMemoryStore();
    const storage = new StorageService(store);
    storage.set('snake.highscore', 40);

    storage.remove('snake.highscore');

    expect(store.data.has('playground:v1:snake.highscore')).toBe(false);
    expect(storage.getNumber('snake.highscore', 0)).toBe(0);
  });

  it('survives unavailable storage', () => {
    const storage = new StorageService(null);

    expect(() => storage.set('snake.highscore', 10)).not.toThrow();
    expect(() => storage.remove('snake.highscore')).not.toThrow();
    expect(storage.getNumber('snake.highscore', 3)).toBe(3);
  });

  it('swallows storage exceptions (private mode, quota, blocked cookies)', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const storage = new StorageService(broken);

    expect(storage.getString('sound', 'on')).toBe('on');
    expect(() => storage.set('sound', 'off')).not.toThrow();
    expect(() => storage.remove('sound')).not.toThrow();
  });
});
