export interface TileStyle {
  readonly fill: number;
  readonly text: number;
}

export const COLORS = {
  canvas: 0x04070e,
  frame: 0x0b1526,
  board: 0x0a1322,
  empty: 0x111d30,
  border: 0x263a58,
  highlight: 0xffffff,
} as const;

/**
 * Tile colors shared by every value the board can realistically reach. The
 * fallback keeps custom debug boards readable after 2048.
 */
export const TILE_STYLES: Readonly<Record<number, TileStyle>> = {
  2: { fill: 0xe2e8f0, text: 0x0b1220 },
  4: { fill: 0xcbd5e1, text: 0x0b1220 },
  8: { fill: 0xfbbf24, text: 0x0b1220 },
  16: { fill: 0xf59e0b, text: 0x0b1220 },
  32: { fill: 0xf97316, text: 0xffffff },
  64: { fill: 0xef4444, text: 0xffffff },
  128: { fill: 0xa855f7, text: 0xffffff },
  256: { fill: 0x8b5cf6, text: 0xffffff },
  512: { fill: 0x6366f1, text: 0xffffff },
  1024: { fill: 0x22d3ee, text: 0x04121a },
  2048: { fill: 0x67e8f9, text: 0x04121a },
};

export const FALLBACK_TILE: TileStyle = { fill: 0xf0abfc, text: 0x1a0b22 };
