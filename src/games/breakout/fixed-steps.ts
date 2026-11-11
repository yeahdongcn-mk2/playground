import { FIXED_STEP_MS } from './engine';

/**
 * Advance exactly `steps` fixed simulation steps.
 *
 * The debug capture seam needs the simulated state to depend only on the seed
 * and the requested step count, never on wall-clock frame deltas. This loop
 * lives outside the Phaser scene so the exact boundary can be unit tested
 * without booting Phaser; the scene still calls it to produce the screenshot
 * state.
 */
export function advanceFixedSteps(
  steps: number,
  advance: (delta: number) => void,
): void {
  for (let index = 0; index < steps; index += 1) {
    advance(FIXED_STEP_MS);
  }
}
