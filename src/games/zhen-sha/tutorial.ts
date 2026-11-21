/**
 * First-visit tutorial state for Zhen Sha.
 *
 * Pure logic only: it reads and writes the shared `playground:v1` namespace
 * through `StorageService` and returns the timing the view needs. The key is
 * game-scoped (`zhen-sha.tutorial`), so the other five games keep their own
 * storage and teaching paths untouched.
 *
 * A fresh player sees one short hint and a stretched opening wind-up. Only the
 * exact value `done` marks the tutorial complete; a missing key, an unreadable
 * storage or any other value keeps it pending, so clearing the key restores
 * the first-visit experience.
 */

import type { StorageService } from '../../core/storage';
import { FIRST_TELEGRAPH_TICKS } from './engine';

/** Game-scoped key inside the shared storage namespace. */
export const TUTORIAL_STORAGE_KEY = 'zhen-sha.tutorial';

/** The only stored value that marks the tutorial as finished. */
export const TUTORIAL_DONE = 'done';

/** Four Han characters: wait for the killing move, then tap. */
export const TUTORIAL_HINT_TEXT = '等它出手';

/** Minimum factor applied to the opening wind-up on a first visit. */
export const TUTORIAL_TELEGRAPH_FACTOR = 1.5;

/** Stretched opening wind-up; integer ticks, >= 1.5x the normal baseline. */
export const TUTORIAL_FIRST_TELEGRAPH_TICKS = Math.ceil(
  FIRST_TELEGRAPH_TICKS * TUTORIAL_TELEGRAPH_FACTOR,
);

export interface TutorialState {
  /** True until the first perfect parry has been persisted as `done`. */
  readonly pending: boolean;
  /** Wind-up for the opening attack of a new duel in this state. */
  readonly firstTelegraphTicks: number;
}

/** Read the first-visit state and the opening wind-up it implies. */
export function readTutorialState(storage: StorageService): TutorialState {
  const done = storage.getString(TUTORIAL_STORAGE_KEY, '') === TUTORIAL_DONE;
  return {
    pending: !done,
    firstTelegraphTicks: done ? FIRST_TELEGRAPH_TICKS : TUTORIAL_FIRST_TELEGRAPH_TICKS,
  };
}

/** Persist the end of the tutorial; later mounts and restarts stay quiet. */
export function markTutorialDone(storage: StorageService): void {
  storage.set(TUTORIAL_STORAGE_KEY, TUTORIAL_DONE);
}
