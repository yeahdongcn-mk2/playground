import type { GameModule } from '../core/game';
import { game2048 } from './2048';
import { blankGame } from './blank';
import { breakoutGame } from './breakout';
import { minesweeperGame } from './minesweeper';
import { snakeGame } from './snake';
import { tetrisGame } from './tetris';

/**
 * Static registry: it only imports metadata plus a lazy mount function for each
 * game. Adding a game therefore never pulls that game's engine into the shell.
 */
export const games: readonly GameModule[] = [
  snakeGame,
  tetrisGame,
  game2048,
  breakoutGame,
  minesweeperGame,
  blankGame,
];

export function findGame(id: string): GameModule | undefined {
  return games.find((game) => game.meta.id === id);
}
