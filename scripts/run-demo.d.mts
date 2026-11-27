import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { DemoConfig, DemoConfigEnv } from './lib/demo-config.mjs';

/** One child command the demo plan starts. */
export interface DemoCommand {
  /** Human-readable name used in progress and failure messages. */
  readonly label: string;
  /** Executable to spawn. */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args: readonly string[];
  /** Complete environment for the child. */
  readonly env: DemoConfigEnv;
  /** Whether the command needs a shell (the npm `.cmd` shim on Windows). */
  readonly shell: boolean;
}

/** Everything one demo run needs, resolved from the shared contract. */
export interface DemoPlan {
  /** Directory the children run in. */
  readonly cwd: string;
  /** Resolved site/room ports and URLs from `demo-config.mjs`. */
  readonly config: DemoConfig;
  /** Absolute path to the built entry that must exist before previewing. */
  readonly distEntry: string;
  /** Optional `npm run build` step. */
  readonly build: DemoCommand;
  /** Standalone room-service command. */
  readonly room: DemoCommand;
  /** `vite preview` command. */
  readonly preview: DemoCommand;
}

export function createDemoPlan(env?: DemoConfigEnv, cwd?: string): DemoPlan;

/** Writable stream used for progress output. */
export interface DemoOutput {
  write(data: string): unknown;
}

/** Minimal child surface the demo drives; a real ChildProcess satisfies it. */
export interface DemoChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Spawn function used by the demo; the real `spawn` matches it. */
export type DemoSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: DemoConfigEnv;
    stdio: 'inherit';
    shell: boolean;
  },
) => DemoChild;

/** Minimal fetch response the readiness probe consumes. */
export interface DemoProbeResponse {
  readonly ok: boolean;
}

/** Minimal fetch surface the readiness probe consumes. */
export type DemoFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<DemoProbeResponse>;

export interface DemoBuildOptions {
  spawnImpl?: DemoSpawn;
  stdout?: DemoOutput;
}

export interface DemoReadyOptions {
  fetchImpl?: DemoFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  /** Stops the polling loop once startup was aborted. */
  signal?: AbortSignal;
}

export function runDemoBuild(
  plan: DemoPlan,
  options?: DemoBuildOptions,
): Promise<void>;

export function waitForDemoReady(
  plan: DemoPlan,
  options?: DemoReadyOptions,
): Promise<void>;

export interface DemoStopOptions {
  killTimeoutMs?: number;
  stderr?: DemoOutput;
}

export function stopDemo(
  children: readonly DemoChild[],
  options?: DemoStopOptions,
): Promise<void>;

/** One-shot signal listener with a disposer. */
export interface DemoStopSignal {
  readonly promise: Promise<void>;
  dispose(): void;
}

export function createDemoStopSignal(signals?: EventEmitter): DemoStopSignal;

export interface DemoRunOptions {
  env?: DemoConfigEnv;
  cwd?: string;
  spawnImpl?: DemoSpawn;
  exists?: (path: string) => boolean;
  fetchImpl?: DemoFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  stdout?: DemoOutput;
  stderr?: DemoOutput;
  signals?: EventEmitter;
  readyTimeoutMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  killTimeoutMs?: number;
}

/** Result of a demo run; `plan` is `null` only after a CLI startup failure. */
export interface DemoRunResult {
  readonly plan: DemoPlan | null;
  readonly code: number;
}

export function runDemo(options?: DemoRunOptions): Promise<DemoRunResult>;

export function main(
  env?: DemoConfigEnv,
  options?: Omit<DemoRunOptions, 'env'>,
): Promise<DemoRunResult>;

export const DEMO_DIST_ENTRY: string;
export const DEMO_READY_TIMEOUT_MS: number;
export const DEMO_PROBE_INTERVAL_MS: number;
export const DEMO_PROBE_TIMEOUT_MS: number;
export const DEMO_KILL_TIMEOUT_MS: number;
