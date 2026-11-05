/** Minimal storage abstraction with namespacing and safe fallbacks. */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class StorageService {
  private readonly store: KeyValueStore | null;
  private readonly namespace: string;

  constructor(store: KeyValueStore | null, namespace = 'playground:v1') {
    this.store = store;
    this.namespace = namespace;
  }

  getString(key: string, fallback: string): string {
    return this.read(key) ?? fallback;
  }

  getNumber(key: string, fallback: number): number {
    const value = this.read(key);
    if (value === null) {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  getBoolean(key: string, fallback: boolean): boolean {
    const value = this.read(key);
    if (value === null) {
      return fallback;
    }
    return value === 'true' || value === 'on' || value === '1';
  }

  set(key: string, value: string | number | boolean): void {
    try {
      this.store?.setItem(this.key(key), String(value));
    } catch {
      // Storage can be unavailable (private mode, quota). Games must keep working.
    }
  }

  remove(key: string): void {
    try {
      this.store?.removeItem(this.key(key));
    } catch {
      // Ignore unavailable storage.
    }
  }

  private read(key: string): string | null {
    try {
      return this.store?.getItem(this.key(key)) ?? null;
    } catch {
      return null;
    }
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }
}

/** Resolve browser localStorage without assuming it exists or is writable. */
export function createBrowserStorage(namespace = 'playground:v1'): StorageService {
  return new StorageService(resolveLocalStorage(), namespace);
}

function resolveLocalStorage(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
