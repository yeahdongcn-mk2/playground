import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { games } from '../../src/games/registry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const README = read('README.md');
const INDEX = read('index.html');
const APP = read('src/app/app.ts');
const HUB = read('src/app/hub.ts');

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

const shippedGames = games.filter((game) => game.meta.id !== 'blank');
const shippedIds = shippedGames.map((game) => game.meta.id);
const shippedTitles = shippedGames.map((game) => game.meta.title);
const shippedCount = CHINESE_DIGITS[shippedGames.length] ?? '?';
const countLabel = `${shippedCount}款`;

/** The current copy line that contains the given marker. */
function lineContaining(source: string, marker: string): string {
  const line = source.split('\n').find((candidate) => candidate.includes(marker));
  if (line === undefined) {
    throw new Error(`missing a copy line containing ${marker}`);
  }
  return line;
}

/** Capture one group of a copy surface, failing when the group is missing. */
function extract(source: string, pattern: RegExp, name: string): string {
  const match = pattern.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`missing ${name}`);
  }
  return match[1];
}

describe('current game copy', () => {
  it('ships six complete games plus the blank canvas example', () => {
    expect(shippedGames).toHaveLength(6);
    expect(games).toHaveLength(shippedGames.length + 1);
    expect(shippedIds).toContain('zhen-sha');
    expect(shippedTitles).toContain('镇煞');
    expect(games.find((game) => game.meta.id === 'blank')).toBeDefined();
  });

  it('keeps the README title, intro, verification and limitations on the six games', () => {
    const heading = lineContaining(README, '## Playground Arcade：');
    for (const title of shippedTitles) {
      expect(heading).toContain(title);
    }

    const intro = lineContaining(README, '这是 Issue #11 的交付');
    expect(intro).toContain(`第${shippedCount}款完整游戏`);
    for (const title of shippedTitles) {
      expect(intro).toContain(title);
    }

    const verification = lineContaining(README, 'npm run test:unit    #');
    expect(verification).toContain(`${shippedCount}个游戏`);
    expect(verification).toContain('规则');

    const limitations = lineContaining(README, '- 目前有');
    expect(limitations).toContain(`${countLabel}完整游戏`);
    for (const title of shippedTitles) {
      expect(limitations).toContain(title);
    }
  });

  it('keeps the index.html title and description on the six games plus blank canvas', () => {
    const title = extract(INDEX, /<title>([^<]+)<\/title>/, '<title>');
    expect(title).toContain(`${countLabel}游戏`);
    expect(title).toContain('共享游戏框架');

    const description = extract(
      INDEX,
      /<meta\s+name="description"\s+content="([^"]+)"/,
      'meta description',
    );
    for (const gameTitle of shippedTitles) {
      expect(description).toContain(gameTitle);
    }
    expect(description).toContain('空白画布');
  });

  it('keeps the app shell footer and document title on the six games', () => {
    expect(APP).toContain(`共享游戏框架 · ${countLabel}游戏已上线`);
    expect(APP).toContain(
      `document.title = 'Playground Arcade · 共享游戏框架与${countLabel}游戏';`,
    );
  });

  it('keeps the hub eyebrow and lede on the current six-game story', () => {
    const eyebrow = extract(HUB, /<p class="eyebrow">([\s\S]*?)<\/p>/, 'hub eyebrow');
    expect(eyebrow).not.toContain('ISSUE #11');
    expect(eyebrow).toContain(`${countLabel}游戏`);

    const lede = extract(HUB, /<p class="lede">([\s\S]*?)<\/p>/, 'hub lede');
    expect(lede).toContain(`${countLabel}游戏`);
    for (const title of shippedTitles) {
      expect(lede).toContain(title);
    }
  });

  it('removes stale game counts and hub issue wording from every current copy surface', () => {
    for (const [name, source] of [
      ['README.md', README],
      ['index.html', INDEX],
      ['src/app/app.ts', APP],
      ['src/app/hub.ts', HUB],
    ] as const) {
      expect(source, `${name} should not carry the old five-game count`).not.toContain('五款');
      expect(source, `${name} should not carry the old four-game count`).not.toContain('四款');
      expect(source, `${name} should not carry the old hub issue eyebrow`).not.toContain(
        'ISSUE #11',
      );
    }
  });
});
