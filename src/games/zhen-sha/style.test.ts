import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GAME_DIR = join(ROOT, 'src', 'games', 'zhen-sha');
const PUBLIC_DIR = join(ROOT, 'public', 'games', 'zhen-sha');
const CSS = readFileSync(join(GAME_DIR, 'zhen-sha.css'), 'utf8');

/** The four core colours, then the single gold accent, in declaration order. */
const PALETTE_TOKENS = ['ink', 'paper', 'cinnabar', 'ash', 'gold'] as const;
const CORE_TOKEN_COUNT = PALETTE_TOKENS.length - 1;

interface ColourToken {
  name: string;
  value: string;
}

const DECLARED_TOKENS: ColourToken[] = [
  ...CSS.matchAll(/--zhen-([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g),
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
const SHIPPED_FILES = ASSET_FILES.filter(
  (file) => !file.endsWith('.test.ts') && !file.endsWith('.test.css') && !file.endsWith('.d.ts'),
);

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

const CSS_WITHOUT_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The value of one declaration inside a rule body, up to its semicolon. */
function declarationValue(body: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]*);`).exec(body);
  const value = match?.[1];
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
    expect(CSS.match(/--zhen-[a-z-]+\s*:/g)).toHaveLength(PALETTE_TOKENS.length);
  });

  it('derives every colour literal and named colour in the stylesheet from the palette', () => {
    const paletteValues = new Set(DECLARED_TOKENS.map((token) => token.value));
    const literals = CSS_WITHOUT_COMMENTS.match(
      /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g,
    );
    expect(literals).not.toBeNull();
    expect(new Set((literals ?? []).map((literal) => literal.toLowerCase()))).toEqual(
      paletteValues,
    );

    // Named colours are not hex/rgb/hsl literals, so they need a separate guard.
    // `transparent` is allowed; `black` is allowed only as a mask alpha stop.
    const withoutTokensAndMask = CSS_WITHOUT_COMMENTS.replace(/--zhen-[a-z-]+/g, '')
      .replace(/var\([^)]*\)/g, '')
      .replace(/(?:-webkit-)?mask-image\s*:[^;]*;/g, '');
    const namedColour = new RegExp(`\\b(?:${NAMED_COLOURS.join('|')})\\b`, 'gi');
    expect(withoutTokensAndMask.match(namedColour)).toBeNull();
    expect(ruleBody('.zhen-sha-stage::after')).toMatch(/mask-image:[\s\S]*\bblack\b/);
  });

  it('ships no external URLs, bitmap/audio assets or webfonts', () => {
    const externalUrl = /https?:\/\/|ftp:\/\//i;
    const fontFace = /@font-face/i;
    const assetExtension =
      /\.(?:png|jpe?g|webp|gif|avif|bmp|ico|mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;

    expect(ASSET_FILES.length).toBeGreaterThan(0);
    for (const file of ASSET_FILES) {
      const label = relative(ROOT, file);
      expect(assetExtension.test(file), `${label} 不应是图片或音频资产`).toBe(false);
    }
    // Only files that enter the build must be URL/font-free. Tests may link a
    // tracked issue (e.g. the #261 playtest follow-up) as a readable literal.
    expect(SHIPPED_FILES.length).toBeGreaterThan(0);
    for (const file of SHIPPED_FILES) {
      const label = relative(ROOT, file);
      const contents = readFileSync(file, 'utf8');
      expect(externalUrl.test(contents), `${label} 不应含外部 URL`).toBe(false);
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

  it('keeps the settlement overlay above both paper layers', () => {
    const overlay = zIndex('.zhen-sha-overlay');
    expect(overlay).toBeGreaterThan(zIndex('.zhen-sha-canvas'));
    for (const selector of ['.zhen-sha-stage::before', '.zhen-sha-stage::after']) {
      expect(zIndex(selector), `${selector} 应位于结算 overlay 之下`).toBeLessThan(overlay);
      expect(ruleBody(selector), `${selector} 不应拦截指针事件`).toMatch(
        /pointer-events:\s*none/,
      );
    }
    expect(CSS).toContain('.zhen-sha-hud');
    expect(CSS).toContain('.zhen-sha-hints');
    expect(CSS).toContain('.zhen-sha-gesture-note');
  });
});
