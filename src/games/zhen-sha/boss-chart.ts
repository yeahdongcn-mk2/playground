/**
 * Pure boss-chart contract for Zhen Sha, intended for the rules engine and the
 * real 3 boss × 2 phase data that #246 commits in `bosses.ts`.
 *
 * A chart is data only: no DOM, renderer, audio, timer or wall clock, and no
 * import from the engine or the view. Once the engine is wired to a chart, it
 * reads that chart to decide how long a move winds up, when its parry bands are
 * open, how hard it hits and how long the duel rests between exchanges. The
 * engine consumes a chart through its constructor.
 *
 * Relationship to `bosses.ts`: #246 already ships `BOSSES` with its own
 * `BossMove` / `BossPhase` / `BossChart` types — there a boss carries `id`,
 * `damage` is 7–13 points and `activeMs` is post-wind-up active time. This
 * module is the contract the engine consumes; `boss-chart-adapter.ts` maps
 * `BOSSES` into it and reconciles the units (including `activeMs`) in one
 * place instead of leaving two live contracts, so later cards read the
 * adapter rather than the historical field wording above.
 *
 * `bosses` and `phases` are arrays, not fixed-size tuples. Real charts have
 * three bosses with two phases each and 6–10 moves per phase, but the default
 * chart below is a single boss with a single phase and a single repeated move
 * that reproduces the existing kill-gate timing exactly, ready for the engine
 * to consume.
 */

/**
 * One boss move as timing and damage data.
 *
 * All times are milliseconds of game time; the engine card converts them to
 * integer ticks (120 per second). The default chart's values are exact
 * multiples of 1000/120 ms; non-aligned real values (for example #246's 320 ms)
 * need one explicit rounding rule before they drive judgement. The impact tick
 * ends the wind-up and is the centre of the parry bands.
 */
export interface BossMoveChart {
  /** Stable identifier, unique inside a chart; real data must not recycle it. */
  readonly id: string;
  /** Wind-up before the impact tick; 900 ms for the default chart's repeated move. */
  readonly telegraphMs: number;
  /**
   * Full width of the normal parry band in this contract, not the post-wind-up
   * active time that `bosses.ts` currently calls `activeMs`: the band opens
   * `activeMs / 2` before impact and closes `activeMs / 2` after it, both
   * endpoints inclusive. A tap inside it parries normally; a tap outside it
   * lets the move land.
   */
  readonly activeMs: number;
  /**
   * Full width of the perfect parry band, centred on the impact tick and
   * nested inside `activeMs`, endpoints inclusive. A tap inside it is perfect
   * and earns momentum.
   */
  readonly parryWindowMs: number;
  /**
   * Unparried hits this move costs the player. The default chart's 1 is one
   * hit out of the engine's three-hit budget (`MAX_HITS`). #246's `bosses.ts`
   * currently stores 7–13 damage points instead; the wiring card must pick one
   * unit for both contracts rather than mixing them.
   */
  readonly damage: number;
}

/** One boss phase: an ordered, cycling list of moves. */
export interface BossPhaseChart {
  /** Stable identifier, unique inside a chart. */
  readonly id: string;
  /** 6–10 moves for real data; the default kill-gate phase has one. */
  readonly moves: readonly BossMoveChart[];
}

/** One boss: a name shown by the view and an ordered list of phases. */
export interface BossChartBoss {
  readonly name: string;
  /** Two phases for real data; one for the default kill-gate boss. */
  readonly phases: readonly BossPhaseChart[];
}

/** A complete duel chart: every boss the player must defeat, in order. */
export interface BossChart {
  readonly bosses: readonly BossChartBoss[];
  /**
   * Optional pause between a resolved exchange and the next wind-up. The
   * default kill-gate chart uses 600 ms; omitted charts rest immediately.
   */
  readonly recoveryMs?: number;
  /**
   * Optional wind-up that replaces the first move's own `telegraphMs` for the
   * duel's opening attack only. The default chart warms up for 1500 ms and then
   * uses the move's 900 ms wind-up for every later attack.
   */
  readonly firstTelegraphMs?: number;
}

/**
 * Default chart an argument-free engine uses.
 *
 * It reproduces the original kill gate tick for tick: one 黑煞 phase whose
 * single move repeats after a 900 ms wind-up, an opening attack warmed up for
 * 1500 ms, a 600 ms recovery, a 300 ms normal parry band and a nested 100 ms
 * perfect band. At 120 Hz those convert to 108, 180, 72, 36 and 12 ticks,
 * i.e. the engine's TELEGRAPH_TICKS, FIRST_TELEGRAPH_TICKS, RECOVERY_TICKS,
 * 2 × NORMAL_BAND_HALF_TICKS and 2 × PERFECT_BAND_HALF_TICKS. The engine now
 * consumes this chart through its constructor; the default chart keeps the
 * original kill-gate schedule tick for tick.
 */
export const DEFAULT_BOSS_CHART: BossChart = {
  firstTelegraphMs: 1500,
  recoveryMs: 600,
  bosses: [
    {
      name: '黑煞',
      phases: [
        {
          id: 'kill-gate-1',
          moves: [
            {
              id: 'kill-gate-strike',
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
};
