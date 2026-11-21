import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GAME_DIR = join(ROOT, 'src', 'games', 'zhen-sha');
const PUBLIC_DIR = join(ROOT, 'public', 'games', 'zhen-sha');
const CSS = readFileSync(join(GAME_DIR, 'zhen-sha.css'), 'utf8');
const CSS_WITHOUT_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The four core colours, then the single gold accent, in declaration order. */
const PALETTE_TOKENS = ['ink', 'paper', 'cinnabar', 'ash', 'gold'] as const;
const CORE_TOKEN_COUNT = PALETTE_TOKENS.length - 1;

interface ColourToken {
  name: string;
  value: string;
}

const DECLARED_TOKENS: ColourToken[] = [
  ...CSS_WITHOUT_COMMENTS.matchAll(/--zhen-([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g),
].map((match) => ({ name: match[1] ?? '', value: (match[2] ?? '').toLowerCase() }));

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

/** Files that actually enter the production build; tests may link tracked issues. */
const SHIPPED_FILES = ASSET_FILES.filter((file) => {
  const extension = extname(file);
  const name = basename(file);
  return (
    (extension === '.ts' || extension === '.css') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.test.css') &&
    !name.endsWith('.d.ts')
  );
});

/** The body of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS_WITHOUT_COMMENTS);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`zhen-sha.css 缺少规则：${selector}`);
  }
  return body;
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

/** CSS named colours that must not appear as literal values; transparent is allowed. */
const NAMED_COLOURS = `aliceblue antiquewhite aqua aquamarine azure beige bisque black
  blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
  cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen
  darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
  darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
  deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
  ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo
  ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen`.split(/\s+/);

describe('zhen-sha palette and procedural paper theme', () => {
  it('declares exactly four core colour tokens plus one gold accent', () => {
    expect(DECLARED_TOKENS.map((token) => token.name)).toEqual([...PALETTE_TOKENS]);
    expect(DECLARED_TOKENS.filter((token) => token.name !== 'gold')).toHaveLength(
      CORE_TOKEN_COUNT,
    );
    expect(DECLARED_TOKENS.find((token) => token.name === 'gold')?.value).toBe('#f6c453');
    expect(new Set(DECLARED_TOKENS.map((token) => token.value)).size).toBe(
      PALETTE_TOKENS.length,
    );
    // No sixth colour token sneaks in under the same prefix.
    expect(CSS_WITHOUT_COMMENTS.match(/--zhen-[a-z-]+\s*:/g)).toHaveLength(
      PALETTE_TOKENS.length,
    );
  });

  it('derives every colour literal and named colour in the stylesheet from the palette', () => {
    const paletteValues = new Set(DECLARED_TOKENS.map((token) => token.value));
    const literals = CSS_WITHOUT_COMMENTS.match(
      /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:hwb|lab|lch|oklab|oklch|color)\([^)]*\)/g,
    );
    expect(literals).not.toBeNull();
    expect(new Set((literals ?? []).map((literal) => literal.toLowerCase()))).toEqual(
      paletteValues,
    );

    // Named colours are not hex/rgb/hsl literals, so they need a separate guard.
    // `transparent` is allowed, and `black` is exempt only inside the mask.
    const namedColour = new RegExp(`\\b(?:${NAMED_COLOURS.join('|')})\\b`, 'gi');
    const maskDeclarations =
      CSS_WITHOUT_COMMENTS.match(/(?:-webkit-)?mask-image\s*:[^;]*;/g) ?? [];
    const maskWithoutBlack = maskDeclarations.join('\n').replace(/\bblack\b/gi, '');
    expect(maskWithoutBlack.match(namedColour)).toBeNull();

    const withoutTokensAndMask = CSS_WITHOUT_COMMENTS
      // Drop only the custom-property reference so fallbacks stay visible.
      .replace(/var\(\s*--[a-z-]+\s*,?/g, '')
      .replace(/\)/g, '')
      .replace(/--zhen-[a-z-]+/g, '')
      .replace(/(?:-webkit-)?mask-image\s*:[^;]*;/g, '');
    expect(withoutTokensAndMask.match(namedColour)).toBeNull();
    expect(declarationValue(ruleBody('.zhen-sha-stage::after'), 'mask-image')).toMatch(/\bblack\b/);
  });

  it('ships no external URLs, bitmap/audio assets or webfonts', () => {
    const externalUrl =
      /https?:\/\/|ftp:\/\/|(?:^|[^:\w])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\//i;
    const dataUri =
      /data:(?:image\/(?:png|jpe?g|webp|gif|avif|bmp)|audio\/|font\/|application\/font)/i;
    const fontFace = /@font-face/i;
    const assetExtension =
      /\.(?:png|jpe?g|webp|gif|avif|bmp|ico|mp3|wav|ogg|oga|m4a|aac|flac|opus|woff2?|ttf|otf|eot)$/i;

    expect(ASSET_FILES.length).toBeGreaterThan(0);
    for (const file of ASSET_FILES) {
      const label = relative(ROOT, file);
      expect(assetExtension.test(file), `${label} 不应是图片、音频或字体资产`).toBe(false);
    }
    // Only files that enter the build must be URL/font-free. Tests may link a
    // tracked issue (e.g. the #261 playtest follow-up) as a readable literal.
    expect(SHIPPED_FILES.length).toBeGreaterThan(0);
    for (const file of SHIPPED_FILES) {
      const label = relative(ROOT, file);
      const contents = readFileSync(file, 'utf8');
      expect(externalUrl.test(contents), `${label} 不应含外部 URL`).toBe(false);
      expect(dataUri.test(contents), `${label} 不应内联位图或字体数据`).toBe(false);
      expect(fontFace.test(contents), `${label} 不应含 webfont 声明`).toBe(false);
    }
  });

  it('paints the black xuan paper stage from the ink token', () => {
    // The opaque canvas covers the stage every frame, so this background is only
    // the pre-first-paint base colour; scope the assertion to the declaration
    // itself so the box-shadow cannot satisfy it by accident.
    const background = declarationValue(ruleBody('.zhen-sha-stage'), 'background');
    expect(background).toContain('var(--zhen-ink)');
    expect(background).toMatch(/(?:repeating-)?(?:linear|radial)-gradient\(/);

    const paper = ruleBody('.zhen-sha-stage::before');
    expect(paper).toContain('var(--zhen-paper)');
    expect(paper).toMatch(/(?:repeating-)?(?:linear|radial)-gradient\(/);
    expect(paper).toContain('mix-blend-mode: screen');
  });

  it('breaks the frame with a masked flying-white edge', () => {
    const edge = ruleBody('.zhen-sha-stage::after');
    expect(edge).toMatch(/(?:-webkit-)?mask-image:/);
    expect(edge).toMatch(/mask-composite:\s*add/);
    expect(edge).toMatch(/repeating-linear-gradient\(/);
    expect(edge).toContain('var(--zhen-paper)');
  });

  it('overlays the first-visit hint without intercepting gestures', () => {
    const tutorial = zIndex('.zhen-sha-tutorial');
    const canvas = zIndex('.zhen-sha-canvas');
    const overlay = zIndex('.zhen-sha-overlay');
    expect(tutorial).toBeGreaterThan(canvas);
    expect(tutorial).toBeLessThan(overlay);
    expect(declarationValue(ruleBody('.zhen-sha-tutorial'), 'pointer-events')).toBe('none');

    // Animation is opt-in; reduce motion keeps a static gold contour.
    expect(CSS).toContain('.zhen-sha-tutorial[data-motion="animated"] .zhen-sha-tutorial-ring');
    const staticRing = ruleBody(
      '.zhen-sha-tutorial[data-motion="static"] .zhen-sha-tutorial-ring',
    );
    expect(staticRing).toMatch(/animation:\s*none/);
    expect(staticRing).toContain('var(--zhen-gold)');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('stacks the paper layers above the canvas and below the settlement overlay', () => {
    const canvas = zIndex('.zhen-sha-canvas');
    const overlay = zIndex('.zhen-sha-overlay');
    expect(overlay).toBeGreaterThan(canvas);
    for (const selector of ['.zhen-sha-stage::before', '.zhen-sha-stage::after']) {
      expect(zIndex(selector), `${selector} 应位于结算 overlay 之下`).toBeLessThan(overlay);
      expect(zIndex(selector), `${selector} 应位于不透明 canvas 之上`).toBeGreaterThan(canvas);
      const pointerEvents = declarationValue(ruleBody(selector), 'pointer-events');
      expect(pointerEvents, `${selector} 不应拦截指针事件`).toBe('none');
    }
  });
});
