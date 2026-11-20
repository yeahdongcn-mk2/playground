import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

    const wordmark = ruleBody('.zhen-sha-wordmark');
    expect(wordmark).toContain('var(--zhen-gold)');
    expect(declarationValue(wordmark, 'writing-mode')).toBe('vertical-rl');
    expect(declarationValue(wordmark, 'font-size')).toMatch(/^clamp\(/);
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
    expect(VIEW).toContain('drawStaff(ctx, state, flash)');
    // Input mapping is untouched by this subtask.
    expect(VIEW).toContain("engine.input('block')");
    expect(VIEW).toContain("engine.input('strike')");

    const glow = ruleBody('.zhen-sha-arc-glow');
    const edge = ruleBody('.zhen-sha-arc-edge');
    expect(declarationValue(glow, 'clip-path')).toContain('polygon(');
    expect(declarationValue(glow, 'mix-blend-mode')).toBe('screen');
    expect(declarationValue(edge, 'background')).toContain('var(--zhen-gold)');
    expect(declarationValue(edge, 'filter')).toContain('drop-shadow');

    // Every pointer-events declaration in the stylesheet is `none`: the new
    // decorative layers cannot intercept a gesture or steal focus.
    for (const [, value] of CSS_WITHOUT_COMMENTS.matchAll(/pointer-events\s*:\s*([^;]+);/g)) {
      expect((value ?? '').trim()).toBe('none');
    }
    for (const selector of ['.zhen-sha-marks', '.zhen-sha-arc-glow', '.zhen-sha-arc-edge']) {
      expect(declarationValue(ruleBody(selector), 'pointer-events')).toBe('none');
    }
  });

  it('stacks the marks above the canvas and below the settlement overlay', () => {
    const canvas = zIndex('.zhen-sha-canvas');
    const marks = zIndex('.zhen-sha-marks');
    const overlay = zIndex('.zhen-sha-overlay');
    expect(marks).toBeGreaterThan(canvas);
    expect(marks).toBeLessThan(overlay);
    expect(declarationValue(ruleBody('.zhen-sha-marks'), 'inset')).toBe('0');

    // Percent anchors plus clamp() keep both marks clear at 320x640 and
    // 1440x1000; no media query hides them.
    const seal = ruleBody('.zhen-sha-seal');
    expect(declarationValue(seal, 'top')).toMatch(/%$/);
    expect(declarationValue(seal, 'right')).toMatch(/%$/);
    expect(declarationValue(seal, 'width')).toMatch(/^clamp\(/);
    const wordmark = ruleBody('.zhen-sha-wordmark');
    expect(declarationValue(wordmark, 'top')).toMatch(/%$/);
    expect(declarationValue(wordmark, 'left')).toMatch(/%$/);
    expect(declarationValue(wordmark, 'font-size')).toMatch(/^clamp\(/);
    expect(CSS_WITHOUT_COMMENTS).not.toMatch(
      /\.zhen-sha-(?:seal|wordmark)[^{]*\{[^}]*display\s*:\s*none/,
    );
  });
});
