import { describe, expect, it } from 'vitest';
import type { DifficultyId, ParseCustomDifficultyResult } from './difficulty';
import {
  DEFAULT_DIFFICULTY_ID,
  DIFFICULTY_PRESETS,
  findDifficultyForConfig,
  getDifficulty,
  parseCustomDifficulty,
} from './difficulty';
import { validateConfig } from './engine';

/** Return a rejection message and prove the failed parse exposed no config. */
function rejectionMessage(result: ParseCustomDifficultyResult): string {
  if (result.ok) {
    throw new Error(`Expected a rejected difficulty, received ${JSON.stringify(result.config)}.`);
  }
  expect('config' in result).toBe(false);
  return result.message;
}

describe('difficulty presets', () => {
  it('exposes the three classic presets in order', () => {
    expect(DIFFICULTY_PRESETS.map((preset) => preset.id)).toEqual([
      'beginner',
      'intermediate',
      'expert',
    ]);
    expect(DIFFICULTY_PRESETS.map((preset) => preset.label)).toEqual(['初级', '中级', '高级']);
  });

  it('defines the classic beginner, intermediate and expert boards', () => {
    expect(getDifficulty('beginner')).toEqual({
      id: 'beginner',
      label: '初级',
      rows: 9,
      cols: 9,
      mines: 10,
      firstClickSafe: true,
    });
    expect(getDifficulty('intermediate')).toEqual({
      id: 'intermediate',
      label: '中级',
      rows: 16,
      cols: 16,
      mines: 40,
      firstClickSafe: true,
    });
    expect(getDifficulty('expert')).toEqual({
      id: 'expert',
      label: '高级',
      rows: 16,
      cols: 30,
      mines: 99,
      firstClickSafe: true,
    });
  });

  it('defaults to the beginner preset', () => {
    expect(DEFAULT_DIFFICULTY_ID).toBe('beginner');
    expect(getDifficulty(DEFAULT_DIFFICULTY_ID)).toEqual(getDifficulty('beginner'));
  });

  it('keeps every preset playable under the engine rules', () => {
    for (const preset of DIFFICULTY_PRESETS) {
      expect(validateConfig(preset)).toEqual({
        rows: preset.rows,
        cols: preset.cols,
        mines: preset.mines,
        firstClickSafe: true,
      });
    }
  });
});

describe('getDifficulty', () => {
  it('looks a preset up by id', () => {
    for (const preset of DIFFICULTY_PRESETS) {
      expect(getDifficulty(preset.id)).toBe(preset);
    }
  });

  it('rejects an unknown id at runtime', () => {
    expect(() => getDifficulty('nightmare' as DifficultyId)).toThrow(RangeError);
  });
});

describe('findDifficultyForConfig', () => {
  it('matches every preset configuration to its id', () => {
    for (const preset of DIFFICULTY_PRESETS) {
      expect(findDifficultyForConfig(preset)).toBe(preset.id);
    }
  });

  it('returns null for a custom board', () => {
    expect(findDifficultyForConfig({ rows: 12, cols: 12, mines: 20, firstClickSafe: true })).toBeNull();
    expect(findDifficultyForConfig({ rows: 30, cols: 30, mines: 1, firstClickSafe: true })).toBeNull();
  });

  it('does not match a preset with a different mine count or first-click policy', () => {
    expect(findDifficultyForConfig({ rows: 9, cols: 9, mines: 11, firstClickSafe: true })).toBeNull();
    expect(findDifficultyForConfig({ rows: 9, cols: 9, mines: 10, firstClickSafe: false })).toBeNull();
    expect(findDifficultyForConfig({ rows: 16, cols: 30, mines: 99, firstClickSafe: true })).toBe(
      'expert',
    );
  });

  it('does not match a preset that differs only in rows', () => {
    expect(findDifficultyForConfig({ rows: 8, cols: 9, mines: 10, firstClickSafe: true })).toBeNull();
  });

  it('does not match a preset that differs only in cols', () => {
    expect(findDifficultyForConfig({ rows: 9, cols: 8, mines: 10, firstClickSafe: true })).toBeNull();
  });
});

describe('parseCustomDifficulty', () => {
  it('parses a preset-sized custom board with a safe first click', () => {
    expect(parseCustomDifficulty('9', '9', '10')).toEqual({
      ok: true,
      config: { rows: 9, cols: 9, mines: 10, firstClickSafe: true },
    });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseCustomDifficulty(' 16 ', '\t16\n', ' 40 ')).toEqual({
      ok: true,
      config: { rows: 16, cols: 16, mines: 40, firstClickSafe: true },
    });
  });

  it('accepts a custom size inside the playable bounds', () => {
    expect(parseCustomDifficulty('7', '12', '20')).toEqual({
      ok: true,
      config: { rows: 7, cols: 12, mines: 20, firstClickSafe: true },
    });
    expect(parseCustomDifficulty('30', '30', '1')).toEqual({
      ok: true,
      config: { rows: 30, cols: 30, mines: 1, firstClickSafe: true },
    });
  });

  it('accepts a mine count that exactly fills the safe-zone capacity', () => {
    expect(parseCustomDifficulty('5', '5', '16')).toEqual({
      ok: true,
      config: { rows: 5, cols: 5, mines: 16, firstClickSafe: true },
    });
  });

  it('rejects blank values for every field', () => {
    expect(rejectionMessage(parseCustomDifficulty('', '9', '10'))).toBe('行数不能为空。');
    expect(rejectionMessage(parseCustomDifficulty('   ', '9', '10'))).toBe('行数不能为空。');
    expect(rejectionMessage(parseCustomDifficulty('9', '   ', '10'))).toBe('列数不能为空。');
    expect(rejectionMessage(parseCustomDifficulty('9', '9', ''))).toBe('雷数不能为空。');
    expect(rejectionMessage(parseCustomDifficulty(null, '9', '10'))).toBe('行数不能为空。');
    expect(rejectionMessage(parseCustomDifficulty('9', undefined, '10'))).toBe('列数不能为空。');
  });

  it('rejects non-numeric, NaN and non-finite values as non-integers', () => {
    expect(rejectionMessage(parseCustomDifficulty('abc', '9', '10'))).toBe('行数必须是整数。');
    expect(rejectionMessage(parseCustomDifficulty('NaN', '9', '10'))).toBe('行数必须是整数。');
    expect(rejectionMessage(parseCustomDifficulty('Infinity', '9', '10'))).toBe('行数必须是整数。');
    expect(rejectionMessage(parseCustomDifficulty('9', '16abc', '10'))).toBe('列数必须是整数。');
    expect(rejectionMessage(parseCustomDifficulty('9', '9', '40abc'))).toBe('雷数必须是整数。');
  });

  it('rejects decimals without rounding or truncating them', () => {
    expect(rejectionMessage(parseCustomDifficulty('9.5', '9', '10'))).toBe('行数必须是整数。');
    expect(rejectionMessage(parseCustomDifficulty('9', '16.0001', '10'))).toBe('列数必须是整数。');
    expect(rejectionMessage(parseCustomDifficulty('9', '9', '10.9'))).toBe('雷数必须是整数。');
  });

  it('rejects dimensions outside the engine bounds without clamping them', () => {
    expect(rejectionMessage(parseCustomDifficulty('4', '9', '10'))).toBe(
      '行数必须是 5 到 30 之间的整数。',
    );
    expect(rejectionMessage(parseCustomDifficulty('31', '9', '10'))).toBe(
      '行数必须是 5 到 30 之间的整数。',
    );
    expect(rejectionMessage(parseCustomDifficulty('0', '9', '10'))).toBe(
      '行数必须是 5 到 30 之间的整数。',
    );
    expect(rejectionMessage(parseCustomDifficulty('-1', '9', '10'))).toBe(
      '行数必须是 5 到 30 之间的整数。',
    );
    expect(rejectionMessage(parseCustomDifficulty('9', '4', '10'))).toBe(
      '列数必须是 5 到 30 之间的整数。',
    );
    expect(rejectionMessage(parseCustomDifficulty('9', '31', '10'))).toBe(
      '列数必须是 5 到 30 之间的整数。',
    );
  });

  it('rejects zero and negative mine counts', () => {
    expect(rejectionMessage(parseCustomDifficulty('9', '9', '0'))).toBe('雷数必须是正整数。');
    expect(rejectionMessage(parseCustomDifficulty('9', '9', '-5'))).toBe('雷数必须是正整数。');
  });

  it('rejects a mine count that fills the whole board', () => {
    expect(rejectionMessage(parseCustomDifficulty('9', '9', '81'))).toBe(
      '雷数必须小于格子总数（81）。',
    );
    expect(rejectionMessage(parseCustomDifficulty('9', '9', '100'))).toBe(
      '雷数必须小于格子总数（81）。',
    );
  });

  it('rejects a mine count that overflows the first-click safe zone', () => {
    expect(rejectionMessage(parseCustomDifficulty('5', '5', '17'))).toBe(
      '雷数过多：首点安全区占 9 格，最多只能放 16 颗雷。',
    );
    expect(rejectionMessage(parseCustomDifficulty('9', '9', '80'))).toBe(
      '雷数过多：首点安全区占 9 格，最多只能放 72 颗雷。',
    );
  });
});
