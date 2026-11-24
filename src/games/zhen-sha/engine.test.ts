import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOSS_CHART,
  type BossChart,
  type BossMoveChart,
} from './boss-chart';
import {
  BREAK_TICKS,
  FIXED_STEP_MS,
  FIRST_TELEGRAPH_TICKS,
  MAX_HITS,
  MOMENTUM_FOR_BREAK,
  NORMAL_BAND_HALF_TICKS,
  PERFECT_BAND_HALF_TICKS,
  RECOVERY_TICKS,
  SCORE_FINISHER,
  SCORE_NORMAL,
  SCORE_PERFECT,
  TELEGRAPH_TICKS,
  TICKS_PER_SECOND,
  ZhenShaEngine,
  type ParryJudgement,
  type ZhenShaAction,
  type ZhenShaEvent,
  type ZhenShaSnapshot,
} from './engine';

const FIRST_IMPACT = FIRST_TELEGRAPH_TICKS;
/** Ticks between the perfect parries of consecutive moves. */
const MOVE_GAP = TELEGRAPH_TICKS + RECOVERY_TICKS;
/** The third perfect parry lands here and opens the break. */
const BREAK_START = FIRST_IMPACT + 2 * MOVE_GAP;
/** The mixed schedule misses the second move two ticks outside the band. */
const WHIFF_STEP = FIRST_IMPACT + MOVE_GAP - (NORMAL_BAND_HALF_TICKS + 2);
/** The missed second move lands here, then its recovery shifts the schedule. */
const SECOND_HIT = FIRST_IMPACT + MOVE_GAP + NORMAL_BAND_HALF_TICKS;
const THIRD_IMPACT =
  SECOND_HIT + RECOVERY_TICKS + TELEGRAPH_TICKS;
const FOURTH_IMPACT = THIRD_IMPACT + MOVE_GAP;

/** Advance exactly `ticks` simulation steps, in groups of `chunkTicks`. */
function advance(engine: ZhenShaEngine, ticks: number, chunkTicks = 1): void {
  let remaining = ticks;
  while (remaining > 0) {
    const take = Math.min(chunkTicks, remaining);
    engine.update(take * FIXED_STEP_MS);
    remaining -= take;
  }
}

/** Tap `offset` ticks from the first impact, then read the resulting state. */
function judgeTap(offset: number): ZhenShaSnapshot {
  const engine = new ZhenShaEngine();
  engine.input('block', FIRST_IMPACT + offset);
  advance(engine, FIRST_IMPACT + offset + 1);
  return engine.snapshot();
}

/** Land three perfect parries by following the deterministic move schedule. */
function perfectThree(): ZhenShaEngine {
  const engine = new ZhenShaEngine();
  for (let move = 0; move < MOMENTUM_FOR_BREAK; move += 1) {
    engine.input('block', FIRST_IMPACT + move * MOVE_GAP);
  }
  advance(engine, BREAK_START + 1);
  return engine;
}

const BOUNDARY_CASES: ReadonlyArray<
  readonly [offset: number, judgement: ParryJudgement, hits: number]
> = [
  // Perfect band edges and their neighbours: outside is still a normal parry.
  [-PERFECT_BAND_HALF_TICKS - 1, 'normal', 0],
  [-PERFECT_BAND_HALF_TICKS, 'perfect', 0],
  [-PERFECT_BAND_HALF_TICKS + 1, 'perfect', 0],
  [0, 'perfect', 0],
  [PERFECT_BAND_HALF_TICKS - 1, 'perfect', 0],
  [PERFECT_BAND_HALF_TICKS, 'perfect', 0],
  [PERFECT_BAND_HALF_TICKS + 1, 'normal', 0],
  // Normal band edges and their neighbours: outside is a whiff.
  [-NORMAL_BAND_HALF_TICKS - 1, 'miss', 0],
  [-NORMAL_BAND_HALF_TICKS, 'normal', 0],
  [-NORMAL_BAND_HALF_TICKS + 1, 'normal', 0],
  [NORMAL_BAND_HALF_TICKS - 1, 'normal', 0],
  [NORMAL_BAND_HALF_TICKS, 'normal', 0],
  [NORMAL_BAND_HALF_TICKS + 1, 'miss', 1],
];

describe('ZhenShaEngine setup', () => {
  it('starts with a first wind-up and an empty scoreboard', () => {
    const engine = new ZhenShaEngine();
    const snapshot = engine.snapshot();

    expect(snapshot.step).toBe(0);
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.status).toBe('playing');
    expect(snapshot.boss).toEqual({ name: '黑煞', phase: 1, guard: 'up' });
    expect(snapshot.attack).toEqual({
      impactStep: FIRST_IMPACT,
      ticksUntilImpact: FIRST_IMPACT,
      phase: 'telegraph',
      committed: false,
    });
    expect(snapshot).toMatchObject({
      charging: false,
      momentum: 0,
      perfects: 0,
      hits: 0,
      score: 0,
      breakTicksLeft: 0,
      lastJudgement: null,
    });
    expect(engine.state).toEqual(snapshot);
    expect(engine.currentStatus).toBe('playing');
  });

  it('pins the exported timing and score constants the view relies on', () => {
    expect(TICKS_PER_SECOND).toBe(120);
    expect(FIXED_STEP_MS).toBeCloseTo(1000 / 120, 12);
    expect(PERFECT_BAND_HALF_TICKS).toBe(6);
    expect(NORMAL_BAND_HALF_TICKS).toBe(18);
    expect(FIRST_TELEGRAPH_TICKS).toBe(180);
    expect(TELEGRAPH_TICKS).toBe(108);
    expect(RECOVERY_TICKS).toBe(72);
    expect(BREAK_TICKS).toBe(240);
    expect(MAX_HITS).toBe(3);
    expect(MOMENTUM_FOR_BREAK).toBe(3);
    expect(SCORE_PERFECT).toBe(300);
    expect(SCORE_NORMAL).toBe(100);
    expect(SCORE_FINISHER).toBe(1000);
  });

  it('exposes the wind-up and active strike phases', () => {
    const engine = new ZhenShaEngine();

    advance(engine, FIRST_IMPACT - 1);
    expect(engine.snapshot().attack).toMatchObject({
      phase: 'telegraph',
      ticksUntilImpact: 1,
    });

    advance(engine, 1);
    expect(engine.snapshot().attack).toMatchObject({
      phase: 'active',
      ticksUntilImpact: 0,
    });

    advance(engine, NORMAL_BAND_HALF_TICKS + 1);
    expect(engine.snapshot().attack).toBeNull();
  });

  it('ignores non-positive and non-finite deltas', () => {
    const engine = new ZhenShaEngine();

    engine.update(0);
    engine.update(-1);
    engine.update(Number.NaN);
    engine.update(Number.POSITIVE_INFINITY);

    expect(engine.snapshot().step).toBe(0);
  });

  it('accumulates partial deltas into whole fixed ticks', () => {
    const engine = new ZhenShaEngine();

    engine.update(FIXED_STEP_MS / 2);
    expect(engine.snapshot().step).toBe(0);

    engine.update(FIXED_STEP_MS / 2);
    expect(engine.snapshot().step).toBe(1);

    engine.update(FIXED_STEP_MS * 2.5);
    expect(engine.snapshot().step).toBe(3);
  });

  it('caps one update at 250 ms of simulation', () => {
    const engine = new ZhenShaEngine();

    engine.update(10_000);

    expect(engine.snapshot().step).toBe(30);
  });
});

describe('parry timing bands', () => {
  it.each(BOUNDARY_CASES)(
    'judges a tap %i ticks from impact as %s',
    (offset, judgement, hits) => {
      const snapshot = judgeTap(offset);

      expect(snapshot.lastJudgement).toBe(judgement);
      expect(snapshot.hits).toBe(hits);
      if (judgement === 'perfect') {
        expect(snapshot.perfects).toBe(1);
        expect(snapshot.momentum).toBe(1);
        expect(snapshot.score).toBe(SCORE_PERFECT);
        expect(snapshot.attack).toBeNull();
      } else if (judgement === 'normal') {
        expect(snapshot.perfects).toBe(0);
        expect(snapshot.momentum).toBe(0);
        expect(snapshot.score).toBe(SCORE_NORMAL);
        expect(snapshot.attack).toBeNull();
      } else {
        expect(snapshot.perfects).toBe(0);
        expect(snapshot.momentum).toBe(0);
        expect(snapshot.score).toBe(0);
      }
    },
  );

  it('commits an early whiff: the move still lands', () => {
    const engine = new ZhenShaEngine();
    engine.input('block', FIRST_IMPACT - NORMAL_BAND_HALF_TICKS - 1);

    advance(engine, FIRST_IMPACT + NORMAL_BAND_HALF_TICKS + 2);

    const snapshot = engine.snapshot();
    expect(snapshot.lastJudgement).toBe('miss');
    expect(snapshot.hits).toBe(1);
    expect(snapshot.attack).toBeNull();
  });

  it('marks a whiffed move as committed', () => {
    const engine = new ZhenShaEngine();
    engine.input('block', FIRST_IMPACT - NORMAL_BAND_HALF_TICKS - 1);
    advance(engine, FIRST_IMPACT);

    const snapshot = engine.snapshot();
    expect(snapshot.lastJudgement).toBe('miss');
    expect(snapshot.attack).toMatchObject({
      impactStep: FIRST_IMPACT,
      ticksUntilImpact: 0,
      phase: 'active',
      committed: true,
    });
  });

  it('does not let a second tap rescue an early whiff', () => {
    const engine = new ZhenShaEngine();
    engine.input('block', FIRST_IMPACT - NORMAL_BAND_HALF_TICKS - 12);
    engine.input('block', FIRST_IMPACT);
    advance(engine, FIRST_IMPACT + NORMAL_BAND_HALF_TICKS + 2);

    const snapshot = engine.snapshot();
    expect(snapshot.lastJudgement).toBe('miss');
    expect(snapshot.perfects).toBe(0);
    expect(snapshot.hits).toBe(1);
  });

  it('punishes mashing instead of rewarding it', () => {
    const engine = new ZhenShaEngine();
    // A tap on every tick. The third move lands on tick 594, so 700 is enough.
    for (let tick = 0; tick < 700; tick += 1) {
      engine.input('block', tick);
    }
    advance(engine, 700);

    const snapshot = engine.snapshot();
    expect(snapshot.perfects).toBe(0);
    expect(snapshot.status).toBe('lost');
  });

  it('applies live input on the next fixed tick', () => {
    const engine = new ZhenShaEngine();
    advance(engine, FIRST_IMPACT);

    engine.input('block');
    engine.update(FIXED_STEP_MS);

    expect(engine.snapshot().lastJudgement).toBe('perfect');
    expect(engine.snapshot().perfects).toBe(1);
  });

  it('floors fractional input ticks', () => {
    const engine = new ZhenShaEngine();
    engine.input('block', FIRST_IMPACT - 0.1); // floors to one tick before impact
    advance(engine, FIRST_IMPACT + 1);

    expect(engine.snapshot().perfects).toBe(1);
  });

  it('still applies queued input whose tick is already past', () => {
    const engine = new ZhenShaEngine();
    advance(engine, 10);

    engine.input('charge', -5);
    engine.input('charge', Number.NaN);
    advance(engine, 1);

    expect(engine.snapshot().charging).toBe(true);
  });

  it('applies an out-of-order queue in tick order', () => {
    const engine = new ZhenShaEngine();
    // Queue the later action first, as a replay prefilling its schedule might.
    engine.input('block', FIRST_IMPACT);
    engine.input('charge', 10);

    advance(engine, 11);
    expect(engine.snapshot().step).toBe(11);
    expect(engine.snapshot().charging).toBe(true);
    expect(engine.snapshot().perfects).toBe(0);

    advance(engine, FIRST_IMPACT - 10);
    expect(engine.snapshot().perfects).toBe(1);
  });

  it('rejects unknown actions', () => {
    const engine = new ZhenShaEngine();

    expect(() => engine.input('parry' as ZhenShaAction)).toThrow(RangeError);
  });

  it('scores a normal parry without building momentum', () => {
    const snapshot = judgeTap(PERFECT_BAND_HALF_TICKS + 1);

    expect(snapshot.lastJudgement).toBe('normal');
    expect(snapshot.score).toBe(SCORE_NORMAL);
    expect(snapshot.momentum).toBe(0);
    expect(snapshot.perfects).toBe(0);
  });
});

describe('feedback events', () => {
  it('emits every public event with the step that produced it', () => {
    const engine = new ZhenShaEngine();

    // 1. A normal parry seven ticks after the first impact.
    const NORMAL_TAP = FIRST_IMPACT + PERFECT_BAND_HALF_TICKS + 1;
    // The normal parry schedules the next wind-up one recovery later.
    const SECOND_IMPACT = NORMAL_TAP + RECOVERY_TICKS + TELEGRAPH_TICKS;
    // 2. A whiff outside the normal band commits the second move to landing.
    const WHIFF_TAP = SECOND_IMPACT - NORMAL_BAND_HALF_TICKS - 2;
    const SECOND_HIT_STEP = SECOND_IMPACT + NORMAL_BAND_HALF_TICKS;
    // 3. Charging and releasing with the guard up only produces a bare strike.
    const CHARGE_STEP = SECOND_HIT_STEP + RECOVERY_TICKS + 3;
    const STRIKE_STEP = CHARGE_STEP + 10;
    // 4. Three perfect parries open the break, which then expires.
    const THIRD_IMPACT = SECOND_HIT_STEP + RECOVERY_TICKS + TELEGRAPH_TICKS;
    const FOURTH_IMPACT = THIRD_IMPACT + MOVE_GAP;
    const FIFTH_IMPACT = FOURTH_IMPACT + MOVE_GAP;
    const BREAK_END = FIFTH_IMPACT + BREAK_TICKS;

    engine.input('block', NORMAL_TAP);
    engine.input('block', WHIFF_TAP);
    engine.input('charge', CHARGE_STEP);
    engine.input('strike', STRIKE_STEP);
    engine.input('block', THIRD_IMPACT);
    engine.input('block', FOURTH_IMPACT);
    engine.input('block', FIFTH_IMPACT);
    advance(engine, BREAK_END + 1);

    expect(engine.drainEvents()).toEqual([
      { type: 'normal', step: NORMAL_TAP },
      { type: 'miss', step: WHIFF_TAP },
      { type: 'hit', step: SECOND_HIT_STEP },
      { type: 'strike', step: STRIKE_STEP },
      { type: 'perfect', step: THIRD_IMPACT },
      { type: 'perfect', step: FOURTH_IMPACT },
      { type: 'perfect', step: FIFTH_IMPACT },
      { type: 'break', step: FIFTH_IMPACT },
      { type: 'break-end', step: BREAK_END },
    ]);
    expect(engine.snapshot()).toMatchObject({
      step: BREAK_END + 1,
      status: 'playing',
      hits: 1,
      perfects: 3,
      momentum: 0,
      boss: { guard: 'up' },
    });
  });

  it('returns drained events once and clears the queue', () => {
    const engine = new ZhenShaEngine();
    engine.input('block', FIRST_IMPACT);
    advance(engine, FIRST_IMPACT + 1);

    expect(engine.drainEvents()).toEqual([
      { type: 'perfect', step: FIRST_IMPACT },
    ]);
    expect(engine.drainEvents()).toEqual([]);

    // The next move lands unparried; a later drain only reports the new hit.
    advance(engine, 200);
    expect(engine.drainEvents().map((event) => event.type)).toEqual(['hit']);
    expect(engine.drainEvents()).toEqual([]);
  });
});

describe('momentum and guard break', () => {
  it('breaks the guard after three perfect parries', () => {
    const engine = perfectThree();
    const snapshot = engine.snapshot();

    expect(snapshot.perfects).toBe(3);
    expect(snapshot.momentum).toBe(MOMENTUM_FOR_BREAK);
    expect(snapshot.hits).toBe(0);
    expect(snapshot.score).toBe(SCORE_PERFECT * 3);
    expect(snapshot.boss.guard).toBe('broken');
    expect(snapshot.breakTicksLeft).toBe(BREAK_TICKS - 1);
    expect(snapshot.status).toBe('playing');
    expect(engine.drainEvents().map((event) => event.type)).toEqual([
      'perfect',
      'perfect',
      'perfect',
      'break',
    ]);
  });

  it('wins when a charged strike lands inside the break', () => {
    const engine = perfectThree();
    engine.input('charge', BREAK_START + 60);
    engine.input('strike', BREAK_START + 80);
    advance(engine, 81);

    const snapshot = engine.snapshot();
    expect(snapshot.status).toBe('won');
    expect(snapshot.score).toBe(SCORE_PERFECT * 3 + SCORE_FINISHER);
    expect(snapshot.hits).toBe(0);
    expect(snapshot.charging).toBe(false);
    expect(snapshot.boss.guard).toBe('broken');

    const types = engine.drainEvents().map((event) => event.type);
    expect(types.slice(-2)).toEqual(['finisher', 'win']);
  });

  it('reports the charge state between hold and release', () => {
    const engine = new ZhenShaEngine();
    engine.input('charge', 10);
    advance(engine, 11);
    expect(engine.snapshot().charging).toBe(true);

    engine.input('strike', 20);
    advance(engine, 10);
    expect(engine.snapshot().charging).toBe(false);
  });

  it('wins on the last tick of the break', () => {
    const engine = perfectThree();
    engine.input('charge', BREAK_START + BREAK_TICKS - 20);
    engine.input('strike', BREAK_START + BREAK_TICKS - 1);
    advance(engine, BREAK_TICKS - 1);

    expect(engine.snapshot().status).toBe('won');
  });

  it('reports the guard up as soon as the break expires', () => {
    const engine = perfectThree();
    advance(engine, BREAK_TICKS - 1);

    const snapshot = engine.snapshot();
    expect(snapshot.step).toBe(BREAK_START + BREAK_TICKS);
    expect(snapshot.boss.guard).toBe('up');
    expect(snapshot.momentum).toBe(0);
    expect(snapshot.breakTicksLeft).toBe(0);

    engine.input('charge');
    engine.input('strike');
    advance(engine, 1);
    expect(engine.snapshot().status).toBe('playing');
  });

  it('waits RECOVERY_TICKS after the break before winding up again', () => {
    const engine = perfectThree();
    advance(engine, BREAK_TICKS - 1);

    const breakEndStep = BREAK_START + BREAK_TICKS;
    const nextWindUpStep = breakEndStep + RECOVERY_TICKS;
    expect(engine.snapshot().step).toBe(breakEndStep);
    expect(engine.snapshot().attack).toBeNull();

    advance(engine, RECOVERY_TICKS - 1);
    expect(engine.snapshot().step).toBe(nextWindUpStep - 1);
    expect(engine.snapshot().attack).toBeNull();

    // The wind-up happens on the recovery frame, so the snapshot taken after
    // it still shows no attack.
    advance(engine, 1);
    expect(engine.snapshot().step).toBe(nextWindUpStep);
    expect(engine.snapshot().attack).toBeNull();

    advance(engine, 1);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: nextWindUpStep + TELEGRAPH_TICKS,
      phase: 'telegraph',
    });
  });

  it('cannot win on the break expiry tick', () => {
    const engine = perfectThree();
    engine.input('charge', BREAK_START + BREAK_TICKS - 10);
    engine.input('strike', BREAK_START + BREAK_TICKS);
    advance(engine, BREAK_TICKS);

    const snapshot = engine.snapshot();
    expect(snapshot.status).toBe('playing');
    expect(snapshot.boss.guard).toBe('up');
    expect(snapshot.momentum).toBe(0);
  });

  it('cannot finish the boss with a strike that was never charged', () => {
    const engine = perfectThree();
    engine.input('strike', BREAK_START + 60);
    advance(engine, 61);

    expect(engine.snapshot().status).toBe('playing');

    engine.input('charge', BREAK_START + 80);
    engine.input('strike', BREAK_START + 90);
    advance(engine, 91);
    expect(engine.snapshot().status).toBe('won');
  });

  it('drops the break and the momentum when the finisher is too late', () => {
    const engine = perfectThree();
    advance(engine, BREAK_TICKS + 2);

    const recovered = engine.snapshot();
    expect(recovered.boss.guard).toBe('up');
    expect(recovered.momentum).toBe(0);
    expect(recovered.breakTicksLeft).toBe(0);
    expect(recovered.status).toBe('playing');

    engine.input('charge', BREAK_START + BREAK_TICKS + 10);
    engine.input('strike', BREAK_START + BREAK_TICKS + 20);
    advance(engine, 30);
    expect(engine.snapshot().status).toBe('playing');
  });
});

describe('hits, loss and restart', () => {
  it('survives two hits and loses on the third', () => {
    const engine = new ZhenShaEngine();
    advance(engine, 400);

    const twoHits = engine.snapshot();
    expect(twoHits.hits).toBe(2);
    expect(twoHits.status).toBe('playing');

    advance(engine, 200);
    expect(engine.snapshot().hits).toBe(MAX_HITS);
    expect(engine.snapshot().status).toBe('lost');
  });

  it('loses the duel after three unparried moves', () => {
    const engine = new ZhenShaEngine();
    advance(engine, 700);

    const snapshot = engine.snapshot();
    expect(snapshot.hits).toBe(MAX_HITS);
    expect(snapshot.status).toBe('lost');
    expect(snapshot.attack).toBeNull();
    expect(snapshot.perfects).toBe(0);

    const types = engine.drainEvents().map((event) => event.type);
    expect(types.filter((type) => type === 'hit')).toHaveLength(MAX_HITS);
    expect(types.at(-1)).toBe('lose');
  });

  it('counts one hit per unparried move when the chart damage is 7–13', () => {
    const damageChart: BossChart = {
      recoveryMs: 200,
      bosses: [
        {
          name: '伤害 boss',
          phases: [
            {
              id: 'damage-phase',
              moves: [7, 10, 13].map((damage, index) => ({
                id: `damage-move-${index + 1}`,
                telegraphMs: 250,
                activeMs: 200,
                parryWindowMs: 100,
                damage,
              })),
            },
          ],
        },
      ],
    };

    const engine = new ZhenShaEngine(damageChart);
    const firstLanding = toTicks(250) + Math.floor(toTicks(200) / 2);

    advance(engine, firstLanding + 1);
    expect(engine.snapshot()).toMatchObject({
      status: 'playing',
      hits: 1,
      lastJudgement: 'miss',
    });

    advance(engine, 400);
    const snapshot = engine.snapshot();
    expect(snapshot.status).toBe('lost');
    expect(snapshot.hits).toBe(MAX_HITS);

    const types = engine.drainEvents().map((event) => event.type);
    expect(types.filter((type) => type === 'hit')).toHaveLength(MAX_HITS);
    expect(types.at(-1)).toBe('lose');
  });

  it('drops a held charge when the duel is lost', () => {
    const engine = new ZhenShaEngine();
    engine.input('charge', 100);
    advance(engine, 700);

    expect(engine.snapshot().status).toBe('lost');
    expect(engine.snapshot().charging).toBe(false);
  });

  it('ignores input after the duel ends', () => {
    const engine = new ZhenShaEngine();
    advance(engine, 700);
    const finished = engine.snapshot();

    engine.input('block', 1000);
    engine.input('charge', 1000);
    advance(engine, 100);

    expect(engine.snapshot()).toEqual(finished);
  });

  it('restarts every counter and can be played again', () => {
    const engine = new ZhenShaEngine();
    engine.input('block', FIRST_IMPACT);
    advance(engine, FIRST_IMPACT + 1);
    expect(engine.snapshot().perfects).toBe(1);

    engine.restart();

    expect(engine.snapshot()).toEqual(new ZhenShaEngine().snapshot());
    expect(engine.drainEvents()).toEqual([]);

    engine.input('block', FIRST_IMPACT);
    advance(engine, FIRST_IMPACT + 1);
    expect(engine.snapshot().perfects).toBe(1);
  });

  it('drops the sub-tick remainder on restart', () => {
    const engine = new ZhenShaEngine();
    engine.update(FIXED_STEP_MS / 2);
    expect(engine.snapshot().step).toBe(0);

    engine.restart();
    engine.update(FIXED_STEP_MS / 2);

    expect(engine.snapshot().step).toBe(0);
  });

  it('restarts after a win', () => {
    const engine = perfectThree();
    engine.input('charge', BREAK_START + 60);
    engine.input('strike', BREAK_START + 80);
    advance(engine, 81);
    expect(engine.snapshot().status).toBe('won');

    engine.restart();

    expect(engine.snapshot()).toEqual(new ZhenShaEngine().snapshot());
  });

  it('restarts after a loss', () => {
    const engine = new ZhenShaEngine();
    advance(engine, 700);
    expect(engine.snapshot().status).toBe('lost');

    engine.restart();

    expect(engine.snapshot()).toEqual(new ZhenShaEngine().snapshot());
  });
});

describe('snapshot isolation', () => {
  it('never rewrites a snapshot after later steps', () => {
    const engine = new ZhenShaEngine();
    engine.input('block', FIRST_IMPACT);
    advance(engine, FIRST_IMPACT + 1);

    const before = engine.snapshot();
    const copy = structuredClone(before);

    advance(engine, 300);
    expect(before).toEqual(copy);
  });

  it('does not expose internal state to snapshot mutation', () => {
    const engine = new ZhenShaEngine();
    const snapshot = engine.snapshot() as unknown as {
      attack: { impactStep: number } | null;
      boss: { guard: string };
    };
    if (snapshot.attack !== null) {
      snapshot.attack.impactStep = -1;
    }
    snapshot.boss.guard = 'broken';

    const current = engine.snapshot();
    expect(current.attack?.impactStep).toBe(FIRST_IMPACT);
    expect(current.boss.guard).toBe('up');

    engine.input('block', FIRST_IMPACT);
    advance(engine, FIRST_IMPACT + 1);
    const played = engine.snapshot() as unknown as { momentum: number };
    played.momentum = 99;
    expect(engine.snapshot().momentum).toBe(1);
  });
});

describe('fixed-step determinism', () => {
  const CHARGE_STEP = FOURTH_IMPACT + Math.floor(BREAK_TICKS / 2);
  const STRIKE_STEP = CHARGE_STEP + 10;

  /** One schedule mixing a perfect, a whiff, two perfects and the finisher. */
  const SCHEDULE: ReadonlyArray<{ readonly step: number; readonly action: ZhenShaAction }> = [
    { step: FIRST_IMPACT, action: 'block' },
    { step: WHIFF_STEP, action: 'block' },
    { step: THIRD_IMPACT, action: 'block' },
    { step: FOURTH_IMPACT, action: 'block' },
    { step: CHARGE_STEP, action: 'charge' },
    { step: STRIKE_STEP, action: 'strike' },
  ];

  function playScheduleWithFrames(frames: readonly number[]): {
    snapshot: ZhenShaSnapshot;
    events: readonly ZhenShaEvent[];
  } {
    const engine = new ZhenShaEngine();
    for (const entry of SCHEDULE) {
      engine.input(entry.action, entry.step);
    }
    const target = STRIKE_STEP + 1;
    let frame = 0;
    while (engine.snapshot().step < target) {
      const frameMs = frames[frame % frames.length];
      if (frameMs === undefined) {
        throw new Error('frame list must not be empty');
      }
      const remaining = target - engine.snapshot().step;
      engine.update(Math.min(frameMs, remaining * FIXED_STEP_MS));
      frame += 1;
    }
    return { snapshot: engine.snapshot(), events: engine.drainEvents() };
  }

  it('matches 120 Hz, 60 Hz and jittered frame chunking of one input schedule', () => {
    const fast = playScheduleWithFrames([1000 / 120]);
    const slow = playScheduleWithFrames([1000 / 60]);
    // Real frame times with a remainder: exercises the fixed-step accumulator.
    const jitter = playScheduleWithFrames([7, 13.7, 3.3, 9.1, 16.2, 1.7]);

    expect(slow.snapshot).toEqual(fast.snapshot);
    expect(slow.events).toEqual(fast.events);
    expect(jitter.snapshot).toEqual(fast.snapshot);
    expect(jitter.events).toEqual(fast.events);
    expect(fast.snapshot).toMatchObject({
      status: 'won',
      perfects: 3,
      hits: 1,
      momentum: MOMENTUM_FOR_BREAK,
      score: SCORE_PERFECT * 3 + SCORE_FINISHER,
    });
    expect(fast.snapshot.step).toBe(STRIKE_STEP + 1);
  });
});

/**
 * Browser, renderer, timer, clock and module-loading APIs that a pure data
 * module must not use. Shared by the engine and boss-chart source guards.
 */
const FORBIDDEN_PURE_SOURCE =
  /\b(?:document|window|navigator|localStorage|sessionStorage|fetch|Audio|performance|requestAnimationFrame|setTimeout|setInterval|Phaser|THREE|require|globalThis)\b|Date\.now|\bnew\s+Date\b|\bMath\.random\b|(?:^|\n)\s*import\b|(?:^|\n)\s*export\b[^;]*\bfrom\b/;

/**
 * Acceptance #4's grep verbatim: no word boundaries, so a substring inside a
 * comment (for example `documented`) counts as a hit. The semantic guard above
 * checks API use and would miss that, so both assertions are needed.
 */
const ACCEPTANCE_PURITY_GREP =
  /document|window|Phaser|THREE|setTimeout|Date\.now/;

/** Build a move that satisfies the chart contract, for shape fixtures. */
function chartMove(
  bossIndex: number,
  phaseIndex: number,
  moveIndex: number,
): BossMoveChart {
  return {
    id: `boss-${bossIndex}-phase-${phaseIndex}-move-${moveIndex}`,
    telegraphMs: (phaseIndex === 1 ? 1500 : 900) - moveIndex * 10,
    activeMs: 300,
    parryWindowMs: 100,
    damage: phaseIndex,
  };
}

/**
 * A shape smoke test for #246's already-merged 3 × 2 `BOSSES`. The engine card
 * that consumes this contract must map `BOSSES` here and reconcile its
 * different `id` / `activeMs` / `damage` semantics, so no production data is
 * bound yet.
 */
const THREE_BY_TWO_CHART: BossChart = {
  bosses: Array.from({ length: 3 }, (_, bossIndex) => ({
    name: `测试 boss ${bossIndex + 1}`,
    phases: Array.from({ length: 2 }, (_, phaseIndex) => ({
      id: `boss-${bossIndex + 1}-phase-${phaseIndex + 1}`,
      moves: Array.from({ length: 6 + phaseIndex }, (_, moveIndex) =>
        chartMove(bossIndex + 1, phaseIndex + 1, moveIndex + 1),
      ),
    })),
  })),
};

/** Assert the fields and chart-unique phase / move ids the engine relies on. */
function expectValidChart(chart: BossChart): void {
  expect(chart.bosses.length).toBeGreaterThan(0);
  const phaseIds: string[] = [];
  const moveIds: string[] = [];

  for (const boss of chart.bosses) {
    expect(boss.name.trim().length).toBeGreaterThan(0);
    expect(boss.phases.length).toBeGreaterThan(0);
    for (const phase of boss.phases) {
      expect(phase.id.trim().length).toBeGreaterThan(0);
      phaseIds.push(phase.id);
      expect(phase.moves.length).toBeGreaterThan(0);
      for (const move of phase.moves) {
        expect(move.id.trim().length).toBeGreaterThan(0);
        for (const ms of [move.telegraphMs, move.activeMs, move.parryWindowMs]) {
          expect(Number.isInteger(ms)).toBe(true);
          expect(ms).toBeGreaterThan(0);
        }
        expect(move.parryWindowMs).toBeLessThan(move.activeMs);
        expect(Number.isInteger(move.damage)).toBe(true);
        expect(move.damage).toBeGreaterThan(0);
        moveIds.push(move.id);
      }
    }
  }

  expect(new Set(phaseIds).size).toBe(phaseIds.length);
  expect(new Set(moveIds).size).toBe(moveIds.length);
}

describe('boss chart contract', () => {
  it('accepts a 3 × 2 fixture with 6–10 moves per phase', () => {
    expect(THREE_BY_TWO_CHART.bosses).toHaveLength(3);
    for (const boss of THREE_BY_TWO_CHART.bosses) {
      expect(boss.phases).toHaveLength(2);
      for (const phase of boss.phases) {
        expect(phase.moves.length).toBeGreaterThanOrEqual(6);
        expect(phase.moves.length).toBeLessThanOrEqual(10);
      }
    }
    // Pin representative fixture values so a broken generator cannot pass.
    const firstBoss = THREE_BY_TWO_CHART.bosses[0];
    expect(firstBoss?.phases[0]?.moves[0]).toEqual({
      id: 'boss-1-phase-1-move-1',
      telegraphMs: 1490,
      activeMs: 300,
      parryWindowMs: 100,
      damage: 1,
    });
    expect(firstBoss?.phases[1]?.moves.at(-1)).toMatchObject({
      id: 'boss-1-phase-2-move-7',
      telegraphMs: 830,
      damage: 2,
    });
    expectValidChart(THREE_BY_TWO_CHART);
  });

  it('ships a 1 × 1 default chart with the kill-gate boss', () => {
    expect(DEFAULT_BOSS_CHART.bosses).toHaveLength(1);
    const boss = DEFAULT_BOSS_CHART.bosses[0];
    expect(boss).toBeDefined();
    if (boss === undefined) {
      throw new Error('default chart must have a boss');
    }
    expect(boss.name).toBe('黑煞');
    expect(boss.phases).toHaveLength(1);
    expect(boss.phases[0]?.moves).toHaveLength(1);
    expectValidChart(DEFAULT_BOSS_CHART);
    expect(boss.phases[0]?.moves[0]).toMatchObject({
      id: 'kill-gate-strike',
      damage: 1,
    });
  });

  it('reproduces the kill gate timing in 120 Hz ticks', () => {
    const ticksFor = (ms: number): number => (ms * TICKS_PER_SECOND) / 1000;
    const move = DEFAULT_BOSS_CHART.bosses[0]?.phases[0]?.moves[0];
    if (move === undefined) {
      throw new Error('default chart must have a move');
    }

    // The documented millisecond values.
    expect(DEFAULT_BOSS_CHART.firstTelegraphMs).toBe(1500);
    expect(DEFAULT_BOSS_CHART.recoveryMs).toBe(600);
    expect(move.telegraphMs).toBe(900);
    expect(move.activeMs).toBe(300);
    expect(move.parryWindowMs).toBe(100);
    expect(move.damage).toBe(1);

    // ... and their integer-tick equivalents in the existing engine.
    expect(
      ticksFor(DEFAULT_BOSS_CHART.firstTelegraphMs ?? Number.NaN),
    ).toBe(FIRST_TELEGRAPH_TICKS);
    expect(ticksFor(DEFAULT_BOSS_CHART.recoveryMs ?? Number.NaN)).toBe(
      RECOVERY_TICKS,
    );
    expect(ticksFor(move.telegraphMs)).toBe(TELEGRAPH_TICKS);
    expect(ticksFor(move.activeMs)).toBe(NORMAL_BAND_HALF_TICKS * 2);
    expect(ticksFor(move.parryWindowMs)).toBe(PERFECT_BAND_HALF_TICKS * 2);
  });

  it('stays pure data with no browser, renderer, timer or engine imports', () => {
    const source = readFileSync(
      new URL('./boss-chart.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(FORBIDDEN_PURE_SOURCE);
    // Acceptance #4 greps boss-chart.ts verbatim, so comments must not match.
    expect(source).not.toMatch(ACCEPTANCE_PURITY_GREP);
  });

  it('describes an engine that already consumes charts', () => {
    const source = readFileSync(
      new URL('./boss-chart.ts', import.meta.url),
      'utf8',
    );

    // The engine has scheduled from charts since #448, so the old "not wired
    // yet" wording must not come back.
    expect(source).not.toMatch(/Today the engine still reads/);
    expect(source).not.toMatch(/Until the wiring lands/);
    expect(source).not.toMatch(/once it is wired to charts/i);

    // Guard the positive claims too. Limit the module-header claims to the top
    // doc comment: the fields are declared again in the interfaces below, so a
    // whole-file check would not prove the header says what we claim.
    const headerEnd = source.indexOf('*/') + 2;
    expect(headerEnd).toBeGreaterThan(2);
    const header = source.slice(0, headerEnd);
    for (const expectedText of [
      'Since #448 the engine consumes a chart',
      'normalizeChart(chart)',
      'telegraphMs',
      'activeMs',
      'parryWindowMs',
      'recoveryMs',
      '`damage` takes no part in judgement',
      'only checks that it is positive',
    ]) {
      expect(header).toContain(expectedText);
    }

    // The default chart's doc block covers the argument-free default, the tick
    // constants and the fact that the engine no longer schedules from them.
    const chartExport = source.indexOf('export const DEFAULT_BOSS_CHART');
    expect(chartExport).toBeGreaterThanOrEqual(0);
    const chartDoc = source.slice(
      source.lastIndexOf('/**', chartExport),
      chartExport,
    );
    expect(chartDoc).toMatch(/^\/\*\*/);
    // Fold the comment's leading asterisks so a claim may span source lines.
    const chartDocProse = chartDoc.replace(/\s*\*\s*/g, ' ');
    for (const expectedText of [
      'argument-free engine',
      'TELEGRAPH_TICKS',
      'FIRST_TELEGRAPH_TICKS',
      'RECOVERY_TICKS',
      'NORMAL_BAND_HALF_TICKS',
      'PERFECT_BAND_HALF_TICKS',
    ]) {
      expect(chartDocProse).toContain(expectedText);
    }
    expect(chartDocProse).toContain(
      'the engine already schedules from the chart and no longer reads them',
    );
  });
});

const STAGE_FIRST_TELEGRAPH_MS = 500;
const STAGE_TELEGRAPH_MS = 250;
const STAGE_ACTIVE_MS = 200;
const STAGE_PARRY_MS = 100;
const STAGE_RECOVERY_MS = 250;

const toTicks = (ms: number): number => (ms * TICKS_PER_SECOND) / 1000;

const STAGE_TIMING = {
  firstTelegraph: toTicks(STAGE_FIRST_TELEGRAPH_MS),
  telegraph: toTicks(STAGE_TELEGRAPH_MS),
  normalHalf: toTicks(STAGE_ACTIVE_MS) / 2,
  perfectHalf: toTicks(STAGE_PARRY_MS) / 2,
  recovery: toTicks(STAGE_RECOVERY_MS),
} as const;

const STAGE_BOSS_NAMES = ['阶段 boss 1', '阶段 boss 2', '阶段 boss 3'] as const;

function stageName(bossIndex: number): string {
  const name = STAGE_BOSS_NAMES[bossIndex];
  if (name === undefined) {
    throw new Error(`missing stage boss name for index ${bossIndex}`);
  }
  return name;
}

function stageMove(
  bossIndex: number,
  phaseIndex: number,
  moveIndex: number,
): BossMoveChart {
  return {
    id: `stage-${bossIndex}-${phaseIndex}-${moveIndex}`,
    telegraphMs: STAGE_TELEGRAPH_MS,
    activeMs: STAGE_ACTIVE_MS,
    parryWindowMs: STAGE_PARRY_MS,
    damage: 1,
  };
}

/** A 3 boss × 2 phase chart whose moves all share the same test timing. */
const STAGE_CHART: BossChart = {
  firstTelegraphMs: STAGE_FIRST_TELEGRAPH_MS,
  recoveryMs: STAGE_RECOVERY_MS,
  bosses: STAGE_BOSS_NAMES.map((name, bossIndex) => ({
    name,
    phases: [1, 2].map((phaseNumber) => ({
      id: `stage-boss-${bossIndex + 1}-phase-${phaseNumber}`,
      moves: [1, 2, 3, 4, 5, 6].map((moveNumber) =>
        stageMove(bossIndex + 1, phaseNumber, moveNumber),
      ),
    })),
  })),
};

interface StagePhasePlan {
  readonly bossIndex: number;
  readonly phaseIndex: number;
  readonly impacts: readonly [number, number, number];
  readonly breakStart: number;
  readonly strikeStep: number;
}

/** Exact tick plan for three perfects plus a finisher in every phase. */
function stagePlan(): StagePhasePlan[] {
  const plan: StagePhasePlan[] = [];
  let entry = 0;

  for (let phase = 0; phase < 6; phase += 1) {
    const firstImpact =
      entry +
      (phase === 0 ? STAGE_TIMING.firstTelegraph : STAGE_TIMING.telegraph);
    const secondImpact =
      firstImpact + STAGE_TIMING.telegraph + STAGE_TIMING.recovery;
    const thirdImpact =
      secondImpact + STAGE_TIMING.telegraph + STAGE_TIMING.recovery;
    plan.push({
      bossIndex: Math.floor(phase / 2),
      phaseIndex: phase % 2,
      impacts: [firstImpact, secondImpact, thirdImpact],
      breakStart: thirdImpact,
      strikeStep: thirdImpact + 10,
    });
    entry = thirdImpact + 10 + STAGE_TIMING.recovery;
  }

  return plan;
}

/** Queue the whole perfect plan before advancing, as a replay would. */
function stagedEngine(plan: readonly StagePhasePlan[]): ZhenShaEngine {
  const engine = new ZhenShaEngine(STAGE_CHART);
  for (const phase of plan) {
    for (const impact of phase.impacts) {
      engine.input('block', impact);
    }
    engine.input('charge', phase.breakStart + 5);
    engine.input('strike', phase.strikeStep);
  }
  return engine;
}

function judgeStageTap(offset: number): ZhenShaSnapshot {
  const engine = new ZhenShaEngine(STAGE_CHART);
  const impact = STAGE_TIMING.firstTelegraph;
  engine.input('block', impact + offset);
  advance(engine, impact + offset + 1);
  return engine.snapshot();
}

const STAGE_BOUNDARY_CASES: ReadonlyArray<
  readonly [offset: number, judgement: ParryJudgement, hits: number]
> = [
  // Perfect band edges and their neighbours on a chart move.
  [-STAGE_TIMING.perfectHalf - 1, 'normal', 0],
  [-STAGE_TIMING.perfectHalf, 'perfect', 0],
  [-STAGE_TIMING.perfectHalf + 1, 'perfect', 0],
  [0, 'perfect', 0],
  [STAGE_TIMING.perfectHalf - 1, 'perfect', 0],
  [STAGE_TIMING.perfectHalf, 'perfect', 0],
  [STAGE_TIMING.perfectHalf + 1, 'normal', 0],
  // Normal band edges and their neighbours.
  [-STAGE_TIMING.normalHalf - 1, 'miss', 0],
  [-STAGE_TIMING.normalHalf, 'normal', 0],
  [-STAGE_TIMING.normalHalf + 1, 'normal', 0],
  [STAGE_TIMING.normalHalf - 1, 'normal', 0],
  [STAGE_TIMING.normalHalf, 'normal', 0],
  [STAGE_TIMING.normalHalf + 1, 'miss', 1],
];

/**
 * A chart whose perfect window is deliberately narrower than the default
 * 100 ms / 12-tick window (half-width `PERFECT_BAND_HALF_TICKS` = 6): 60 ms
 * rounds to 7 full ticks, so this chart's half-width is 3 ticks. Its 200 ms
 * active window gives a 12-tick half-width, versus the default 18. Watching
 * the ±3 / ±4 and -13 edges proves the engine reads the chart's values
 * instead of the exported defaults.
 */
const NARROW_PARRY_MS = 60;
const NARROW_PERFECT_HALF = 3;
const NARROW_NORMAL_HALF = STAGE_TIMING.normalHalf;

const NARROW_CHART: BossChart = {
  recoveryMs: STAGE_RECOVERY_MS,
  bosses: [
    {
      name: '窄窗 boss',
      phases: [
        {
          id: 'narrow-phase',
          moves: [
            {
              id: 'narrow-move',
              telegraphMs: STAGE_TELEGRAPH_MS,
              activeMs: STAGE_ACTIVE_MS,
              parryWindowMs: NARROW_PARRY_MS,
              damage: 1,
            },
          ],
        },
      ],
    },
  ],
};
const NARROW_IMPACT = STAGE_TIMING.telegraph;

const NARROW_BOUNDARY_CASES: ReadonlyArray<
  readonly [offset: number, judgement: ParryJudgement, hits: number]
> = [
  // Perfect band edges from parryWindowMs=60 (3 ticks), not the default 6.
  [-NARROW_PERFECT_HALF - 1, 'normal', 0],
  [-NARROW_PERFECT_HALF, 'perfect', 0],
  [0, 'perfect', 0],
  [NARROW_PERFECT_HALF, 'perfect', 0],
  [NARROW_PERFECT_HALF + 1, 'normal', 0],
  // Normal band: the early edge is falsifiable; a tap one tick further out
  // is a live whiff before the move lands. The late side is preempted by the
  // landing check at impact + half-width, so +1 tick there is a tap after the
  // landing, not a parry band decision.
  [-NARROW_NORMAL_HALF - 1, 'miss', 0],
  [-NARROW_NORMAL_HALF, 'normal', 0],
  [NARROW_NORMAL_HALF, 'normal', 0],
  [NARROW_NORMAL_HALF + 1, 'miss', 1],
];

function judgeNarrowTap(offset: number): ZhenShaSnapshot {
  const engine = new ZhenShaEngine(NARROW_CHART);
  engine.input('block', NARROW_IMPACT + offset);
  advance(engine, NARROW_IMPACT + offset + 1);
  return engine.snapshot();
}

/** Same boss data as NARROW_CHART, minus recoveryMs: it rests immediately. */
const NO_RECOVERY_CHART: BossChart = { bosses: NARROW_CHART.bosses };

/**
 * A two-phase chart whose moves deliberately use different telegraphs, so a
 * test can tell which chart move the engine actually consumed. Phase 1 winds up
 * for 250 / 500 / 750 / 1000 ms and phase 2 starts at 350 ms; the 200 ms
 * recovery is not the default 600 ms. Removing a move advance, the stage reset
 * or either chart-recovery read changes the next impact by a whole move.
 */
const SEQUENCE_FIRST_TELEGRAPH_MS = 250;
const SEQUENCE_TELEGRAPHS_MS = [250, 500, 750, 1000] as const;
const NEXT_PHASE_TELEGRAPHS_MS = [350, 450, 550, 650] as const;
const SEQUENCE_ACTIVE_MS = 200;
const SEQUENCE_PARRY_MS = 100;
const SEQUENCE_RECOVERY_MS = 200;

const SEQUENCE_TIMING = {
  firstTelegraph: toTicks(SEQUENCE_FIRST_TELEGRAPH_MS),
  telegraphs: SEQUENCE_TELEGRAPHS_MS.map(toTicks),
  nextTelegraphs: NEXT_PHASE_TELEGRAPHS_MS.map(toTicks),
  normalHalf: toTicks(SEQUENCE_ACTIVE_MS) / 2,
  recovery: toTicks(SEQUENCE_RECOVERY_MS),
} as const;

function sequenceMoves(
  phaseId: string,
  telegraphs: readonly number[],
): BossMoveChart[] {
  return telegraphs.map((telegraphMs, moveIndex) => ({
    id: `${phaseId}-move-${moveIndex + 1}`,
    telegraphMs,
    activeMs: SEQUENCE_ACTIVE_MS,
    parryWindowMs: SEQUENCE_PARRY_MS,
    damage: 1,
  }));
}

const SEQUENCE_CHART: BossChart = {
  firstTelegraphMs: SEQUENCE_FIRST_TELEGRAPH_MS,
  recoveryMs: SEQUENCE_RECOVERY_MS,
  bosses: [
    {
      name: '时序 boss',
      phases: [
        {
          id: 'sequence-phase-1',
          moves: sequenceMoves('sequence-phase-1', SEQUENCE_TELEGRAPHS_MS),
        },
        {
          id: 'sequence-phase-2',
          moves: sequenceMoves('sequence-phase-2', NEXT_PHASE_TELEGRAPHS_MS),
        },
      ],
    },
  ],
};

/** Move tells for a chart without firstTelegraphMs: 400 ms, then 800 ms. */
const FALLBACK_FIRST_MS = 400;
const FALLBACK_SECOND_MS = 800;

const FALLBACK_TIMING = {
  first: toTicks(FALLBACK_FIRST_MS),
  second: toTicks(FALLBACK_SECOND_MS),
} as const;

/**
 * A chart with no firstTelegraphMs, so the opening tell must fall back to the
 * first move's 400 ms and a restart that keeps a stale move index would pick
 * the 800 ms tell instead.
 */
const FALLBACK_CHART: BossChart = {
  recoveryMs: SEQUENCE_RECOVERY_MS,
  bosses: [
    {
      name: '回退 boss',
      phases: [
        {
          id: 'fallback-phase',
          moves: [
            {
              id: 'fallback-fast',
              telegraphMs: FALLBACK_FIRST_MS,
              activeMs: SEQUENCE_ACTIVE_MS,
              parryWindowMs: SEQUENCE_PARRY_MS,
              damage: 1,
            },
            {
              id: 'fallback-slow',
              telegraphMs: FALLBACK_SECOND_MS,
              activeMs: SEQUENCE_ACTIVE_MS,
              parryWindowMs: SEQUENCE_PARRY_MS,
              damage: 1,
            },
          ],
        },
      ],
    },
  ],
};

/** Impact ticks of the first three perfect parries in SEQUENCE_CHART phase 1. */
function sequencePerfectImpacts(): readonly [number, number, number] {
  const second =
    SEQUENCE_TIMING.firstTelegraph +
    SEQUENCE_TIMING.recovery +
    SEQUENCE_TIMING.telegraphs[1]!;
  const third =
    second + SEQUENCE_TIMING.recovery + SEQUENCE_TIMING.telegraphs[2]!;
  return [SEQUENCE_TIMING.firstTelegraph, second, third];
}

describe('boss chart stages', () => {
  it('walks 1-1 → 1-2 → 2-1 → 2-2 → 3-1 → 3-2 and wins only on 3-2', () => {
    const plan = stagePlan();
    const engine = stagedEngine(plan);
    let perfects = 0;

    plan.forEach((phase, index) => {
      advance(engine, phase.breakStart + 1 - engine.snapshot().step);
      perfects += 3;

      expect(engine.snapshot()).toMatchObject({
        status: 'playing',
        boss: {
          name: stageName(phase.bossIndex),
          phase: phase.phaseIndex + 1,
          guard: 'broken',
        },
        momentum: MOMENTUM_FOR_BREAK,
        perfects,
        hits: 0,
        score: perfects * SCORE_PERFECT + index * SCORE_FINISHER,
        breakTicksLeft: BREAK_TICKS - 1,
        elapsedMs: (phase.breakStart + 1) * FIXED_STEP_MS,
      });
      expect(engine.snapshot().attack).toBeNull();

      advance(engine, phase.strikeStep + 1 - engine.snapshot().step);
      const cleared = engine.snapshot();

      if (index < plan.length - 1) {
        const next = plan[index + 1];
        if (next === undefined) {
          throw new Error('missing next stage');
        }
        expect(cleared).toMatchObject({
          status: 'playing',
          boss: {
            name: stageName(next.bossIndex),
            phase: next.phaseIndex + 1,
            guard: 'up',
          },
          charging: false,
          momentum: 0,
          breakTicksLeft: 0,
          perfects,
          hits: 0,
          score: perfects * SCORE_PERFECT + (index + 1) * SCORE_FINISHER,
        });
        expect(cleared.attack).toBeNull();
        // The cleared phase starts with no stale perfect/normal/miss feedback.
        expect(cleared.lastJudgement).toBeNull();
      } else {
        expect(cleared).toMatchObject({
          status: 'won',
          boss: { name: stageName(2), phase: 2, guard: 'broken' },
          momentum: MOMENTUM_FOR_BREAK,
          perfects,
          hits: 0,
          score: perfects * SCORE_PERFECT + plan.length * SCORE_FINISHER,
        });
      }
    });

    const types = engine.drainEvents().map((event) => event.type);
    expect(types.filter((type) => type === 'break')).toHaveLength(plan.length);
    expect(types.filter((type) => type === 'finisher')).toHaveLength(plan.length);
    expect(types.filter((type) => type === 'win')).toHaveLength(1);
  });

  it('reads moves in chart order and cycles the phase list', () => {
    const ORDER_CHART: BossChart = {
      recoveryMs: STAGE_RECOVERY_MS,
      bosses: [
        {
          name: '顺序 boss',
          phases: [
            {
              id: 'order-phase',
              moves: [
                {
                  id: 'order-fast',
                  telegraphMs: 250,
                  activeMs: 200,
                  parryWindowMs: 100,
                  damage: 1,
                },
                {
                  id: 'order-slow',
                  telegraphMs: 500,
                  activeMs: 200,
                  parryWindowMs: 100,
                  damage: 1,
                },
              ],
            },
          ],
        },
      ],
    };
    const engine = new ZhenShaEngine(ORDER_CHART);
    const fastTelegraph = toTicks(250);
    const slowTelegraph = toTicks(500);

    // Without firstTelegraphMs the opening uses the first move's 250 ms tell.
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: fastTelegraph,
    });

    const firstImpact = fastTelegraph;
    engine.input('block', firstImpact);
    advance(engine, firstImpact + 1);
    expect(engine.snapshot()).toMatchObject({
      perfects: 1,
      momentum: 1,
      attack: null,
    });

    // The second move's 500 ms tell puts its impact 60 ticks after spawning.
    const secondImpact =
      firstImpact + STAGE_TIMING.recovery + slowTelegraph;
    engine.input('block', secondImpact);
    advance(engine, secondImpact + 1 - engine.snapshot().step);
    expect(engine.snapshot()).toMatchObject({ perfects: 2, momentum: 2 });

    // The two-move list then cycles back to the fast move.
    const thirdImpact =
      secondImpact + STAGE_TIMING.recovery + fastTelegraph;
    engine.input('block', thirdImpact);
    advance(engine, thirdImpact + 1 - engine.snapshot().step);
    expect(engine.snapshot()).toMatchObject({
      status: 'playing',
      perfects: 3,
      momentum: MOMENTUM_FOR_BREAK,
      boss: { name: '顺序 boss', phase: 1, guard: 'broken' },
    });
  });

  it.each(STAGE_BOUNDARY_CASES)(
    'judges a tap %i ticks from an injected move impact as %s',
    (offset, judgement, hits) => {
      const snapshot = judgeStageTap(offset);

      expect(snapshot.lastJudgement).toBe(judgement);
      expect(snapshot.hits).toBe(hits);
      if (judgement === 'perfect') {
        expect(snapshot.perfects).toBe(1);
        expect(snapshot.momentum).toBe(1);
        expect(snapshot.score).toBe(SCORE_PERFECT);
      } else if (judgement === 'normal') {
        expect(snapshot.perfects).toBe(0);
        expect(snapshot.momentum).toBe(0);
        expect(snapshot.score).toBe(SCORE_NORMAL);
      } else {
        expect(snapshot.perfects).toBe(0);
        expect(snapshot.momentum).toBe(0);
        expect(snapshot.score).toBe(0);
      }
    },
  );

  it.each(NARROW_BOUNDARY_CASES)(
    'judges a %i tick tap on a 60 ms perfect / 200 ms active chart as %s',
    (offset, judgement, hits) => {
      const snapshot = judgeNarrowTap(offset);

      expect(snapshot.lastJudgement).toBe(judgement);
      expect(snapshot.hits).toBe(hits);
      if (judgement === 'perfect') {
        expect(snapshot.perfects).toBe(1);
        expect(snapshot.momentum).toBe(1);
      } else {
        expect(snapshot.perfects).toBe(0);
        expect(snapshot.momentum).toBe(0);
      }
    },
  );

  it('rests immediately when the chart omits recoveryMs', () => {
    const engine = new ZhenShaEngine(NO_RECOVERY_CHART);

    engine.input('block', NARROW_IMPACT);
    advance(engine, NARROW_IMPACT + 1);
    expect(engine.snapshot()).toMatchObject({
      perfects: 1,
      attack: null,
    });

    // No recovery: the next move starts winding up on the very next tick.
    advance(engine, 1);
    expect(engine.snapshot().attack).not.toBeNull();
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: NARROW_IMPACT + 1 + NARROW_IMPACT,
      phase: 'telegraph',
    });
  });

  it('rests immediately after an unparried landing when recoveryMs is omitted', () => {
    const engine = new ZhenShaEngine(NO_RECOVERY_CHART);
    const landingTick = NARROW_IMPACT + NARROW_NORMAL_HALF;

    advance(engine, landingTick + 1);
    expect(engine.snapshot()).toMatchObject({ hits: 1, attack: null });

    // The landing path also honors the chart: no recovery means the next move
    // starts on the tick after the unparried move resolves.
    advance(engine, 1);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: landingTick + 1 + NARROW_IMPACT,
      phase: 'telegraph',
    });
  });

  it('advances to the next chart move after a normal parry', () => {
    const engine = new ZhenShaEngine(SEQUENCE_CHART);
    const tapStep = SEQUENCE_TIMING.firstTelegraph + SEQUENCE_TIMING.normalHalf;
    engine.input('block', tapStep);
    advance(engine, tapStep + 1);

    expect(engine.snapshot()).toMatchObject({
      lastJudgement: 'normal',
      hits: 0,
      score: SCORE_NORMAL,
      attack: null,
    });

    // The next move is chart move 2 (500 ms), not the tap's own 250 ms move.
    const nextSpawn = tapStep + SEQUENCE_TIMING.recovery;
    const nextImpact = nextSpawn + SEQUENCE_TIMING.telegraphs[1]!;
    advance(engine, nextSpawn + 1 - engine.snapshot().step);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: nextImpact,
      phase: 'telegraph',
    });
  });

  it('advances to the next chart move after an unparried landing', () => {
    const engine = new ZhenShaEngine(SEQUENCE_CHART);
    const landingStep =
      SEQUENCE_TIMING.firstTelegraph + SEQUENCE_TIMING.normalHalf;
    advance(engine, landingStep + 1);

    expect(engine.snapshot()).toMatchObject({
      lastJudgement: 'miss',
      hits: 1,
      attack: null,
    });

    // Landing also consumes chart move 1: the next impact uses move 2's tell.
    const nextSpawn = landingStep + SEQUENCE_TIMING.recovery;
    const nextImpact = nextSpawn + SEQUENCE_TIMING.telegraphs[1]!;
    advance(engine, nextSpawn + 1 - engine.snapshot().step);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: nextImpact,
      phase: 'telegraph',
    });
  });

  it('opens the cleared phase with its first chart move', () => {
    const engine = new ZhenShaEngine(SEQUENCE_CHART);
    const [first, second, third] = sequencePerfectImpacts();
    for (const impact of [first, second, third]) {
      engine.input('block', impact);
    }
    const strikeStep = third + 10;
    engine.input('charge', strikeStep - 5);
    engine.input('strike', strikeStep);
    advance(engine, strikeStep + 1);

    expect(engine.snapshot()).toMatchObject({
      status: 'playing',
      boss: { name: '时序 boss', phase: 2, guard: 'up' },
      charging: false,
      momentum: 0,
      breakTicksLeft: 0,
      lastJudgement: null,
      attack: null,
    });

    // Phase 1 had cycled to its 1000 ms move; phase 2 must restart at 350 ms.
    const nextSpawn = strikeStep + SEQUENCE_TIMING.recovery;
    const nextImpact = nextSpawn + SEQUENCE_TIMING.nextTelegraphs[0]!;
    advance(engine, nextSpawn + 1 - engine.snapshot().step);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: nextImpact,
      phase: 'telegraph',
    });
  });

  it('rests for the chart recovery after a break expires naturally', () => {
    const engine = new ZhenShaEngine(SEQUENCE_CHART);
    const [, , third] = sequencePerfectImpacts();
    for (const impact of sequencePerfectImpacts()) {
      engine.input('block', impact);
    }
    advance(engine, third + 1);
    expect(engine.snapshot()).toMatchObject({
      momentum: MOMENTUM_FOR_BREAK,
      boss: { guard: 'broken' },
      breakTicksLeft: BREAK_TICKS - 1,
    });

    const expiryStep = third + BREAK_TICKS;
    advance(engine, expiryStep - engine.snapshot().step);
    expect(engine.snapshot()).toMatchObject({
      momentum: 0,
      breakTicksLeft: 0,
      attack: null,
    });
    expect(engine.drainEvents().map((event) => event.type)).toContain(
      'break-end',
    );

    // The break expiry restarts the phase's 1000 ms move after 200 ms, not 600.
    const nextSpawn = expiryStep + SEQUENCE_TIMING.recovery;
    const nextImpact = nextSpawn + SEQUENCE_TIMING.telegraphs[3]!;
    advance(engine, nextSpawn + 1 - engine.snapshot().step);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: nextImpact,
      phase: 'telegraph',
    });
  });

  it('carries hits across phases and loses on the third unparried move', () => {
    const engine = new ZhenShaEngine(STAGE_CHART);
    // Miss the first two moves of 1-1, then clear it with three perfects.
    engine.input(
      'block',
      STAGE_TIMING.firstTelegraph - STAGE_TIMING.normalHalf - 2,
    );
    engine.input('block', 118);
    engine.input('block', 204);
    engine.input('block', 264);
    engine.input('block', 324);
    engine.input('charge', 329);
    engine.input('strike', 334);
    // The third unparried move lands three ticks into 1-2.
    engine.input('block', 380);
    advance(engine, 407);

    expect(engine.snapshot()).toMatchObject({
      status: 'lost',
      boss: { name: stageName(0), phase: 2, guard: 'up' },
      hits: MAX_HITS,
      perfects: 3,
      momentum: 0,
      score: 3 * SCORE_PERFECT + SCORE_FINISHER,
      breakTicksLeft: 0,
    });

    const types = engine.drainEvents().map((event) => event.type);
    expect(types.filter((type) => type === 'hit')).toHaveLength(MAX_HITS);
    expect(types.filter((type) => type === 'finisher')).toHaveLength(1);
    expect(types.at(-1)).toBe('lose');
  });

  it('keeps old stage snapshots immutable across later transitions', () => {
    const plan = stagePlan();
    const engine = stagedEngine(plan);
    advance(engine, plan[0]!.breakStart + 1);

    const before = engine.snapshot();
    const copy = structuredClone(before);

    advance(engine, plan[2]!.strikeStep + 1 - engine.snapshot().step);
    expect(before).toEqual(copy);
  });

  it('restart returns to the first boss and phase of the injected chart', () => {
    const plan = stagePlan();
    const engine = stagedEngine(plan);
    advance(engine, plan[1]!.strikeStep + 1);
    expect(engine.snapshot().boss).toMatchObject({
      name: stageName(1),
      phase: 1,
    });

    engine.restart();

    expect(engine.snapshot()).toEqual(new ZhenShaEngine(STAGE_CHART).snapshot());
    expect(engine.drainEvents()).toEqual([]);
  });

  it('restart drops a stale phase and move index in a multi-phase chart', () => {
    const engine = new ZhenShaEngine(SEQUENCE_CHART);
    for (const impact of sequencePerfectImpacts()) {
      engine.input('block', impact);
    }
    const strikeStep = sequencePerfectImpacts()[2] + 10;
    engine.input('charge', strikeStep - 5);
    engine.input('strike', strikeStep);
    advance(engine, strikeStep + 1);

    // Land one perfect in 1-2 so restart starts from non-zero phase and move
    // indices: phaseIndex = 1 and moveIndex = 1.
    const phaseTwoSpawn = strikeStep + SEQUENCE_TIMING.recovery;
    const phaseTwoFirstImpact =
      phaseTwoSpawn + SEQUENCE_TIMING.nextTelegraphs[0]!;
    engine.input('block', phaseTwoFirstImpact);
    advance(engine, phaseTwoFirstImpact + 1 - engine.snapshot().step);
    const phaseTwoSecondSpawn =
      phaseTwoFirstImpact + SEQUENCE_TIMING.recovery;
    advance(engine, phaseTwoSecondSpawn + 1 - engine.snapshot().step);

    expect(engine.snapshot().boss).toMatchObject({ phase: 2, guard: 'up' });
    // The queued attack uses 1-2 move 2's 450 ms tell, so moveIndex is 1 and
    // a restart that keeps it would skip the first move.
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: phaseTwoSecondSpawn + SEQUENCE_TIMING.nextTelegraphs[1]!,
    });

    engine.restart();

    expect(engine.snapshot()).toEqual(
      new ZhenShaEngine(SEQUENCE_CHART).snapshot(),
    );
    // The opening attack uses firstTelegraphMs, not a stale phase/move tell.
    expect(engine.snapshot().boss.phase).toBe(1);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: SEQUENCE_TIMING.firstTelegraph,
    });

    // 1-1 starts at move 1, so move 2 must wind up for 500 ms, not the stale
    // 750 ms / 1000 ms move a kept moveIndex would select.
    engine.input('block', SEQUENCE_TIMING.firstTelegraph);
    advance(engine, SEQUENCE_TIMING.firstTelegraph + 1);
    const restartSecondSpawn =
      SEQUENCE_TIMING.firstTelegraph + SEQUENCE_TIMING.recovery;
    advance(engine, restartSecondSpawn + 1 - engine.snapshot().step);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: restartSecondSpawn + SEQUENCE_TIMING.telegraphs[1]!,
      phase: 'telegraph',
    });
  });

  it('restart falls back to the first move telegraph without firstTelegraphMs', () => {
    const engine = new ZhenShaEngine(FALLBACK_CHART);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: FALLBACK_TIMING.first,
    });

    // One perfect moves the cursor to move 2 (an 800 ms tell).
    engine.input('block', FALLBACK_TIMING.first);
    advance(engine, FALLBACK_TIMING.first + 1);
    const secondSpawn = FALLBACK_TIMING.first + SEQUENCE_TIMING.recovery;
    advance(engine, secondSpawn + 1 - engine.snapshot().step);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: secondSpawn + FALLBACK_TIMING.second,
    });

    engine.restart();

    expect(engine.snapshot()).toEqual(
      new ZhenShaEngine(FALLBACK_CHART).snapshot(),
    );
    // With no firstTelegraphMs, restart opens on the first move's 400 ms tell.
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: FALLBACK_TIMING.first,
    });

    // The fallback also resets the move cursor: move 2 keeps its 800 ms tell.
    engine.input('block', FALLBACK_TIMING.first);
    advance(engine, FALLBACK_TIMING.first + 1);
    const restartSpawn = FALLBACK_TIMING.first + SEQUENCE_TIMING.recovery;
    advance(engine, restartSpawn + 1 - engine.snapshot().step);
    expect(engine.snapshot().attack).toMatchObject({
      impactStep: restartSpawn + FALLBACK_TIMING.second,
    });
  });

  it('defaults to DEFAULT_BOSS_CHART and keeps the kill-gate schedule', () => {
    const implicit = new ZhenShaEngine();
    const explicit = new ZhenShaEngine(DEFAULT_BOSS_CHART);
    expect(implicit.snapshot()).toEqual(explicit.snapshot());

    for (const engine of [implicit, explicit]) {
      engine.input('block', FIRST_IMPACT);
      engine.input('block', FIRST_IMPACT + MOVE_GAP);
      engine.input('block', FIRST_IMPACT + 2 * MOVE_GAP);
      engine.input('charge', BREAK_START + 60);
      engine.input('strike', BREAK_START + 80);
      advance(engine, BREAK_START + 81);
    }

    expect(implicit.snapshot()).toEqual(explicit.snapshot());
    expect(implicit.snapshot().status).toBe('won');
    expect(implicit.drainEvents()).toEqual(explicit.drainEvents());
  });
});

describe('chart validation', () => {
  const VALIDATION_MOVE: BossMoveChart = {
    id: 'validation-move',
    telegraphMs: 900,
    activeMs: 300,
    parryWindowMs: 100,
    damage: 1,
  };

  /** One valid boss/phase/move, with `overrides` applied to that move. */
  function chartWithMove(overrides: Partial<BossMoveChart>): BossChart {
    return {
      bosses: [
        {
          name: '校验 boss',
          phases: [
            {
              id: 'validation-phase',
              moves: [{ ...VALIDATION_MOVE, ...overrides }],
            },
          ],
        },
      ],
    };
  }

  const INVALID_MOVE_TIMINGS: ReadonlyArray<
    readonly [label: string, move: Partial<BossMoveChart>]
  > = [
    ['telegraphMs = 0', { telegraphMs: 0 }],
    ['telegraphMs negative', { telegraphMs: -900 }],
    ['telegraphMs NaN', { telegraphMs: Number.NaN }],
    ['telegraphMs infinite', { telegraphMs: Number.POSITIVE_INFINITY }],
    ['activeMs = 0', { activeMs: 0 }],
    ['activeMs NaN', { activeMs: Number.NaN }],
    ['parryWindowMs negative', { parryWindowMs: -100 }],
  ];

  it.each(INVALID_MOVE_TIMINGS)(
    'rejects a move with %s',
    (_label, move) => {
      expect(() => new ZhenShaEngine(chartWithMove(move))).toThrow(
        /must be a positive number of milliseconds/,
      );
    },
  );

  const INVALID_MOVE_DAMAGE: ReadonlyArray<
    readonly [label: string, move: Partial<BossMoveChart>]
  > = [
    ['damage = 0', { damage: 0 }],
    ['damage negative', { damage: -1 }],
    ['damage NaN', { damage: Number.NaN }],
    ['damage infinite', { damage: Number.POSITIVE_INFINITY }],
  ];

  it.each(INVALID_MOVE_DAMAGE)(
    'rejects a move with invalid damage: %s',
    (_label, move) => {
      expect(() => new ZhenShaEngine(chartWithMove(move))).toThrow(
        /damage must be positive/,
      );
    },
  );

  it.each([1, 10, 12])(
    'rejects activeMs = %i because it spans less than one band tick',
    (activeMs) => {
      expect(() => new ZhenShaEngine(chartWithMove({ activeMs }))).toThrow(
        /activeMs must span at least one tick/,
      );
    },
  );

  const INVALID_BOSS_NAMES: ReadonlyArray<readonly [label: string, name: string]> =
    [
      ['an empty', ''],
      ['a whitespace-only', '   '],
    ];

  it.each(INVALID_BOSS_NAMES)(
    'rejects %s boss name',
    (_label, name) => {
      expect(
        () =>
          new ZhenShaEngine({
            bosses: [
              {
                name,
                phases: [{ id: 'validation-phase', moves: [VALIDATION_MOVE] }],
              },
            ],
          }),
      ).toThrow(/needs a name/);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects firstTelegraphMs = %s',
    (firstTelegraphMs) => {
      expect(
        () =>
          new ZhenShaEngine({
            ...chartWithMove({}),
            firstTelegraphMs,
          }),
      ).toThrow(
        /firstTelegraphMs must be a positive number of milliseconds/,
      );
    },
  );

  it('rejects a chart without a complete first stage', () => {
    expect(() => new ZhenShaEngine({ bosses: [] })).toThrow(RangeError);
    expect(
      () => new ZhenShaEngine({ bosses: [{ name: '空', phases: [] }] }),
    ).toThrow(RangeError);
    expect(
      () =>
        new ZhenShaEngine({
          bosses: [{ name: '空', phases: [{ id: 'empty', moves: [] }] }],
        }),
    ).toThrow(RangeError);
  });

  it('rejects a perfect window wider than the move active window', () => {
    expect(
      () =>
        new ZhenShaEngine({
          bosses: [
            {
              name: '错',
              phases: [
                {
                  id: 'wide',
                  moves: [
                    {
                      id: 'wide-move',
                      telegraphMs: 900,
                      activeMs: 100,
                      parryWindowMs: 200,
                      damage: 1,
                    },
                  ],
                },
              ],
            },
          ],
        }),
    ).toThrow(RangeError);
  });

  it('rejects a negative recovery', () => {
    expect(
      () =>
        new ZhenShaEngine({
          recoveryMs: -1,
          bosses: [
            {
              name: '错',
              phases: [
                {
                  id: 'bad-recovery',
                  moves: [
                    {
                      id: 'bad-recovery-move',
                      telegraphMs: 900,
                      activeMs: 300,
                      parryWindowMs: 100,
                      damage: 1,
                    },
                  ],
                },
              ],
            },
          ],
        }),
    ).toThrow(RangeError);
  });
});

/** Browser, renderer, timer and wall-clock APIs the tick engine must not use. */
const FORBIDDEN_ENGINE_SOURCE =
  /\b(?:document|window|navigator|localStorage|sessionStorage|fetch|Audio|performance|requestAnimationFrame|setTimeout|setInterval|Phaser|THREE|require|globalThis)\b|Date\.now|\bnew\s+Date\b|\bMath\.random\b/;

describe('engine source constraints', () => {
  it('stays free of browser, renderer, timer and wall-clock APIs', () => {
    const source = readFileSync(
      new URL('./engine.ts', import.meta.url),
      'utf8',
    );

    // The chart contract is the engine's only import; everything else stays
    // out so the rules keep running in plain Node and in a fixed tick loop.
    const importSpecifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ].map((match) => match[1]);
    expect(importSpecifiers).toEqual(['./boss-chart']);
    // Side-effect and dynamic imports have no `from` clause; reject them too.
    expect(source).not.toMatch(/(?:^|\n)\s*import\s*['"]/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(FORBIDDEN_ENGINE_SOURCE);
    expect(source).not.toMatch(ACCEPTANCE_PURITY_GREP);
  });
});
