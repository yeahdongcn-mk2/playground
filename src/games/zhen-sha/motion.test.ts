import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CSS_PATH = join(ROOT, 'src', 'games', 'zhen-sha', 'zhen-sha.css');
const CSS = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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

/** The media feature that turns the decorative loops off. */
const REDUCED_MOTION_FEATURE = /prefers-reduced-motion\s*:\s*reduce/i;

/** The part of a media prelude outside any parenthesised feature. */
function topLevelMediaText(prelude: string): string {
  let depth = 0;
  let topLevel = '';
  for (const char of prelude.toLowerCase()) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      topLevel += char;
    }
  }
  return topLevel;
}

/**
 * Whether a media prelude is a positive `prefers-reduced-motion: reduce`
 * query. A top-level `not (...)`, `... or (...)` or comma-separated query list
 * (an implicit `or`) changes who the block applies to and must not be mistaken
 * for the reduce off switch: `not (...)` is active when the user did *not* ask
 * for reduced motion, while `... or (...)` widens the block to every user.
 * Nested conditions inside `and (...)` stay accepted because the block still
 * only applies to reduce users. The equivalent `screen and (...)` write for
 * this screen-only app counts as positive.
 */
function isReducedMotionPrelude(prelude: string): boolean {
  const topLevel = topLevelMediaText(prelude);
  if (/\bnot\b/.test(topLevel) || /\bor\b/.test(topLevel) || topLevel.includes(',')) {
    return false;
  }
  return REDUCED_MOTION_FEATURE.test(prelude);
}

/** Every media block that mentions `prefers-reduced-motion: reduce`. */
function reducedMotionMentions(): {
  prelude: string;
  body: string;
  start: number;
  end: number;
}[] {
  return mediaBlocks().filter(({ prelude }) => REDUCED_MOTION_FEATURE.test(prelude));
}

/**
 * Every media block whose condition asks for `prefers-reduced-motion: reduce`.
 * A `not` / `or` variant is not the off switch this test is about, so it is
 * excluded here and then rejected explicitly against the mentions list.
 */
function reducedMotionBlocks(): {
  prelude: string;
  body: string;
  start: number;
  end: number;
}[] {
  return reducedMotionMentions().filter(({ prelude }) => isReducedMotionPrelude(prelude));
}

/** The single `prefers-reduced-motion: reduce` block start, body and end. */
function reducedMotionRange(): { start: number; body: string; end: number } {
  const blocks = reducedMotionBlocks();
  const [block] = blocks;
  if (block === undefined || blocks.length !== 1) {
    throw new Error('zhen-sha.css 应恰好有一条 prefers-reduced-motion: reduce 媒体块');
  }
  return block;
}

/** The body of the single `prefers-reduced-motion: reduce` media block. */
function reducedMotionBlock(): string {
  return reducedMotionRange().body;
}

/**
 * Every `@media` block in source order: its normalised prelude, body and the
 * source range of the block including its prelude.
 */
function mediaBlocks(): { prelude: string; body: string; start: number; end: number }[] {
  return [...CSS.matchAll(/@media\s*([^{]+)\{/gi)].map((match) => {
    const start = match.index ?? 0;
    const openBrace = start + match[0].length - 1;
    return {
      prelude: normalizeSelector(match[1] ?? ''),
      body: balancedBlockFrom(openBrace),
      start,
      end: matchingBraceIndex(openBrace) + 1,
    };
  });
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
  return [...body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]*)(?=;|$)/gi)].map((match) => {
    const property = match[1] ?? '';
    return {
      // CSS property names are ASCII case-insensitive, and a final declaration
      // may omit its semicolon. Custom property names are case-sensitive, so
      // `--FX-SCAN` must not collapse onto `--fx-scan`.
      property: property.startsWith('--') ? property : property.toLowerCase(),
      value: (match[2] ?? '').trim(),
    };
  });
}

/** A CSS value with insignificant whitespace and keyword case folded. */
function normalizeCssValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s*!\s*important$/, ' !important');
}

/**
 * The reduced-motion block's declarations grouped by individual selector.
 * Splitting a selector list into separate rules, reordering rules and ASCII
 * case changes are equivalent writes, so the assertions compare this semantic
 * grouping instead of the literal rule list.
 */
function reducedMotionDeclarations(): Map<string, { property: string; value: string }[]> {
  const grouped = new Map<string, { property: string; value: string }[]>();
  for (const rule of rulesIn(reducedMotionBlock())) {
    for (const selector of rule.selector.split(',').map(normalizeSelector)) {
      const declarations = grouped.get(selector) ?? [];
      declarations.push(
        ...declarationsIn(rule.body).map(({ property, value }) => ({
          property,
          value: normalizeCssValue(value),
        })),
      );
      grouped.set(selector, declarations);
    }
  }
  return grouped;
}

/**
 * Assert the reduced-motion block overrides only the scanline ink alpha and the
 * two decorative loops. Split selector lists, reordered rules, `ANIMATION:
 * NONE` and `none !important` are equivalent writes and must pass; any extra
 * selector or declaration is still rejected by the exact per-selector set.
 */
function expectOnlyReducedMotionOverrides(): void {
  const grouped = reducedMotionDeclarations();
  expect([...grouped.keys()].sort(), 'reduced-motion 块只应覆盖 stage 与两个伪元素').toEqual([
    '.zhen-sha-stage',
    '.zhen-sha-stage::after',
    '.zhen-sha-stage::before',
  ]);
  expect(
    grouped.get('.zhen-sha-stage'),
    'stage 只应把 --fx-scan 置为 transparent',
  ).toEqual([{ property: '--fx-scan', value: 'transparent' }]);

  for (const selector of ['.zhen-sha-stage::before', '.zhen-sha-stage::after']) {
    const declarations = grouped.get(selector) ?? [];
    expect(declarations, `${selector} 只应声明一条 animation`).toHaveLength(1);
    const [declaration] = declarations;
    expect(declaration?.property, `${selector} 的动画必须是 animation 简写`).toBe('animation');
    expect(declaration?.value, `${selector} 的动画必须关闭循环`).toMatch(
      /^none(?: !important)?$/,
    );
  }
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

/** The shortest loop duration that still reads as motion rather than a blur. */
const MIN_LOOP_DURATION_MS = 1000;

/**
 * Every CSS time token in a value, normalised to milliseconds. The lookbehind
 * keeps a digit inside an identifier out, and exponent numbers such as `1e3ms`
 * stay one token instead of being read as `3ms`.
 */
function timeValuesIn(value: string): number[] {
  return [
    ...value.matchAll(
      /(?<![\w.-])(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(ms|s)(?![\w-])/gi,
    ),
  ].map((match) => {
    const amount = Number.parseFloat(match[1] ?? '0');
    return match[2]?.toLowerCase() === 's' ? amount * 1000 : amount;
  });
}

/**
 * Assert one `animation` shorthand actually runs: every item must carry a
 * duration of at least {@link MIN_LOOP_DURATION_MS}, must not contain the
 * `paused` play-state keyword, and must not postpone the loop with a positive
 * delay. Merely finding `infinite` would still pass `0s`, `paused` or a
 * 999 s delay, where the loops become invisible even in the normal
 * (no-preference) case.
 */
function expectRunningAnimation(value: string, label: string): void {
  const items = topLevelItems(value);
  expect(items.length, `${label} 至少应有一条动画`).toBeGreaterThan(0);
  for (const item of items) {
    expect(item, `${label} 不得把 play-state 写成 paused`).not.toMatch(
      /(?:^|\s)paused(?:\s|$)/i,
    );
    // The first time value is the duration; a shorthand without one falls
    // back to 0s, so it must be declared explicitly and stay visible. The
    // second time value is the delay, which must not park the loop offscreen.
    const times = timeValuesIn(item);
    expect(times.length, `${label} 必须显式声明 duration`).toBeGreaterThan(0);
    expect(times[0], `${label} 的 duration 必须至少 ${MIN_LOOP_DURATION_MS}ms`).toBeGreaterThanOrEqual(
      MIN_LOOP_DURATION_MS,
    );
    for (const delay of times.slice(1)) {
      expect(delay, `${label} 不得用正延迟推迟循环`).toBeLessThanOrEqual(0);
    }
  }
}

/**
 * Reject longhands that would silently stop a loop the `animation` shorthand
 * just started: `animation-play-state: paused`, `animation-duration: 0s`,
 * `animation-name: none`, a finite `animation-iteration-count` and a positive
 * `animation-delay`. Harmless explicit equivalents (`running`, a non-zero
 * duration list, `infinite`, zero or negative delay) pass.
 */
function expectNoStoppingAnimationOverrides(
  selector: string,
  declarations: { property: string; value: string }[],
): void {
  for (const { property, value } of declarations) {
    const unprefixed = unprefixedAnimationProperty(property);
    if (unprefixed === 'animation-play-state') {
      for (const item of topLevelItems(value)) {
        expect(
          item.toLowerCase(),
          `${selector} 的 animation-play-state 不得暂停`,
        ).toBe('running');
      }
      continue;
    }
    if (unprefixed === 'animation-duration') {
      const times = timeValuesIn(value);
      expect(times.length, `${selector} 的 animation-duration 必须有时长`).toBeGreaterThan(0);
      for (const time of times) {
        expect(
          time,
          `${selector} 的 animation-duration 必须至少 ${MIN_LOOP_DURATION_MS}ms`,
        ).toBeGreaterThanOrEqual(MIN_LOOP_DURATION_MS);
      }
      continue;
    }
    if (unprefixed === 'animation-name') {
      for (const item of topLevelItems(value)) {
        expect(item.toLowerCase(), `${selector} 的 animation-name 不得置为 none`).not.toBe('none');
      }
      continue;
    }
    if (unprefixed === 'animation-iteration-count') {
      for (const item of topLevelItems(value)) {
        expect(
          item.toLowerCase(),
          `${selector} 的 animation-iteration-count 必须保持 infinite`,
        ).toBe('infinite');
      }
      continue;
    }
    if (unprefixed === 'animation-delay') {
      const times = timeValuesIn(value);
      expect(times.length, `${selector} 的 animation-delay 必须有时长`).toBeGreaterThan(0);
      for (const time of times) {
        expect(time, `${selector} 的 animation-delay 不得用正延迟推迟循环`).toBeLessThanOrEqual(0);
      }
    }
  }
}

describe('zhen-sha procedural motion layer', () => {
  it('classifies reduced-motion preludes by their effective media condition', () => {
    // Positive reduce queries are accepted, including the equivalent
    // `screen and (...)` write this screen-only app may use.
    expect(isReducedMotionPrelude('(prefers-reduced-motion: reduce)'), '基础 reduce 查询').toBe(
      true,
    );
    expect(
      isReducedMotionPrelude('screen and (prefers-reduced-motion: reduce)'),
      'screen and (...) 等价写法',
    ).toBe(true);
    expect(
      isReducedMotionPrelude('(prefers-reduced-motion: reduce) and (min-width: 0px)'),
      '与其它正向条件相与仍是 reduce 查询',
    ).toBe(true);
    expect(
      isReducedMotionPrelude('(prefers-reduced-motion: reduce) and (not (prefers-contrast: more))'),
      '括号内的嵌套 not 不改变外层 reduce 生效人群',
    ).toBe(true);
    expect(
      isReducedMotionPrelude(
        '(prefers-reduced-motion: reduce) and ((min-width: 0px) or (min-height: 0px))',
      ),
      '括号内的嵌套 or 不改变外层 reduce 生效人群',
    ).toBe(true);

    // A top-level `not (...)`, `... or (...)` or comma list changes who the
    // block applies to, so none of them may serve as the reduce off switch.
    expect(
      isReducedMotionPrelude('not (prefers-reduced-motion: reduce)'),
      '顶层 not 变体',
    ).toBe(false);
    expect(
      isReducedMotionPrelude('(prefers-reduced-motion: reduce) or (min-width: 0px)'),
      '顶层 or 变体',
    ).toBe(false);
    expect(
      isReducedMotionPrelude('(prefers-reduced-motion: reduce), (min-width: 0px)'),
      '逗号媒体查询列表等价于 or',
    ).toBe(false);
    expect(
      isReducedMotionPrelude('not (prefers-reduced-motion: no-preference)'),
      '顶层 not 仍视为非正向查询',
    ).toBe(false);
    expect(
      isReducedMotionPrelude('(prefers-reduced-motion: no-preference)'),
      'no-preference 不是关闭条件',
    ).toBe(false);
    expect(isReducedMotionPrelude('print'), '没有 reduce 条件的媒体类型').toBe(false);
  });

  it('rejects zero-duration and paused animation declarations', () => {
    // Guard the guard: the CSS-driven assertions below must really fail when
    // a loop is frozen through a shorthand, a longhand or a tiny duration.
    expect(() =>
      expectRunningAnimation('zhen-sha-ink-mist 38s ease-in-out infinite', '纸面'),
    ).not.toThrow();
    expect(() =>
      expectRunningAnimation('zhen-sha-ink-mist 1000ms ease-in-out infinite', '纸面'),
    ).not.toThrow();
    for (const [value, pattern] of [
      ['zhen-sha-ink-mist 0s ease-in-out infinite', /duration/],
      ['zhen-sha-ink-mist 0.001s ease-in-out infinite', /duration/],
      ['zhen-sha-ink-mist ease-in-out infinite', /duration/],
      ['zhen-sha-ink-mist 38s ease-in-out infinite paused', /paused/],
      ['zhen-sha-ink-mist 38s 999s ease-in-out infinite', /延迟/],
    ] as const) {
      expect(() => expectRunningAnimation(value, '纸面')).toThrow(pattern);
    }

    expect(() =>
      expectNoStoppingAnimationOverrides('纸面', [
        { property: 'animation-play-state', value: 'paused' },
      ]),
    ).toThrow(/play-state/);
    expect(() =>
      expectNoStoppingAnimationOverrides('纸面', [
        { property: 'animation-duration', value: '38s, 0s' },
      ]),
    ).toThrow(/duration/);
    expect(() =>
      expectNoStoppingAnimationOverrides('纸面', [
        { property: 'animation-name', value: 'none' },
      ]),
    ).toThrow(/animation-name/);
    expect(() =>
      expectNoStoppingAnimationOverrides('纸面', [
        { property: 'animation-iteration-count', value: '1' },
      ]),
    ).toThrow(/iteration-count/);
    expect(() =>
      expectNoStoppingAnimationOverrides('纸面', [
        { property: 'animation-delay', value: '999s' },
      ]),
    ).toThrow(/delay/);
    expect(() =>
      expectNoStoppingAnimationOverrides('纸面', [
        { property: '-webkit-animation-play-state', value: 'running' },
        { property: 'animation-duration', value: '38s, 9s' },
        { property: 'animation-iteration-count', value: 'infinite' },
        { property: 'animation-delay', value: '0s' },
      ]),
    ).not.toThrow();
  });

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
      expect(loops[0], `${name} 循环必须带 infinite`).toMatch(/\binfinite\b/i);
      expectRunningAnimation(loops[0] ?? '', `${name} 循环`);
    }
    expectNoStoppingAnimationOverrides(
      '.zhen-sha-stage::before',
      ruleBodies('.zhen-sha-stage::before').flatMap(declarationsIn),
    );
    // `declarationsIn` cannot see escaped property names such as
    // `animation-play\2d state`, so require every token in the running rule
    // bodies to parse as a declaration too.
    for (const body of ruleBodies('.zhen-sha-stage::before')) {
      expect(undeclaredTextIn(body), '::before 的声明应能被完整解析').toBe('');
    }

    const edge = ruleBody('.zhen-sha-stage::after');
    const edgeAnimation = declarationValue(edge, 'animation');
    expect(edgeAnimation, '边缘层应跑抖动循环').toMatch(/zhen-sha-jitter\b/);
    expect(edgeAnimation, '边缘抖动必须带 infinite').toMatch(/\binfinite\b/i);
    expectRunningAnimation(edgeAnimation, '边缘抖动循环');
    expectNoStoppingAnimationOverrides(
      '.zhen-sha-stage::after',
      ruleBodies('.zhen-sha-stage::after').flatMap(declarationsIn),
    );
    for (const body of ruleBodies('.zhen-sha-stage::after')) {
      expect(undeclaredTextIn(body), '::after 的声明应能被完整解析').toBe('');
    }

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
    // `--fx-scan` becomes transparent under reduced motion, so a static paper
    // layer that reused it would be erased too. Pin it to exactly one paint and
    // to the last background layer instead of merely checking that it appears.
    const scanInk = /var\(\s*--fx-scan\s*\)/;
    expect(paper.match(/var\(\s*--fx-scan\s*\)/g) ?? [], 'var(--fx-scan) 只能用于扫描线层')
      .toHaveLength(1);
    const paperLayers = topLevelItems(declarationValue(paper, 'background-image'));
    expect(paperLayers.at(-1), '扫描线应是最后一个 background-image 层').toMatch(scanInk);
    for (const layer of paperLayers.slice(0, -1)) {
      expect(layer, '前五个静态背景层不应复用 --fx-scan').not.toMatch(scanInk);
    }

    const edge = ruleBody('.zhen-sha-stage::after');
    expect(declarationValue(edge, 'position')).toBe('absolute');
    expect(declarationValue(edge, 'pointer-events')).toBe('none');
  });

  it('keeps the four static paper layers from main under the two motion layers', () => {
    // Rebasing #412 onto main (#406 4+1 palette, #411 marks) must not replace
    // the paper base: the first four background layers are main's two wash
    // blooms and two fibre gradients, and only layers five / six are the
    // motion additions of this PR. Dropping a base layer would still leave
    // six layers if another one were duplicated, so pin the shapes and sizes.
    const paper = ruleBody('.zhen-sha-stage::before');
    const layers = topLevelItems(declarationValue(paper, 'background-image'));
    const sizes = topLevelItems(declarationValue(paper, 'background-size'));
    expect(layers).toHaveLength(6);
    expect(sizes).toHaveLength(6);

    expect(layers[0]).toMatch(/^radial-gradient\(/);
    expect(layers[1]).toMatch(/^radial-gradient\(/);
    expect(layers[2]).toMatch(/^repeating-linear-gradient\(\s*108deg/);
    expect(layers[3]).toMatch(/^repeating-linear-gradient\(\s*21deg/);
    expect(sizes.slice(0, 4)).toEqual(['auto', 'auto', 'auto', 'auto']);

    // The two motion layers keep their own paint geometry: the oversized mist
    // wash (so no paper edge shows while it drifts) and the 6px scanline tile.
    expect(layers[4]).toMatch(/^radial-gradient\(/);
    expect(layers[5]).toMatch(/^repeating-linear-gradient\(/);
    expect(sizes[4]).toBe('165% 150%');
    expect(sizes[5]).toBe('100% 6px');
  });

  it('stops the mist, jitter and scanlines under reduced motion', () => {
    // Exactly one media block may request `prefers-reduced-motion: reduce`.
    // The semantic match keeps a second reduce block out while accepting the
    // equivalent `@media screen and (...)` prelude for this screen-only app
    // instead of pinning one canonical spelling. Every block that mentions the
    // feature must be a positive reduce query: `not (...)` applies to users
    // who did NOT ask for reduced motion, and `... or (...)` applies to
    // everyone, so neither may ride along as the off switch.
    expect(
      reducedMotionMentions().map(({ prelude }) => compactPrelude(prelude)),
      'prefers-reduced-motion: reduce 只允许正向查询（not / or 变体会改变生效人群）',
    ).toEqual(reducedMotionBlocks().map(({ prelude }) => compactPrelude(prelude)));
    expect(
      reducedMotionBlocks().map(({ prelude }) => compactPrelude(prelude)),
      'prefers-reduced-motion: reduce 媒体块只能有一条',
    ).toHaveLength(1);

    const { body: reduced, start: reducedStart, end: reducedEnd } = reducedMotionRange();

    // Only the scanline ink alpha and the two decorative loops may be
    // overridden. Equivalent writes (split selector list, reordered rules,
    // keyword case, `none !important`) pass; any extra declaration still fails.
    expectOnlyReducedMotionOverrides();

    const rules = rulesIn(reduced);
    const scanOff = rules.find((rule) => rule.body.includes('--fx-scan'));
    expect(scanOff?.selector).toBe('.zhen-sha-stage');
    expect(scanOff?.body).toMatch(/--fx-scan\s*:\s*transparent/);

    // The reduced block must not keep any of the zhen-sha animation names alive.
    expect(reduced).not.toMatch(/zhen-sha-ink-mist|zhen-sha-scanlines|zhen-sha-jitter/);

    // Only the two decorative pseudo-element rules and the first-visit hint
    // ring may run animation before the override; a higher-specificity stage
    // selector (for example `.zhen-sha-stage.is-playing::before`) would beat
    // the reduced rule in the cascade even though it comes earlier in the
    // file. The hint ring has no media-query override on purpose: the view
    // switches it to `data-motion="static"` from `services.reduceMotion`, so
    // the static rule declares `animation: none` and needs no cascade battle.
    const runningRules = rulesIn(CSS.slice(0, reducedStart)).filter(
      (rule) => animationPropertiesIn(rule.body).length > 0,
    );
    expect(runningRules.map((rule) => rule.selector)).toEqual([
      '.zhen-sha-stage::before',
      '.zhen-sha-stage::after',
      '.zhen-sha-tutorial[data-motion="animated"] .zhen-sha-tutorial-ring',
      '.zhen-sha-tutorial[data-motion="static"] .zhen-sha-tutorial-ring',
    ]);

    // `animation: none` in the media block is normal, so a running declaration
    // with `!important` would beat it regardless of source order. Reject any
    // `!` in a running animation value instead of spelling `important`: CSS
    // escapes such as `!\69 mportant` form the same token, and a literal `!`
    // cannot be escaped without ceasing to be the `!important` delimiter.
    for (const rule of runningRules) {
      for (const { property, value } of declarationsIn(rule.body)) {
        const unprefixed = unprefixedAnimationProperty(property);
        if (unprefixed === 'animation' || unprefixed.startsWith('animation-')) {
          expect(value, `${rule.selector} 的 ${property} 不得用 !important`).not.toContain('!');
        }
      }
    }

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
    // Assert the semantic per-selector set instead of the literal rule list:
    // splitting the selector list, reordering rules, `ANIMATION: NONE` and
    // `none !important` are equivalent writes, while any extra declaration
    // still fails. Longhands such as `background-image: none`,
    // `background-size: 0 0` or `border-color` cannot hide either.
    expectOnlyReducedMotionOverrides();

    // The semantic set above is only complete when every token in each rule
    // body was parsed as a declaration; escape tricks such as
    // `background\2d image` would otherwise be invisible to `declarationsIn`.
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
