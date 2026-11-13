import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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

  it('pins the exported timing constants the view relies on', () => {
    expect(TICKS_PER_SECOND).toBe(120);
    expect(FIXED_STEP_MS).toBeCloseTo(1000 / 120, 12);
    expect(PERFECT_BAND_HALF_TICKS).toBe(6);
    expect(NORMAL_BAND_HALF_TICKS).toBe(18);
    expect(BREAK_TICKS).toBe(240);
    expect(MAX_HITS).toBe(3);
    expect(MOMENTUM_FOR_BREAK).toBe(3);
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

describe('engine source constraints', () => {
  it('stays free of browser, renderer, timer and wall-clock APIs', () => {
    const source = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(
      /\b(?:document|window|navigator|localStorage|sessionStorage|fetch|Audio|performance|requestAnimationFrame|setTimeout|setInterval|Phaser|THREE)\b|Date\.now|Math\.random/,
    );
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});
