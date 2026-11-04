import type { GameModule } from '../core/game';
import { snakeGame } from './snake';

/** Playable games. Adding a game here makes it appear in the hub; cards may need their own art. */
export const GAMES: readonly GameModule[] = [snakeGame];

export interface UpcomingGame {
  readonly title: string;
  readonly englishTitle: string;
  readonly description: string;
  readonly engine: string;
  readonly accent: string;
}

/** Roadmap cards: honest "planned" entries, never fake playable links. */
export const UPCOMING_GAMES: readonly UpcomingGame[] = [
  {
    title: '霓虹打砖块',
    englishTitle: 'Neon Breakout',
    description: '验证同一套 2D 场景、计分与关卡数据管线，复用 Phaser 引擎层。',
    engine: 'Phaser · 2D',
    accent: '#22d3ee',
  },
  {
    title: '立体迷宫',
    englishTitle: '3D Labyrinth',
    description: '首个 3D 试点：用 Three.js 适配器接入共享的输入、音频与存档服务。',
    engine: 'Three.js · 3D',
    accent: '#c084fc',
  },
];

export function findGame(id: string): GameModule | undefined {
  return GAMES.find((game) => game.meta.id === id);
}
