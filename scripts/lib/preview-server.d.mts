import type { ChildProcess } from 'node:child_process';

export function previewStartupError(
  origin: string,
  port: number,
  detail: string,
): Error;

export interface WaitForServerOptions {
  port?: number;
  timeoutMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  failure?: () => string | null | undefined;
  fetchImpl?: (
    url: string,
    init: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean }>;
}

export function waitForServer(
  url: string,
  options?: WaitForServerOptions,
): Promise<void>;

export interface WaitForPreviewServerOptions {
  origin: string;
  port?: number;
  timeoutMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
}

export function waitForPreviewServer(
  child: ChildProcess,
  options: WaitForPreviewServerOptions,
): Promise<void>;
