import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CSS_PATH = join(ROOT, 'src', 'games', 'zhen-sha', 'zhen-sha.css');
const CSS = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const REDUCED_MOTION_QUERY = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i;

/*
 * The parsing helpers below deliberately mirror style.test.ts instead of
 * moving to a shared module: kill-gate-doc.test.ts counts every non-test .ts
 * file under src/games/zhen-sha as production size, so a shared helper there
 * would change the documented production file count and line total.
 */

/** The index of the `}` that closes the block opened at `openBraceIndex`. */
function matchingBraceIndex(openBraceIndex: number): number {
  let depth = 0;
  for (let index = openBraceIndex; index < CSS.length; index += 1) {
    if (CSS[index] === '{') {
      depth += 1;
    } else if (CSS[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error('zhen-sha.css 中存在未闭合的块');
}

/** The text between an opening brace and its matching closing brace. */
function balancedBlockFrom(openBraceIndex: number): string {
  return CSS.slice(openBraceIndex + 1, matchingBraceIndex(openBraceIndex));
}

/** The start, body and end index of the first block the pattern ends on. */
function blockRangeAfter(pattern: RegExp): { start: number; body: string; end: number } {
  const match = pattern.exec(CSS);
  if (match === null) {
    throw new Error(`zhen-sha.css 缺少 ${String(pattern)}`);
  }
  const openBrace = match.index + match[0].length - 1;
  if (CSS[openBrace] !== '{') {
    throw new Error(`${String(pattern)} 没有匹配到块起始花括号`);
  }
  return {
    start: match.index,
    body: balancedBlockFrom(openBrace),
    end: matchingBraceIndex(openBrace) + 1,
  };
}

/** The body of the first block whose opening `{` the pattern ends on. */
function blockAfter(pattern: RegExp): string {
  return blockRangeAfter(pattern).body;
}

/** The body of one `@keyframes <name> { ... }` block. */
function keyframes(name: string): string {
  return blockAfter(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
}

/** The single `prefers-reduced-motion: reduce` block start, body and end. */
function reducedMotionRange(): { start: number; body: string; end: number } {
  return blockRangeAfter(new RegExp(`${REDUCED_MOTION_QUERY.source}\\s*\\{`, 'i'));
}

/** The body of the single `prefers-reduced-motion: reduce` media block. */
function reducedMotionBlock(): string {
  return reducedMotionRange().body;
}

/** Every `@media` block in source order: its normalised prelude and body. */
function mediaBlocks(): { prelude: string; body: string }[] {
  return [...CSS.matchAll(/@media\s*([^{]+)\{/gi)].map((match) => ({
    prelude: normalizeSelector(match[1] ?? ''),
    body: balancedBlockFrom((match.index ?? 0) + match[0].length - 1),
  }));
}

/** A media prelude with insignificant whitespace removed and case folded. */
function compactPrelude(prelude: string): string {
  return prelude.toLowerCase().replace(/\s+/g, '');
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

/** A selector with its surrounding and repeated whitespace normalised. */
function normalizeSelector(selector: string): string {
  return selector.trim().replace(/\s+/g, ' ');
}

/**
 * The bodies of every rule whose selector list contains `selector` exactly,
 * including rules nested in media queries and duplicate selector lists.
 */
function ruleBodies(selector: string): string[] {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => (match[1] ?? '').split(',').map(normalizeSelector).includes(selector))
    .map((match) => match[2] ?? '');
}

/** Every selector/body pair inside a block, in source order. */
function rulesIn(block: string): { selector: string; body: string }[] {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: normalizeSelector(match[1] ?? ''),
    body: match[2] ?? '',
  }));
}

/** The value of one declaration inside a rule body, up to its semicolon. */
function declarationValue(body: string, property: string): string {
  const matches = [
    ...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]*)(?=;|$)`, 'g')),
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

/**
 * Whatever is left in a rule body after removing every declaration the parser
 * recognises, ignoring only separators and whitespace. A non-empty result means
 * a declaration-shaped token was skipped (for example an escaped property name
 * such as `background\2d image`), so no exact-set assertion over
 * `declarationsIn` can be complete.
 */
function undeclaredTextIn(body: string): string {
  let last = 0;
  let leftover = '';
  for (const match of body.matchAll(/(?:^|;)\s*[a-z-]+\s*:\s*[^;]*(?=;|$)/gi)) {
    leftover += body.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
  }
  leftover += body.slice(last);
  return leftover.replace(/[\s;]/g, '');
}

/** An animation property name without its vendor prefix. */
function unprefixedAnimationProperty(property: string): string {
  return property.replace(/^-(?:webkit|moz|ms|o)-/, '');
}

/** The `animation` / `animation-*` property names declared in a rule body. */
function animationPropertiesIn(body: string): string[] {
  return declarationsIn(body)
    .map(({ property }) => unprefixedAnimationProperty(property))
    .filter((property) => property === 'animation' || property.startsWith('animation-'));
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
    // The paper layer runs two comma-separated loops in one shorthand. Split
    // them so each name is bound to its own `infinite`: in a shared shorthand
    // one `infinite` would still satisfy a whole-rule search.
    const paperAnimations = topLevelItems(declarationValue(paper, 'animation'));
    expect(paperAnimations, '纸面层应同时跑墨雾与扫描线两条循环').toHaveLength(2);
    for (const name of ['zhen-sha-ink-mist', 'zhen-sha-scanlines']) {
      const loops = paperAnimations.filter((animation) =>
        new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(animation),
      );
      expect(loops, `${name} 应恰好是一条纸面循环`).toHaveLength(1);
      expect(loops[0], `${name} 循环必须带 infinite`).toMatch(/\binfinite\b/);
    }

    const edge = ruleBody('.zhen-sha-stage::after');
    const edgeAnimation = declarationValue(edge, 'animation');
    expect(edgeAnimation, '边缘层应跑抖动循环').toMatch(/zhen-sha-jitter\b/);
    expect(edgeAnimation, '边缘抖动必须带 infinite').toMatch(/\binfinite\b/);

    // Content, HUD, hints and the settlement overlay stay free of looping
    // animation, including the judgement feedback that must survive reduced
    // motion. Check every rule for the selector and both the `animation`
    // shorthand and `animation-*` longhands, so `animation-name` cannot slip
    // through.
    for (const selector of [
      '.zhen-sha-stage',
      '.zhen-sha-stage.is-pressed',
      '.zhen-sha-canvas',
      '.zhen-sha-layout',
      '.zhen-sha-hud',
      '.zhen-sha-stat',
      '.zhen-sha-pip',
      '.zhen-sha-pip.is-filled',
      '.zhen-sha-hints',
      '.zhen-sha-hints li',
      '.zhen-sha-gesture-note',
      '.zhen-sha-note',
      '.zhen-sha-overlay',
      '.zhen-sha-overlay[hidden]',
      '.zhen-sha-overlay-body',
      '.zhen-sha-overlay-card',
      '.zhen-sha-overlay-card h2',
    ]) {
      const bodies = ruleBodies(selector);
      expect(bodies.length, `${selector} 应至少有一条规则`).toBeGreaterThan(0);
      expect(bodies.flatMap(animationPropertiesIn), `${selector} 不应参与循环动画`).toEqual([]);
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
    // A second reduced-motion block written as `@media screen and
    // (prefers-reduced-motion: reduce)` would be invisible to the canonical
    // lookup below and could override the static paper with a longhand. Require
    // every media query that mentions the preference to be the canonical one,
    // ignoring only case and whitespace, so `@media screen and (...)` or a
    // `no-preference` variant cannot slip in.
    expect(
      mediaBlocks()
        .map(({ prelude }) => compactPrelude(prelude))
        .filter((prelude) => prelude.includes('prefers-reduced-motion')),
      'prefers-reduced-motion 媒体查询只能有一条规范写法',
    ).toEqual(['(prefers-reduced-motion:reduce)']);

    const { body: reduced, start: reducedStart, end: reducedEnd } = reducedMotionRange();
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

    // Only the two decorative pseudo-element rules may run animation before the
    // override; a third selector (for example a higher-specificity
    // `.zhen-sha-stage.is-playing::before`) would beat the reduced rule in the
    // cascade even though it comes earlier in the file.
    const runningRules = rulesIn(CSS.slice(0, reducedStart)).filter(
      (rule) => animationPropertiesIn(rule.body).length > 0,
    );
    expect(runningRules.map((rule) => rule.selector)).toEqual([
      '.zhen-sha-stage::before',
      '.zhen-sha-stage::after',
    ]);

    // `animation: none` in the media block is normal, so a running declaration
    // with `!important` would beat it regardless of source order.
    expect(CSS.slice(0, reducedStart), 'running animation 不得用 !important').not.toMatch(
      /animation(?:-[a-z-]+)?\s*:[^;}]*!\s*important/i,
    );

    // Nothing after the media block may declare animation / animation-*
    // again: a later rule of equal specificity would cascade over
    // `animation: none` and silently restart a loop under reduced motion.
    // Slicing after the block also pins it after every running declaration.
    const afterReduced = CSS.slice(reducedEnd);
    expect(afterReduced, 'reduced-motion 媒体块之后不应再声明动画').not.toMatch(
      /(?:^|[;{])\s*(?:-(?:webkit|moz|ms|o)-)?animation(?:-[a-z-]+)?\s*:/i,
    );

    // A later stage / pseudo-element rule could also undo the static paper with
    // a longhand (for example `.zhen-sha-stage::before { background-image:
    // none; }`). The reduced block is the last word on those selectors, so pin
    // them instead of enumerating every static property in a blacklist.
    const laterStageRules = rulesIn(afterReduced).filter((rule) =>
      rule.selector
        .split(',')
        .map(normalizeSelector)
        .some((selector) => /\.zhen-sha-stage(?![\w-])/.test(selector)),
    );
    expect(
      laterStageRules.map((rule) => rule.selector),
      'reduced-motion 媒体块之后不应再出现 stage / 伪元素规则',
    ).toEqual([]);
  });

  it('keeps the static ink paper, gold highlights and judgement feedback', () => {
    const reduced = reducedMotionBlock();

    // Only motion and its scanline alpha are overridden; colours, borders,
    // contrast, stacking and sizing stay exactly as the base rules define them.
    // The reduced-motion test above pins the selector list and the single
    // animation declaration; here the complete set additionally proves that no
    // other declaration sneaks in. Pin it instead of blacklisting property
    // names: longhands such as `background-image: none`, `background-size: 0 0`
    // or `border-color` were never named in the old blacklist, so a
    // property-name blacklist can never be complete.
    expect(
      rulesIn(reduced).map((rule) => ({
        selector: rule.selector,
        declarations: declarationsIn(rule.body),
      })),
      'reduced-motion 块只应覆盖 --fx-scan 与 animation: none',
    ).toEqual([
      {
        selector: '.zhen-sha-stage',
        declarations: [{ property: '--fx-scan', value: 'transparent' }],
      },
      {
        selector: '.zhen-sha-stage::before, .zhen-sha-stage::after',
        declarations: [{ property: 'animation', value: 'none' }],
      },
    ]);

    // The exact set above is only complete when every token in each rule body
    // was parsed as a declaration; escape tricks such as `background\2d image`
    // would otherwise be invisible to `declarationsIn`.
    for (const rule of rulesIn(reduced)) {
      expect(undeclaredTextIn(rule.body), `${rule.selector} 的声明应能被完整解析`).toBe('');
    }

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
