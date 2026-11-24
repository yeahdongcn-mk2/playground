import { describe, expect, it } from 'vitest';
import { BOSSES } from './bosses';
import type { BossMove } from './bosses';
import { REAL_BOSS_CHART, toBossChart } from './boss-chart-adapter';
import {
  MAX_HITS,
  MOMENTUM_FOR_BREAK,
  TICKS_PER_SECOND,
  ZhenShaEngine,
} from './engine';
import type { ZhenShaSnapshot } from './engine';

function expectDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function toTicks(ms: number): number {
  return Math.round((ms * TICKS_PER_SECOND) / 1000);
}

function advanceUntil(
  engine: ZhenShaEngine,
  predicate: (snapshot: ZhenShaSnapshot) => boolean,
  limit = 5000,
): ZhenShaSnapshot {
  for (let index = 0; index <= limit; index += 1) {
    const snapshot = engine.snapshot();
    if (predicate(snapshot)) {
      return snapshot;
    }
    engine.step();
  }
  throw new Error('engine did not reach the expected state');
}

function advanceTo(engine: ZhenShaEngine, step: number): ZhenShaSnapshot {
  return advanceUntil(engine, (snapshot) => snapshot.step >= step);
}

function firstPhaseMove(index: number): BossMove {
  return expectDefined(
    BOSSES[0]?.phases[0]?.moves[index],
    `BOSSES[0].phases[0].moves[${String(index)}]`,
  );
}

/**
 * Impact ticks for perfect parries on the first boss's first phase. With no
 * chart-level recovery the next attack spawns on the tick after a parry, so
 * each later impact is the previous one plus one tick plus its own wind-up.
 */
function firstPhaseImpacts(count: number): number[] {
  const impacts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index === 0) {
      impacts.push(toTicks(firstPhaseMove(0).telegraphMs));
      continue;
    }
    const previous = expectDefined(impacts[index - 1], `impact ${String(index)}`);
    impacts.push(previous + 1 + toTicks(firstPhaseMove(index).telegraphMs));
  }
  return impacts;
}

describe('BOSSES to BossChart adapter', () => {
  it('maps three bosses with two phases each and keeps every source id', () => {
    expect(REAL_BOSS_CHART.bosses).toHaveLength(3);

    BOSSES.forEach((sourceBoss, bossIndex) => {
      const mappedBoss = expectDefined(
        REAL_BOSS_CHART.bosses[bossIndex],
        `mapped boss ${String(bossIndex + 1)}`,
      );
      expect(mappedBoss.name).toBe(sourceBoss.id);
      expect(mappedBoss.phases).toHaveLength(2);

      sourceBoss.phases.forEach((sourcePhase, phaseIndex) => {
        const mappedPhase = expectDefined(
          mappedBoss.phases[phaseIndex],
          `mapped phase ${sourcePhase.id}`,
        );
        expect(mappedPhase.id).toBe(sourcePhase.id);
        expect(mappedPhase.moves.map((move) => move.id)).toEqual(
          sourcePhase.moves.map((move) => move.id),
        );
      });
    });
  });

  it('passes timing and damage through unchanged and leaves BOSSES untouched', () => {
    const before = structuredClone(BOSSES);
    const chart = toBossChart();
    const sourceMoves = BOSSES.flatMap((boss) =>
      boss.phases.flatMap((phase) => phase.moves),
    );
    const mappedMoves = chart.bosses.flatMap((boss) =>
      boss.phases.flatMap((phase) => phase.moves),
    );

    expect(mappedMoves.map((move) => move.id)).toEqual(
      sourceMoves.map((move) => move.id),
    );
    mappedMoves.forEach((mapped, index) => {
      const source = expectDefined(
        sourceMoves[index],
        `source move ${String(index)}`,
      );
      expect(mapped.telegraphMs).toBe(source.telegraphMs);
      // Identity conversion documented in the adapter: the source post-wind-up
      // active time becomes the engine's full centred normal band unchanged.
      expect(mapped.activeMs).toBe(source.activeMs);
      expect(mapped.parryWindowMs).toBe(source.parryWindowMs);
      expect(mapped.damage).toBe(source.damage);
    });

    const damages = mappedMoves.map((move) => move.damage);
    expect(Math.min(...damages)).toBe(7);
    expect(Math.max(...damages)).toBe(13);
    expect(structuredClone(BOSSES)).toEqual(before);
  });

  it('spends one hit per unparried real move and loses on the third', () => {
    // The first real move's display damage is already above the whole budget,
    // so the budget can only stay intact if damage is not used as a hit cost.
    expect(firstPhaseMove(0).damage).toBeGreaterThan(MAX_HITS);

    const engine = new ZhenShaEngine(REAL_BOSS_CHART);
    const first = advanceUntil(engine, (snapshot) => snapshot.hits >= 1);
    expect(first.hits).toBe(1);
    expect(first.status).toBe('playing');
    expect(first.lastJudgement).toBe('miss');

    const second = advanceUntil(engine, (snapshot) => snapshot.hits >= 2);
    expect(second.hits).toBe(2);
    expect(second.status).toBe('playing');

    const third = advanceUntil(engine, (snapshot) => snapshot.status === 'lost');
    expect(third.hits).toBe(MAX_HITS);
    expect(third.lastJudgement).toBe('miss');

    const hitEvents = engine
      .drainEvents()
      .filter((event) => event.type === 'hit');
    expect(hitEvents).toHaveLength(MAX_HITS);
  });

  it('breaks the first guard with three perfect parries and a staff strike enters phase two', () => {
    const impacts = firstPhaseImpacts(MOMENTUM_FOR_BREAK);
    const engine = new ZhenShaEngine(REAL_BOSS_CHART);

    impacts.forEach((impact, index) => {
      engine.input('block', impact);
      const parried = advanceTo(engine, impact + 1);
      expect(parried.perfects).toBe(index + 1);
      expect(parried.momentum).toBe(index + 1);
      expect(parried.attack).toBeNull();
    });

    const lastImpact = expectDefined(impacts.at(-1), 'last impact');
    const phaseTwoTelegraph = toTicks(
      expectDefined(
        BOSSES[0]?.phases[1]?.moves[0],
        'BOSSES[0].phases[1].moves[0]',
      ).telegraphMs,
    );

    engine.input('charge', lastImpact + 1);
    engine.input('strike', lastImpact + 2);
    const advanced = advanceTo(engine, lastImpact + 4);

    expect(advanced.status).toBe('playing');
    expect(advanced.boss.name).toBe('boss-1');
    expect(advanced.boss.phase).toBe(2);
    expect(advanced.momentum).toBe(0);
    expect(advanced.hits).toBe(0);
    expect(advanced.attack?.phase).toBe('telegraph');
    expect(advanced.attack?.impactStep).toBe(lastImpact + 3 + phaseTwoTelegraph);
  });
});
