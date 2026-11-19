import type { ReproResult } from './lib/screenshot-repro.mjs';

export interface VerifyReproOptions {
  help: boolean;
  manifest: string;
  dir: string;
  logDir: string;
  targets: string[];
  runs: number;
}

export interface VerifyReproLogger {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface ReproMainDependencies {
  env?: NodeJS.ProcessEnv;
  logger?: VerifyReproLogger;
  runRepro?: (options: {
    manifestPath: string;
    dir: string;
    logDir: string;
    targets: string[];
    runs: number;
    repoRoot: string;
    env: NodeJS.ProcessEnv;
    progress?: (line: string) => void;
  }) => ReproResult | Promise<ReproResult>;
  appendFile?: (path: string, data: string) => void;
  repoRoot?: string;
}

export function parseArgs(argv: string[]): VerifyReproOptions;
export function main(
  argv?: string[],
  dependencies?: ReproMainDependencies,
): Promise<number>;
