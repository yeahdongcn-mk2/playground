/**
 * Resolve the debug `seed` query parameter to a deterministic RNG seed.
 *
 * The 2048 debug seam defaults to seed 1 when the parameter is missing or
 * invalid, so a bare `?debug=1` page is still deterministic. Only an explicit
 * finite number (including `0`) is used as-is. Kept local to the 2048 module
 * on purpose: importing the minesweeper helper would couple two games that
 * only happen to share this parsing rule.
 */
export function resolveDebugSeed(raw: string | null): number {
  const token = raw?.trim() ?? '';
  if (token === '') {
    return 1;
  }
  const seed = Number(token);
  return Number.isFinite(seed) ? seed : 1;
}
