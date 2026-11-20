import type { ScreenshotSha256Manifest } from './screenshot-sha256.mjs';

export const DEFAULT_REPRO_LOAD_TARGETS: readonly string[];
export const DEFAULT_REPRO_LOAD_RUNS: number;
export const MIN_REPRO_LOAD_RUNS: number;
export const DEFAULT_REPRO_LOAD_WORKERS: number;

export const REPRO_LOAD_INPUT_ENV: Readonly<{
  targets: string;
  runs: string;
  load: string;
}>;

export class ReproLoadInputError extends Error {}

export interface ReproLoadInputs {
  targets: string[];
  runs: number;
  load: number;
}

export interface RawReproLoadInputs {
  targets?: unknown;
  runs?: unknown;
  load?: unknown;
}

export function manifestCaptureTargets(manifest: ScreenshotSha256Manifest): string[];
export function parseTargetList(
  value: unknown,
  supportedTargets: string[],
): string[];
export function normalizeRuns(value: unknown): number;
export function normalizeLoad(value: unknown): number;
export function normalizeReproLoadInputs(
  raw?: RawReproLoadInputs,
  supportedTargets?: string[],
): ReproLoadInputs;
export function formatGithubOutput(inputs: ReproLoadInputs): string;
