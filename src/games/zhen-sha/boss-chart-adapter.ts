/**
 * The single adapter from the real `bosses.ts` data table to the engine's
 * `BossChart` contract.
 *
 * `bosses.ts` predates `boss-chart.ts` and describes the same rhythm with two
 * different field meanings. This module is the only place that reconciles the
 * units; its rules supersede the older field comments when the two meet:
 *
 * - `telegraphMs` and `parryWindowMs` mean the same thing in both modules and
 *   pass through unchanged.
 * - `activeMs` in `bosses.ts` is the time a move stays active after its
 *   wind-up; in `boss-chart.ts` it is the full width of the normal parry band,
 *   centred on the impact tick. The adapter treats the real value as the full
 *   band width (so the engine opens the band `activeMs / 2` on either side of
 *   impact) instead of inventing a second duration field.
 * - `damage` in `bosses.ts` is 7–13 fictional points; `BossMoveChart.damage`
 *   is how many of the engine's `MAX_HITS` (3) an unparried move costs. The
 *   adapter therefore maps every real move to `damage: 1`, keeping the
 *   three-hit end rule intact.
 * - Every phase rests for `REAL_CHART_RECOVERY_MS` after an exchange; the source
 *   table has no recovery field, so the default kill-gate pause is reused. The
 *   opening wind-up is the first move's own `telegraphMs`.
 *
 * Boss `name` uses the source `id`: the data table carries stable ids, not
 * display names, and copy stays a presentation concern.
 */

import type {
  BossChart,
  BossChartBoss,
  BossMoveChart,
  BossPhaseChart,
} from './boss-chart';
import {
  BOSSES,
  type BossChart as BossDataChart,
  type BossMove,
  type BossPhase,
} from './bosses';

/** Pause after a resolved exchange, matching the default kill-gate chart. */
export const REAL_CHART_RECOVERY_MS = 600;

/** Convert one real move to the engine contract, reconciling its units. */
function toMoveChart(move: BossMove): BossMoveChart {
  return {
    id: move.id,
    telegraphMs: move.telegraphMs,
    // Full normal-band width; the engine derives the two halves.
    activeMs: move.activeMs,
    // Full perfect-band width; also centred on impact.
    parryWindowMs: move.parryWindowMs,
    // One unparried real move costs one of the three allowed hits.
    damage: 1,
  };
}

function toPhaseChart(phase: BossPhase): BossPhaseChart {
  return {
    id: phase.id,
    moves: phase.moves.map(toMoveChart),
  };
}

function toBossChartBoss(boss: BossDataChart): BossChartBoss {
  return {
    name: boss.id,
    phases: boss.phases.map(toPhaseChart),
  };
}

/**
 * Convert the real 3 boss × 2 phase table to the engine's `BossChart`.
 *
 * Kept as a function so tests can prove the mapping directly and a later card
 * can derive a variant without copying the rules. `REAL_BOSS_CHART` is the
 * exact table a caller injects into the engine.
 */
export function toBossChart(
  bosses: readonly BossDataChart[] = BOSSES,
): BossChart {
  return {
    recoveryMs: REAL_CHART_RECOVERY_MS,
    bosses: bosses.map(toBossChartBoss),
  };
}

/** The real campaign: three bosses, two phases each, in `BOSSES` order. */
export const REAL_BOSS_CHART: BossChart = toBossChart();
