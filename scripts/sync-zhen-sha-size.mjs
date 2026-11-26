#!/usr/bin/env node
/**
 * Refresh docs/zhen-sha-production-size.json from the current production tree.
 *
 * The historical kill-gate table stays frozen; this rolling snapshot is the
 * only place that follows the current src/games/zhen-sha/ sources.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRODUCTION_DIR,
  SNAPSHOT_PATH,
  SYNC_COMMAND,
  ZhenShaSizeError,
  measureProductionSize,
  serializeSizeSnapshot,
} from './lib/zhen-sha-size.mjs';

function formatSize(measurement) {
  return `${measurement.files.length} 个文件 / ${measurement.total.toLocaleString('en-US')} 行`;
}

try {
  const root = process.cwd();
  if (!existsSync(join(root, PRODUCTION_DIR))) {
    throw new ZhenShaSizeError(
      `找不到 ${PRODUCTION_DIR}；请在仓库根目录运行 ${SYNC_COMMAND}`,
    );
  }
  const measurement = measureProductionSize(root);
  const next = serializeSizeSnapshot(measurement);
  const snapshotPath = join(root, SNAPSHOT_PATH);
  const previous = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : null;

  if (previous === next) {
    console.log(`未变化：${SNAPSHOT_PATH} 已是最新（${formatSize(measurement)}）。`);
  } else {
    writeFileSync(snapshotPath, next, 'utf8');
    console.log(`已写入 ${SNAPSHOT_PATH}（${formatSize(measurement)}）。`);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`error: ${detail}`);
  process.exitCode = error instanceof ZhenShaSizeError ? 2 : 1;
}
