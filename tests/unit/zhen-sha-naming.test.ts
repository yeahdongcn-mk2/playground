import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findGame } from '../../src/games/registry';
import { zhenShaGame } from '../../src/games/zhen-sha';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = resolve(ROOT, 'src');
const VIEW_SOURCE = readFileSync(
  resolve(SRC, 'games', 'zhen-sha', 'zhen-sha-view.ts'),
  'utf8',
);

/** The single Chinese name both the metadata and the first screen must show. */
const TITLE = '镇煞';
/** The retired name that must no longer ship. */
const RETIRED_TITLE = '真煞';

const SHIPPED_SOURCE_EXTENSIONS = new Set(['.ts', '.css', '.html']);

/** Files that ship in the production bundle; test and declaration files do not. */
function shippedSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return shippedSourceFiles(path);
    }
    if (!entry.isFile()) {
      return [];
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) {
      return [];
    }
    if (!SHIPPED_SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      return [];
    }
    return [path];
  });
}

describe('zhen-sha naming', () => {
  it('exposes 镇煞 as the game metadata title', () => {
    expect(zhenShaGame.meta.id).toBe('zhen-sha');
    expect(zhenShaGame.meta.title).toBe(TITLE);
    expect(zhenShaGame.meta.englishTitle).toBe('Zhen Sha');
  });

  it('keeps the registry entry on the same Chinese title', () => {
    const registered = findGame('zhen-sha');
    expect(registered).toBe(zhenShaGame);
    expect(registered?.meta.title).toBe(TITLE);
  });

  it('shows 镇煞 in the game first-screen heading', () => {
    expect(VIEW_SOURCE).toContain(`<h1>${TITLE} <span>Zhen Sha</span></h1>`);
    expect(VIEW_SOURCE).not.toContain(`<h1>${RETIRED_TITLE}`);
  });

  it('keeps the retired name out of every shipped source file', () => {
    const files = shippedSourceFiles(SRC);
    const relativeFiles = files.map((file) => relative(ROOT, file));

    // Guard the walker itself: the renamed game files must be part of the scan.
    expect(relativeFiles).toEqual(
      expect.arrayContaining([
        'src/games/zhen-sha/index.ts',
        'src/games/zhen-sha/zhen-sha-view.ts',
      ]),
    );

    const offenders = files
      .filter((file) => readFileSync(file, 'utf8').includes(RETIRED_TITLE))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
