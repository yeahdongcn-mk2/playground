// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioService } from '../../core/audio';
import type { GameHandle, GameServices } from '../../core/game';
import { StorageService, type KeyValueStore } from '../../core/storage';
import type { MinesweeperConfig } from './engine';
import { mountMinesweeper } from './view';

// The debug seam fixes a single mine at the top-left so every interaction below
// is deterministic instead of depending on the random mine placement.
const BOARD_HASH =
  '#/games/minesweeper?debug=1&rows=5&cols=5&mineCount=1&safeFirst=0&mines=0,0';
const MINE_ROW = 0;
const MINE_COL = 0;
const ROWS = 5;
const COLS = 5;

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

async function mount(services: GameServices): Promise<HTMLElement> {
  window.location.hash = BOARD_HASH;
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

function statusOf(root: HTMLElement): string {
  return root.querySelector<HTMLElement>('[data-testid="minesweeper-game"]')?.dataset.status ?? '';
}

/** Spy-backed services whose `enabled` getter throws if the view reads it. */
function createServices(): {
  services: GameServices;
  play: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
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
      storage: new StorageService(new MemoryStore()),
      audio,
      reduceMotion: false,
    },
    play,
    unlock,
  };
}

interface TestDebugApi {
  readonly setConfig: (config: MinesweeperConfig) => void;
}

function debugApi(): TestDebugApi | undefined {
  return (window as unknown as { __playground?: TestDebugApi }).__playground;
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

  it('does not play a tone for a reveal that changes nothing', async () => {
    const { services, play } = createServices();
    const root = await mount(services);

    clickCell(root, 2, 2);
    play.mockClear();
    clickCell(root, 2, 2);

    expect(play).not.toHaveBeenCalled();
  });

  it('plays win exactly once for the playing -> won transition and never repeats it', async () => {
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
    const winCalls = (): unknown[] =>
      play.mock.calls.filter(([event]) => event === 'win');
    expect(winCalls()).toHaveLength(1);

    // The winning reveal plays its reveal tone immediately before the chime.
    const events = play.mock.calls.map(([event]) => event);
    expect(events.at(-2)).toBe('reveal');
    expect(events.at(-1)).toBe('win');

    // Further input after the win is ignored and must not replay the chime.
    clickCell(root, MINE_ROW, MINE_COL);
    flagCell(root, 2, 2);
    expect(winCalls()).toHaveLength(1);

    // Rebuilding the board resets the game without replaying the win.
    debugApi()?.setConfig({ rows: ROWS, cols: COLS, mines: 1, firstClickSafe: false });
    expect(statusOf(root)).toBe('ready');
    expect(winCalls()).toHaveLength(1);
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
