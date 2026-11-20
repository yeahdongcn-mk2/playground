import { BudgetError, formatGzipKb, measureBudget } from './lib/budget.mjs';

let report;
try {
  report = measureBudget('dist');
} catch (error) {
  if (error instanceof BudgetError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

console.log(
  `Entry JS: ${formatGzipKb(report.entry.bytes)} (${formatGzipKb(report.entry.gzipBytes)} gzip)`,
);
console.log(
  `All JS chunks: ${formatGzipKb(report.allJs.gzipBytes)} gzip (2D game budget 450 KB)`,
);
console.log(`CSS: ${formatGzipKb(report.cssGzipBytes)} gzip`);

const zhenShaChunks = report.zhenSha.chunks;
if (zhenShaChunks.length === 0) {
  console.log('Zhen Sha view JS: missing (expected dist/assets/zhen-sha-view-*.js)');
} else if (zhenShaChunks.length === 1) {
  const [chunk] = zhenShaChunks;
  console.log(
    `Zhen Sha view JS: ${chunk.file} ${formatGzipKb(chunk.gzipBytes)} gzip (per-game budget 35 KB)`,
  );
} else {
  console.log('Zhen Sha view JS:');
  for (const chunk of zhenShaChunks) {
    console.log(`  ${chunk.file}: ${formatGzipKb(chunk.gzipBytes)} gzip`);
  }
  console.log(
    `  total: ${formatGzipKb(report.zhenSha.gzipBytes)} gzip (per-game budget 35 KB)`,
  );
}

if (report.failures.length > 0) {
  console.error('Budget check failed:');
  for (const failure of report.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Budget check OK: shell is engine-free and within the 2D download budget.');
