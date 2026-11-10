export const DEFAULT_PREVIEW_PORT: number;
export function parsePreviewPort(value?: string, fallback?: number): number;

export interface AssertPortAvailableOptions {
  serverName?: string;
}

export function assertPortAvailable(
  port: number,
  host?: string,
  options?: AssertPortAvailableOptions,
): Promise<void>;
