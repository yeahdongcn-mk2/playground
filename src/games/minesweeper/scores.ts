/**
 * Versioned local best-time storage for Minesweeper.
 *
 * Pure logic: this module never touches the DOM. It keeps one namespaced JSON
 * key through `core/storage.ts`, so a broken `localStorage`, corrupt JSON or an
 * older schema can never stop the game from starting: bad data is removed and
 * reported as an empty board instead of escaping to the caller.
 *
 * Records live in a single key as `{ version: 1, records: { <bucket>: <ms> } }`.
 * Preset boards use their stable `DifficultyId`; custom boards use a key made
 * from rows, columns, mine count and the first-click policy, so equivalent
 * preset-sized custom boards share a bucket while different boards never do.
 */
import { createBrowserStorage, type StorageService } from '../../core/storage';
import {
  DIFFICULTY_PRESETS,
  findDifficultyForConfig,
  getDifficulty,
  type DifficultyId,
} from './difficulty';
import { validateConfig, type MinesweeperConfig } from './engine';

/** Namespaced key that holds the whole best-time table. */
export const SCORES_STORAGE_KEY = 'minesweeper.scores';

/** Schema version written to and accepted from storage. */
export const SCORES_VERSION = 1;

/** Stable id of one score bucket: a preset id or an encoded custom board. */
export type ScoreBucketId =
  | DifficultyId
  | `custom:${number}x${number}x${number}:${'safe' | 'unsafe'}`;

/** A score bucket with the board it describes and a display label. */
export interface ScoreBucket {
  readonly id: ScoreBucketId;
  /** Human-readable Chinese label for the leaderboard. */
  readonly label: string;
  readonly config: Readonly<MinesweeperConfig>;
}

/** One stored best time, ready to render. */
export interface ScoreEntry {
  readonly bucket: ScoreBucket;
  readonly elapsedMs: number;
}

interface StoredScores {
  readonly version: typeof SCORES_VERSION;
  readonly records: Record<string, number>;
}

const CUSTOM_BUCKET_PATTERN = /^custom:(\d+)x(\d+)x(\d+):(safe|unsafe)$/;

/** Non-JSON sentinel so a stored empty string is treated as corrupt, not absent. */
const ABSENT_VALUE = '\u0000absent';

const PRESET_ORDER: ReadonlyMap<string, number> = new Map(
  DIFFICULTY_PRESETS.map((preset, index) => [preset.id, index]),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidElapsed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function customLabel(
  rows: number,
  cols: number,
  mines: number,
  firstClickSafe: boolean,
): string {
  const safety = firstClickSafe ? '' : '（首点不安全）';
  return `自定义 ${rows}×${cols} / ${mines} 雷${safety}`;
}

function presetBucket(id: DifficultyId): ScoreBucket {
  const preset = getDifficulty(id);
  return Object.freeze({
    id,
    label: preset.label,
    config: Object.freeze({
      rows: preset.rows,
      cols: preset.cols,
      mines: preset.mines,
      firstClickSafe: preset.firstClickSafe,
    }),
  });
}

/** Build the stable bucket for a board configuration. */
export function bucketForConfig(config: MinesweeperConfig): ScoreBucket {
  const presetId = findDifficultyForConfig(config);
  if (presetId !== null) {
    return presetBucket(presetId);
  }

  const firstClickSafe = config.firstClickSafe === true;
  return Object.freeze({
    id: `custom:${config.rows}x${config.cols}x${config.mines}:${
      firstClickSafe ? 'safe' : 'unsafe'
    }`,
    label: customLabel(config.rows, config.cols, config.mines, firstClickSafe),
    config: Object.freeze({
      rows: config.rows,
      cols: config.cols,
      mines: config.mines,
      firstClickSafe,
    }),
  });
}

/**
 * Rebuild a bucket from its stored id.
 *
 * Returns null for unknown or non-canonical ids (for example `custom:01x9…`),
 * which the reader treats as corrupt data rather than silently re-keying it.
 */
function bucketForId(id: string): ScoreBucket | null {
  const preset = DIFFICULTY_PRESETS.find((candidate) => candidate.id === id);
  if (preset !== undefined) {
    return presetBucket(preset.id);
  }

  const match = CUSTOM_BUCKET_PATTERN.exec(id);
  if (match === null) {
    return null;
  }
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  const mines = Number(match[3]);
  const firstClickSafe = match[4] === 'safe';
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || !Number.isInteger(mines)) {
    return null;
  }

  let config: Readonly<MinesweeperConfig>;
  try {
    config = validateConfig({ rows, cols, mines, firstClickSafe });
  } catch {
    return null;
  }

  const bucket = bucketForConfig(config);
  return bucket.id === id ? bucket : null;
}

type DecodedScores =
  | { readonly ok: true; readonly records: ReadonlyMap<string, number> }
  | { readonly ok: false };

/** Parse and validate one raw storage value without touching the store. */
function decodeScores(raw: string): DecodedScores {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!isPlainObject(parsed) || parsed.version !== SCORES_VERSION) {
    return { ok: false };
  }
  const rawRecords = parsed.records;
  if (!isPlainObject(rawRecords)) {
    return { ok: false };
  }

  const records = new Map<string, number>();
  for (const [id, elapsedMs] of Object.entries(rawRecords)) {
    const bucket = bucketForId(id);
    if (bucket === null || !isValidElapsed(elapsedMs)) {
      return { ok: false };
    }
    records.set(bucket.id, elapsedMs);
  }
  return { ok: true, records };
}

/** Keep preset buckets in difficulty order, then custom boards by board size. */
function compareEntries(left: ScoreEntry, right: ScoreEntry): number {
  const leftPreset = PRESET_ORDER.get(left.bucket.id);
  const rightPreset = PRESET_ORDER.get(right.bucket.id);
  if (leftPreset !== undefined || rightPreset !== undefined) {
    if (leftPreset === undefined) {
      return 1;
    }
    if (rightPreset === undefined) {
      return -1;
    }
    return leftPreset - rightPreset;
  }

  const leftConfig = left.bucket.config;
  const rightConfig = right.bucket.config;
  return (
    leftConfig.rows - rightConfig.rows ||
    leftConfig.cols - rightConfig.cols ||
    leftConfig.mines - rightConfig.mines ||
    Number(rightConfig.firstClickSafe) - Number(leftConfig.firstClickSafe) ||
    left.bucket.id.localeCompare(right.bucket.id)
  );
}

/**
 * Best-time table backed by a single `StorageService` key.
 *
 * Every method is safe to call when storage is missing, full or throwing: the
 * worst case is an empty table and a silently skipped write.
 */
export class MinesweeperScores {
  private readonly storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  /**
   * Store `elapsedMs` for `bucket` only when it beats the current best.
   *
   * Non-finite or negative times, unknown buckets and unplayable boards are
   * ignored. Persistence is best-effort: a full or unavailable store swallows
   * the write instead of surfacing an exception.
   */
  record(bucket: ScoreBucket, elapsedMs: number): void {
    if (!isValidElapsed(elapsedMs)) {
      return;
    }
    const canonical = bucketForId(bucket.id);
    if (canonical === null) {
      return;
    }

    const records = this.readRecords();
    const current = records.get(canonical.id);
    if (current !== undefined && current <= elapsedMs) {
      return;
    }
    records.set(canonical.id, elapsedMs);
    this.writeRecords(records);
  }

  /** Best time for `bucket`, or null when the bucket has no record. */
  best(bucket: ScoreBucket): number | null {
    const canonical = bucketForId(bucket.id);
    if (canonical === null) {
      return null;
    }
    return this.readRecords().get(canonical.id) ?? null;
  }

  /**
   * Every stored best time, presets first and custom boards by board size.
   *
   * Presets without a record are absent; use `best()` for their placeholder
   * rows so the three preset labels keep their fixed display order.
   */
  list(): ScoreEntry[] {
    const entries: ScoreEntry[] = [];
    for (const [id, elapsedMs] of this.readRecords()) {
      const bucket = bucketForId(id);
      if (bucket !== null) {
        entries.push({ bucket, elapsedMs });
      }
    }
    return entries.sort(compareEntries);
  }

  /** Remove the whole Minesweeper score table, leaving other keys untouched. */
  clear(): void {
    this.storage.remove(SCORES_STORAGE_KEY);
  }

  private readRecords(): Map<string, number> {
    const raw = this.storage.getString(SCORES_STORAGE_KEY, ABSENT_VALUE);
    if (raw === ABSENT_VALUE) {
      return new Map();
    }

    const decoded = decodeScores(raw);
    if (!decoded.ok) {
      this.storage.remove(SCORES_STORAGE_KEY);
      return new Map();
    }
    return new Map(decoded.records);
  }

  private writeRecords(records: ReadonlyMap<string, number>): void {
    const payload: StoredScores = {
      version: SCORES_VERSION,
      records: Object.fromEntries(records),
    };
    this.storage.set(SCORES_STORAGE_KEY, JSON.stringify(payload));
  }
}

/** Create the best-time table for a game, defaulting to browser storage. */
export function createMinesweeperScores(
  storage: StorageService = createBrowserStorage(),
): MinesweeperScores {
  return new MinesweeperScores(storage);
}
