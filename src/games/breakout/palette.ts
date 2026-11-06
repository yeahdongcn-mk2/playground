/** Shared breakout palette: one fill per engine brick colour tier, plus court colors. */

export const BRICK_COLORS = [0x22d3ee, 0x60a5fa, 0xa78bfa, 0xf472b6] as const;

export const BREAKOUT_COLORS = {
  canvas: 0x04070e,
  court: 0x08111f,
  courtEdge: 0x263a58,
  courtHighlight: 0x67e8f9,
  paddle: 0x67e8f9,
  paddleEdge: 0x22d3ee,
  paddleHighlight: 0xe0f2fe,
  ball: 0xf8fafc,
  ballGlow: 0x22d3ee,
  brickHighlight: 0xffffff,
} as const;
