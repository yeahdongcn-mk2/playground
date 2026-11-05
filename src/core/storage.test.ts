import { describe, expect, it } from 'vitest';
import { StorageService, type KeyValueStore } from './storage';

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

describe('StorageService', () => {
  it('namespaces keys and round-trips values', () => {
    const store = new MemoryStore();
    const storage = new StorageService(store, 'test:v1');

    storage.set('snake.highscore', 42);
    storage.set('settings.sound', 'off');

    expect(store.values.get('test:v1:snake.highscore')).toBe('42');
    expect(storage.getNumber('snake.highscore', 0)).toBe(42);
    expect(storage.getString('settings.sound', 'on')).toBe('off');
  });

  it('uses fallbacks for missing, malformed and non-finite numbers', () => {
    const store = new MemoryStore();
    const storage = new StorageService(store);

    expect(storage.getNumber('missing', 7)).toBe(7);
    store.setItem('playground:v1:bad', 'not-a-number');
    expect(storage.getNumber('bad', 7)).toBe(7);
    store.setItem('playground:v1:infinite', String(Number.POSITIVE_INFINITY));
    expect(storage.getNumber('infinite', 7)).toBe(7);
  });

  it('parses booleans without surprising truthiness', () => {
    const store = new MemoryStore();
    const storage = new StorageService(store);

    expect(storage.getBoolean('missing', true)).toBe(true);
    store.setItem('playground:v1:on', 'on');
    store.setItem('playground:v1:off', 'off');
    store.setItem('playground:v1:zero', '0');
    expect(storage.getBoolean('on', false)).toBe(true);
    expect(storage.getBoolean('off', true)).toBe(false);
    expect(storage.getBoolean('zero', true)).toBe(false);
  });

  it('keeps working when the underlying store throws', () => {
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
    const storage = new StorageService(broken);

    expect(storage.getString('anything', 'fallback')).toBe('fallback');
    expect(() => storage.set('anything', 1)).not.toThrow();
    expect(() => storage.remove('anything')).not.toThrow();
  });

  it('can run without any store (SSR / disabled storage)', () => {
    const storage = new StorageService(null);
    expect(storage.getString('x', 'none')).toBe('none');
    storage.set('x', 'y');
    expect(storage.getString('x', 'none')).toBe('none');
  });
});
