/**
 * Engine-agnostic input primitives shared by Phaser, Three.js and DOM games.
 * Games keep their own gesture rules, but key mapping and direction math should
 * stay consistent so muscle memory carries across games.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Vector {
  readonly x: number;
  readonly y: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly width: number;
  readonly height: number;
}

const KEY_DIRECTIONS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};

/** Map a KeyboardEvent.code to a direction, or null for non-game keys. */
export function directionFromCode(code: string): Direction | null {
  return KEY_DIRECTIONS[code] ?? null;
}

/** Ignore game keys while the user types into a form control or editor. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
  );
}

/** Tracks held directions and resolves opposite keys without last-write wins. */
export class DirectionState {
  private readonly held = new Set<Direction>();

  press(direction: Direction): void {
    this.held.add(direction);
  }

  release(direction: Direction): void {
    this.held.delete(direction);
  }

  clear(): void {
    this.held.clear();
  }

  get active(): boolean {
    return this.held.size > 0;
  }

  vector(): Vector {
    let x = 0;
    let y = 0;
    if (this.held.has('left')) x -= 1;
    if (this.held.has('right')) x += 1;
    if (this.held.has('up')) y -= 1;
    if (this.held.has('down')) y += 1;
    return normalizeVector(x, y);
  }
}

/** Normalise a direction vector so diagonal movement is not faster. */
export function normalizeVector(x: number, y: number): Vector {
  const length = Math.hypot(x, y);
  if (length === 0 || !Number.isFinite(length)) {
    return { x: 0, y: 0 };
  }
  return { x: x / length, y: y / length };
}

/** Keep a point inside a rectangle with a safety margin for the player sprite. */
export function clampPoint(point: Point, bounds: Rect, margin = 0): Point {
  const safeX = Math.max(margin, Math.min(bounds.width - margin, point.x));
  const safeY = Math.max(margin, Math.min(bounds.height - margin, point.y));
  return { x: safeX, y: safeY };
}
