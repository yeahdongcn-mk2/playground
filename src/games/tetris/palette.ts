import type { TetrominoType } from './engine';

/**
 * One palette shared by the Phaser board and the DOM next-piece preview, so a
 * piece keeps the same identity in both places. Numeric values feed Phaser's
 * graphics API; the CSS strings style the small preview grid.
 */
export interface TetrominoColors {
  readonly core: number;
  readonly css: string;
}

export const TETROMINO_COLORS: Readonly<Record<TetrominoType, TetrominoColors>> = {
  I: { core: 0x38bdf8, css: '#38bdf8' },
  O: { core: 0xfacc15, css: '#facc15' },
  T: { core: 0xc084fc, css: '#c084fc' },
  S: { core: 0x4ade80, css: '#4ade80' },
  Z: { core: 0xf87171, css: '#f87171' },
  J: { core: 0x60a5fa, css: '#60a5fa' },
  L: { core: 0xfb923c, css: '#fb923c' },
};
