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

  it('derives every colour literal in the stylesheet from the palette', () => {
    const paletteValues = new Set(DECLARED_TOKENS.map((token) => token.value));
    const literals = CSS_WITHOUT_COMMENTS.match(
      /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g,
    );
    expect(literals).not.toBeNull();
    expect(new Set((literals ?? []).map((literal) => literal.toLowerCase()))).toEqual(
      paletteValues,
    );
  });

  it('ships no external URLs, bitmap/audio assets or webfonts', () => {
    const externalUrl = new RegExp('(?:https?|ftp)' + ':\\/\\/', 'i');
    const fontFace = new RegExp('@font' + '-face', 'i');
    const assetExtension =
      /\.(?:png|jpe?g|webp|gif|avif|bmp|ico|mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;

    expect(ASSET_FILES.length).toBeGreaterThan(0);
    for (const file of ASSET_FILES) {
      const label = relative(ROOT, file);
      expect(assetExtension.test(file), `${label} 不应是图片或音频资产`).toBe(false);
      const contents = readFileSync(file, 'utf8');
      expect(externalUrl.test(contents), `${label} 不应含外部 URL`).toBe(false);
      expect(fontFace.test(contents), `${label} 不应含 webfont 声明`).toBe(false);
    }
  });

  it('paints the black xuan paper stage from the ink token', () => {
    const stage = ruleBody('.zhen-sha-stage');
    expect(stage).toContain('var(--zhen-ink)');
    expect(stage).toMatch(/(?:repeating-)?(?:linear|radial)-gradient\(/);

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

  it('keeps the canvas, HUD and gesture hooks above the paper layers', () => {
    expect(ruleBody('.zhen-sha-canvas')).toContain('z-index: 0');
    expect(ruleBody('.zhen-sha-overlay')).toContain('z-index: 3');
    expect(CSS).toContain('.zhen-sha-hud');
    expect(CSS).toContain('.zhen-sha-hints');
    expect(CSS).toContain('.zhen-sha-gesture-note');
    expect(CSS).toContain('pointer-events: none');
  });
});
