export const DEFAULT_PREVIEW_PORT: number;
export function parsePreviewPort(value?: string): number;
export function assertPortAvailable(port: number, host?: string): Promise<void>;
