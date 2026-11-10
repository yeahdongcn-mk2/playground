// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** One cell of the current engine snapshot, with a clear failure when missing. */
function snapshotCell(row: number, col: number) {
  const target = gameState().board[row]?.[col];
  if (!target) {
    throw new Error(`Expected cell ${row},${col} in the snapshot`);
  }
  return target;
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
  const row = scoreRow(root, bucketId);
  if (!row) {
    throw new Error(`Expected a score row for ${bucketId}`);
  }
  return row.querySelector('dd')?.textContent ?? '';
}

function isHidden(root: HTMLElement, testId: string): boolean {
  const element = root.querySelector(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Expected ${testId}`);
  }
  return element.hasAttribute('hidden');
}

function clearScoresButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(
    '[data-testid="clear-scores-button"]',
  );
  if (!button) {
    throw new Error('Expected clear-scores button');
  }
  return button;
}

function announcerText(root: HTMLElement): string {
  return root.querySelector<HTMLElement>('[data-testid="announcer"]')?.textContent ?? '';
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

describe('minesweeper large-board warning', () => {
  function largeBoardState(root: HTMLElement): string | undefined {
    return root.querySelector<HTMLElement>('[data-testid="minesweeper-game"]')
      ?.dataset.largeBoard;
  }

  it('marks boards wider than nine columns and exposes readable warning copy', async () => {
    const { services } = createServices();
    const root = await mount(services);

    const warning = root.querySelector<HTMLElement>(
      '[data-testid="board-size-warning"]',
    );
    expect(warning).not.toBeNull();
    expect(warning?.getAttribute('role')).toBe('status');
    expect(warning?.textContent).toContain('≥36px');
    expect(warning?.textContent).toContain('9×9');
    expect(warning?.textContent).toContain('横屏');
    expect(warning?.textContent).toContain('更小的棋盘');

    // The default 5×5 debug board is not a large board; the preset 9×9 stays
    // at the guaranteed width, while a wide custom board flips the state.
    expect(largeBoardState(root)).toBe('false');
    debugApi()?.setConfig(BEGINNER_CONFIG);
    expect(largeBoardState(root)).toBe('false');
    debugApi()?.setConfig({
      rows: 16,
      cols: 30,
      mines: 99,
      firstClickSafe: true,
    });
    expect(largeBoardState(root)).toBe('true');

    // Switching back to 9×9 must clear the state, not just leave the warning
    // hidden by CSS.
    debugApi()?.setConfig(BEGINNER_CONFIG);
    expect(largeBoardState(root)).toBe('false');
  });
});

describe('minesweeper square-board state', () => {
  function squareBoardState(root: HTMLElement): string | undefined {
    return root.querySelector<HTMLElement>('[data-testid="minesweeper-game"]')
      ?.dataset.squareBoard;
  }

  it('marks only boards whose rows and columns match', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // The default 5×5 debug board and the 9×9 preset are square; a wide custom
    // board must not inherit the square-board stage ratio.
    expect(squareBoardState(root)).toBe('true');
    debugApi()?.setConfig(BEGINNER_CONFIG);
    expect(squareBoardState(root)).toBe('true');
    debugApi()?.setConfig({
      rows: 16,
      cols: 30,
      mines: 99,
      firstClickSafe: true,
    });
    expect(squareBoardState(root)).toBe('false');
    debugApi()?.setConfig({
      rows: 16,
      cols: 16,
      mines: 40,
      firstClickSafe: true,
    });
    expect(squareBoardState(root)).toBe('true');

    debugApi()?.setConfig(BEGINNER_CONFIG);
    expect(squareBoardState(root)).toBe('true');
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

  it('keeps the clear action visible but disabled on an empty table', async () => {
    const { services } = createServices();
    const root = await mount(services);

    const button = clearScoresButton(root);
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('清空记录');

    // A disabled button cannot run the clear action.
    button.click();
    expect(isHidden(root, 'scores-empty')).toBe(false);
    expect(announcerText(root)).toBe('');
  });

  it('clears every score in one click while other game and settings keys survive', async () => {
    const { services, store } = createServices();
    store.setItem('playground:v1:snake.highscore', '42');
    store.setItem('playground:v1:settings.sound', 'off');
    store.setItem('playground:v1:snake.lastPlayed', '1700000000000');
    const scores = createMinesweeperScores(services.storage);
    scores.record(bucketForConfig(BEGINNER_CONFIG), 1_200);
    scores.record(
      bucketForConfig({ rows: 12, cols: 12, mines: 20, firstClickSafe: true }),
      7_000,
    );

    const root = await mount(services);
    expect(isHidden(root, 'scores-empty')).toBe(true);
    expect(isHidden(root, 'scores-presets')).toBe(false);
    expect(scoreText(root, 'beginner')).toBe('0:01');
    expect(scoreText(root, 'custom:12x12x20:safe')).toBe('0:07');

    const button = clearScoresButton(root);
    expect(button.disabled).toBe(false);
    button.click();

    // The panel switches to the empty state right away and the whole score key
    // is gone; a second click is harmless because the button is disabled again.
    expect(isHidden(root, 'scores-empty')).toBe(false);
    expect(isHidden(root, 'scores-presets')).toBe(true);
    expect(isHidden(root, 'scores-custom')).toBe(true);
    expect(store.getItem(SCORES_STORE_KEY)).toBeNull();
    expect(button.disabled).toBe(true);
    expect(announcerText(root)).toBe('最高用时记录已清空');

    // Other games and settings share the same underlying store and must remain.
    expect(store.getItem('playground:v1:snake.highscore')).toBe('42');
    expect(store.getItem('playground:v1:settings.sound')).toBe('off');
    expect(store.getItem('playground:v1:snake.lastPlayed')).toBe('1700000000000');
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
    expect(scoreRow(root, CUSTOM_BUCKET)).toBeNull();
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
    const shown = scoreText(root, CUSTOM_BUCKET);
    expect(scoreWrites()).toHaveLength(1);

    clickRestart(root);
    expect(statusOf(root)).toBe('ready');
    expect(scoreText(root, CUSTOM_BUCKET)).toBe(shown);
    expect(scoreWrites()).toHaveLength(1);

    const api = debugApi();
    expect(api).toBeDefined();
    api?.setConfig(BEGINNER_CONFIG);
    expect(statusOf(root)).toBe('ready');
    // Prove the rebuild really happened instead of letting a missing debug
    // seam make the optional call a silent no-op.
    expect(root.querySelectorAll('[data-cell]')).toHaveLength(81);
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-testid="difficulty-beginner"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(scoreWrites()).toHaveLength(1);
  });

  it('re-reads the stored table on restart instead of keeping the old DOM', async () => {
    const { services, store } = createServices();
    const root = await mount(services);
    // The mounted view starts from an empty table; this DOM snapshot is what a
    // stale restart would keep showing.
    expect(isHidden(root, 'scores-empty')).toBe(false);
    expect(scoreText(root, 'beginner')).toBe('—');

    // Another tab records a best time while this view is open. Restart must
    // re-read storage: without renderScores() the empty state and the
    // placeholder would survive even though the store has a record.
    createMinesweeperScores(services.storage).record(
      bucketForConfig(BEGINNER_CONFIG),
      1_200,
    );
    clickRestart(root);
    expect(isHidden(root, 'scores-empty')).toBe(true);
    expect(isHidden(root, 'scores-presets')).toBe(false);
    expect(scoreText(root, 'beginner')).toBe('0:01');

    // The same re-read must notice corruption written by another tab and drop
    // the whole table instead of rendering the previous rows.
    store.setItem(SCORES_STORE_KEY, '{not-json');
    clickRestart(root);
    expect(isHidden(root, 'scores-empty')).toBe(false);
    expect(isHidden(root, 'scores-presets')).toBe(true);
    expect(isHidden(root, 'scores-custom')).toBe(true);
    expect(store.getItem(SCORES_STORE_KEY)).toBeNull();
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

  it('records the real elapsed time for a timed win', async () => {
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
      const root = await mount(services, PRESET_LOSS_HASH);

      clickCell(root, PRESET_SAFE_CLICK.row, PRESET_SAFE_CLICK.col);
      expect(statusOf(root)).toBe('playing');
      vi.advanceTimersByTime(2_500);
      winRemainingSafeCells(root);

      expect(statusOf(root)).toBe('won');
      const elapsedMs = gameState().elapsedMs;
      expect(elapsedMs).toBeGreaterThanOrEqual(2_500);
      expect(scoreText(root, 'beginner')).toBe(displayTime(elapsedMs));
      expect(scoreText(root, 'beginner')).not.toBe('0:00');
      expect(scores.best(beginner)).toBe(elapsedMs);
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
    expect(scoreRow(root, CUSTOM_BUCKET)).toBeNull();

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

/**
 * jsdom ships PointerEvent today, but this minimal stand-in keeps the
 * WebKit-shaped cases meaningful in an environment that only has MouseEvent.
 */
class MinimalPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? '';
    this.isPrimary = init.isPrimary ?? false;
  }
}

let originalPointerEvent: typeof PointerEvent | undefined;

beforeAll(() => {
  originalPointerEvent = window.PointerEvent;
  if (typeof window.PointerEvent !== 'function') {
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      writable: true,
      value: MinimalPointerEvent,
    });
  }
});

afterAll(() => {
  if (originalPointerEvent) {
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      writable: true,
      value: originalPointerEvent,
    });
  } else {
    Reflect.deleteProperty(window, 'PointerEvent');
  }
});

/** Real WebKit touch shape: pointerdown is touch id 2, click is mouse id 1. */
const TOUCH_POINTER_ID = 2;
const WEBKIT_CLICK_POINTER_ID = 1;
/** A second touch finger, used to check cross-pointer bookkeeping. */
const SECOND_TAP_POINTER_ID = 3;
const LONG_PRESS_DELAY_MS = 500;

function pointerEvent(type: string, init: PointerEventInit): PointerEvent {
  return new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
}

function startTouchPress(
  root: HTMLElement,
  row: number,
  col: number,
  pointerId = TOUCH_POINTER_ID,
): void {
  cell(root, row, col).dispatchEvent(
    pointerEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 20,
    }),
  );
}

function moveTouchPress(
  root: HTMLElement,
  row: number,
  col: number,
  pointerId = TOUCH_POINTER_ID,
): void {
  cell(root, row, col).dispatchEvent(
    pointerEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 60,
      clientY: 20,
    }),
  );
}

function endTouchPress(
  root: HTMLElement,
  row: number,
  col: number,
  pointerId = TOUCH_POINTER_ID,
): void {
  cell(root, row, col).dispatchEvent(
    pointerEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: 10,
      clientY: 20,
    }),
  );
}

function cancelTouchPress(
  root: HTMLElement,
  row: number,
  col: number,
  pointerId = TOUCH_POINTER_ID,
): void {
  cell(root, row, col).dispatchEvent(
    pointerEvent('pointercancel', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: 10,
      clientY: 20,
    }),
  );
}

/** The real release click WebKit emits for a touch: mouse pointer id 1. */
function clickRelease(
  root: HTMLElement,
  row: number,
  col: number,
  detail = 1,
): void {
  cell(root, row, col).dispatchEvent(
    pointerEvent('click', {
      pointerId: WEBKIT_CLICK_POINTER_ID,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
      detail,
    }),
  );
}

function board(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>('[data-testid="minesweeper-board"]');
  if (!element) {
    throw new Error('Expected the minesweeper board');
  }
  return element;
}

describe('minesweeper touch click suppression', () => {
  // The fake clock makes the 500 ms long press deterministic without waiting.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function pressAndHold(
    root: HTMLElement,
    row: number,
    col: number,
    pointerId = TOUCH_POINTER_ID,
  ): void {
    startTouchPress(root, row, col, pointerId);
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
  }

  it('swallows the WebKit release click after a long press flags and unflags a cell', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    // A hold on an unflagged mine only places a flag; the release click must
    // not reveal the mine afterwards.
    pressAndHold(root, MINE_ROW, MINE_COL);
    expect(snapshotCell(MINE_ROW, MINE_COL).flagged).toBe(true);
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);

    expect(cell(root, MINE_ROW, MINE_COL).dataset.state).toBe('flagged');
    expect(cell(root, MINE_ROW, MINE_COL).dataset.revealed).toBeUndefined();
    expect(statusOf(root)).toBe('ready');
    expect(play.mock.calls).toEqual([['flag']]);

    // A second hold on the flagged cell clears the flag; its release click must
    // also be swallowed instead of revealing the now unflagged mine.
    play.mockClear();
    pressAndHold(root, MINE_ROW, MINE_COL);
    expect(snapshotCell(MINE_ROW, MINE_COL).flagged).toBe(false);
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);

    expect(cell(root, MINE_ROW, MINE_COL).dataset.state).toBe('hidden');
    expect(cell(root, MINE_ROW, MINE_COL).dataset.revealed).toBeUndefined();
    expect(statusOf(root)).toBe('ready');
    expect(play.mock.calls).toEqual([['flag']]);
  });

  it('reveals exactly once for a quick tap with the WebKit release click shape', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    // (0,1) touches the mine at (0,0), so the reveal stops at a numbered cell
    // and the game stays in progress instead of flood-filling a win.
    startTouchPress(root, 0, 1);
    endTouchPress(root, 0, 1);
    clickRelease(root, 0, 1);

    expect(cell(root, 0, 1).dataset.revealed).toBe('true');
    expect(statusOf(root)).toBe('playing');
    expect(play.mock.calls.filter(([event]) => event === 'reveal')).toHaveLength(1);
  });

  it('does not let a second pointer clear the first pointer suppression', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // Flag the mine first so a leaked release click would reveal it.
    pressAndHold(root, MINE_ROW, MINE_COL);
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);

    // A first finger holds long enough to clear the flag; its release click is
    // already pending when a second finger taps another cell.
    const firstPointerId = 11;
    pressAndHold(root, MINE_ROW, MINE_COL, firstPointerId);
    expect(snapshotCell(MINE_ROW, MINE_COL).flagged).toBe(false);

    startTouchPress(root, 0, 1, 12);
    endTouchPress(root, 0, 1, 12);
    // The second finger's click is not the suppressed one and must reveal.
    clickRelease(root, 0, 1);
    expect(cell(root, 0, 1).dataset.revealed).toBe('true');

    // The first finger's release click still belongs to the suppressed hold.
    endTouchPress(root, MINE_ROW, MINE_COL, firstPointerId);
    clickRelease(root, MINE_ROW, MINE_COL);
    expect(cell(root, MINE_ROW, MINE_COL).dataset.revealed).toBeUndefined();
    expect(statusOf(root)).toBe('playing');
  });

  it('swallows cancelled gesture clicks without leaving a stale suppression', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // Movement beyond the tolerance cancels the hold.
    startTouchPress(root, MINE_ROW, MINE_COL);
    moveTouchPress(root, MINE_ROW, MINE_COL);
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);
    expect(cell(root, MINE_ROW, MINE_COL).dataset.state).toBe('hidden');
    expect(statusOf(root)).toBe('ready');

    // pointerleave on the board cancels as well.
    startTouchPress(root, MINE_ROW, MINE_COL);
    board(root).dispatchEvent(
      pointerEvent('pointerleave', { pointerId: TOUCH_POINTER_ID, pointerType: 'touch' }),
    );
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);
    expect(cell(root, MINE_ROW, MINE_COL).dataset.state).toBe('hidden');
    expect(statusOf(root)).toBe('ready');

    // A scroll cancels a hold even without pointercancel.
    startTouchPress(root, MINE_ROW, MINE_COL);
    window.dispatchEvent(new Event('scroll'));
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);
    expect(cell(root, MINE_ROW, MINE_COL).dataset.state).toBe('hidden');
    expect(statusOf(root)).toBe('ready');

    // pointercancel never produces a click, so it must not leave suppression
    // behind: the next real tap still reveals.
    startTouchPress(root, MINE_ROW, MINE_COL);
    cancelTouchPress(root, MINE_ROW, MINE_COL);
    startTouchPress(root, 2, 2);
    endTouchPress(root, 2, 2);
    clickRelease(root, 2, 2);
    expect(cell(root, 2, 2).dataset.revealed).toBe('true');
  });

  it('drops a cancelled gesture token before a later tap with another pointer id', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // pointerleave cancels the hold without a release click, so its suppression
    // token stays pending. The next tap comes from a different pointer id and
    // must reveal: a stale token may not swallow it.
    startTouchPress(root, 0, 1, TOUCH_POINTER_ID);
    board(root).dispatchEvent(
      pointerEvent('pointerleave', {
        pointerId: TOUCH_POINTER_ID,
        pointerType: 'touch',
      }),
    );

    startTouchPress(root, 0, 1, SECOND_TAP_POINTER_ID);
    endTouchPress(root, 0, 1, SECOND_TAP_POINTER_ID);
    clickRelease(root, 0, 1);

    // (0,1) is adjacent to the mine at (0,0), so the reveal does not win.
    expect(cell(root, 0, 1).dataset.revealed).toBe('true');
    expect(statusOf(root)).toBe('playing');
  });

  it('consumes released tokens when a click misses every cell', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // A cancelled hold leaves a token for (0, 1). A release click on the board
    // background is not a cell, so it must consume the token instead of leaving
    // it to swallow the next real tap.
    startTouchPress(root, 0, 1, TOUCH_POINTER_ID);
    board(root).dispatchEvent(
      pointerEvent('pointerleave', {
        pointerId: TOUCH_POINTER_ID,
        pointerType: 'touch',
      }),
    );
    endTouchPress(root, 0, 1, TOUCH_POINTER_ID);
    board(root).dispatchEvent(
      pointerEvent('click', {
        pointerId: WEBKIT_CLICK_POINTER_ID,
        pointerType: 'mouse',
        isPrimary: true,
        detail: 1,
        button: 0,
        buttons: 0,
      }),
    );
    expect(statusOf(root)).toBe('ready');

    // The background click consumed the token, so a following click without a
    // fresh pointerdown is not swallowed.
    clickRelease(root, 0, 1);
    expect(cell(root, 0, 1).dataset.revealed).toBe('true');

    // A detached token (rebuild) is consumed the same way when the release
    // click misses every cell, so it cannot swallow a later tap.
    startTouchPress(root, 4, 4, TOUCH_POINTER_ID);
    debugApi()?.setConfig({ rows: 6, cols: 6, mines: 10, firstClickSafe: true });
    endTouchPress(root, 5, 5, TOUCH_POINTER_ID);
    board(root).dispatchEvent(
      pointerEvent('click', {
        pointerId: WEBKIT_CLICK_POINTER_ID,
        pointerType: 'mouse',
        isPrimary: true,
        detail: 1,
        button: 0,
        buttons: 0,
      }),
    );
    expect(statusOf(root)).toBe('ready');

    clickRelease(root, 0, 1);
    expect(cell(root, 0, 1).dataset.revealed).toBe('true');
    expect(statusOf(root)).toBe('playing');
  });

  it('keeps a rebuilt board click suppressed while its finger is still down', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // Hold the 5x5 bottom-right cell, then rebuild to 6x6 while the finger is
    // still down. The rebuild detaches the token from its old cell.
    startTouchPress(root, 4, 4, TOUCH_POINTER_ID);
    debugApi()?.setConfig({ rows: 6, cols: 6, mines: 10, firstClickSafe: true });

    // A second finger taps a cell before the first lifts. That click belongs to
    // the second finger and must reveal instead of consuming the pending
    // detached token.
    startTouchPress(root, 0, 1, SECOND_TAP_POINTER_ID);
    endTouchPress(root, 0, 1, SECOND_TAP_POINTER_ID);
    clickRelease(root, 0, 1);
    expect(cell(root, 0, 1).dataset.revealed).toBe('true');

    // The first finger's release click is still swallowed after the rebuild,
    // wherever it lands; pick a cell the second finger's reveal did not open.
    const release = gameState().board.flat().find((candidate) => !candidate.revealed);
    if (!release) {
      throw new Error('Expected a hidden cell after the second finger reveal');
    }
    endTouchPress(root, release.row, release.col, TOUCH_POINTER_ID);
    clickRelease(root, release.row, release.col);
    expect(cell(root, release.row, release.col).dataset.revealed).toBeUndefined();
    expect(statusOf(root)).toBe('playing');
  });

  it('keeps the pending suppression across restart and rebuild', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // Restart while a finger is down; the release click still targets the held
    // cell on the restarted board and must be swallowed.
    startTouchPress(root, MINE_ROW, MINE_COL);
    clickRestart(root);
    expect(statusOf(root)).toBe('ready');
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);
    expect(cell(root, MINE_ROW, MINE_COL).dataset.revealed).toBeUndefined();
    expect(statusOf(root)).toBe('ready');

    // Rebuilding into a larger board replaces the cell elements while the same
    // finger is down. The cell under the finger moves from the 5x5 board's
    // bottom-right (4,4) to the new board's (5,5), so the pending token cannot
    // be matched by its old coordinates; the release click must still be
    // swallowed instead of revealing (5,5).
    startTouchPress(root, 4, 4);
    debugApi()?.setConfig({ rows: 6, cols: 6, mines: 1, firstClickSafe: true });
    expect(root.querySelectorAll('[data-cell]')).toHaveLength(36);
    endTouchPress(root, 5, 5);
    clickRelease(root, 5, 5);
    expect(cell(root, 5, 5).dataset.revealed).toBeUndefined();
    expect(statusOf(root)).toBe('ready');
  });

  it('drops a pending press when the mount is destroyed', async () => {
    const { services } = createServices();
    const root = await mount(services);

    startTouchPress(root, MINE_ROW, MINE_COL);
    vi.advanceTimersByTime(100);
    mounted?.handle.destroy();

    // The aborted listeners ignore the rest of the gesture, and destroy clears
    // the long-press timer so it cannot flag after teardown.
    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    expect(cell(root, MINE_ROW, MINE_COL).dataset.state).toBe('hidden');
    expect(statusOf(root)).toBe('ready');
    expect(debugApi()).toBeUndefined();
  });

  it('keeps keyboard detail 0 and desktop clicks working while a touch is pending', async () => {
    const { services } = createServices();
    const root = await mount(services);

    // A hold leaves a suppression token; keyboard activation has detail 0 and
    // must not consume it or be swallowed by it.
    pressAndHold(root, MINE_ROW, MINE_COL);
    // (0,1) touches the mine, so the reveal does not flood-fill a win.
    cell(root, 0, 1).click();
    expect(cell(root, 0, 1).dataset.revealed).toBe('true');
    expect(statusOf(root)).toBe('playing');

    endTouchPress(root, MINE_ROW, MINE_COL);
    clickRelease(root, MINE_ROW, MINE_COL);
    expect(cell(root, MINE_ROW, MINE_COL).dataset.revealed).toBeUndefined();

    // Right click keeps toggling a flag, and a desktop left click reveals.
    flagCell(root, 1, 3);
    expect(snapshotCell(1, 3).flagged).toBe(true);
    clickRelease(root, 3, 3);
    expect(cell(root, 3, 3).dataset.revealed).toBe('true');
  });
});
