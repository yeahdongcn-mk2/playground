import type { SnakeSnapshot } from './engine';

/** Upper bound for `createSeededRng`, which truncates its input to 32 bits. */
const MAX_DEBUG_SEED = 0xffffffff;
/** Keep a mistyped debug URL from freezing the page for an absurd step count. */
const MAX_DEBUG_TICKS = 100_000;

function parseDebugInt(raw: string | null, min: number, max: number): number | undefined {
  const token = raw?.trim() ?? '';
  if (token === '') {
    return undefined;
  }
  const value = Number(token);
  if (!Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

/**
 * Resolve the debug `seed` query parameter to an RNG seed.
 *
 * Returns `undefined` for a missing or invalid value so the view keeps its
 * previous per-mount random seed; only a debug page (the Vite dev server, or a
 * build opened with `?debug=1`) with an explicit integer uses a fixed seed.
 */
export function resolveDebugSeed(raw: string | null): number | undefined {
  return parseDebugInt(raw, 0, MAX_DEBUG_SEED);
}

/**
 * Resolve the debug `ticks` query parameter to a fixed tick count.
 *
 * Returns `undefined` for a missing or invalid value, leaving normal play (and
 * every route without the debug seam) on the wall-clock update path.
 */
export function resolveDebugTicks(raw: string | null): number | undefined {
  return parseDebugInt(raw, 0, MAX_DEBUG_TICKS);
}

declare global {
  interface Window {
    /**
     * Test seam. Installed on the Vite dev server, and in production builds
     * only when the page is opened with `?debug=1`.
     */
    __playground?: {
      gameId: 'snake';
      getState: () => SnakeSnapshot;
    };
  }
}
