/**
 * Minesweeper difficulty presets and custom-board parsing.
 *
 * Pure logic: this module never touches the DOM. The board rules stay in the
 * engine's `validateConfig`, so presets and parsed custom boards pass through
 * exactly the same validation instead of duplicating the bounds, mine-count
 * and first-click safe-zone rules.
 */
import type { MinesweeperConfig } from './engine';
import { validateConfig } from './engine';

/** Stable identifier for one of the built-in difficulty presets. */
export type DifficultyId = 'beginner' | 'intermediate' | 'expert';

/** A built-in board setup with a display label. */
export interface DifficultyPreset extends MinesweeperConfig {
  readonly id: DifficultyId;
  /** Human-readable Chinese label shown in the difficulty selector. */
  readonly label: string;
  readonly firstClickSafe: true;
}

/** Preset selected when no other difficulty is chosen. */
export const DEFAULT_DIFFICULTY_ID: DifficultyId = 'beginner';

const BEGINNER_DIFFICULTY: DifficultyPreset = Object.freeze({
  id: 'beginner',
  label: '初级',
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
});

const INTERMEDIATE_DIFFICULTY: DifficultyPreset = Object.freeze({
  id: 'intermediate',
  label: '中级',
  rows: 16,
  cols: 16,
  mines: 40,
  firstClickSafe: true,
});

const EXPERT_DIFFICULTY: DifficultyPreset = Object.freeze({
  id: 'expert',
  label: '高级',
  rows: 16,
  cols: 30,
  mines: 99,
  firstClickSafe: true,
});

/** All built-in presets, ordered from the easiest to the hardest. */
export const DIFFICULTY_PRESETS: readonly DifficultyPreset[] = Object.freeze([
  BEGINNER_DIFFICULTY,
  INTERMEDIATE_DIFFICULTY,
  EXPERT_DIFFICULTY,
]);

/** Look up a preset by its stable id. */
export function getDifficulty(id: DifficultyId): DifficultyPreset {
  const preset = DIFFICULTY_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) {
    throw new RangeError(`Unknown difficulty id: ${String(id)}.`);
  }
  return preset;
}

/**
 * Find the preset matching a board configuration.
 *
 * Returns the preset id so a selector can mark the active difficulty, or
 * `null` when the configuration (including its first-click policy) does not
 * match a preset and is therefore custom.
 */
export function findDifficultyForConfig(config: MinesweeperConfig): DifficultyId | null {
  const preset = DIFFICULTY_PRESETS.find(
    (candidate) =>
      candidate.rows === config.rows &&
      candidate.cols === config.cols &&
      candidate.mines === config.mines &&
      candidate.firstClickSafe === config.firstClickSafe,
  );
  return preset?.id ?? null;
}

/** Successful or rejected result of parsing the custom-difficulty form. */
export type ParseCustomDifficultyResult =
  | { readonly ok: true; readonly config: Readonly<MinesweeperConfig> }
  | { readonly ok: false; readonly message: string };

const FIELD_LABELS = {
  rows: '行数',
  cols: '列数',
  mines: '雷数',
} as const;

type ConfigField = keyof typeof FIELD_LABELS;

type ParsedInteger =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

/** Read one form field as an exact integer, never clamping or rounding it. */
function parseIntegerField(raw: string | null | undefined, field: ConfigField): ParsedInteger {
  const text = raw?.trim() ?? '';
  if (text === '') {
    return { ok: false, message: `${FIELD_LABELS[field]}不能为空。` };
  }
  const value = Number(text);
  if (!Number.isInteger(value)) {
    return { ok: false, message: `${FIELD_LABELS[field]}必须是整数。` };
  }
  return { ok: true, value };
}

/** Translate an engine `validateConfig` rejection into a readable Chinese reason. */
function translateConfigError(error: unknown): string {
  const message = error instanceof RangeError ? error.message : '';

  if (message.startsWith('rows ') || message.startsWith('cols ')) {
    const field: ConfigField = message.startsWith('rows ') ? 'rows' : 'cols';
    const bounds = /between (\d+) and (\d+)/.exec(message);
    if (bounds !== null) {
      return `${FIELD_LABELS[field]}必须是 ${bounds[1] ?? ''} 到 ${bounds[2] ?? ''} 之间的整数。`;
    }
    return `${FIELD_LABELS[field]}无效。`;
  }

  if (message.startsWith('mines ')) {
    if (message.includes('positive integer')) {
      return '雷数必须是正整数。';
    }
    const cells = /smaller than the (\d+) board cells/.exec(message);
    if (cells !== null) {
      return `雷数必须小于格子总数（${cells[1] ?? ''}）。`;
    }
    const safeZone = /outside the (\d+)-cell first-click safe zone \(at most (\d+)\)/.exec(message);
    if (safeZone !== null) {
      return `雷数过多：首点安全区占 ${safeZone[1] ?? ''} 格，最多只能放 ${safeZone[2] ?? ''} 颗雷。`;
    }
    return '雷数无效。';
  }

  return `无效的棋盘配置：${message}`;
}

/**
 * Parse the three custom-difficulty form fields into a validated board.
 *
 * Values are read exactly as entered after trimming surrounding whitespace:
 * blank values, non-integers and decimals are rejected instead of being
 * clamped, truncated or rounded. Once all three are integers, the engine's
 * `validateConfig` enforces the playable bounds, the mine-count rules and the
 * first-click safe-zone capacity; a rejection becomes a Chinese message.
 */
export function parseCustomDifficulty(
  rowsRaw: string | null | undefined,
  colsRaw: string | null | undefined,
  minesRaw: string | null | undefined,
): ParseCustomDifficultyResult {
  const rows = parseIntegerField(rowsRaw, 'rows');
  if (!rows.ok) {
    return rows;
  }
  const cols = parseIntegerField(colsRaw, 'cols');
  if (!cols.ok) {
    return cols;
  }
  const mines = parseIntegerField(minesRaw, 'mines');
  if (!mines.ok) {
    return mines;
  }

  try {
    const config = validateConfig({
      rows: rows.value,
      cols: cols.value,
      mines: mines.value,
      firstClickSafe: true,
    });
    return { ok: true, config };
  } catch (error) {
    return { ok: false, message: translateConfigError(error) };
  }
}
