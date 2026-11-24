import { describe, expect, it } from 'vitest';
import { DEFAULT_BOSS_CHART, type BossChart } from './boss-chart';
import {
  REAL_BOSS_CHART,
  REAL_CHART_RECOVERY_MS,
  toBossChart,
} from './boss-chart-adapter';
import { BOSSES } from './bosses';
import {
  FIXED_STEP_MS,
  MAX_HITS,
  MOMENTUM_FOR_BREAK,
  SCORE_FINISHER,
  SCORE_PERFECT,
  TICKS_PER_SECOND,
  ZhenShaEngine,
} from './engine';

/** Mirror the engine's `durationToTicks`: round ms to whole ticks. */
function durationTicks(ms: number): number {
  return Math.round((ms * TICKS_PER_SECOND) / 1000);
}

/** Advance exactly `ticks` fixed steps. */
function advance(engine: ZhenShaEngine, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) {
    engine.step();
  }
}

/**
 * Landing ticks of the first three real moves when left unparried. Each
 * landing is followed by the adapter's 600 ms recovery before the next spawn.
 */
function realMissLandings(): readonly number[] {
  const phase = REAL_BOSS_CHART.bosses[0]?.phases[0];
  if (phase === undefined) {
    throw new Error('real chart must have an opening phase');
  }

  const recoveryTicks = durationTicks(REAL_CHART_RECOVERY_MS);
  const landings: number[] = [];
  let spawnTick = 0;
  for (let index = 0; index < MAX_HITS; index += 1) {
    const move = phase.moves[index];
    if (move === undefined) {
      throw new Error(`${phase.id} needs at least ${MAX_HITS} moves`);
    }
    const telegraphMs =
      index === 0
        ? (REAL_BOSS_CHART.firstTelegraphMs ?? move.telegraphMs)
        : move.telegraphMs;
    const impact = spawnTick + durationTicks(telegraphMs);
    landings.push(impact + Math.floor(durationTicks(move.activeMs) / 2));
    spawnTick = landings[index]! + recoveryTicks;
  }
  return landings;
}

/** The real chart with every display-damage value raised to 13. */
const HEAVY_REAL_CHART: BossChart = {
  ...REAL_BOSS_CHART,
  bosses: REAL_BOSS_CHART.bosses.map((boss) => ({
    ...boss,
    phases: boss.phases.map((phase) => ({
      ...phase,
      moves: phase.moves.map((move) => ({ ...move, damage: 13 })),
    })),
  })),
};

describe('real boss chart adapter', () => {
  it('maps the real 3 × 2 BOSSES table into the engine chart in order', () => {
    expect(REAL_BOSS_CHART.bosses).toHaveLength(3);
    expect(REAL_BOSS_CHART.bosses).toHaveLength(BOSSES.length);

    const mappedMoveIds: string[] = [];
    REAL_BOSS_CHART.bosses.forEach((boss, bossIndex) => {
      const source = BOSSES[bossIndex];
      if (source === undefined) {
        throw new Error(`missing source boss ${String(bossIndex + 1)}`);
      }
      expect(boss.name).toBe(source.id);
      expect(boss.phases).toHaveLength(2);
      expect(boss.phases).toHaveLength(source.phases.length);

      boss.phases.forEach((phase, phaseIndex) => {
        const sourcePhase = source.phases[phaseIndex];
        if (sourcePhase === undefined) {
          throw new Error(`missing source phase ${String(phaseIndex + 1)}`);
        }
        expect(phase.id).toBe(sourcePhase.id);
        expect(phase.moves).toHaveLength(sourcePhase.moves.length);

        phase.moves.forEach((move, moveIndex) => {
          const sourceMove = sourcePhase.moves[moveIndex];
          if (sourceMove === undefined) {
            throw new Error(`missing source move ${String(moveIndex + 1)}`);
          }
          expect(move).toEqual({
            id: sourceMove.id,
            telegraphMs: sourceMove.telegraphMs,
            activeMs: sourceMove.activeMs,
            parryWindowMs: sourceMove.parryWindowMs,
            // The source's 7–13 display points map to one unparried hit each.
            damage: 1,
          });
          mappedMoveIds.push(move.id);
        });
      });
    });

    const sourceMoveIds = BOSSES.flatMap((boss) =>
      boss.phases.flatMap((phase) => phase.moves.map((move) => move.id)),
    );
    expect(mappedMoveIds).toEqual(sourceMoveIds);
    expect(new Set(mappedMoveIds).size).toBe(mappedMoveIds.length);
  });

  it('reuses the kill-gate recovery and lets the first move own the opening tell', () => {
    expect(REAL_CHART_RECOVERY_MS).toBe(600);
    expect(REAL_CHART_RECOVERY_MS).toBe(DEFAULT_BOSS_CHART.recoveryMs);
    expect(REAL_BOSS_CHART.recoveryMs).toBe(REAL_CHART_RECOVERY_MS);
    expect(REAL_BOSS_CHART.firstTelegraphMs).toBeUndefined();
    expect(toBossChart()).toEqual(REAL_BOSS_CHART);
  });

  it('adapts a supplied real table instead of hard-coding the campaign', () => {
    const firstBossOnly = toBossChart(BOSSES.slice(0, 1));

    expect(firstBossOnly.recoveryMs).toBe(REAL_CHART_RECOVERY_MS);
    expect(firstBossOnly.bosses).toHaveLength(1);
    expect(firstBossOnly.bosses[0]?.name).toBe('boss-1');
    expect(firstBossOnly.bosses[0]?.phases).toHaveLength(2);
  });

  it('costs one hit per unparried real move and loses on the third', () => {
    const landings = realMissLandings();
    expect(new Set(landings).size).toBe(MAX_HITS);

    const engine = new ZhenShaEngine(REAL_BOSS_CHART);
    advance(engine, landings[0]! + 1);
    expect(engine.snapshot()).toMatchObject({ status: 'playing', hits: 1 });

    advance(engine, landings[1]! + 1 - engine.snapshot().step);
    expect(engine.snapshot()).toMatchObject({ status: 'playing', hits: 2 });

    advance(engine, landings[2]! + 1 - engine.snapshot().step);
    expect(engine.snapshot()).toMatchObject({
      status: 'lost',
      boss: { name: 'boss-1', phase: 1, guard: 'up' },
      hits: MAX_HITS,
      momentum: 0,
      breakTicksLeft: 0,
      lastJudgement: 'miss',
    });
    expect(engine.drainEvents().map((event) => event.type).at(-1)).toBe('lose');
  });

  it('keeps damage a display value: 13 still costs one hit per unparried move', () => {
    const landings = realMissLandings();
    const engine = new ZhenShaEngine(HEAVY_REAL_CHART);

    advance(engine, landings[0]! + 1);
    expect(engine.snapshot()).toMatchObject({ status: 'playing', hits: 1 });
    advance(engine, landings[1]! + 1 - engine.snapshot().step);
    expect(engine.snapshot()).toMatchObject({ status: 'playing', hits: 2 });
    advance(engine, landings[2]! + 1 - engine.snapshot().step);
    expect(engine.snapshot()).toMatchObject({
      status: 'lost',
      hits: MAX_HITS,
    });
    expect(engine.drainEvents().map((event) => event.type)).toEqual([
      'hit',
      'hit',
      'hit',
      'lose',
    ]);
  });

  it('advances the real chart from 1-1 to 1-2 with a fresh phase', () => {
    const engine = new ZhenShaEngine(REAL_BOSS_CHART);
    const impacts = [162, 378, 630];
    for (const impact of impacts) {
      engine.input('block', impact);
    }
    engine.input('charge', 635);
    engine.input('strike', 640);

    advance(engine, 641);
    expect(engine.snapshot()).toMatchObject({
      status: 'playing',
      boss: { name: 'boss-1', phase: 2, guard: 'up' },
      charging: false,
      momentum: 0,
      breakTicksLeft: 0,
    });

    const cleared = engine.snapshot();
    expect(cleared.perfects).toBe(MOMENTUM_FOR_BREAK);
    expect(cleared.score).toBe(3 * SCORE_PERFECT + SCORE_FINISHER);
    expect(cleared.lastJudgement).toBeNull();
    expect(cleared.attack).toBeNull();
    expect(cleared.elapsedMs).toBe(cleared.step * FIXED_STEP_MS);

    // Phase 2 restarts at its own first move (950 ms tell), not phase 1's list.
    advance(engine, 712 - engine.snapshot().step + 1);
    expect(engine.snapshot().step).toBe(713);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: 712 + durationTicks(950),
      phase: 'telegraph',
    });
  });
});
