import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GAME_DIR = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  'src',
  'games',
  'zhen-sha',
);

/** Production sources that ship in the game chunk, not tests or declarations. */
const PRODUCTION_FILES = readdirSync(GAME_DIR)
  .filter((name) => {
    const extension = extname(name);
    return (
      (extension === '.ts' || extension === '.css') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.css') &&
      !name.endsWith('.d.ts')
    );
  })
  .sort();

const SOURCES = PRODUCTION_FILES.map((name) => ({
  name,
  text: readFileSync(join(GAME_DIR, name), 'utf8'),
}));

/**
 * Borrowed titles, characters, sects, moves and trademarks. The seal may only
 * use the original name 镇煞 and abstract ink marks, so any of these appearing
 * in a shipped file is a regression.
 */
const BANNED_TOKENS: readonly string[] = [
  // Works and characters
  '黑神话',
  '悟空',
  'wukong',
  'black myth',
  '只狼',
  'sekiro',
  '苇名',
  'ashina',
  '艾尔登',
  'elden',
  '褪色者',
  'tarnished',
  '黑暗之魂',
  'dark souls',
  '血源',
  'bloodborne',
  '仁王',
  'nioh',
  '卧龙',
  'wo long',
  '鬼泣',
  'devil may cry',
  '忍者龙剑传',
  'ninja gaiden',
  '塞尔达',
  'zelda',
  '对马岛',
  'ghost of tsushima',
  '刺客信条',
  "assassin's creed",
  '怪物猎人',
  'monster hunter',
  '最终幻想',
  'final fantasy',
  '尼尔',
  'nier',
  '原神',
  'genshin',
  '崩坏',
  'honkai',
  '阴阳师',
  'onmyoji',
  '王者荣耀',
  'honor of kings',
  '永劫无间',
  'naraka',
  '剑网',
  '天涯明月刀',
  '逆水寒',
  '古剑奇谭',
  '太吾绘卷',
  '鬼谷八荒',
  '暖雪',
  '雨血',
  '影之刃',
  '拳皇',
  'king of fighters',
  '侍魂',
  'samurai shodown',
  '街头霸王',
  'street fighter',
  '铁拳',
  'tekken',
  // Sects and moves from existing wuxia works
  '少林',
  '武当',
  '峨眉',
  '丐帮',
  '明教',
  '日月神教',
  '全真',
  '古墓派',
  '桃花岛',
  '星宿派',
  '灵鹫宫',
  '逍遥派',
  '独孤九剑',
  '降龙十八掌',
  '六脉神剑',
  '九阴真经',
  '九阳神功',
  '乾坤大挪移',
  '葵花宝典',
  '吸星大法',
  '凌波微步',
  '北冥神功',
  '一阳指',
  '弹指神通',
  '打狗棒法',
  '玉女心经',
  '黯然销魂掌',
  '不死斩',
  '振刀',
  '定身术',
  // Trademarks and publishers
  '©',
  '™',
  '®',
  'copyright',
  'all rights reserved',
  'nintendo',
  'playstation',
  'xbox',
  'fromsoftware',
  'capcom',
  'bandai',
  'square enix',
  'miHoYo',
  'tencent',
  'netease',
];

function matchedTokens(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_TOKENS.filter((token) => lower.includes(token.toLowerCase()));
}

describe('zhen-sha original seal face', () => {
  it('ships production sources to inspect', () => {
    expect(PRODUCTION_FILES).toContain('settlement.ts');
    expect(PRODUCTION_FILES).toContain('zhen-sha-view.ts');
    expect(SOURCES.length).toBeGreaterThan(0);
    for (const source of SOURCES) {
      expect(source.text.length).toBeGreaterThan(0);
    }
  });

  it('uses only the original 镇煞 name and abstract seal marks', () => {
    const settlement = SOURCES.find((source) => source.name === 'settlement.ts');
    expect(settlement).toBeDefined();
    expect(settlement?.text).toMatch(/fillText\('镇'/);
    expect(settlement?.text).toMatch(/fillText\('煞'/);
    expect(settlement?.text).toContain('战 绩 符');
    expect(settlement?.text).not.toMatch(/fillText\('[^']*[A-Za-z]/);
  });

  it('never names another work, character, sect, move or trademark', () => {
    for (const source of SOURCES) {
      expect(matchedTokens(source.text), `${source.name} 不应借用现有作品元素`).toEqual([]);
    }
  });

  it('has no external asset or web-font reference in the shipped files', () => {
    for (const source of SOURCES) {
      expect(source.text, `${source.name} 不应含外部 URL`).not.toMatch(
        /https?:\/\/|ftp:\/\//i,
      );
      expect(source.text, `${source.name} 不应含内联位图或字体`).not.toMatch(
        /data:(?:image\/(?:png|jpe?g|webp|gif|avif)|audio\/|font\/)/i,
      );
      expect(source.text, `${source.name} 不应含 @font-face`).not.toMatch(/@font-face/i);
    }
  });
});
