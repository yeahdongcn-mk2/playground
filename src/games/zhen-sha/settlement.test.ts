// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZhenShaEvent, ZhenShaSnapshot } from './engine';
import {
  SETTLEMENT_HEIGHT,
  SETTLEMENT_WIDTH,
  createSettlement,
  downloadSettlementPng,
  drawSettlement,
  exportSettlementPng,
  formatSettlementElapsed,
  type ZhenShaSettlement,
} from './settlement';

/** A complete dogfight snapshot; overrides keep the fixtures explicit. */
function snapshot(overrides: Partial<ZhenShaSnapshot> = {}): ZhenShaSnapshot {
  return {
    step: 240,
    elapsedMs: 2000,
    status: 'won',
    boss: { name: '黑煞', phase: 1, guard: 'broken' },
    attack: null,
    charging: false,
    momentum: 3,
    perfects: 3,
    hits: 1,
    score: 1900,
    breakTicksLeft: 0,
    lastJudgement: 'perfect',
    ...overrides,
  };
}

/** A fixed duel: three perfect parries, one hit and the finisher. */
const DUEL_EVENTS: readonly ZhenShaEvent[] = [
  { type: 'perfect', step: 12 },
  { type: 'hit', step: 96 },
  { type: 'perfect', step: 150 },
  { type: 'perfect', step: 222 },
  { type: 'finisher', step: 240 },
];

/**
 * Hand-computed expectation for {@link DUEL_EVENTS}. The arc fields must be
 * copied from the deterministic specification, not produced by calling the
 * implementation under test.
 */
const EXPECTED: ZhenShaSettlement = {
  perfects: 3,
  elapsedMs: 2000,
  boss: { name: '黑煞', phase: 1 },
  slashes: [
    {
      step: 12,
      tone: 'gold',
      start: { x: 0.205, y: 0.574 },
      control: { x: 0.498, y: 0.455 },
      end: { x: 0.795, y: 0.571 },
    },
    {
      step: 96,
      tone: 'cinnabar',
      start: { x: 0.163, y: 0.507 },
      control: { x: 0.542, y: 0.385 },
      end: { x: 0.837, y: 0.648 },
    },
    {
      step: 150,
      tone: 'gold',
      start: { x: 0.249, y: 0.505 },
      control: { x: 0.544, y: 0.528 },
      end: { x: 0.751, y: 0.651 },
    },
    {
      step: 222,
      tone: 'gold',
      start: { x: 0.162, y: 0.584 },
      control: { x: 0.491, y: 0.383 },
      end: { x: 0.838, y: 0.559 },
    },
    {
      step: 240,
      tone: 'gold',
      start: { x: 0.235, y: 0.528 },
      control: { x: 0.528, y: 0.506 },
      end: { x: 0.765, y: 0.624 },
    },
  ],
};

interface FakeCanvasContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
}

/** Minimal 2D context stub that records drawing calls and scale factors. */
function createFakeContext(): {
  context: CanvasRenderingContext2D;
  calls: string[];
  scales: Array<readonly [number, number]>;
} {
  const calls: string[] = [];
  const scales: Array<readonly [number, number]> = [];
  const context: FakeCanvasContext = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    save() {
      calls.push('save');
    },
    restore() {
      calls.push('restore');
    },
    scale(x, y) {
      scales.push([x, y]);
      calls.push(`scale:${x},${y}`);
    },
    clearRect(x, y, width, height) {
      calls.push(`clearRect:${x},${y},${width},${height}`);
    },
    fillRect(x, y, width, height) {
      calls.push(`fillRect:${this.fillStyle}:${x},${y},${width},${height}`);
    },
    strokeRect(x, y, width, height) {
      calls.push(`strokeRect:${this.strokeStyle}:${x},${y},${width},${height}`);
    },
    beginPath() {
      calls.push('beginPath');
    },
    closePath() {
      calls.push('closePath');
    },
    arc(x, y, radius, start, end) {
      calls.push(`arc:${x},${y},${radius},${start},${end}`);
    },
    moveTo(x, y) {
      calls.push(`moveTo:${x},${y}`);
    },
    lineTo(x, y) {
      calls.push(`lineTo:${x},${y}`);
    },
    quadraticCurveTo(cx, cy, x, y) {
      calls.push(`quadraticCurveTo:${cx},${cy},${x},${y}`);
    },
    fill() {
      calls.push('fill');
    },
    stroke() {
      calls.push('stroke');
    },
    fillText(text, x, y) {
      calls.push(`fillText:${this.fillStyle}:${text}:${x},${y}`);
    },
  };

  return {
    context: context as unknown as CanvasRenderingContext2D,
    calls,
    scales,
  };
}

describe('zhen-sha settlement data', () => {
  it('derives perfects, elapsed time, boss, phase and trail item by item', () => {
    expect(createSettlement(snapshot(), DUEL_EVENTS)).toEqual(EXPECTED);
  });

  it('freezes the boss name and phase exactly as the snapshot reports them', () => {
    const settlement = createSettlement(
      snapshot({ boss: { name: '测试首领', phase: 2, guard: 'up' } }),
      [],
    );

    expect(settlement.boss).toEqual({ name: '测试首领', phase: 2 });
    expect(settlement.perfects).toBe(3);
    expect(settlement.elapsedMs).toBe(2000);
  });

  it('returns an empty trail when the duel produced no events', () => {
    const settlement = createSettlement(snapshot({ perfects: 0 }), []);

    expect(settlement.slashes).toEqual([]);
    expect(settlement.perfects).toBe(0);
  });

  it('derives a different trail from a different event sequence', () => {
    const alternative = createSettlement(snapshot(), [
      { type: 'perfect', step: 12 },
      { type: 'perfect', step: 96 },
      { type: 'perfect', step: 150 },
    ]);

    expect(alternative.slashes).toHaveLength(3);
    expect(alternative.slashes).not.toEqual(EXPECTED.slashes);
    expect(alternative.slashes.map((slash) => slash.tone)).toEqual([
      'gold',
      'gold',
      'gold',
    ]);
  });

  it('is deterministic and leaves frozen inputs untouched', () => {
    const frozenSnapshot = Object.freeze({
      ...snapshot(),
      boss: Object.freeze({ name: '黑煞', phase: 1, guard: 'broken' as const }),
    });
    const frozenEvents = Object.freeze(
      DUEL_EVENTS.map((event) => Object.freeze({ ...event })),
    );

    const first = createSettlement(frozenSnapshot, frozenEvents);
    const second = createSettlement(frozenSnapshot, frozenEvents);

    expect(second).toEqual(first);
    expect(second.slashes).not.toBe(first.slashes);
  });

  it('formats elapsed time with one decimal and a fixed unit', () => {
    expect(formatSettlementElapsed(2000)).toBe('2.0s');
    expect(formatSettlementElapsed(12345)).toBe('12.3s');
    expect(formatSettlementElapsed(-50)).toBe('0.0s');
    expect(formatSettlementElapsed(Number.NaN)).toBe('0.0s');
  });
});

describe('zhen-sha settlement renderer', () => {
  it('paints the xuan paper, cinnabar seal and readout on a 2D context', () => {
    const { context, calls, scales } = createFakeContext();
    drawSettlement(context, EXPECTED);

    expect(scales).toEqual([[1, 1]]);
    expect(calls).toContain(`clearRect:0,0,${SETTLEMENT_WIDTH},${SETTLEMENT_HEIGHT}`);
    expect(calls).toContain(`fillRect:#e9dfcc:0,0,${SETTLEMENT_WIDTH},${SETTLEMENT_HEIGHT}`);
    expect(calls.some((call) => call.startsWith('fillRect:#a72c24'))).toBe(true);
    expect(calls.some((call) => call.startsWith('fillText:#e9dfcc:镇'))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes('完美 3 次'))).toBe(true);
    expect(calls.some((call) => call.includes('用时 2.0s'))).toBe(true);
    expect(calls.some((call) => call.includes('黑煞 · 第 1 阶段'))).toBe(true);
  });

  it('draws one quadratic blade-light arc per settlement slash', () => {
    const { context, calls } = createFakeContext();
    drawSettlement(context, EXPECTED);

    const arcs = calls.filter((call) => call.startsWith('quadraticCurveTo'));
    const first = EXPECTED.slashes[0];
    expect(arcs).toHaveLength(EXPECTED.slashes.length * 2);
    if (first === undefined) {
      throw new Error('fixture is missing its first slash');
    }
    expect(arcs[0]).toBe(
      `quadraticCurveTo:${first.control.x * SETTLEMENT_WIDTH},${
        first.control.y * SETTLEMENT_HEIGHT
      },${first.end.x * SETTLEMENT_WIDTH},${first.end.y * SETTLEMENT_HEIGHT}`,
    );
  });

  it('draws no blade-light arc when the settlement trail is empty', () => {
    const { context, calls } = createFakeContext();
    drawSettlement(context, createSettlement(snapshot({ perfects: 0 }), []));

    expect(calls.filter((call) => call.startsWith('quadraticCurveTo'))).toEqual(
      [],
    );
    expect(calls.some((call) => call.includes('完美 0 次'))).toBe(true);
  });

  it('scales the 1080x1440 design to the requested canvas size', () => {
    const { context, calls, scales } = createFakeContext();
    drawSettlement(context, EXPECTED, { width: 540, height: 720 });

    expect(scales).toEqual([[0.5, 0.5]]);
    expect(calls[0]).toBe('save');
    expect(calls[1]).toBe('clearRect:0,0,540,720');
  });

  it('keeps randomness, wall clocks and network APIs out of the source', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'settlement.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/Math\.random|Date\.now|fetch|XMLHttpRequest/);
  });
});

interface FakeExportCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly calls: string[];
  readonly requestedSizes: Array<readonly [number, number]>;
  readonly toBlobTypes: string[];
  readonly toDataUrlTypes: string[];
  /** The blob the fake `toBlob` returns; null on the toDataURL fallback variants. */
  readonly toBlobResult: Blob | null;
}

/** Canvas stub that records sizing, encoding and the shared 2D drawing calls. */
function createFakeExportCanvas(
  options: {
    readonly blob?: Blob | null;
    readonly dataUrl?: string;
    readonly withoutToBlob?: boolean;
    readonly toBlobError?: boolean;
    readonly withoutContext?: boolean;
  } = {},
): FakeExportCanvas {
  const { context, calls } = createFakeContext();
  const requestedSizes: Array<readonly [number, number]> = [];
  const toBlobTypes: string[] = [];
  const toDataUrlTypes: string[] = [];
  const blob =
    options.blob === undefined
      ? new Blob(['seal'], { type: 'image/png' })
      : options.blob;
  const dataUrl = options.dataUrl ?? 'data:image/png;base64,iVBORw==';

  const canvas = {
    width: 0,
    height: 0,
    getContext(kind: string) {
      calls.push(`getContext:${kind}`);
      return options.withoutContext === true ? null : context;
    },
    toBlob(callback: BlobCallback, type?: string) {
      toBlobTypes.push(type ?? '');
      if (options.toBlobError === true) {
        throw new Error('toBlob unavailable');
      }
      callback(blob);
    },
    toDataURL(type?: string) {
      toDataUrlTypes.push(type ?? '');
      return dataUrl;
    },
  };

  if (options.withoutToBlob === true) {
    delete (canvas as Partial<typeof canvas>).toBlob;
  }

  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    calls,
    requestedSizes,
    toBlobTypes,
    toDataUrlTypes,
    toBlobResult: blob,
  };
}

/** Inject one fake canvas while recording every requested export size. */
function useFakeCanvas(
  fixture: FakeExportCanvas,
): (width: number, height: number) => HTMLCanvasElement {
  return (width, height) => {
    fixture.requestedSizes.push([width, height]);
    return fixture.canvas;
  };
}

describe('zhen-sha settlement PNG export', () => {
  it('draws the settlement on a 1080x1440 offscreen canvas and encodes it with toBlob', async () => {
    const fixture = createFakeExportCanvas();

    const blob = await exportSettlementPng(EXPECTED, {
      createCanvas: useFakeCanvas(fixture),
    });

    expect(fixture.requestedSizes).toEqual([
      [SETTLEMENT_WIDTH, SETTLEMENT_HEIGHT],
    ]);
    expect(fixture.canvas.width).toBe(SETTLEMENT_WIDTH);
    expect(fixture.canvas.height).toBe(SETTLEMENT_HEIGHT);
    expect(fixture.calls).toContain('getContext:2d');
    expect(fixture.calls).toContain('scale:1,1');
    expect(fixture.calls).toContain(
      `clearRect:0,0,${SETTLEMENT_WIDTH},${SETTLEMENT_HEIGHT}`,
    );
    expect(fixture.calls.some((call) => call.includes('完美 3 次'))).toBe(true);
    expect(fixture.toBlobTypes).toEqual(['image/png']);
    expect(fixture.toDataUrlTypes).toEqual([]);
    expect(blob.type).toBe('image/png');
  });

  it('falls back to toDataURL when the canvas has no toBlob', async () => {
    const fixture = createFakeExportCanvas({ withoutToBlob: true });

    const blob = await exportSettlementPng(EXPECTED, {
      createCanvas: useFakeCanvas(fixture),
    });

    expect(fixture.toDataUrlTypes).toEqual(['image/png']);
    expect(blob.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
      137, 80, 78, 71,
    ]);
  });

  it('falls back to toDataURL when toBlob yields null', async () => {
    const fixture = createFakeExportCanvas({ blob: null });

    const blob = await exportSettlementPng(EXPECTED, {
      createCanvas: useFakeCanvas(fixture),
    });

    expect(fixture.toBlobTypes).toEqual(['image/png']);
    expect(fixture.toDataUrlTypes).toEqual(['image/png']);
    expect(blob.type).toBe('image/png');
  });

  it('falls back to toDataURL when toBlob throws', async () => {
    const fixture = createFakeExportCanvas({ toBlobError: true });

    const blob = await exportSettlementPng(EXPECTED, {
      createCanvas: useFakeCanvas(fixture),
    });

    expect(fixture.toBlobTypes).toEqual(['image/png']);
    expect(fixture.toDataUrlTypes).toEqual(['image/png']);
    expect(blob.type).toBe('image/png');
  });

  it('reports a missing 2D context instead of exporting a blank bitmap', async () => {
    const fixture = createFakeExportCanvas({ withoutContext: true });

    await expect(
      exportSettlementPng(EXPECTED, { createCanvas: useFakeCanvas(fixture) }),
    ).rejects.toThrow('无法为战绩符创建 1080x1440 的 2D canvas 上下文');
    expect(fixture.toBlobTypes).toEqual([]);
    expect(fixture.toDataUrlTypes).toEqual([]);
  });

  it('reports a toDataURL result that is not a base64 PNG data URL', async () => {
    const withoutBase64 = createFakeExportCanvas({
      withoutToBlob: true,
      dataUrl: 'data:image/png,not-base64',
    });
    await expect(
      exportSettlementPng(EXPECTED, {
        createCanvas: useFakeCanvas(withoutBase64),
      }),
    ).rejects.toThrow('canvas.toDataURL 未返回 base64 编码的 PNG data URL');
    expect(withoutBase64.toDataUrlTypes).toEqual(['image/png']);

    const withoutComma = createFakeExportCanvas({
      withoutToBlob: true,
      dataUrl: 'data:image/png;base64',
    });
    await expect(
      exportSettlementPng(EXPECTED, { createCanvas: useFakeCanvas(withoutComma) }),
    ).rejects.toThrow('canvas.toDataURL 未返回 base64 编码的 PNG data URL');
    expect(withoutComma.toDataUrlTypes).toEqual(['image/png']);
  });
});

describe('zhen-sha settlement PNG download', () => {
  const objectUrls = URL as unknown as {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };

  beforeEach(() => {
    objectUrls.createObjectURL = vi.fn(() => 'blob:zhen-sha-seal');
    objectUrls.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    delete objectUrls.createObjectURL;
    delete objectUrls.revokeObjectURL;
    vi.restoreAllMocks();
  });

  it('clicks an <a download> named from the caller timestamp and releases the object URL', async () => {
    const fixture = createFakeExportCanvas();
    const clickedAnchors: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      });

    await downloadSettlementPng(EXPECTED, {
      timestamp: 1_700_000_000_000,
      createCanvas: useFakeCanvas(fixture),
    });

    const [anchor] = clickedAnchors;
    expect(clickSpy).toHaveBeenCalledTimes(1);
    if (anchor === undefined) {
      throw new Error('下载没有点击合成的 <a>');
    }
    // Literal expectation: the caller timestamp must reach the file name
    // verbatim, so a `settlementPngFilename` regression cannot self-confirm.
    expect(anchor.download).toBe('zhen-sha-seal-1700000000000.png');
    expect(anchor.getAttribute('href')).toBe('blob:zhen-sha-seal');
    expect(anchor.isConnected).toBe(false);
    expect(fixture.toBlobTypes).toEqual(['image/png']);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:zhen-sha-seal');
    const exported = fixture.toBlobResult;
    if (exported === null) {
      throw new Error('假 canvas 没有导出 blob');
    }
    const downloaded = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    // The object URL must wrap the very blob the export produced; an empty
    // placeholder blob would still carry the image/png MIME type.
    expect(downloaded).toBe(exported);
  });
});
