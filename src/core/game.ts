import type { AudioService } from './audio';
import type { StorageService } from './storage';

export type GameEngine = 'phaser' | 'three' | 'dom';

export interface GameMeta {
  readonly id: string;
  readonly title: string;
  readonly englishTitle: string;
  readonly description: string;
  readonly engine: GameEngine;
  readonly genre: string;
  readonly accent: string;
}

export interface GameServices {
  readonly storage: StorageService;
  readonly audio: AudioService;
}

export interface GameHandle {
  destroy(): void;
}

export interface GameModule {
  readonly meta: GameMeta;
  /** Load whatever engine the game needs and take over the given container. */
  mount(root: HTMLElement, services: GameServices): Promise<GameHandle>;
}
