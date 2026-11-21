import type { SoundEvent } from '../../core/audio';
import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import {
  MAX_HITS,
  MOMENTUM_FOR_BREAK,
  TELEGRAPH_TICKS,
  TICKS_PER_SECOND,
  ZhenShaEngine,
  type ZhenShaAction,
  type ZhenShaEvent,
  type ZhenShaEventType,
  type ZhenShaSnapshot,
  type ZhenShaStatus,
} from './engine';
import {
  SETTLEMENT_HEIGHT,
  SETTLEMENT_WIDTH,
  createSettlement,
  drawSettlement,
  formatSettlementElapsed,
  type ZhenShaSettlement,
} from './settlement';
import './zhen-sha.css';

/** Hold this long without lifting to turn the tap into a charged strike. */
const HOLD_TO_CHARGE_MS = 220;
/** Logical canvas size; CSS scales it down to the available 320px-wide stage. */
const CANVAS_WIDTH = 360;
const CANVAS_HEIGHT = 560;
/** How long a successful/failed exchange stays visible on the canvas. */
const FLASH_MS = 420;
const RESULT_FLASH_MS = 900;
const TAU = Math.PI * 2;

const STATUS_LABELS: Readonly<Record<ZhenShaStatus, string>> = {
  playing: '进行中',
  won: '胜利',
  lost: '失败',
};

const SOUND_BY_EVENT: Readonly<Record<ZhenShaEventType, SoundEvent | null>> = {
  perfect: 'blip',
  normal: 'flag',
  miss: 'reset',
  hit: 'mine',
  strike: 'blip',
  break: 'start',
  'break-end': null,
  finisher: 'win',
  win: 'win',
  lose: 'mine',
};

const VIEW_HTML = `
  <section class="zhen-sha-game" data-testid="zhen-sha-game" data-status="playing">
    <div class="game-heading">
      <a class="back-link" href="#/">
        <span aria-hidden="true">←</span> 返回大厅
      </a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> DOM · 动作 · 弹反</p>
        <h1>镇煞 <span>Zhen Sha</span></h1>
      </div>
      <dl class="zhen-sha-hud" aria-label="游戏数据">
        <div class="zhen-sha-stat">
          <dt>势</dt>
          <dd class="zhen-sha-momentum" data-testid="momentum" data-filled="0"
            aria-label="势 0 / 3">
            <span class="zhen-sha-pip" aria-hidden="true"></span>
            <span class="zhen-sha-pip" aria-hidden="true"></span>
            <span class="zhen-sha-pip" aria-hidden="true"></span>
          </dd>
        </div>
        <div class="zhen-sha-stat">
          <dt>完美</dt>
          <dd data-testid="perfects">0</dd>
        </div>
        <div class="zhen-sha-stat">
          <dt>中招</dt>
          <dd data-testid="hits">0 / ${MAX_HITS}</dd>
        </div>
      </dl>
    </div>

    <div class="zhen-sha-layout">
      <div class="zhen-sha-main">
        <div class="zhen-sha-stage" data-testid="zhen-sha-stage">
          <canvas class="zhen-sha-canvas" data-testid="zhen-sha-canvas"
            role="img" aria-label="黑宣纸上的黑煞首领与金棍"></canvas>
          <div class="zhen-sha-overlay" data-testid="overlay" role="group"
            aria-labelledby="zhen-sha-overlay-title" hidden>
            <div class="zhen-sha-overlay-card zhen-sha-settlement" data-testid="settlement"
              data-stamps="0">
              <p class="panel-kicker" data-testid="overlay-kicker">RESULT</p>
              <h2 id="zhen-sha-overlay-title" data-testid="overlay-title">对决结束</h2>
              <canvas class="zhen-sha-settlement-canvas" data-testid="settlement-canvas"
                width="${SETTLEMENT_WIDTH}" height="${SETTLEMENT_HEIGHT}" role="img"
                aria-label="战绩符：朱印、完美数、用时、首领阶段与弹回刀光"></canvas>
              <dl class="zhen-sha-settlement-stats">
                <div><dt>完美</dt><dd data-testid="settlement-perfects">0</dd></div>
                <div><dt>用时</dt><dd data-testid="settlement-elapsed">0.0s</dd></div>
                <div><dt>刀光</dt><dd data-testid="settlement-slashes">0 道</dd></div>
                <div><dt>首领</dt><dd data-testid="settlement-boss">—</dd></div>
              </dl>
              <div class="zhen-sha-overlay-actions">
                <button class="button button--primary" type="button" data-action="restart"
                  data-testid="overlay-restart">再来一局</button>
                <a class="button button--ghost" href="#/" data-testid="overlay-lobby">返回大厅</a>
              </div>
            </div>
          </div>
        </div>

        <ul class="zhen-sha-hints" data-testid="gesture-hints" aria-label="三种手势">
          <li><span>轻点</span>格挡</li>
          <li><span>长按</span>蓄势</li>
          <li><span>松手</span>棍击</li>
        </ul>
        <p class="zhen-sha-gesture-note" data-testid="gesture-note">
          杀招出手前一瞬轻点才是完美格挡。完美三次破防，破防后按住蓄势、松手终结。
        </p>
      </div>

      <aside class="zhen-sha-panel" aria-label="操作与状态">
        <div class="panel-card">
          <p class="panel-kicker">CONTROLS</p>
          <h2>三种手势</h2>
          <dl class="control-list">
            <div><dt>轻点</dt><dd>格挡杀招</dd></div>
            <div><dt>长按</dt><dd>蓄起金棍</dd></div>
            <div><dt>松手</dt><dd>一棍击出</dd></div>
          </dl>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">STATUS</p>
          <h2>本局</h2>
          <p class="zhen-sha-row"><span>判定</span><strong data-testid="judgement">等待出手</strong></p>
          <p class="zhen-sha-row"><span>得分</span><strong data-testid="score">0</strong></p>
          <p class="zhen-sha-row"><span>状态</span><strong data-testid="status">进行中</strong></p>
          <div class="panel-actions">
            <button class="button button--ghost" type="button" data-action="restart"
              data-testid="restart-button">重开</button>
          </div>
        </div>

        <p class="zhen-sha-note">
          首领只有一招：长枪突刺。看准枪尖亮起的时机轻点，三次完美便破防。
        </p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
      </aside>
    </div>
  </section>
`;

function abortError(): DOMException {
  return new DOMException('Game mount aborted', 'AbortError');
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface Flash {
  readonly type: ZhenShaEventType;
  remainingMs: number;
}

/** Snapshot plus the settlement of the same duel, read through the test seam. */
type ZhenShaDebugState = ZhenShaSnapshot & {
  settlement: ZhenShaSettlement | null;
};

interface ZhenShaDebugApi {
  readonly gameId: 'zhen-sha';
  readonly getState: () => ZhenShaDebugState;
  /** Queue one logical action at the current tick, like a pointer gesture. */
  readonly input: (action: ZhenShaAction) => void;
  /** Advance exactly `ticks` fixed steps (default 1) without wall-clock time. */
  readonly step: (ticks?: number) => void;
  readonly restart: () => void;
  readonly destroy: () => void;
}

/**
 * Test seam. `window.__playground` is shared with the other games, so use one
 * local cast instead of merging a conflicting global declaration.
 */
interface ZhenShaDebugWindow {
  __playground?: ZhenShaDebugApi;
}

function debugWindow(): ZhenShaDebugWindow {
  return window as unknown as ZhenShaDebugWindow;
}

/**
 * Test seam: only a `?debug=1` hash route installs it, so the normal entry
 * never exposes engine control or the settlement model. Unlike the Phaser
 * games this is not enabled for every dev-server visit: the parry timing is
 * tick-exact and a stray auto-started loop would make a fixed input sequence
 * non-reproducible.
 */
function debugEnabled(): boolean {
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).has('debug') : false;
}

/** Mount the minimal playable Zhen Sha duel: canvas scene plus pointer gestures. */
export function mountZhenSha(
  root: HTMLElement,
  services: GameServices,
  mountSignal: AbortSignal,
): GameHandle {
  if (mountSignal.aborted) {
    throw abortError();
  }

  root.innerHTML = VIEW_HTML;

  const gameRoot = query<HTMLElement>(root, '[data-testid="zhen-sha-game"]');
  const stage = query<HTMLElement>(root, '[data-testid="zhen-sha-stage"]');
  const canvas = query<HTMLCanvasElement>(root, '[data-testid="zhen-sha-canvas"]');
  const overlay = query<HTMLElement>(root, '[data-testid="overlay"]');
  const overlayKicker = query<HTMLElement>(root, '[data-testid="overlay-kicker"]');
  const overlayTitle = query<HTMLElement>(root, '[data-testid="overlay-title"]');
  const overlayRestart = query<HTMLButtonElement>(root, '[data-testid="overlay-restart"]');
  const restartButton = query<HTMLButtonElement>(root, '[data-testid="restart-button"]');
  const momentumElement = query<HTMLElement>(root, '[data-testid="momentum"]');
  const pips = Array.from(momentumElement.querySelectorAll<HTMLElement>('.zhen-sha-pip'));
  const perfectsElement = query<HTMLElement>(root, '[data-testid="perfects"]');
  const hitsElement = query<HTMLElement>(root, '[data-testid="hits"]');
  const scoreElement = query<HTMLElement>(root, '[data-testid="score"]');
  const statusElement = query<HTMLElement>(root, '[data-testid="status"]');
  const judgementElement = query<HTMLElement>(root, '[data-testid="judgement"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');
  const settlementCanvas = query<HTMLCanvasElement>(
    root,
    '[data-testid="settlement-canvas"]',
  );
  const settlementPerfects = query<HTMLElement>(root, '[data-testid="settlement-perfects"]');
  const settlementElapsed = query<HTMLElement>(root, '[data-testid="settlement-elapsed"]');
  const settlementSlashes = query<HTMLElement>(root, '[data-testid="settlement-slashes"]');
  const settlementBoss = query<HTMLElement>(root, '[data-testid="settlement-boss"]');

  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext('2d');
  settlementCanvas.width = SETTLEMENT_WIDTH;
  settlementCanvas.height = SETTLEMENT_HEIGHT;
  const settlementContext = settlementCanvas.getContext('2d');

  const engine = new ZhenShaEngine();
  const audio = services.audio;
  const debug = debugEnabled();

  let lastStatus: ZhenShaStatus = engine.currentStatus;
  let pointerDown = false;
  let charged = false;
  let holdMs = 0;
  let flash: Flash | null = null;
  let running = true;
  let frameId: number | null = null;
  let lastFrameMs: number | null = null;
  /** Every engine event of this duel, in order, kept for the settlement trail. */
  let duelEvents: ZhenShaEvent[] = [];
  /** Created once when the duel ends; later frames never rebuild or redraw it. */
  let settlement: ZhenShaSettlement | null = null;

  function sync(): void {
    const state = engine.snapshot();

    gameRoot.dataset.status = state.status;
    setText(perfectsElement, String(state.perfects));
    setText(hitsElement, `${state.hits} / ${MAX_HITS}`);
    setText(scoreElement, String(state.score));
    setText(statusElement, STATUS_LABELS[state.status]);
    setText(judgementElement, judgementText(state));

    momentumElement.dataset.filled = String(state.momentum);
    momentumElement.setAttribute(
      'aria-label',
      `势 ${state.momentum} / ${MOMENTUM_FOR_BREAK}`,
    );
    for (const [index, pip] of pips.entries()) {
      pip.classList.toggle('is-filled', index < state.momentum);
    }

    const previousStatus = lastStatus;
    lastStatus = state.status;
    if (state.status === 'playing') {
      overlay.hidden = true;
    } else {
      overlay.hidden = false;
      if (settlement === null) {
        // One stamp per duel: the model freezes this snapshot and the whole
        // event list, and the seal canvas is drawn exactly once.
        settlement = createSettlement(state, duelEvents);
        stampSeal(settlement);
      }
      showSettlement(settlement);
      if (state.status === 'won') {
        setText(overlayKicker, 'VICTORY');
        setText(overlayTitle, '一棍定魂');
      } else {
        setText(overlayKicker, 'DEFEAT');
        setText(overlayTitle, '被黑煞击倒');
      }
      if (previousStatus === 'playing') {
        overlayRestart.focus({ preventScroll: true });
      }
    }

    if (previousStatus !== state.status) {
      if (state.status === 'won') {
        setText(announcer, '你赢了，一棍定魂');
      } else if (state.status === 'lost') {
        setText(announcer, '你被黑煞击倒');
      } else {
        setText(announcer, '新的一局开始');
      }
    }
  }

  /** Paint the battle seal once and bump the observable stamp counter. */
  function stampSeal(model: ZhenShaSettlement): void {
    if (settlementContext !== null) {
      drawSettlement(settlementContext, model, {
        width: SETTLEMENT_WIDTH,
        height: SETTLEMENT_HEIGHT,
      });
    }
    settlementCanvas.dataset.stamps = String(
      Number(settlementCanvas.dataset.stamps ?? '0') + 1,
    );
  }

  /** Copy the settlement numbers into the visible readout under the seal. */
  function showSettlement(model: ZhenShaSettlement): void {
    setText(settlementPerfects, String(model.perfects));
    setText(settlementElapsed, formatSettlementElapsed(model.elapsedMs));
    setText(settlementSlashes, `${model.slashes.length} 道`);
    setText(settlementBoss, `${model.boss.name} · 第 ${model.boss.phase} 阶段`);
  }

  function render(): void {
    sync();
    draw(context, engine.snapshot(), flash, services.reduceMotion);
  }

  function frame(time: number): void {
    frameId = null;
    if (!running) {
      return;
    }
    const delta =
      lastFrameMs === null ? 0 : Math.min(250, Math.max(0, time - lastFrameMs));
    lastFrameMs = time;

    if (pointerDown && !charged) {
      holdMs += delta;
      if (holdMs >= HOLD_TO_CHARGE_MS) {
        charged = true;
        engine.input('charge');
      }
    }

    engine.update(delta);

    const events = engine.drainEvents();
    if (events.length > 0) {
      absorbEvents(events);
    }
    if (flash !== null) {
      flash.remainingMs -= delta;
      if (flash.remainingMs <= 0) {
        flash = null;
      }
    }

    render();
    scheduleFrame();
  }

  function scheduleFrame(): void {
    if (!running || frameId !== null) {
      return;
    }
    frameId = window.requestAnimationFrame(frame);
  }

  function startLoop(): void {
    // In debug mode the caller owns time through `step(ticks)`; an auto-started
    // loop would advance ticks behind a fixed input sequence.
    if (!running || debug) {
      return;
    }
    lastFrameMs = null;
    scheduleFrame();
  }

  function stopLoop(): void {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    lastFrameMs = null;
  }

  /** Play the cues, flash the scene and keep every event for the settlement. */
  function absorbEvents(events: readonly ZhenShaEvent[]): void {
    for (const event of events) {
      duelEvents.push(event);
      flash = {
        type: event.type,
        remainingMs: isResultFlash(event.type) ? RESULT_FLASH_MS : FLASH_MS,
      };
      const sound = SOUND_BY_EVENT[event.type];
      if (sound !== null) {
        audio.play(sound);
      }
    }
  }

  function resetPointer(): void {
    pointerDown = false;
    charged = false;
    holdMs = 0;
    stage.classList.remove('is-pressed');
  }

  function onPointerDown(event: PointerEvent): void {
    if (!running || engine.currentStatus !== 'playing' || pointerDown) {
      return;
    }
    event.preventDefault();
    pointerDown = true;
    charged = false;
    holdMs = 0;
    stage.classList.add('is-pressed');
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    audio.unlock();
    engine.input('block');
    render();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!running || !pointerDown) {
      return;
    }
    event.preventDefault();
    const wasCharged = charged;
    resetPointer();
    try {
      if (
        typeof stage.hasPointerCapture === 'function' &&
        stage.hasPointerCapture(event.pointerId)
      ) {
        stage.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The capture may already be gone.
    }
    if (wasCharged) {
      engine.input('strike');
    }
    render();
  }

  function onPointerCancel(): void {
    resetPointer();
    render();
  }

  function onLostPointerCapture(): void {
    // The browser can steal the capture without a pointerup/pointercancel. The
    // held flag must not outlive the gesture, or every later press is ignored.
    if (!running || !pointerDown) {
      return;
    }
    resetPointer();
    render();
  }

  function restart(): void {
    audio.unlock();
    audio.play('reset');
    engine.restart();
    resetPointer();
    flash = null;
    duelEvents = [];
    settlement = null;
    settlementCanvas.dataset.stamps = '0';
    lastStatus = engine.currentStatus;
    overlay.hidden = true;
    startLoop();
    render();
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      resetPointer();
      stopLoop();
    } else {
      startLoop();
    }
  }

  function onAbort(): void {
    running = false;
    resetPointer();
    stopLoop();
    removeDebugSeam();
    detachListeners();
  }

  function detachListeners(): void {
    mountSignal.removeEventListener('abort', onAbort);
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointercancel', onPointerCancel);
    stage.removeEventListener('lostpointercapture', onLostPointerCapture);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    restartButton.removeEventListener('click', restart);
    overlayRestart.removeEventListener('click', restart);
  }

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerCancel);
  stage.addEventListener('lostpointercapture', onLostPointerCapture);
  document.addEventListener('visibilitychange', onVisibilityChange);
  restartButton.addEventListener('click', restart);
  overlayRestart.addEventListener('click', restart);
  mountSignal.addEventListener('abort', onAbort, { once: true });

  render();
  startLoop();

  /** Debug seam installed by this mount, so destroy never deletes another's. */
  let installedDebugApi: ZhenShaDebugApi | null = null;
  function removeDebugSeam(): void {
    if (installedDebugApi !== null && debugWindow().__playground === installedDebugApi) {
      delete debugWindow().__playground;
    }
    installedDebugApi = null;
  }

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    running = false;
    stopLoop();
    removeDebugSeam();
    detachListeners();
  };

  if (debug) {
    const api: ZhenShaDebugApi = {
      gameId: 'zhen-sha',
      getState: () => ({ ...engine.snapshot(), settlement }),
      input: (action) => {
        engine.input(action);
        render();
      },
      step: (ticks = 1) => {
        if (!Number.isInteger(ticks) || ticks < 0) {
          throw new RangeError(`Invalid Zhen Sha debug step count: ${String(ticks)}`);
        }
        for (let index = 0; index < ticks; index += 1) {
          engine.step();
        }
        const events = engine.drainEvents();
        if (events.length > 0) {
          absorbEvents(events);
        }
        render();
      },
      restart,
      destroy,
    };
    installedDebugApi = api;
    debugWindow().__playground = api;
  }

  return { destroy };
}

function judgementText(state: ZhenShaSnapshot): string {
  if (state.status === 'won') {
    return '一棍定魂';
  }
  if (state.status === 'lost') {
    return '败于黑煞';
  }
  if (state.breakTicksLeft > 0) {
    return `破防 ${(state.breakTicksLeft / TICKS_PER_SECOND).toFixed(1)}s · 松手终结`;
  }
  if (state.lastJudgement === 'perfect') {
    return '完美格挡';
  }
  if (state.lastJudgement === 'normal') {
    return '普通格挡';
  }
  if (state.lastJudgement === 'miss') {
    return '落空';
  }
  if (state.attack !== null) {
    return state.attack.committed ? '杀招将至 · 已落空' : '杀招将至 · 看准再点';
  }
  return '等待出手';
}

function isResultFlash(type: ZhenShaEventType): boolean {
  return type === 'finisher' || type === 'win' || type === 'lose';
}

function draw(
  context: CanvasRenderingContext2D | null,
  state: ZhenShaSnapshot,
  flash: Flash | null,
  reduceMotion: boolean,
): void {
  if (context === null) {
    return;
  }
  const ctx = context;
  const flashAlpha =
    flash === null || reduceMotion
      ? 0
      : clamp01(flash.remainingMs / (isResultFlash(flash.type) ? RESULT_FLASH_MS : FLASH_MS));

  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Black xuan paper: a deep ink base with a few fixed wash blooms.
  ctx.fillStyle = '#08070a';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  for (const [x, y, radius, alpha] of INK_BLOOMS) {
    ctx.fillStyle = `rgba(226, 232, 240, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
  }
  for (const [x1, y1, x2, y2] of INK_STROKES) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  drawBoss(ctx, state);
  drawStaff(ctx, state, flash);
  drawMomentum(ctx, state);
  drawFlash(ctx, flash, flashAlpha);
}

const INK_BLOOMS: readonly (readonly [number, number, number, number])[] = [
  [40, 96, 76, 0.035],
  [310, 120, 92, 0.028],
  [70, 410, 104, 0.03],
  [286, 470, 70, 0.026],
  [180, 60, 54, 0.022],
];

const INK_STROKES: readonly (readonly [number, number, number, number])[] = [
  [20, 24, 340, 24],
  [20, 536, 340, 536],
  [24, 20, 24, 540],
  [336, 20, 336, 540],
];

function drawBoss(ctx: CanvasRenderingContext2D, state: ZhenShaSnapshot): void {
  const attack = state.attack;
  const windup =
    attack === null ? 0 : clamp01(attack.ticksUntilImpact / TELEGRAPH_TICKS);
  const broken = state.boss.guard === 'broken';

  if (attack !== null) {
    // The killing move's telegraph: a shrinking ring that turns gold on a break.
    ctx.strokeStyle = attack.committed
      ? 'rgba(224, 66, 79, 0.55)'
      : 'rgba(246, 196, 83, 0.42)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(180, 220, 62 + 108 * windup, 0, TAU);
    ctx.stroke();
  }

  // Ink-wash silhouette: hood, shoulders and a ragged robe.
  ctx.fillStyle = '#121016';
  ctx.beginPath();
  ctx.moveTo(180, 132);
  ctx.quadraticCurveTo(104, 176, 84, 334);
  ctx.lineTo(276, 334);
  ctx.quadraticCurveTo(256, 176, 180, 132);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#0c0a10';
  ctx.beginPath();
  ctx.arc(180, 176, 46, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = 'rgba(226, 232, 240, 0.12)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(84, 334);
  ctx.quadraticCurveTo(140, 300, 180, 308);
  ctx.quadraticCurveTo(220, 300, 276, 334);
  ctx.stroke();

  // Eyes: embers while the killing move is coming.
  const eyeAlpha = attack === null ? 0.34 : 0.92;
  ctx.fillStyle = `rgba(224, 66, 79, ${eyeAlpha})`;
  ctx.beginPath();
  ctx.arc(164, 174, 5, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(196, 174, 5, 0, TAU);
  ctx.fill();

  if (broken) {
    // Three perfect parries crack the mask and open the guard.
    ctx.strokeStyle = 'rgba(246, 196, 83, 0.82)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(150, 150);
    ctx.lineTo(172, 182);
    ctx.lineTo(158, 208);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(212, 158);
    ctx.lineTo(196, 190);
    ctx.lineTo(214, 210);
    ctx.stroke();
  }
}

function drawStaff(
  ctx: CanvasRenderingContext2D,
  state: ZhenShaSnapshot,
  flash: Flash | null,
): void {
  const swinging =
    flash !== null &&
    (flash.type === 'perfect' ||
      flash.type === 'strike' ||
      flash.type === 'finisher' ||
      flash.type === 'win');
  const lift = state.charging || state.breakTicksLeft > 0 || swinging ? 34 : 0;

  const arc = (): void => {
    ctx.beginPath();
    ctx.moveTo(42, 486);
    ctx.quadraticCurveTo(178, 420 - lift, 318, 456 - lift * 0.4);
    ctx.stroke();
  };

  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(246, 196, 83, 0.16)';
  ctx.lineWidth = 20;
  arc();
  ctx.strokeStyle = '#f6c453';
  ctx.lineWidth = 7;
  arc();
  ctx.strokeStyle = '#ffe9a8';
  ctx.lineWidth = 2.5;
  arc();
}

function drawMomentum(ctx: CanvasRenderingContext2D, state: ZhenShaSnapshot): void {
  for (let index = 0; index < MOMENTUM_FOR_BREAK; index += 1) {
    const filled = index < state.momentum;
    ctx.fillStyle = filled ? '#f6c453' : 'rgba(246, 196, 83, 0.18)';
    ctx.beginPath();
    ctx.arc(48 + index * 24, 526, 6.5, 0, TAU);
    ctx.fill();
  }
}

function drawFlash(
  ctx: CanvasRenderingContext2D,
  flash: Flash | null,
  alpha: number,
): void {
  if (flash === null || alpha <= 0) {
    return;
  }
  if (flash.type === 'hit' || flash.type === 'lose') {
    ctx.fillStyle = `rgba(224, 66, 79, ${0.22 * alpha})`;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }
  if (flash.type === 'miss') {
    ctx.strokeStyle = `rgba(148, 163, 184, ${0.5 * alpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(180, 220, 120 - 24 * alpha, 0, TAU);
    ctx.stroke();
  }
  if (
    flash.type === 'perfect' ||
    flash.type === 'normal' ||
    flash.type === 'break' ||
    flash.type === 'finisher' ||
    flash.type === 'win'
  ) {
    const gold = flash.type === 'normal' ? '246, 196, 83' : '255, 233, 168';
    ctx.strokeStyle = `rgba(${gold}, ${0.75 * alpha})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(180, 260, 70 + 110 * (1 - alpha), 0, TAU);
    ctx.stroke();
  }
}
