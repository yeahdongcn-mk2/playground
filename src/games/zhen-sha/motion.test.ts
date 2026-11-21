import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CSS_PATH = join(ROOT, 'src', 'games', 'zhen-sha', 'zhen-sha.css');
const CSS = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const REDUCED_MOTION_QUERY = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/;

/*
 * The parsing helpers below deliberately mirror style.test.ts instead of
 * moving to a shared module: kill-gate-doc.test.ts counts every non-test .ts
 * file under src/games/zhen-sha as production size, so a shared helper there
 * would change the documented production file count and line total.
 */

/** The text between an opening brace and its matching closing brace. */
function balancedBlockFrom(openBraceIndex: number): string {
  let depth = 0;
  for (let index = openBraceIndex; index < CSS.length; index += 1) {
    if (CSS[index] === '{') {
      depth += 1;
    } else if (CSS[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return CSS.slice(openBraceIndex + 1, index);
      }
    }
  }
  throw new Error('zhen-sha.css 中存在未闭合的块');
}

/** The body of the first block whose opening `{` the pattern ends on. */
function blockAfter(pattern: RegExp): string {
  const match = pattern.exec(CSS);
  if (match === null) {
    throw new Error(`zhen-sha.css 缺少 ${String(pattern)}`);
  }
  const openBrace = match.index + match[0].length - 1;
  if (CSS[openBrace] !== '{') {
    throw new Error(`${String(pattern)} 没有匹配到块起始花括号`);
  }
  return balancedBlockFrom(openBrace);
}

/** The body of one `@keyframes <name> { ... }` block. */
function keyframes(name: string): string {
  return blockAfter(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
}

/** The body of the single `prefers-reduced-motion: reduce` media block. */
function reducedMotionBlock(): string {
  return blockAfter(new RegExp(`${REDUCED_MOTION_QUERY.source}\\s*\\{`));
}

/** The body of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`zhen-sha.css 缺少规则：${selector}`);
  }
  return body;
}

/** Every selector/body pair inside a block, in source order. */
function rulesIn(block: string): { selector: string; body: string }[] {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    body: match[2] ?? '',
  }));
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

/** Every property/value declaration inside a rule body, in source order. */
function declarationsIn(body: string): { property: string; value: string }[] {
  return [...body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]*)(?=;|$)/gi)].map((match) => ({
    // CSS property names are ASCII case-insensitive, and a final declaration
    // may omit its semicolon.
    property: (match[1] ?? '').toLowerCase(),
    value: (match[2] ?? '').trim(),
  }));
}

/** An animation property name without its vendor prefix. */
function unprefixedAnimationProperty(property: string): string {
  return property.replace(/^-(?:webkit|moz|ms|o)-/, '');
}

/** The comma-separated items of a value, split only at nesting depth zero. */
function topLevelItems(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items;
}

/** How many comma-separated items a value has at nesting depth zero. */
function topLevelItemCount(value: string): number {
  return topLevelItems(value).length;
}

describe('zhen-sha procedural motion layer', () => {
  it('declares looping mist, scanline and jitter keyframes', () => {
    const mist = keyframes('zhen-sha-ink-mist');
    expect(mist).toMatch(/transform:\s*translate3d\(/);
    expect(mist).toMatch(/scale\(/);

    // Mist starts and ends on the same transform, so its 38 s loop has no
    // visible jump.
    expect(rulesIn(mist)[0]?.selector).toBe('0%, 100%');

    const scanlines = keyframes('zhen-sha-scanlines');
    const paper = ruleBody('.zhen-sha-stage::before');
    // The scanline paint must belong to the last background layer, not merely
    // to the rule: moving `var(--fx-scan)` into another layer has to fail.
    const scanlineLayer = topLevelItems(declarationValue(paper, 'background-image')).at(-1);
    expect(scanlineLayer, '最后一个 background-image 层应是扫描线').toBeDefined();
    expect(scanlineLayer).toMatch(/^repeating-linear-gradient\(/);
    // Pin the complete argument list; a trailing stop would change the real
    // period while the 6px crawl stays in place.
    const scanlineStops = topLevelItems(
      (scanlineLayer ?? '').replace(/^repeating-linear-gradient\(/, '').replace(/\)\s*$/, ''),
    );
    expect(scanlineStops).toEqual([
      'to bottom',
      'transparent 0 2px',
      'var(--fx-scan) 2px 3px',
    ]);
    const scanlinePeriod = Number(/(\d+(?:\.\d+)?)px$/.exec(scanlineStops[2] ?? '')?.[1]);
    expect(scanlinePeriod).toBe(3);

    // The crawl moves only that layer by exactly one declared background tile.
    // The tile must contain a whole number of 3px scanline periods, otherwise
    // the loop jumps at the wrap.
    const scanlineTile = topLevelItems(declarationValue(paper, 'background-size')).at(-1);
    const scanlineTileMatch = /^100%\s+(\d+(?:\.\d+)?)px$/.exec(scanlineTile ?? '');
    expect(scanlineTileMatch, 'background-size 最后一层应为 100% <tile>px').not.toBeNull();
    const scanlineTileHeight = `${scanlineTileMatch?.[1]}px`;
    expect(scanlineTileHeight).toBe('6px');
    expect(Number.parseFloat(scanlineTileHeight ?? '') % scanlinePeriod).toBe(0);

    const scanSteps = rulesIn(scanlines);
    expect(scanSteps).toHaveLength(2);
    expect(declarationValue(scanSteps[0]?.body ?? '', 'background-position')).toBe(
      '0 0, 0 0, 0 0, 0 0, 0 0, 0 0',
    );
    expect(
      topLevelItems(declarationValue(scanSteps[1]?.body ?? '', 'background-position')),
    ).toEqual(['0 0', '0 0', '0 0', '0 0', '0 0', `0 ${scanlineTileHeight}`]);

    const jitter = keyframes('zhen-sha-jitter');
    expect(jitter.match(/translate3d\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // Jitter starts and ends at rest, so it never accumulates an offset.
    const jitterSteps = rulesIn(jitter);
    expect(jitterSteps[0]?.selector).toBe('0%, 100%');
    expect(declarationValue(jitterSteps[0]?.body ?? '', 'transform')).toBe(
      'translate3d(0, 0, 0)',
    );

    // Motion keyframes may only animate transform / background-position; a
    // width, margin or offset animation would move the page layout.
    for (const [name, body] of Object.entries({
      'zhen-sha-ink-mist': mist,
      'zhen-sha-scanlines': scanlines,
      'zhen-sha-jitter': jitter,
    })) {
      const properties = new Set(
        [...body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1] ?? ''),
      );
      for (const property of properties) {
        expect(
          ['transform', 'background-position'],
          `${name} 只应动画 transform / background-position`,
        ).toContain(property);
      }
    }
  });

  it('runs the loops on the decorative pseudo-elements, never on game content', () => {
    const paper = ruleBody('.zhen-sha-stage::before');
    expect(paper).toMatch(/animation:\s*[^;]*zhen-sha-ink-mist/);
    expect(paper).toMatch(/animation:\s*[^;]*zhen-sha-scanlines/);
    expect(paper).toMatch(/infinite/);

    const edge = ruleBody('.zhen-sha-stage::after');
    expect(edge).toMatch(/animation:\s*[^;]*zhen-sha-jitter/);
    expect(edge).toMatch(/infinite/);

    // Content, HUD, hints and the settlement overlay stay free of looping
    // animation, including the judgement feedback that must survive reduced
    // motion.
    for (const selector of [
      '.zhen-sha-stage',
      '.zhen-sha-canvas',
      '.zhen-sha-layout',
      '.zhen-sha-hud',
      '.zhen-sha-stat',
      '.zhen-sha-pip',
      '.zhen-sha-hints',
      '.zhen-sha-overlay',
      '.zhen-sha-overlay-card',
    ]) {
      expect(ruleBody(selector), `${selector} 不应参与循环动画`).not.toMatch(/animation\s*:/);
    }
  });

  it('keeps the motion layer clipped, input-transparent and low contrast', () => {
    const stage = ruleBody('.zhen-sha-stage');
    expect(declarationValue(stage, 'overflow')).toBe('hidden');

    const paper = ruleBody('.zhen-sha-stage::before');
    expect(declarationValue(paper, 'position')).toBe('absolute');
    expect(declarationValue(paper, 'pointer-events')).toBe('none');
    expect(declarationValue(paper, 'opacity')).toBe('0.5');

    // background-image / -size / -repeat must stay aligned: six layers, six
    // sizes and six repeats, so a new layer cannot shift the scanline tile.
    const imageLayers = topLevelItemCount(declarationValue(paper, 'background-image'));
    expect(imageLayers).toBe(6);
    expect(topLevelItemCount(declarationValue(paper, 'background-size'))).toBe(imageLayers);
    expect(topLevelItemCount(declarationValue(paper, 'background-repeat'))).toBe(imageLayers);

    // Scanlines are 8% paper over the ink base, so they cannot hide the canvas.
    expect(declarationValue(stage, '--fx-scan')).toMatch(/var\(--zhen-paper\)\s*8%/);
    expect(paper).toMatch(/var\(--fx-scan\)/);

    const edge = ruleBody('.zhen-sha-stage::after');
    expect(declarationValue(edge, 'position')).toBe('absolute');
    expect(declarationValue(edge, 'pointer-events')).toBe('none');
  });

  it('stops the mist, jitter and scanlines under reduced motion', () => {
    expect(CSS.match(new RegExp(REDUCED_MOTION_QUERY.source, 'g'))).toHaveLength(1);

    const reduced = reducedMotionBlock();
    const rules = rulesIn(reduced);

    // The block may only turn the two decorative pseudo-elements off and make
    // the scanline ink transparent; any other rule is an unnecessary override
    // of the static style that reduced motion must keep.
    expect(rules.map((rule) => rule.selector)).toEqual([
      '.zhen-sha-stage',
      '.zhen-sha-stage::before, .zhen-sha-stage::after',
    ]);

    // Exactly one animation*-declaration may exist in the whole reduced block,
    // and it must be the `none` shorthand on both pseudo-elements. A second
    // `animation` shorthand or any longhand (including a vendor-prefixed one)
    // would override it in the cascade and silently re-enable a loop.
    const animationDeclarations = rules.flatMap((rule) =>
      declarationsIn(rule.body)
        .filter(({ property }) => {
          const unprefixed = unprefixedAnimationProperty(property);
          return unprefixed === 'animation' || unprefixed.startsWith('animation-');
        })
        .map(({ property, value }) => ({ selector: rule.selector, property, value })),
    );
    expect(animationDeclarations, 'reduced-motion 只允许一条 animation: none').toEqual([
      {
        selector: '.zhen-sha-stage::before, .zhen-sha-stage::after',
        property: 'animation',
        value: 'none',
      },
    ]);

    const scanOff = rules.find((rule) => rule.body.includes('--fx-scan'));
    expect(scanOff?.selector).toBe('.zhen-sha-stage');
    expect(scanOff?.body).toMatch(/--fx-scan\s*:\s*transparent/);

    // The reduced block must not keep any of the zhen-sha animation names alive.
    expect(reduced).not.toMatch(/zhen-sha-ink-mist|zhen-sha-scanlines|zhen-sha-jitter/);

    // It must come after the last running declaration so the cascade override
    // wins; searching backwards from the media block skips its own
    // `animation: none`.
    const reduceIndex = CSS.search(REDUCED_MOTION_QUERY);
    expect(reduceIndex).toBeGreaterThan(-1);
    const lastRunningAnimation = CSS.lastIndexOf('animation:', reduceIndex);
    expect(lastRunningAnimation).toBeGreaterThan(-1);
    expect(reduceIndex).toBeGreaterThan(lastRunningAnimation);
  });

  it('keeps the static ink paper, gold highlights and judgement feedback', () => {
    const reduced = reducedMotionBlock();

    // Only motion and its scanline alpha are overridden; colours, borders,
    // contrast, stacking and sizing stay exactly as the base rules define them.
    expect(reduced).not.toMatch(
      /(?:^|[;{])\s*(?:background|border|box-shadow|color|opacity|filter|transform|mix-blend-mode|z-index|display|position|inset|width|height|padding|margin|content|visibility|(?:-webkit-)?mask-image|font|letter-spacing|line-height|animation-(?:delay|duration|iteration-count|timing-function|direction))\s*:/,
    );

    // style.test.ts guards the base declarations; here the point is that the
    // reduced-motion block leaves them in force rather than overriding them.
    expect(declarationValue(ruleBody('.zhen-sha-stage'), 'background')).toContain(
      'var(--zhen-ink)',
    );
    const paper = ruleBody('.zhen-sha-stage::before');
    expect(paper).toContain('var(--zhen-paper)');
    expect(paper).toContain('mix-blend-mode: screen');

    expect(declarationValue(ruleBody('.zhen-sha-pip.is-filled'), 'background')).toBe(
      'var(--zhen-gold)',
    );
    const pressed = ruleBody('.zhen-sha-stage.is-pressed');
    expect(pressed).toMatch(/border-color:\s*color-mix\([^;]*var\(--zhen-gold\)/);
    expect(pressed).toMatch(/box-shadow:\s*[^;]*var\(--zhen-gold\)/);
  });
});
