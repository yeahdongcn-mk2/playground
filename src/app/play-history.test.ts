import { describe, expect, it } from 'vitest';
import type { GameModule } from '../core/game';
import { StorageService, type KeyValueStore } from '../core/storage';
import { renderHub } from './hub';
import { PlayHistory, formatLastPlayed } from './play-history';

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

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function createHistory(): { store: MemoryStore; history: PlayHistory } {
  const store = new MemoryStore();
  return { store, history: new PlayHistory(new StorageService(store, 'test:v1')) };
}

const snakeGame: GameModule = {
  meta: {
    id: 'snake',
    title: '贪食蛇',
    englishTitle: 'Snake',
    description: '测试用的贪食蛇卡片。',
    engine: 'phaser',
    genre: '街机',
    accent: '#a3e635',
    controls: ['方向键'],
  },
  async mount() {
    return { destroy() {} };
  },
};

const blankGame: GameModule = {
  meta: {
    id: 'blank',
    title: '空白画布',
    englishTitle: 'Blank Canvas',
    description: '测试用的画布卡片。',
    engine: 'phaser',
    genre: '框架演示',
    accent: '#22d3ee',
    controls: ['方向键'],
  },
  async mount() {
    return { destroy() {} };
  },
};

describe('PlayHistory', () => {
  it('records and reads a namespaced timestamp per game', () => {
    const { store, history } = createHistory();

    expect(history.lastPlayed('snake')).toBeNull();
    history.record('snake', NOW - 3 * MINUTE);

    expect(store.values.get('test:v1:snake.lastPlayed')).toBe(String(NOW - 3 * MINUTE));
    expect(history.lastPlayed('snake')).toBe(NOW - 3 * MINUTE);
    expect(history.lastPlayed('blank')).toBeNull();
  });

  it('keeps working when storage is missing or malformed', () => {
    const { store, history } = createHistory();
    store.setItem('test:v1:snake.lastPlayed', 'not-a-number');

    expect(history.lastPlayed('snake')).toBeNull();
    expect(new PlayHistory(new StorageService(null)).lastPlayed('snake')).toBeNull();
  });
});

describe('formatLastPlayed', () => {
  it('renders the never-played fallback', () => {
    expect(formatLastPlayed(null, NOW)).toBe('还没玩过');
  });

  it('renders relative times for the card', () => {
    expect(formatLastPlayed(NOW - 20_000, NOW)).toBe('刚刚');
    expect(formatLastPlayed(NOW - 3 * MINUTE, NOW)).toBe('3 分钟前');
    expect(formatLastPlayed(NOW - 59 * MINUTE, NOW)).toBe('59 分钟前');
    expect(formatLastPlayed(NOW - 2 * HOUR, NOW)).toBe('2 小时前');
    expect(formatLastPlayed(NOW - 5 * DAY, NOW)).toBe('5 天前');
  });

  it('treats a future timestamp from clock skew as just played', () => {
    expect(formatLastPlayed(NOW + 10_000, NOW)).toBe('刚刚');
  });
});

describe('hub cards', () => {
  it('renders the stored relative time and a never-played fallback', () => {
    const { history } = createHistory();
    history.record('snake', NOW - 3 * MINUTE);

    const html = renderHub([snakeGame, blankGame], history, NOW);

    expect(html).toContain('data-testid="game-card-last-played-snake"');
    expect(html).toContain('3 分钟前');
    expect(html).toContain('data-testid="game-card-last-played-blank"');
    expect(html).toContain('还没玩过');
  });
});
