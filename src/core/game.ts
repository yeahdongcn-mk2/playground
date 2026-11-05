import type { AudioService } from './audio';
import type { StorageService } from './storage';

/**
 * Engines are loaded lazily by each game module. The shell and core layers never
 * import them, so adding a 3D game does not grow the 2D bundle (and vice versa).
 */
export type GameEngine = 'phaser' | 'three' | 'dom';

export interface GameMeta {
  readonly id: string;
  readonly title: string;
  readonly englishTitle: string;
  readonly description: string;
  readonly engine: GameEngine;
  readonly genre: string;
  readonly accent: string;
  readonly controls: readonly string[];
}

/** Shared capabilities handed to every game at mount time. */
export interface GameServices {
  readonly storage: StorageService;
  readonly audio: AudioService;
  readonly reduceMotion: boolean;
}

/** A mounted game. The shell calls destroy() on every route change. */
export interface GameHandle {
  destroy(): void;
}

export interface GameModule {
  readonly meta: GameMeta;
  /**
   * Load the game's engine if needed, take over the container and resolve when
   * ready. The signal is aborted when the user leaves the route; late work must
   * stop and resolve with an AbortError instead of mounting into a dead view.
   */
  mount(root: HTMLElement, services: GameServices, signal: AbortSignal): Promise<GameHandle>;
}
