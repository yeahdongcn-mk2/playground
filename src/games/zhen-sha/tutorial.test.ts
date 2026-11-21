import { describe, expect, it } from 'vitest';
import { StorageService, type KeyValueStore } from '../../core/storage';
import { FIRST_TELEGRAPH_TICKS } from './engine';
import {
  markTutorialDone,
  readTutorialState,
  TUTORIAL_DONE,
  TUTORIAL_FIRST_TELEGRAPH_TICKS,
  TUTORIAL_HINT_TEXT,
  TUTORIAL_STORAGE_KEY,
  TUTORIAL_TELEGRAPH_FACTOR,
} from './tutorial';

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

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

function createStorage(): { storage: StorageService; store: MemoryStore } {
  const store = new MemoryStore();
  return { storage: new StorageService(store), store };
}

describe('zhen-sha first-visit tutorial state', () => {
  it('keeps the hint to a short phrase and stretches the opening by >= 1.5x', () => {
    expect(TUTORIAL_STORAGE_KEY).toBe('zhen-sha.tutorial');
    expect(TUTORIAL_DONE).toBe('done');
    expect(TUTORIAL_TELEGRAPH_FACTOR).toBe(1.5);
    expect(TUTORIAL_FIRST_TELEGRAPH_TICKS).toBe(270);
    expect(Number.isInteger(TUTORIAL_FIRST_TELEGRAPH_TICKS)).toBe(true);
    expect(TUTORIAL_FIRST_TELEGRAPH_TICKS).toBeGreaterThanOrEqual(
      FIRST_TELEGRAPH_TICKS * TUTORIAL_TELEGRAPH_FACTOR,
    );

    const han = TUTORIAL_HINT_TEXT.match(/[\u4e00-\u9fff]/g) ?? [];
    expect(han.length).toBeGreaterThan(0);
    expect(han.length).toBeLessThanOrEqual(6);
    expect(TUTORIAL_HINT_TEXT).toBe('等它出手');
  });

  it('treats only the exact done value as finished', () => {
    for (const value of ['', 'Done', 'DONE', 'true', '1', 'pending', 'done ']) {
      const { storage } = createStorage();
      storage.set(TUTORIAL_STORAGE_KEY, value);
      const state = readTutorialState(storage);
      expect(state.pending, `value ${JSON.stringify(value)} must stay pending`).toBe(true);
      expect(state.firstTelegraphTicks).toBe(TUTORIAL_FIRST_TELEGRAPH_TICKS);
    }
  });

  it('reads a missing key as pending and an exact done value as finished', () => {
    const { storage } = createStorage();

    expect(readTutorialState(storage)).toEqual({
      pending: true,
      firstTelegraphTicks: TUTORIAL_FIRST_TELEGRAPH_TICKS,
    });

    storage.set(TUTORIAL_STORAGE_KEY, TUTORIAL_DONE);
    expect(readTutorialState(storage)).toEqual({
      pending: false,
      firstTelegraphTicks: FIRST_TELEGRAPH_TICKS,
    });
  });

  it('persists done under the namespaced key and restores pending after removal', () => {
    const { storage, store } = createStorage();
    expect(store.getItem('playground:v1:zhen-sha.tutorial')).toBeNull();

    markTutorialDone(storage);
    expect(store.getItem('playground:v1:zhen-sha.tutorial')).toBe(TUTORIAL_DONE);
    expect(readTutorialState(storage).pending).toBe(false);

    storage.remove(TUTORIAL_STORAGE_KEY);
    expect(store.getItem('playground:v1:zhen-sha.tutorial')).toBeNull();
    expect(readTutorialState(storage).pending).toBe(true);
  });
});
