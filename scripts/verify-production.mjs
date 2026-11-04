import { spawn } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const HOST = '127.0.0.1';
const PORT = 4174;
const ORIGIN = `http://${HOST}:${PORT}`;

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // preview not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  await access('dist/index.html');
} catch {
  console.error('dist/index.html is missing; run `npm run build` first.');
  process.exit(1);
}

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
);

let browser;
try {
  await waitForServer(ORIGIN);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${ORIGIN}/?food=11,10#/games/snake`);
  await page.waitForSelector('[data-testid="snake-canvas"]');

  const debug = await page.evaluate(() => window.__playground);
  if (debug !== undefined) {
    throw new Error('The test-only window.__playground helper is exposed in the production build.');
  }

  const assets = await readdir('dist/assets');
  const snakeChunk = assets.find((file) => file.startsWith('snake-view-') && file.endsWith('.js'));
  if (!snakeChunk) {
    throw new Error('Could not find the production snake chunk in dist/assets.');
  }
  const chunkSource = await readFile(`dist/assets/${snakeChunk}`, 'utf8');
  if (chunkSource.includes('getState') || chunkSource.includes('URLSearchParams')) {
    throw new Error('A DEV-only debug seam survived in the production snake chunk.');
  }

  if (errors.length > 0) {
    throw new Error(`Production page errors: ${errors.join('; ')}`);
  }

  console.log('Production preview OK: game mounts and the DEV-only debug seam is absent.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
