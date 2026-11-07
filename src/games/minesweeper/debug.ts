/**
 * Resolve the debug `seed` query parameter to a deterministic RNG seed.
 *
 * The debug seam defaults to seed 1, so a bare `?debug=1` page is still
 * deterministic. Only an explicitly supplied finite number (including `0`)
 * is used as-is; a missing, blank, non-numeric or non-finite value falls
 * back to 1.
 */
export function resolveDebugSeed(raw: string | null): number {
  const token = raw?.trim() ?? '';
  if (token === '') {
    return 1;
  }
  const seed = Number(token);
  return Number.isFinite(seed) ? seed : 1;
}
