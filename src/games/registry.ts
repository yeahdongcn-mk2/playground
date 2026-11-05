import type { GameModule } from '../core/game';
import { blankGame } from './blank';
import { snakeGame } from './snake';
import { tetrisGame } from './tetris';

/**
 * Static registry: it only imports metadata plus a lazy mount function for each
 * game. Adding a game therefore never pulls that game's engine into the shell.
 */
export const games: readonly GameModule[] = [snakeGame, tetrisGame, blankGame];

export function findGame(id: string): GameModule | undefined {
  return games.find((game) => game.meta.id === id);
}
