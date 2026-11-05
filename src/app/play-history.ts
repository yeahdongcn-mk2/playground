import type { StorageService } from '../core/storage';

/** Read-only view of each game's last-played timestamp, used by the hub. */
export interface PlayHistoryReader {
  lastPlayed(gameId: string): number | null;
}

const KEY_SUFFIX = '.lastPlayed';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Persist when a game was last opened. Timestamps live in the shared
 * namespaced storage, so they survive reloads without a backend.
 */
export class PlayHistory implements PlayHistoryReader {
  private readonly storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  record(gameId: string, at = Date.now()): void {
    this.storage.set(`${gameId}${KEY_SUFFIX}`, at);
  }

  lastPlayed(gameId: string): number | null {
    const value = this.storage.getNumber(`${gameId}${KEY_SUFFIX}`, 0);
    return value > 0 ? value : null;
  }
}

/** Render a stored timestamp as a short relative label for the hub card. */
export function formatLastPlayed(lastPlayed: number | null, now = Date.now()): string {
  if (lastPlayed === null) {
    return '还没玩过';
  }

  const elapsed = now - lastPlayed;
  // A clock change can make the stored timestamp look newer than "now"; show
  // the most useful label instead of a negative duration.
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) {
    return '刚刚';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)} 分钟前`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)} 小时前`;
  }
  return `${Math.floor(elapsed / DAY)} 天前`;
}
