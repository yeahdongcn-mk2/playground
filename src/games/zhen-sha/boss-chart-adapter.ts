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
 *   centred on the impact tick. The adapter keeps the source number and reads
 *   it as that full band width: the engine opens the band `activeMs / 2`
 *   before impact and closes it `activeMs / 2` after impact. The number is
 *   neither doubled nor shifted, so the source's ratio between `activeMs` and
 *   `parryWindowMs` is preserved.
 * - `damage` is a display / design point value in both contracts. The adapter
 *   passes the source 7–13 points through unchanged; the engine spends exactly
 *   one of its three allowed hits per unparried move, whatever this number
 *   says.
 * - Boss, phase and move ids are stable and pass through unchanged.
 *   `BossChartBoss` has no id field, so `name` temporarily carries the source
 *   boss id; the real display name is a later wiring decision. Phase and move
 *   ids stay on their own fields.
 * - The source table has no recovery pause or opening wind-up, so the mapped
 *   chart omits `recoveryMs` and `firstTelegraphMs`. The engine then rests for
 *   0 ms between exchanges and opens with the first move's own `telegraphMs`.
 */

import type {
  BossChart,
  BossChartBoss,
  BossMoveChart,
  BossPhaseChart,
} from './boss-chart';
import {
  BOSSES,
  type BossChart as BossesChart,
  type BossMove,
  type BossPhase,
} from './bosses';

/** Convert one real move to the engine contract, reconciling its units. */
function toMoveChart(move: BossMove): BossMoveChart {
  return {
    id: move.id,
    telegraphMs: move.telegraphMs,
    // Identity conversion documented in the module header: the source value is
    // read as the full centred normal-band width.
    activeMs: move.activeMs,
    parryWindowMs: move.parryWindowMs,
    // Display points only; the hit budget is not derived from this number.
    damage: move.damage,
  };
}

function toPhaseChart(phase: BossPhase): BossPhaseChart {
  return {
    id: phase.id,
    moves: phase.moves.map(toMoveChart),
  };
}

function toBossChartBoss(boss: BossesChart): BossChartBoss {
  return {
    // No id field in the engine contract yet; the stable id stands in for the
    // display name until the real campaign copy is wired.
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
  bosses: readonly BossesChart[] = BOSSES,
): BossChart {
  return {
    bosses: bosses.map(toBossChartBoss),
  };
}

/** The real campaign: three bosses, two phases each, in `BOSSES` order. */
export const REAL_BOSS_CHART: BossChart = toBossChart();
