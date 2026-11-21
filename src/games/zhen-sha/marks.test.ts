import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STAFF_ARC_BAND, staffArcClipPath, staffArcLift } from './zhen-sha-view';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GAME_DIR = join(ROOT, 'src', 'games', 'zhen-sha');
const PUBLIC_DIR = join(ROOT, 'public', 'games', 'zhen-sha');
const CSS = readFileSync(join(GAME_DIR, 'zhen-sha.css'), 'utf8');
const VIEW = readFileSync(join(GAME_DIR, 'zhen-sha-view.ts'), 'utf8');
const CSS_WITHOUT_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every file under a directory, recursively; a missing directory yields none. */
function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

const ASSET_FILES = [...listFiles(GAME_DIR), ...listFiles(PUBLIC_DIR)];

/**
 * The bodies of every rule whose selector list contains `selector`, in source
 * order. A grouped base rule and a later single-selector override both count.
 */
function ruleBody(selector: string): string {
  const bodies: string[] = [];
  for (const match of CSS_WITHOUT_COMMENTS.matchAll(/([^{}]+?)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (selectors.includes(selector)) {
      bodies.push(match[2] ?? '');
    }
  }
  if (bodies.length === 0) {
    throw new Error(`zhen-sha.css 缺少规则：${selector}`);
  }
  return bodies.join('\n');
}

/** The value of one declaration inside a rule body, up to its semicolon. */
function declarationValue(body: string, property: string): string {
  const matches = [
    ...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]*)(?=;)`, 'g')),
  ];
  const value = matches.at(-1)?.[1];
  if (value === undefined) {
    throw new Error(`缺失声明：${property}`);
  }
  return value.trim();
}

function zIndex(selector: string): number {
  const value = declarationValue(ruleBody(selector), 'z-index');
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${selector} 的 z-index 不是整数：${value}`);
  }
  return parsed;
}

/** A single percentage declaration, e.g. `top: 3.5%`. */
function percentValue(selector: string, property: string): number {
  const raw = declarationValue(ruleBody(selector), property);
  const match = /^(-?\d+(?:\.\d+)?)%$/.exec(raw);
  if (match === null) {
    throw new Error(`${selector} 的 ${property} 不是百分比：${raw}`);
  }
  return Number.parseFloat(match[1] ?? '');
}

interface ClampParts {
  readonly min: number;
  readonly middle: number;
  readonly max: number;
}

/** Parse `clamp(<min>, <middle>, <max>)`, keeping each part's numeric value. */
function clampParts(selector: string, property: string): ClampParts {
  const raw = declarationValue(ruleBody(selector), property);
  const unit = '(?:px|rem|em|%|vw|vmin|vmax|ch)';
  const match = new RegExp(
    `^clamp\\(\\s*(-?\\d+(?:\\.\\d+)?)${unit}\\s*,\\s*(-?\\d+(?:\\.\\d+)?)${unit}\\s*,\\s*(-?\\d+(?:\\.\\d+)?)${unit}\\s*\\)$`,
  ).exec(raw);
  if (match === null) {
    throw new Error(`${selector} 的 ${property} 不是三值 clamp()：${raw}`);
  }
  return {
    min: Number.parseFloat(match[1] ?? ''),
    middle: Number.parseFloat(match[2] ?? ''),
    max: Number.parseFloat(match[3] ?? ''),
  };
}

/**
 * Fail if any rule for `selector` hides the element. The reviewer of #249 t2
 * showed that `display: none`, `visibility: hidden` or `opacity: 0` on the
 * decorative layers kept the old source-shape assertions green while the marks
 * were invisible, so these declarations are rejected outright.
 */
function expectVisible(selector: string): void {
  for (const declaration of ruleBody(selector).split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (property === 'display') {
      expect(value, `${selector} 不能 display: none`).not.toBe('none');
    }
    if (property === 'visibility') {
      expect(['hidden', 'collapse'], `${selector} 不能 visibility: ${value}`).not.toContain(
        value,
      );
    }
    if (property === 'opacity') {
      const parsed = Number.parseFloat(value);
      expect(Number.isNaN(parsed), `${selector} 的 opacity 必须是数值：${value}`).toBe(false);
      expect(parsed, `${selector} 的 opacity 必须大于 0`).toBeGreaterThan(0);
    }
  }
}

interface PolygonPoint {
  readonly x: number;
  readonly y: number;
}

/** Parse `polygon(<x>% <y>%, ...)` into percentage points. */
function parsePolygon(raw: string): PolygonPoint[] {
  const match = /^\s*polygon\(\s*([\s\S]*?)\s*\)\s*$/.exec(raw);
  if (match === null) {
    throw new Error(`不是 polygon()：${raw}`);
  }
  return (match[1] ?? '').split(',').map((part) => {
    const point = /^\s*(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*$/.exec(part);
    if (point === null) {
      throw new Error(`无法解析 polygon 顶点：${part}`);
    }
    return { x: Number.parseFloat(point[1] ?? ''), y: Number.parseFloat(point[2] ?? '') };
  });
}

/** The static polygon fallback of a `clip-path: var(--…, polygon(…))` layer. */
function clipFallback(selector: string): string {
  const raw = declarationValue(ruleBody(selector), 'clip-path');
  const match = /^var\(\s*(--zhen-arc-(?:glow|edge)-clip)\s*,\s*(polygon\([\s\S]*\))\s*\)$/.exec(
    raw,
  );
  if (match === null) {
    throw new Error(`${selector} 的 clip-path 必须是由 CSS 变量驱动的 polygon 回退：${raw}`);
  }
  return match[2] ?? '';
}

/** A font stack must end at a system generic family, never a fetched webfont. */
const SYSTEM_GENERIC =
  /(?:^|,)\s*(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded)\s*(?:,|$)/;

describe('zhen-sha cinnabar seal, wordmark and gold arc edge', () => {
  it('renders a cinnabar seal and the 镇煞 wordmark from system glyphs', () => {
    expect(VIEW).toMatch(/<span class="zhen-sha-wordmark">镇煞<\/span>/);
    expect(VIEW).toMatch(/<span class="zhen-sha-seal">镇煞<\/span>/);
    expect(VIEW).toMatch(/class="zhen-sha-marks" aria-hidden="true"/);

    const seal = ruleBody('.zhen-sha-seal');
    expect(seal).toContain('var(--zhen-cinnabar)');
    expect(seal).toContain('var(--zhen-paper)');
    expect(declarationValue(seal, 'aspect-ratio')).toBe('1');
    expect(declarationValue(seal, 'writing-mode')).toBe('vertical-rl');
    expect(declarationValue(seal, 'text-orientation')).toBe('upright');
    expect(declarationValue(seal, 'font-family')).toMatch(/serif$/);
    expect(declarationValue(seal, 'color').toLowerCase()).not.toBe('transparent');

    const wordmark = ruleBody('.zhen-sha-wordmark');
    expect(wordmark).toContain('var(--zhen-gold)');
    expect(declarationValue(wordmark, 'writing-mode')).toBe('vertical-rl');
    expect(declarationValue(wordmark, 'font-size')).toMatch(/^clamp\(/);
    expect(declarationValue(wordmark, 'color').toLowerCase()).not.toBe('transparent');
  });

  it('uses only system font stacks and ships no font or image assets', () => {
    expect(CSS_WITHOUT_COMMENTS).not.toMatch(/@font-face|@import/i);
    expect(CSS_WITHOUT_COMMENTS).not.toMatch(/url\(/i);
    expect(CSS_WITHOUT_COMMENTS).not.toMatch(/https?:\/\//i);
    expect(VIEW).not.toMatch(/@font-face|url\(|https?:\/\//i);

    const families = [...CSS_WITHOUT_COMMENTS.matchAll(/font-family\s*:\s*([^;]+);/g)].map(
      (match) => (match[1] ?? '').trim(),
    );
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      if (family.startsWith('var(--font-')) {
        continue;
      }
      expect(family, `${family} 必须落到系统通用字族`).toMatch(SYSTEM_GENERIC);
      expect(family).not.toMatch(/https?:|url\(/i);
    }

    const fontOrImage = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|webp|gif|avif|bmp|ico)$/i;
    expect(ASSET_FILES.length).toBeGreaterThan(0);
    expect(ASSET_FILES.filter((file) => fontOrImage.test(extname(file)))).toEqual([]);
  });

  it('keeps the gold staff arc in the canvas and only adds a decorative CSS edge', () => {
    const start = VIEW.indexOf('function drawStaff(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = VIEW.indexOf('\nfunction drawMomentum', start);
    const drawStaff = VIEW.slice(start, end === -1 ? undefined : end);
    expect(drawStaff).toContain('quadraticCurveTo');
    expect(drawStaff).toContain('strokeStyle');
    expect(drawStaff).toContain('staffArcLift(');
    // Call-presence check only. The falsifiable proof that the lift reaches the
    // quadratic's control point and endpoint is the recorded quadraticCurveTo
    // arguments in zhen-sha-view.test.ts.
    expect(VIEW).toContain('drawStaff(ctx, state, flash)');
    // Input mapping is untouched by this subtask.
    expect(VIEW).toContain("engine.input('block')");
    expect(VIEW).toContain("engine.input('strike')");

    const glow = ruleBody('.zhen-sha-arc-glow');
    const edge = ruleBody('.zhen-sha-arc-edge');
    expect(declarationValue(glow, 'mix-blend-mode')).toBe('screen');
    expect(declarationValue(edge, 'background')).toContain('var(--zhen-gold)');
    expect(declarationValue(edge, 'filter')).toContain('drop-shadow');

    // The view writes both CSS variables; the layers resolve them with a static
    // resting fallback so the gold edge tracks the canvas lift instead of
    // staying at the resting position while the staff is raised.
    expect(VIEW).toContain("setProperty('--zhen-arc-glow-clip'");
    expect(VIEW).toContain("setProperty('--zhen-arc-edge-clip'");
    expect(VIEW).toContain('staffArcClipPaths(');
    expect(declarationValue(glow, 'clip-path')).toMatch(/var\(\s*--zhen-arc-glow-clip\s*,/);
    expect(declarationValue(edge, 'clip-path')).toMatch(/var\(\s*--zhen-arc-edge-clip\s*,/);

    // The static fallback must trace the same curve the canvas strokes, or the
    // first paint and the hydrated paint would disagree.
    for (const [selector, band] of [
      ['.zhen-sha-arc-glow', STAFF_ARC_BAND.glow],
      ['.zhen-sha-arc-edge', STAFF_ARC_BAND.edge],
    ] as const) {
      const fallback = parsePolygon(clipFallback(selector));
      const fromCanvas = parsePolygon(staffArcClipPath(0, band));
      expect(fallback.length).toBe(fromCanvas.length);
      fallback.forEach((point, index) => {
        const expected = fromCanvas[index];
        if (expected === undefined) {
          throw new Error(`缺少第 ${index} 个顶点`);
        }
        expect(Math.abs(point.x - expected.x)).toBeLessThanOrEqual(0.02);
        expect(Math.abs(point.y - expected.y)).toBeLessThanOrEqual(0.02);
      });
    }

    // Every pointer-events declaration in the stylesheet is `none`: the new
    // decorative layers cannot intercept a gesture or steal focus.
    for (const [, value] of CSS_WITHOUT_COMMENTS.matchAll(/pointer-events\s*:\s*([^;]+);/g)) {
      expect((value ?? '').trim()).toBe('none');
    }
    for (const selector of ['.zhen-sha-marks', '.zhen-sha-arc-glow', '.zhen-sha-arc-edge']) {
      expect(declarationValue(ruleBody(selector), 'pointer-events')).toBe('none');
    }
  });

  it('lifts the CSS gold edge with the canvas while charging, breaking or swinging', () => {
    expect(staffArcLift(false, 0, false)).toBe(0);
    const lifted = staffArcLift(true, 0, false);
    expect(lifted).toBeGreaterThan(0);
    expect(staffArcLift(false, 1, false)).toBe(lifted);
    expect(staffArcLift(false, 0, true)).toBe(lifted);

    const rest = parsePolygon(staffArcClipPath(0, STAFF_ARC_BAND.glow));
    const raised = parsePolygon(staffArcClipPath(lifted, STAFF_ARC_BAND.glow));
    const topCount = rest.length / 2;
    const endIndex = topCount - 1;

    // The pivot end stays put; the free end lifts by the damped end ratio and
    // the middle of the curve lifts the most.
    expect(raised[0]?.x).toBeCloseTo(rest[0]?.x ?? Number.NaN, 2);
    expect(raised[0]?.y).toBeCloseTo(rest[0]?.y ?? Number.NaN, 2);
    const endDelta = (rest[endIndex]?.y ?? 0) - (raised[endIndex]?.y ?? 0);
    expect(endDelta).toBeCloseTo(((lifted * 0.4) / 560) * 100, 1);
    const middleDelta =
      (rest[Math.floor(endIndex / 2)]?.y ?? 0) - (raised[Math.floor(endIndex / 2)]?.y ?? 0);
    expect(middleDelta).toBeGreaterThan(endDelta);

    // Every point of the raised band is at or above the resting band: the gold
    // edge moves with the arc instead of staying behind.
    for (let index = 0; index < rest.length; index += 1) {
      const restPoint = rest[index];
      const raisedPoint = raised[index];
      if (restPoint === undefined || raisedPoint === undefined) {
        throw new Error(`polygon 顶点数量不一致：${index}`);
      }
      expect(raisedPoint.x).toBeCloseTo(restPoint.x, 2);
      expect(raisedPoint.y).toBeLessThanOrEqual(restPoint.y + 1e-9);
    }
    expect(raised).not.toEqual(rest);
  });

  it('stacks canvas, marks, flying-white and overlay on an explicit z-index ladder', () => {
    const canvas = zIndex('.zhen-sha-canvas');
    const marks = zIndex('.zhen-sha-marks');
    const flyingWhite = zIndex('.zhen-sha-stage::after');
    const overlay = zIndex('.zhen-sha-overlay');
    expect(canvas).toBe(0);
    expect(marks).toBeGreaterThan(canvas);
    expect(flyingWhite).toBeGreaterThan(marks);
    expect(overlay).toBeGreaterThan(flyingWhite);
    expect(declarationValue(ruleBody('.zhen-sha-marks'), 'inset')).toBe('0');
  });

  it('keeps both marks and the gold edge visible at every viewport', () => {
    for (const selector of [
      '.zhen-sha-marks',
      '.zhen-sha-seal',
      '.zhen-sha-wordmark',
      '.zhen-sha-arc-glow',
      '.zhen-sha-arc-edge',
    ]) {
      expectVisible(selector);
    }

    // Percent anchors plus clamp() frames keep both marks clear at 320x640 and
    // 1440x1000. Moving a mark off-stage (top: 500%) or to a zero-sized clamp
    // now fails the test instead of passing on a `%` suffix alone.
    const sealTop = percentValue('.zhen-sha-seal', 'top');
    const sealRight = percentValue('.zhen-sha-seal', 'right');
    const sealWidth = clampParts('.zhen-sha-seal', 'width');
    expect(sealTop).toBeGreaterThanOrEqual(0);
    expect(sealTop).toBeLessThanOrEqual(100);
    expect(sealRight).toBeGreaterThanOrEqual(0);
    expect(sealRight).toBeLessThanOrEqual(100);
    expect(sealWidth.min).toBeGreaterThan(0);
    expect(sealWidth.max).toBeGreaterThanOrEqual(sealWidth.min);
    expect(sealWidth.middle).toBeGreaterThan(0);
    expect(sealWidth.middle).toBeLessThanOrEqual(100);

    const wordmarkTop = percentValue('.zhen-sha-wordmark', 'top');
    const wordmarkLeft = percentValue('.zhen-sha-wordmark', 'left');
    const wordmarkSize = clampParts('.zhen-sha-wordmark', 'font-size');
    expect(wordmarkTop).toBeGreaterThanOrEqual(0);
    expect(wordmarkTop).toBeLessThanOrEqual(100);
    expect(wordmarkLeft).toBeGreaterThanOrEqual(0);
    expect(wordmarkLeft).toBeLessThanOrEqual(100);
    expect(wordmarkSize.min).toBeGreaterThan(0);
    expect(wordmarkSize.max).toBeGreaterThanOrEqual(wordmarkSize.min);

    expect(CSS_WITHOUT_COMMENTS).not.toMatch(
      /\.zhen-sha-(?:marks|seal|wordmark|arc-glow|arc-edge)[^{]*\{[^}]*display\s*:\s*none/,
    );
  });
});
