// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioService } from '../../core/audio';
import type { GameHandle, GameServices } from '../../core/game';
import { StorageService, type KeyValueStore } from '../../core/storage';
import type { MinesweeperConfig, MinesweeperSnapshot } from './engine';
import { bucketForConfig, createMinesweeperScores, SCORES_STORAGE_KEY } from './scores';
import { mountMinesweeper } from './view';

// The debug seam fixes a single mine at the top-left so every interaction below
// is deterministic instead of depending on the random mine placement.
const BOARD_HASH =
  '#/games/minesweeper?debug=1&rows=5&cols=5&mineCount=1&safeFirst=0&mines=0,0';
const MINE_ROW = 0;
const MINE_COL = 0;
const ROWS = 5;
const COLS = 5;
/** Bucket id for the fixed 5x5, one-mine board used by the core tests. */
const CUSTOM_BUCKET = 'custom:5x5x1:unsafe';
/** Storage key as it appears in the underlying KeyValueStore. */
const SCORES_STORE_KEY = `playground:v1:${SCORES_STORAGE_KEY}`;
/** A beginner preset board with ten fixed mines and an instant win at (8, 8). */
const PRESET_WIN_MINES = [
  '0,0',
  '0,1',
  '0,2',
  '1,0',
  '1,1',
  '1,2',
  '2,0',
  '2,1',
  '2,2',
  '0,3',
];
const PRESET_WIN_HASH = `#/games/minesweeper?debug=1&rows=9&cols=9&mineCount=10&safeFirst=1&mines=${PRESET_WIN_MINES.join(';')}`;
/** A beginner preset board whose row-4 mine wall leaves a timed win possible. */
const PRESET_LOSS_MINES = [
  '0,0',
  ...Array.from({ length: 9 }, (_, col) => `4,${col}`),
];
const PRESET_SAFE_CLICK = { row: 7, col: 4 } as const;
const PRESET_LOSS_HASH = `#/games/minesweeper?debug=1&rows=9&cols=9&mineCount=10&safeFirst=1&mines=${PRESET_LOSS_MINES.join(';')}`;
const BEGINNER_CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

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

const originalAudioContext = window.AudioContext;

/** Counts constructions; a disabled service must never reach the WebAudio API. */
class FakeAudioContext {
  static created = 0;

  constructor() {
    FakeAudioContext.created += 1;
  }

  createOscillator(): never {
    throw new Error('sound is off, so no oscillator should be created');
  }
}

interface MountedView {
  readonly root: HTMLElement;
  readonly handle: GameHandle;
}

let mounted: MountedView | null = null;

beforeEach(() => {
  FakeAudioContext.created = 0;
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: FakeAudioContext,
  });
});

afterEach(() => {
  mounted?.handle.destroy();
  mounted?.root.remove();
  mounted = null;
  window.location.hash = '';
  if (originalAudioContext) {
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: originalAudioContext,
    });
  } else {
    Reflect.deleteProperty(window, 'AudioContext');
  }
});

async function mount(services: GameServices, hash = BOARD_HASH): Promise<HTMLElement> {
  window.location.hash = hash;
  const root = document.createElement('div');
  document.body.append(root);
  const handle = await mountMinesweeper(root, services, new AbortController().signal);
  mounted = { root, handle };
  return root;
}

function cell(root: HTMLElement, row: number, col: number): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`[data-testid="cell-${row}-${col}"]`);
  if (!button) {
    throw new Error(`Expected cell ${row},${col}`);
  }
  return button;
}

function clickCell(root: HTMLElement, row: number, col: number): void {
  cell(root, row, col).click();
}

function flagCell(root: HTMLElement, row: number, col: number): void {
  cell(root, row, col).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
  );
}

function clickRestart(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>('[data-testid="restart-button"]');
  if (!button) {
    throw new Error('Expected restart button');
  }
  button.click();
}

function statusOf(root: HTMLElement): string {
  return root.querySelector<HTMLElement>('[data-testid="minesweeper-game"]')?.dataset.status ?? '';
}

function winCalls(play: ReturnType<typeof vi.fn>): unknown[] {
  return play.mock.calls.filter(([event]) => event === 'win');
}

/** Spy-backed services whose `enabled` getter throws if the view reads it. */
function createServices(store = new MemoryStore()): {
  services: GameServices;
  play: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
  store: MemoryStore;
} {
  const play = vi.fn();
  const unlock = vi.fn();
  const audio = {
    get enabled(): boolean {
      throw new Error('the minesweeper view must not read audio.enabled');
    },
    play,
    unlock,
  } as unknown as AudioService;
  return {
    services: {
      storage: new StorageService(store),
      audio,
      reduceMotion: false,
    },
    play,
    unlock,
    store,
  };
}

interface TestDebugApi {
  readonly setConfig: (config: MinesweeperConfig) => void;
  readonly getState: () => MinesweeperSnapshot;
}

function debugApi(): TestDebugApi | undefined {
  return (window as unknown as { __playground?: TestDebugApi }).__playground;
}

function gameState(): MinesweeperSnapshot {
  const api = debugApi();
  if (!api) {
    throw new Error('Expected the debug API');
  }
  return api.getState();
}

/** Mirror of the view's own formatting so assertions stay display-level. */
function displayTime(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function scoreRow(root: HTMLElement, bucketId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-score-bucket="${bucketId}"]`);
}

function scoreText(root: HTMLElement, bucketId: string): string {
  return scoreRow(root, bucketId)?.querySelector('dd')?.textContent ?? '';
}

function isHidden(root: HTMLElement, testId: string): boolean {
  return (
    root
      .querySelector(`[data-testid="${testId}"]`)
      ?.hasAttribute('hidden') ?? true
  );
}

function clickDifficulty(root: HTMLElement, id: string): void {
  const button = root.querySelector<HTMLButtonElement>(`[data-testid="difficulty-${id}"]`);
  if (!button) {
    throw new Error(`Expected difficulty button ${id}`);
  }
  button.click();
}

/** Reveal every still-hidden safe cell of the current (already planted) board. */
function winRemainingSafeCells(root: HTMLElement): void {
  for (const cell of gameState().board.flat()) {
    if (!cell.mine && !cell.revealed) {
      clickCell(root, cell.row, cell.col);
    }
  }
}

describe('minesweeper view sound feedback', () => {
  it('plays the reveal tone for a safe reveal and unlocks audio', async () => {
    const { services, play, unlock } = createServices();
    const root = await mount(services);

    clickCell(root, 0, 1);

    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith('reveal');
    expect(unlock).toHaveBeenCalled();
    expect(statusOf(root)).toBe('playing');
  });

  it('plays the mine tone instead of the reveal tone when a mine is hit', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    clickCell(root, MINE_ROW, MINE_COL);

    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith('mine');
    expect(play).not.toHaveBeenCalledWith('reveal');
    expect(statusOf(root)).toBe('lost');
  });

  it('plays the flag tone when placing and when clearing a flag', async () => {
    const { services, play, unlock } = createServices();
    const root = await mount(services);

    flagCell(root, 2, 2);
    flagCell(root, 2, 2);

    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls).toEqual([['flag'], ['flag']]);
    expect(unlock).toHaveBeenCalledTimes(2);
  });

  it('does not play a tone when revealing an already revealed cell', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    // (0,1) touches the mine at (0,0), so this reveal stops at a numbered
    // cell and the game stays in progress. Clicking the same cell again enters
    // the engine's "already revealed" no-op branch instead of the won-state
    // early return, which is the behavior under test.
    clickCell(root, 0, 1);
    expect(statusOf(root)).toBe('playing');
    expect(cell(root, 0, 1).dataset.revealed).toBe('true');
    play.mockClear();

    clickCell(root, 0, 1);

    expect(statusOf(root)).toBe('playing');
    expect(play).not.toHaveBeenCalled();
  });

  it('plays win exactly once when the first reveal clears the board', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    // (2,2) flood-fills every safe cell, so the engine jumps from ready to won
    // during the very first reveal and the view never observes "playing".
    clickCell(root, 2, 2);

    expect(statusOf(root)).toBe('won');
    expect(play.mock.calls.map(([event]) => event)).toEqual(['reveal', 'win']);
  });

  it('plays win exactly once for the playing -> won transition and ignores input afterwards', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        if (row === MINE_ROW && col === MINE_COL) {
          continue;
        }
        clickCell(root, row, col);
      }
    }

    expect(statusOf(root)).toBe('won');
    expect(winCalls(play)).toHaveLength(1);

    // The winning reveal plays its reveal tone immediately before the chime.
    const events = play.mock.calls.map(([event]) => event);
    expect(events.at(-2)).toBe('reveal');
    expect(events.at(-1)).toBe('win');

    // Further input after the win is ignored: the status stays won, no mine or
    // flag tone plays, and the chime never repeats.
    clickCell(root, MINE_ROW, MINE_COL);
    flagCell(root, 2, 2);
    expect(statusOf(root)).toBe('won');
    expect(play).not.toHaveBeenCalledWith('mine');
    expect(play).not.toHaveBeenCalledWith('flag');
    expect(winCalls(play)).toHaveLength(1);
  });

  it('plays win once per game and never replays it on restart or rebuild', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    clickCell(root, 2, 2);
    expect(statusOf(root)).toBe('won');
    expect(winCalls(play)).toHaveLength(1);

    // Restarting resets the board without replaying the previous game's chime.
    clickRestart(root);
    expect(statusOf(root)).toBe('ready');
    expect(winCalls(play)).toHaveLength(1);

    clickCell(root, 2, 2);
    expect(statusOf(root)).toBe('won');
    expect(winCalls(play)).toHaveLength(2);

    // Rebuilding the board resets the game without replaying the chime either.
    debugApi()?.setConfig({ rows: ROWS, cols: COLS, mines: 1, firstClickSafe: false });
    expect(statusOf(root)).toBe('ready');
    expect(winCalls(play)).toHaveLength(2);
  });

  it('does not create an AudioContext while the global sound switch is off', async () => {
    const store = new MemoryStore();
    store.setItem('playground:v1:settings.sound', 'off');
    const storage = new StorageService(store);
    const audio = new AudioService(storage);
    expect(audio.enabled).toBe(false);
    const play = vi.spyOn(audio, 'play');
    const root = await mount({ storage, audio, reduceMotion: false });

    clickCell(root, 0, 1);
    flagCell(root, 2, 2);

    // The view still calls play(); muting is entirely the service's job.
    expect(play).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledWith('reveal');
    expect(play).toHaveBeenCalledWith('flag');
    expect(FakeAudioContext.created).toBe(0);
  });
});

describe('minesweeper best-time leaderboard', () => {
  it('starts from an empty table with the empty-state copy', async () => {
    const { services, store } = createServices();
    const root = await mount(services);

    expect(
      root.querySelector<HTMLElement>('[data-testid="scores-empty"]')?.textContent,
    ).toBe('还没有记录');
    expect(isHidden(root, 'scores-empty')).toBe(false);
    expect(isHidden(root, 'scores-presets')).toBe(true);
    expect(isHidden(root, 'scores-custom')).toBe(true);
    expect(store.getItem(SCORES_STORE_KEY)).toBeNull();
  });

  it('records the winning time immediately for the active bucket', async () => {
    const { services } = createServices();
    const root = await mount(services);

    clickCell(root, 2, 2);
    expect(statusOf(root)).toBe('won');
    const state = gameState();
    const expected = displayTime(state.elapsedMs);

    expect(scoreText(root, CUSTOM_BUCKET)).toBe(expected);
    expect(scoreRow(root, CUSTOM_BUCKET)?.textContent).toContain(
      '自定义 5×5 / 1 雷（首点不安全）',
    );
    expect(isHidden(root, 'scores-empty')).toBe(true);
    expect(isHidden(root, 'scores-presets')).toBe(false);
    expect(isHidden(root, 'scores-custom')).toBe(false);
    // Preset rows keep their fixed order and use a placeholder when they have
    // no record yet.
    expect(scoreText(root, 'beginner')).toBe('—');
    expect(scoreText(root, 'intermediate')).toBe('—');
    expect(scoreText(root, 'expert')).toBe('—');
    expect(
      createMinesweeperScores(services.storage).best(
        bucketForConfig({ rows: 5, cols: 5, mines: 1, firstClickSafe: false }),
      ),
    ).toBe(state.elapsedMs);
  });

  it('shows a preset win in its fixed preset row', async () => {
    const { services } = createServices();
    const root = await mount(services, PRESET_WIN_HASH);

    clickCell(root, 8, 8);
    expect(statusOf(root)).toBe('won');
    expect(scoreText(root, 'beginner')).toBe(displayTime(gameState().elapsedMs));
    expect(isHidden(root, 'scores-custom')).toBe(true);

    const presetIds = Array.from(
      root.querySelectorAll(
        '[data-testid="scores-presets"] [data-score-bucket]',
      ),
    ).map((row) => row.getAttribute('data-score-bucket'));
    expect(presetIds).toEqual(['beginner', 'intermediate', 'expert']);
  });

  it('never records a lost game', async () => {
    const { services, store } = createServices();
    const root = await mount(services);

    clickCell(root, MINE_ROW, MINE_COL);
    expect(statusOf(root)).toBe('lost');
    expect(isHidden(root, 'scores-empty')).toBe(false);
    expect(isHidden(root, 'scores-presets')).toBe(true);
    expect(scoreText(root, CUSTOM_BUCKET)).toBe('');
    expect(store.getItem(SCORES_STORE_KEY)).toBeNull();
  });

  it('writes a win once and never again on restart or a difficulty change', async () => {
    const { services, store } = createServices();
    const setItem = vi.spyOn(store, 'setItem');
    const root = await mount(services);
    const scoreWrites = (): unknown[][] =>
      setItem.mock.calls.filter(([key]) => key === SCORES_STORE_KEY);

    clickCell(root, 2, 2);
    expect(statusOf(root)).toBe('won');
    expect(scoreWrites()).toHaveLength(1);

    clickRestart(root);
    expect(statusOf(root)).toBe('ready');
    expect(scoreWrites()).toHaveLength(1);

    debugApi()?.setConfig(BEGINNER_CONFIG);
    expect(statusOf(root)).toBe('ready');
    expect(scoreWrites()).toHaveLength(1);
  });

  it('keeps a faster stored time when a later win is slower', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'Date',
      ],
    });
    try {
      const { services } = createServices();
      const scores = createMinesweeperScores(services.storage);
      const beginner = bucketForConfig(BEGINNER_CONFIG);
      scores.record(beginner, 1_200);

      const root = await mount(services, PRESET_LOSS_HASH);
      expect(scoreText(root, 'beginner')).toBe('0:01');

      clickCell(root, PRESET_SAFE_CLICK.row, PRESET_SAFE_CLICK.col);
      expect(statusOf(root)).toBe('playing');
      vi.advanceTimersByTime(2_500);
      expect(gameState().elapsedMs).toBeGreaterThanOrEqual(2_500);

      winRemainingSafeCells(root);
      expect(statusOf(root)).toBe('won');
      expect(gameState().elapsedMs).toBeGreaterThanOrEqual(2_500);

      // 0:02 would be slower than the stored 0:01, so the table must not move.
      expect(scoreText(root, 'beginner')).toBe('0:01');
      expect(scores.best(beginner)).toBe(1_200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every bucket when the difficulty changes and shows the matching rows', async () => {
    const { services } = createServices();
    const scores = createMinesweeperScores(services.storage);
    const beginner = bucketForConfig(BEGINNER_CONFIG);
    const customBoard = bucketForConfig({
      rows: 12,
      cols: 12,
      mines: 20,
      firstClickSafe: true,
    });
    scores.record(beginner, 5_000);
    scores.record(customBoard, 7_000);

    const root = await mount(services);
    expect(isHidden(root, 'scores-custom')).toBe(false);
    expect(scoreText(root, 'beginner')).toBe('0:05');
    expect(scoreText(root, customBoard.id)).toBe('0:07');
    expect(scoreRow(root, customBoard.id)?.textContent).toContain(
      '自定义 12×12 / 20 雷',
    );
    // The mounted 5x5 board itself has no record, so it is not listed.
    expect(scoreText(root, CUSTOM_BUCKET)).toBe('');

    clickDifficulty(root, 'beginner');
    expect(statusOf(root)).toBe('ready');
    expect(scoreText(root, 'beginner')).toBe('0:05');
    expect(scoreText(root, customBoard.id)).toBe('0:07');
  });

  it('reads the same table back after a remount with the same storage service', async () => {
    const { services } = createServices();
    const first = await mount(services);
    clickCell(first, 2, 2);
    const shown = scoreText(first, CUSTOM_BUCKET);
    expect(shown).toBe(displayTime(gameState().elapsedMs));

    mounted?.handle.destroy();
    mounted?.root.remove();
    mounted = null;

    const second = await mount(services);
    expect(scoreText(second, CUSTOM_BUCKET)).toBe(shown);
    expect(isHidden(second, 'scores-empty')).toBe(true);
  });

  it.each([
    ['invalid JSON', '{not-json'],
    [
      'an older schema version',
      JSON.stringify({ version: 0, records: { beginner: 1_000 } }),
    ],
    [
      'an invalid record payload',
      JSON.stringify({ version: 1, records: { beginner: -5 } }),
    ],
  ])('starts empty and clears %s', async (_label, raw) => {
    const { services, store } = createServices();
    store.setItem(SCORES_STORE_KEY, raw);

    const root = await mount(services);
    expect(statusOf(root)).toBe('ready');
    expect(isHidden(root, 'scores-empty')).toBe(false);
    expect(isHidden(root, 'scores-presets')).toBe(true);
    expect(store.getItem(SCORES_STORE_KEY)).toBeNull();
  });
});
