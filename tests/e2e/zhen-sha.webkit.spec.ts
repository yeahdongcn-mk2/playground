import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openDebugGame, playFixedWin } from './zhen-sha-helpers';

/**
 * Count `URL.revokeObjectURL` calls before the app boots. The save flow must
 * release the blob URL it creates; if WebKit only reads the blob after the
 * download starts, an early revoke cancels the download instead.
 */
async function installRevokeProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window as unknown as { __revokedObjectUrls?: number };
    probe.__revokedObjectUrls = 0;
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string): void => {
      probe.__revokedObjectUrls = (probe.__revokedObjectUrls ?? 0) + 1;
      nativeRevoke(url);
    };
  });
}

async function revokedObjectUrlCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __revokedObjectUrls?: number }).__revokedObjectUrls ?? 0,
  );
}

/**
 * Non-Chromium coverage for the battle seal download (issue #428). This spec is
 * collected by the existing `mobile-webkit` project via `*.webkit.spec.ts`; it
 * runs the same fixed input sequence as the Chromium case and proves the
 * deferred object URL release is late enough for WebKit to read the blob.
 */
test('saves the battle seal as a 1080x1440 PNG on WebKit', async ({
  page,
  browserName,
}) => {
  expect(browserName).toBe('webkit');
  await installRevokeProbe(page);
  await openDebugGame(page);
  await playFixedWin(page);
  await expect(page.getByTestId('overlay-save-seal')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('overlay-save-seal').click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^zhen-sha-seal-\d+\.png$/);
  expect(await download.failure()).toBeNull();
  const downloadPath = await download.path();
  if (downloadPath === null) {
    throw new Error('the download has no local path');
  }

  const png = readFileSync(downloadPath);
  expect(png.byteLength).toBeGreaterThan(0);
  // PNG signature followed by the IHDR chunk width/height, big-endian.
  expect([...png.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBe(1440);

  // The deferred revoke must still run, so the object URL is not leaked.
  await expect
    .poll(() => revokedObjectUrlCount(page), {
      message: 'the download object URL should be revoked after saving',
    })
    .toBeGreaterThanOrEqual(1);
});
