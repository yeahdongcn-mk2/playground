import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ENTRY_LIMIT = 50 * 1024;
const GAME_LIMIT = 450 * 1024;
const failures = [];

if (!existsSync('dist/index.html')) {
  console.error('dist/index.html is missing; run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync('dist/index.html', 'utf8');
const entrySrc = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
if (!entrySrc) {
  console.error('Could not find the entry script in dist/index.html.');
  process.exit(1);
}

const entryFile = join('dist', entrySrc.replace(/^\//, ''));
const entry = readFileSync(entryFile);
const entryGzip = gzipSync(entry).length;
const engineMarkers = [/\bPhaser\.(?:Game|Scene|AUTO)\b/, /\bTHREE\./];

console.log(`Entry JS: ${(entry.length / 1024).toFixed(2)} KB (${(entryGzip / 1024).toFixed(2)} KB gzip)`);
if (entryGzip > ENTRY_LIMIT) {
  failures.push(`entry JS is ${(entryGzip / 1024).toFixed(2)} KB gzip, over the 50 KB budget`);
}
for (const marker of engineMarkers) {
  if (marker.test(entry.toString('utf8'))) {
    failures.push(`entry JS contains engine marker ${marker}`);
  }
}

const jsFiles = readdirSync('dist/assets').filter((file) => file.endsWith('.js'));
const totalGzip = jsFiles.reduce(
  (total, file) => total + gzipSync(readFileSync(join('dist/assets', file))).length,
  0,
);
console.log(`All JS chunks: ${(totalGzip / 1024).toFixed(2)} KB gzip (2D game budget 450 KB)`);
if (totalGzip > GAME_LIMIT) {
  failures.push(
    `all JS chunks are ${(totalGzip / 1024).toFixed(2)} KB gzip, over the 450 KB 2D budget`,
  );
}

const cssFiles = readdirSync('dist/assets').filter((file) => file.endsWith('.css'));
const cssGzip = cssFiles.reduce(
  (total, file) => total + gzipSync(readFileSync(join('dist/assets', file))).length,
  0,
);
console.log(`CSS: ${(cssGzip / 1024).toFixed(2)} KB gzip`);

if (failures.length > 0) {
  console.error('Budget check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Budget check OK: shell is engine-free and within the 2D download budget.');
