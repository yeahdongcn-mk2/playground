export interface ProductionFileSize {
  file: string;
  lines: number;
}

export interface ProductionSizeMeasurement {
  directory: string;
  files: ProductionFileSize[];
  total: number;
}

/** Input accepted by the snapshot builders; the total is recomputed. */
export interface ProductionSizeInput {
  directory?: string;
  files: ProductionFileSize[];
  total?: number;
}

export interface ProductionSizeSnapshot {
  directory: string;
  caliber: string;
  files: ProductionFileSize[];
  total: number;
}

export interface VerifySizeSnapshotOptions {
  snapshotText: string;
  measurement?: ProductionSizeMeasurement;
}

export interface SizeSnapshotVerification {
  ok: boolean;
  snapshot: ProductionSizeSnapshot | null;
  problems: string[];
  hint: string;
}

export const PRODUCTION_DIR: string;
export const SNAPSHOT_PATH: string;
export const SYNC_COMMAND: string;
export const MEASUREMENT_CALIBER: string;

export class ZhenShaSizeError extends Error {}

export function isProductionFile(name: string): boolean;
export function countLines(text: string): number;
export function measureProductionSize(root?: string): ProductionSizeMeasurement;
export function buildSizeSnapshot(measurement: ProductionSizeInput): ProductionSizeSnapshot;
export function serializeSizeSnapshot(measurement: ProductionSizeInput): string;
export function parseSizeSnapshot(text: string, source?: string): ProductionSizeSnapshot;
export function verifySizeSnapshot(options: VerifySizeSnapshotOptions): SizeSnapshotVerification;
