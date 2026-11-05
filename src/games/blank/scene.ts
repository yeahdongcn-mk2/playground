import Phaser from 'phaser';
import {
  clampPoint,
  DirectionState,
  directionFromCode,
  isEditableTarget,
  type Point,
} from '../../core/input';

export type InteractionMode = 'idle' | 'keyboard' | 'pointer';

export interface BlankState {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly mode: InteractionMode;
  readonly trail: number;
}

export interface BlankSceneCallbacks {
  onReady(): void;
  onState(state: BlankState): void;
  onFirstInput(): void;
}

interface TrailDot {
  x: number;
  y: number;
  life: number;
}

const ORB_TEXTURE = 'blank-orb';
const ORB_TEXTURE_SIZE = 128;
const ORB_SIZE = 76;
const SPEED = 360;
const POINTER_SPEED = 820;
const MAX_DELTA = 100;
const TRAIL_INTERVAL = 38;
const STATE_INTERVAL = 100;

/**
 * The blank game's presentation layer. It intentionally contains no game rules:
 * it demonstrates the reusable parts of the 2D runtime — preload, Phaser's game
 * loop, keyboard/pointer/touch input, responsive scale, and clean shutdown.
 */
export class BlankScene extends Phaser.Scene {
  private readonly callbacks: BlankSceneCallbacks;
  private readonly reduceMotion: boolean;
  private readonly directions = new DirectionState();
  private readonly trail: TrailDot[] = [];

  private grid!: Phaser.GameObjects.Graphics;
  private glow!: Phaser.GameObjects.Graphics;
  private orb!: Phaser.GameObjects.Image | Phaser.GameObjects.Arc;
  private orbBaseScale = 1;
  private target: Point | null = null;
  private mode: InteractionMode = 'idle';
  private trailClock = 0;
  private stateClock = 0;
  private firstInputFired = false;
  private disposed = false;

  constructor(callbacks: BlankSceneCallbacks, reduceMotion = false) {
    super('blank');
    this.callbacks = callbacks;
    this.reduceMotion = reduceMotion;
  }

  preload(): void {
    this.load.image(ORB_TEXTURE, `${import.meta.env.BASE_URL}games/blank/orb.svg`);
  }

  create(): void {
    this.grid = this.add.graphics();
    this.glow = this.add.graphics();
    this.orb = this.createOrb();

    this.drawBackdrop(this.scale.width, this.scale.height);
    this.bindInput();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    // game.destroy(true) bypasses SHUTDOWN and only emits DESTROY in Phaser 4.
    this.events.once(Phaser.Scenes.Events.DESTROY, this.handleShutdown, this);

    this.callbacks.onReady();
    this.emitState();
  }

  /** Called by the DOM shell's reset button. */
  reset(): void {
    const { width, height } = this.scale;
    this.target = null;
    this.directions.clear();
    this.mode = 'idle';
    this.trail.length = 0;
    this.orb.setPosition(width / 2, height / 2);
    this.emitState();
  }

  update(time: number, delta: number): void {
    const dt = Math.min(delta, MAX_DELTA) / 1000;
    const { width, height } = this.scale;
    const margin = this.safeMargin(width, height);

    const keyboard = this.directions.vector();
    let moved = false;

    if (keyboard.x !== 0 || keyboard.y !== 0) {
      this.mode = 'keyboard';
      this.target = null;
      const next = clampPoint(
        {
          x: this.orb.x + keyboard.x * SPEED * dt,
          y: this.orb.y + keyboard.y * SPEED * dt,
        },
        { width, height },
        margin,
      );
      moved = next.x !== this.orb.x || next.y !== this.orb.y;
      this.orb.setPosition(next.x, next.y);
    } else if (this.target) {
      this.mode = 'pointer';
      const dx = this.target.x - this.orb.x;
      const dy = this.target.y - this.orb.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 0.75) {
        this.orb.setPosition(this.target.x, this.target.y);
        this.target = null;
      } else {
        const step = Math.min(distance, POINTER_SPEED * dt);
        const next = clampPoint(
          {
            x: this.orb.x + (dx / distance) * step,
            y: this.orb.y + (dy / distance) * step,
          },
          { width, height },
          margin,
        );
        moved = next.x !== this.orb.x || next.y !== this.orb.y;
        this.orb.setPosition(next.x, next.y);
      }
    }

    this.updateTrail(delta, moved);
    this.drawScene(time);
    this.orb.setScale(
      this.orbBaseScale * (this.reduceMotion ? 1 : 1 + Math.sin(time / 420) * 0.045),
    );

    this.stateClock += delta;
    if (this.stateClock >= STATE_INTERVAL) {
      this.stateClock = 0;
      this.emitState();
    }
  }

  private createOrb(): Phaser.GameObjects.Image | Phaser.GameObjects.Arc {
    const { width, height } = this.scale;
    if (this.textures.exists(ORB_TEXTURE)) {
      this.orbBaseScale = ORB_SIZE / ORB_TEXTURE_SIZE;
      return this.add
        .image(width / 2, height / 2, ORB_TEXTURE)
        .setScale(this.orbBaseScale)
        .setAlpha(0.98);
    }

    // A missing/failed SVG should not break the framework demo.
    this.orbBaseScale = ORB_SIZE / 56;
    return this.add
      .circle(width / 2, height / 2, 28, 0x67e8f9, 0.95)
      .setStrokeStyle(2, 0xcffafe, 0.9);
  }

  private bindInput(): void {
    this.input.keyboard?.on('keydown', this.handleKeyDown);
    this.input.keyboard?.on('keyup', this.handleKeyUp);
    this.input.on('pointerdown', this.handlePointerDown);
    this.input.on('pointermove', this.handlePointerMove);
    window.addEventListener('blur', this.handleWindowBlur);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    // Leave browser and OS shortcuts (Ctrl/Cmd/Alt + key) alone.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const direction = directionFromCode(event.code);
    if (!direction || isEditableTarget(event.target)) {
      return;
    }
    event.preventDefault();
    this.directions.press(direction);
    this.mode = 'keyboard';
    this.triggerFirstInput();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    const direction = directionFromCode(event.code);
    if (!direction) {
      return;
    }
    event.preventDefault();
    this.directions.release(direction);
  };

  private readonly handlePointerDown = (pointer: Phaser.Input.Pointer): void => {
    this.target = clampPoint(
      { x: pointer.x, y: pointer.y },
      { width: this.scale.width, height: this.scale.height },
      this.safeMargin(this.scale.width, this.scale.height),
    );
    this.mode = 'pointer';
    this.triggerFirstInput();
  };

  private readonly handlePointerMove = (pointer: Phaser.Input.Pointer): void => {
    if (!pointer.isDown) {
      return;
    }
    this.target = clampPoint(
      { x: pointer.x, y: pointer.y },
      { width: this.scale.width, height: this.scale.height },
      this.safeMargin(this.scale.width, this.scale.height),
    );
    this.mode = 'pointer';
  };

  private readonly handleWindowBlur = (): void => {
    this.directions.clear();
  };

  private readonly handleResize = (): void => {
    const { width, height } = this.scale;
    this.drawBackdrop(width, height);
    const margin = this.safeMargin(width, height);
    if (this.orb) {
      const next = clampPoint({ x: this.orb.x, y: this.orb.y }, { width, height }, margin);
      this.orb.setPosition(next.x, next.y);
    }
    if (this.target) {
      this.target = clampPoint(this.target, { width, height }, margin);
    }
    this.emitState();
  };

  private readonly handleShutdown = (): void => {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.directions.clear();
    this.input.keyboard?.off('keydown', this.handleKeyDown);
    this.input.keyboard?.off('keyup', this.handleKeyUp);
    this.input.off('pointerdown', this.handlePointerDown);
    this.input.off('pointermove', this.handlePointerMove);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
  };

  private triggerFirstInput(): void {
    if (this.firstInputFired) {
      return;
    }
    this.firstInputFired = true;
    this.callbacks.onFirstInput();
  }

  private safeMargin(width: number, height: number): number {
    return Math.max(0, Math.min(38, width / 2 - 1, height / 2 - 1));
  }

  private updateTrail(delta: number, moved: boolean): void {
    const dt = delta / 1000;
    for (const dot of this.trail) {
      dot.life -= dt / 1.15;
    }
    for (let index = this.trail.length - 1; index >= 0; index -= 1) {
      if ((this.trail[index]?.life ?? 0) <= 0) {
        this.trail.splice(index, 1);
      }
    }

    this.trailClock += delta;
    if (!moved || this.trailClock < TRAIL_INTERVAL) {
      return;
    }
    this.trailClock = 0;
    this.trail.push({ x: this.orb.x, y: this.orb.y, life: 1 });
    if (this.trail.length > 26) {
      this.trail.shift();
    }
  }

  private drawBackdrop(width: number, height: number): void {
    if (!this.grid) {
      return;
    }
    this.grid.clear();
    this.grid.fillGradientStyle(0x0b1220, 0x0b1220, 0x070b14, 0x070b14, 1);
    this.grid.fillRect(0, 0, width, height);

    const step = Math.min(56, Math.max(32, Math.round(Math.min(width, height) / 12)));
    this.grid.lineStyle(1, 0x1e293b, 0.55);
    for (let x = (width % step) / 2; x <= width; x += step) {
      this.grid.lineBetween(x, 0, x, height);
    }
    for (let y = (height % step) / 2; y <= height; y += step) {
      this.grid.lineBetween(0, y, width, y);
    }

    const radius = Math.min(width, height) * 0.34;
    this.grid.fillStyle(0x0ea5e9, 0.05);
    this.grid.fillCircle(width / 2, height / 2, radius);
    this.grid.lineStyle(1, 0x22d3ee, 0.12);
    this.grid.strokeCircle(width / 2, height / 2, radius);
  }

  private drawScene(time: number): void {
    this.glow.clear();

    for (const dot of this.trail) {
      this.glow.fillStyle(0x22d3ee, Math.max(0, dot.life) * 0.22);
      this.glow.fillCircle(dot.x, dot.y, 4 + dot.life * 10);
    }

    this.glow.fillStyle(0x22d3ee, 0.09);
    this.glow.fillCircle(this.orb.x, this.orb.y, ORB_SIZE * 0.85);

    if (this.target) {
      const pulse = this.reduceMotion ? 0 : Math.sin(time / 180) * 2;
      this.glow.lineStyle(1.5, 0x67e8f9, 0.7);
      this.glow.strokeCircle(this.target.x, this.target.y, 16 + pulse);
      this.glow.fillStyle(0x67e8f9, 0.9);
      this.glow.fillCircle(this.target.x, this.target.y, 2.5);
    }
  }

  private emitState(): void {
    this.callbacks.onState({
      x: Math.round(this.orb?.x ?? 0),
      y: Math.round(this.orb?.y ?? 0),
      width: Math.round(this.scale.width),
      height: Math.round(this.scale.height),
      mode: this.mode,
      trail: this.trail.length,
    });
  }
}
