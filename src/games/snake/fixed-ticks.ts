/**
 * Advance exactly `ticks` deterministic Snake simulation ticks.
 *
 * The debug capture seam must not depend on wall-clock frame deltas: every
 * engine tick already advances the snake by exactly one grid cell and uses the
 * current `stepMs`. This loop lives outside the Phaser scene so the exact
 * boundary can be unit tested without booting Phaser; the scene still calls it
 * to produce the screenshot state.
 *
 * `advance` may return `false` to stop early, for example after the snake dies
 * or wins before the requested tick count is reached.
 */
export function advanceFixedTicks(
  ticks: number,
  advance: () => boolean | void,
): void {
  for (let index = 0; index < ticks; index += 1) {
    if (advance() === false) {
      return;
    }
  }
}
