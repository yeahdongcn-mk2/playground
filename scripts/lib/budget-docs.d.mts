import type { BudgetReport } from './budget.mjs';

/** The raw and gzip sizes recorded for the shell entry script. */
export interface BudgetDocsEntry {
  /** Entry JS size before gzip, in KB as `check:budget` prints it. */
  rawKb: number;
  /** Entry JS gzip size in KB. */
  gzipKb: number;
}

/** One documented gzip size in KB. */
export interface BudgetDocsGzip {
  gzipKb: number;
}

/** The zhen-sha view chunk name and gzip size recorded in README. */
export interface BudgetDocsZhenSha {
  file: string;
  gzipKb: number;
}

/** Budget numbers parsed from README's "验证" section. */
export interface ReadmeBudgetDocs {
  path: 'README.md';
  entry: BudgetDocsEntry;
  allJs: BudgetDocsGzip;
  css: BudgetDocsGzip;
  zhenSha: BudgetDocsZhenSha;
}

/** Budget numbers parsed from docs/framework.md section 14. */
export interface FrameworkBudgetDocs {
  path: 'docs/framework.md';
  entry: BudgetDocsGzip;
  allJs: BudgetDocsGzip;
  zhenSha: BudgetDocsGzip;
}

/** The parsed budget contract from both documents. */
export interface BudgetDocs {
  readme: ReadmeBudgetDocs;
  framework: FrameworkBudgetDocs;
}

/** Input document contents for `readBudgetDocs()`. */
export interface BudgetDocsInput {
  readme: string;
  framework: string;
}

/** Raised when a budget document cannot be parsed as the contract requires. */
export class BudgetDocsError extends Error {
  constructor(message: string, path?: string);
  /** Document the error belongs to (`README.md` or `docs/framework.md`). */
  readonly path?: string;
}

/**
 * Parse the README "验证" section and docs/framework.md section 14.
 *
 * `input` is optional only so a missing call argument raises a path-named
 * `BudgetDocsError` instead of a `TypeError`; both documents are still
 * required for a usable result.
 *
 * Missing, duplicated or unparseable budget lines throw `BudgetDocsError`
 * with the document path instead of silently using a stale value.
 */
export function readBudgetDocs(): never;
export function readBudgetDocs(input: BudgetDocsInput): BudgetDocs;

/**
 * Compare every documented number and the zhen-sha chunk name with a
 * `measureBudget()` report.
 *
 * Returns one message per mismatch, each naming the document path and field;
 * an empty list means the documents match the measured build.
 */
export function compareBudgetDocs(docs: BudgetDocs, report: BudgetReport): string[];
