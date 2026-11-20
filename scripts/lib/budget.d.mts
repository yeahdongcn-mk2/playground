export interface GzipEntry {
  file: string;
  bytes: number;
  gzipBytes: number;
}

export interface ZhenShaBudgetResult {
  totalGzipBytes: number;
  failures: string[];
}

export interface BudgetReport {
  entry: GzipEntry;
  allJs: { files: string[]; gzipBytes: number };
  cssGzipBytes: number;
  zhenSha: { chunks: GzipEntry[]; gzipBytes: number };
  failures: string[];
}

export const ENTRY_LIMIT: number;
export const TOTAL_JS_LIMIT: number;
export const PER_GAME_LIMIT: number;
export const ZHEN_SHA_VIEW_CHUNK: RegExp;
export const ENGINE_MARKERS: readonly RegExp[];

export class BudgetError extends Error {}

export function gzipBytes(contents: Buffer | string): number;
export function formatGzipKb(bytes: number): string;
export function findZhenShaViewChunks(files: string[]): string[];
export function evaluateZhenShaViewChunks(
  chunks: ReadonlyArray<{ file: string; gzipBytes: number }>,
): ZhenShaBudgetResult;
export function measureBudget(distDir?: string): BudgetReport;
