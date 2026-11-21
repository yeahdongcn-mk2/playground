/**
 * Read-only settlement model and Canvas 2D renderer for Zhen Sha.
 *
 * A settlement is derived from exactly two inputs: the engine snapshot and the
 * engine events of one duel. Nothing here reads the view, storage or any other
 * application state, so the same snapshot plus event list always produces the
 * same perfect count, elapsed time, boss/phase and blade-light trail. There is
 * no randomness and no wall clock in this module.
 *
 * The renderer authors the whole "battle seal" (战绩符) in a fixed
 * 1080 x 1440 design space and scales it to the caller's canvas, so the in-game
 * preview and the PNG export share one drawing implementation.
 */

import type { ZhenShaEvent, ZhenShaEventType, ZhenShaSnapshot } from './engine';

/** Design width of the exported battle seal (3:4 portrait). */
export const SETTLEMENT_WIDTH = 1080;

/** Design height of the exported battle seal (3:4 portrait). */
export const SETTLEMENT_HEIGHT = 1440;

/** Ink colour used by one deterministic blade-light arc. */
export type SettlementTone = 'gold' | 'cinnabar' | 'ash';

/** A point in normalised card space: 0..1 on both axes. */
export interface SettlementPoint {
  readonly x: number;
  readonly y: number;
}

/** One deterministic blade-light arc derived from one engine event. */
export interface SettlementSlash {
  /** Engine tick that produced the event; the arc geometry starts here. */
  readonly step: number;
  readonly tone: SettlementTone;
  readonly start: SettlementPoint;
  readonly control: SettlementPoint;
  readonly end: SettlementPoint;
}

/** Boss identity frozen at settlement time. */
export interface SettlementBoss {
  readonly name: string;
  readonly phase: number;
}

/** Immutable per-duel settlement, ready for preview and PNG export. */
export interface ZhenShaSettlement {
  readonly perfects: number;
  readonly elapsedMs: number;
  readonly boss: SettlementBoss;
  /**
   * One arc per engine event of this duel, in event order. Empty when the duel
   * produced no events, which is exactly when nothing was struck.
   */
  readonly slashes: readonly SettlementSlash[];
}

/** Options for {@link drawSettlement}; defaults to the 1080 x 1440 export size. */
export interface SettlementRenderOptions {
  readonly width?: number;
  readonly height?: number;
}

/**
 * Derive the settlement from the engine snapshot and the events drained from
 * this duel. The snapshot owns the numbers; the events only shape the trail.
 */
export function createSettlement(
  snapshot: ZhenShaSnapshot,
  events: readonly ZhenShaEvent[],
): ZhenShaSettlement {
  return {
    perfects: snapshot.perfects,
    elapsedMs: snapshot.elapsedMs,
    boss: {
      name: snapshot.boss.name,
      phase: snapshot.boss.phase,
    },
    slashes: events.map((event, index) => ({
      step: event.step,
      tone: TONE_BY_EVENT[event.type],
      ...geometryFor(event.step, index, event.type),
    })),
  };
}

/** Format duel time for the seal: one decimal, fixed unit. */
export function formatSettlementElapsed(elapsedMs: number): string {
  const safeMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return `${(safeMs / 1000).toFixed(1)}s`;
}

const TONE_BY_EVENT: Readonly<Record<ZhenShaEventType, SettlementTone>> = {
  perfect: 'gold',
  normal: 'ash',
  miss: 'ash',
  hit: 'cinnabar',
  strike: 'gold',
  break: 'gold',
  'break-end': 'ash',
  finisher: 'gold',
  win: 'gold',
  lose: 'cinnabar',
};

/** Small integer salt per event type so two outcomes never share one arc. */
const SALT_BY_EVENT: Readonly<Record<ZhenShaEventType, number>> = {
  perfect: 1,
  normal: 2,
  miss: 3,
  hit: 5,
  strike: 7,
  break: 11,
  'break-end': 13,
  finisher: 17,
  win: 19,
  lose: 23,
};

/** Modular bucket count for the deterministic step-to-fraction mapping. */
const SLASH_BUCKETS = 997;

/** Round to three decimals so a fixed fixture compares exactly. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Map a signed integer seed into a stable 0..1 fraction without randomness. */
function fraction(seed: number): number {
  const wrapped = ((seed % SLASH_BUCKETS) + SLASH_BUCKETS) % SLASH_BUCKETS;
  return round3(wrapped / SLASH_BUCKETS);
}

/**
 * Deterministic arc geometry. The event's tick and its ordinal pick the swing
 * width and lift, so a different event sequence always yields a different
 * trail, while replaying the same sequence yields the same arcs.
 */
function geometryFor(
  step: number,
  index: number,
  type: ZhenShaEventType,
): Pick<SettlementSlash, 'start' | 'control' | 'end'> {
  const salt = SALT_BY_EVENT[type] + index * 37;
  const swoop = fraction(step * 31 + salt);
  const lift = fraction(step * 17 + salt * 3 + 11);
  return {
    start: {
      x: round3(0.16 + 0.12 * swoop),
      y: round3(0.6 - 0.12 * lift),
    },
    control: {
      x: round3(0.48 + 0.08 * lift),
      y: round3(0.38 + 0.2 * swoop),
    },
    end: {
      x: round3(0.84 - 0.12 * swoop),
      y: round3(0.54 + 0.14 * lift),
    },
  };
}

const PAPER = '#e9dfcc';
const INK = '#070609';
const CINNABAR = '#a72c24';
const ASH = '#857f87';
const GOLD = '#f6c453';
const SERIF_FONT =
  "'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', 'SimSun', serif";
const TAU = Math.PI * 2;

const TONE_RGB: Readonly<Record<SettlementTone, string>> = {
  gold: '246, 196, 83',
  cinnabar: '167, 44, 36',
  ash: '133, 127, 135',
};

/** Fixed ink blooms; a table, not a random generator, keeps the paper stable. */
const PAPER_BLOOMS: readonly (readonly [number, number, number, number])[] = [
  [118, 214, 252, 0.05],
  [934, 402, 318, 0.038],
  [236, 1186, 356, 0.034],
];

/** Fixed paper fibres, drawn as short hairlines under the seal. */
const PAPER_FIBERS: readonly (readonly [number, number, number, number])[] = [
  [72, 96, 286, 112],
  [108, 204, 372, 190],
  [760, 88, 1004, 104],
  [52, 356, 226, 344],
  [44, 762, 214, 776],
  [58, 1068, 238, 1054],
];

const SEAL_SIZE = 470;
const SEAL_X = (SETTLEMENT_WIDTH - SEAL_SIZE) / 2;
const SEAL_Y = 230;

/** Paper-coloured cuts along the seal's inner frame. */
const SEAL_NOTCHES: readonly (readonly [number, number, number, number])[] = [
  [SEAL_X + 34, SEAL_Y + 120, SEAL_X + 34, SEAL_Y + 168],
  [SEAL_X + 34, SEAL_Y + 300, SEAL_X + 34, SEAL_Y + 344],
  [SEAL_X + SEAL_SIZE - 34, SEAL_Y + 126, SEAL_X + SEAL_SIZE - 34, SEAL_Y + 180],
  [SEAL_X + 108, SEAL_Y + 34, SEAL_X + 160, SEAL_Y + 34],
  [SEAL_X + 118, SEAL_Y + SEAL_SIZE - 34, SEAL_X + 166, SEAL_Y + SEAL_SIZE - 34],
];

function font(size: number, weight: number): string {
  return `${weight} ${size}px ${SERIF_FONT}`;
}

/**
 * Paint the complete battle seal on `context`.
 *
 * The caller sets the backing canvas to `width` x `height`; the design is
 * authored at 1080 x 1440 and scaled to fit, so the on-screen preview, the
 * bitmap export and the tests all exercise the same calls.
 */
export function drawSettlement(
  context: CanvasRenderingContext2D,
  settlement: ZhenShaSettlement,
  options: SettlementRenderOptions = {},
): void {
  const width = options.width ?? SETTLEMENT_WIDTH;
  const height = options.height ?? SETTLEMENT_HEIGHT;

  context.save();
  context.clearRect(0, 0, width, height);
  context.scale(width / SETTLEMENT_WIDTH, height / SETTLEMENT_HEIGHT);

  drawPaper(context);
  drawSeal(context);
  drawTrail(context, settlement.slashes);
  drawReadout(context, settlement);

  context.restore();
}

function drawPaper(context: CanvasRenderingContext2D): void {
  context.fillStyle = PAPER;
  context.fillRect(0, 0, SETTLEMENT_WIDTH, SETTLEMENT_HEIGHT);

  for (const [x, y, radius, alpha] of PAPER_BLOOMS) {
    context.fillStyle = `rgba(${TONE_RGB.ash}, ${alpha})`;
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.fill();
  }

  context.lineCap = 'round';
  context.strokeStyle = 'rgba(133, 127, 135, 0.14)';
  context.lineWidth = 2;
  for (const [x1, y1, x2, y2] of PAPER_FIBERS) {
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  }

  context.strokeStyle = 'rgba(7, 6, 9, 0.55)';
  context.lineWidth = 3;
  context.strokeRect(36, 36, SETTLEMENT_WIDTH - 72, SETTLEMENT_HEIGHT - 72);
}

function drawSeal(context: CanvasRenderingContext2D): void {
  // A soft cinnabar halo reads as fresh seal paste pressed into the paper.
  context.strokeStyle = 'rgba(167, 44, 36, 0.16)';
  context.lineWidth = 28;
  context.strokeRect(SEAL_X - 10, SEAL_Y - 10, SEAL_SIZE + 20, SEAL_SIZE + 20);
  context.strokeStyle = 'rgba(167, 44, 36, 0.28)';
  context.lineWidth = 10;
  context.strokeRect(SEAL_X - 2, SEAL_Y - 2, SEAL_SIZE + 4, SEAL_SIZE + 4);

  context.fillStyle = CINNABAR;
  context.fillRect(SEAL_X, SEAL_Y, SEAL_SIZE, SEAL_SIZE);

  // Uneven ink patches keep the stamp from looking like a flat vector tile.
  context.fillStyle = 'rgba(7, 6, 9, 0.08)';
  context.fillRect(SEAL_X + 22, SEAL_Y + 26, SEAL_SIZE - 74, 64);
  context.fillRect(SEAL_X + 44, SEAL_Y + SEAL_SIZE - 92, SEAL_SIZE - 92, 46);

  context.strokeStyle = 'rgba(233, 223, 204, 0.85)';
  context.lineWidth = 7;
  context.strokeRect(SEAL_X + 34, SEAL_Y + 34, SEAL_SIZE - 68, SEAL_SIZE - 68);

  context.strokeStyle = 'rgba(233, 223, 204, 0.5)';
  context.lineWidth = 4;
  for (const [x1, y1, x2, y2] of SEAL_NOTCHES) {
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  }

  // Original two-character seal face: the game's own name, no borrowed marks.
  context.fillStyle = PAPER;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = font(176, 700);
  context.fillText('镇', SEAL_X + 148, SEAL_Y + 214);
  context.fillText('煞', SEAL_X + 330, SEAL_Y + 226);

  context.font = font(32, 600);
  context.globalAlpha = 0.85;
  context.fillText('战 绩 符', SEAL_X + SEAL_SIZE / 2, SEAL_Y + SEAL_SIZE - 78);
  context.globalAlpha = 1;
}

function drawTrail(
  context: CanvasRenderingContext2D,
  slashes: readonly SettlementSlash[],
): void {
  if (slashes.length === 0) {
    return;
  }
  context.lineCap = 'round';
  context.lineJoin = 'round';

  for (const slash of slashes) {
    const rgb = TONE_RGB[slash.tone];
    for (const [alpha, lineWidth] of [
      [0.17, 22],
      [0.86, 6],
    ] as const) {
      context.strokeStyle = `rgba(${rgb}, ${alpha})`;
      context.lineWidth = lineWidth;
      context.beginPath();
      context.moveTo(
        slash.start.x * SETTLEMENT_WIDTH,
        slash.start.y * SETTLEMENT_HEIGHT,
      );
      context.quadraticCurveTo(
        slash.control.x * SETTLEMENT_WIDTH,
        slash.control.y * SETTLEMENT_HEIGHT,
        slash.end.x * SETTLEMENT_WIDTH,
        slash.end.y * SETTLEMENT_HEIGHT,
      );
      context.stroke();
    }
  }
}

function drawReadout(
  context: CanvasRenderingContext2D,
  settlement: ZhenShaSettlement,
): void {
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  context.fillStyle = INK;
  context.font = font(58, 700);
  context.fillText('镇 煞', SETTLEMENT_WIDTH / 2, 118);

  context.strokeStyle = GOLD;
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(440, 168);
  context.lineTo(640, 168);
  context.stroke();

  context.strokeStyle = 'rgba(7, 6, 9, 0.35)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(140, 1018);
  context.lineTo(940, 1018);
  context.stroke();

  context.fillStyle = INK;
  context.font = font(76, 700);
  context.fillText(`完美 ${settlement.perfects} 次`, SETTLEMENT_WIDTH / 2, 1112);

  context.fillStyle = 'rgba(7, 6, 9, 0.78)';
  context.font = font(48, 500);
  context.fillText(
    `用时 ${formatSettlementElapsed(settlement.elapsedMs)}`,
    SETTLEMENT_WIDTH / 2,
    1202,
  );

  context.fillStyle = CINNABAR;
  context.font = font(44, 600);
  context.fillText(
    `${settlement.boss.name} · 第 ${settlement.boss.phase} 阶段`,
    SETTLEMENT_WIDTH / 2,
    1282,
  );

  context.fillStyle = ASH;
  context.font = font(34, 500);
  context.fillText('一 局 一 符', SETTLEMENT_WIDTH / 2, 1360);
}
