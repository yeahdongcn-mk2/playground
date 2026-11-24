import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-budget-docs.mjs');
const KB = 1024;
const ENTRY_FILE = 'index-abc123.js';
const ZHEN_SHA_FILE = 'zhen-sha-view-abc123.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-budget-docs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Deterministic pseudo-random bytes: incompressible, so the gzip size is stable
 * across runs without depending on `randomBytes`.
 */
function incompressibleBytes(rawBytes: number): Buffer {
  const buffer = Buffer.alloc(rawBytes);
  let state = 0x12345678;
  for (let index = 0; index < rawBytes; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[index] = (state >>> 0) & 0xff;
  }
  return buffer;
}

function kb(bytes: number): string {
  return (bytes / KB).toFixed(2);
}

interface DocTexts {
  readme: string;
  framework: string;
}

interface Measured {
  entryBytes: number;
  entryGzipBytes: number;
  allJsGzipBytes: number;
  cssGzipBytes: number;
  zhenShaGzipBytes: number;
}

interface Fixture {
  dir: string;
}

interface FixtureOptions {
  mutate?: (docs: DocTexts) => DocTexts;
  /** Remove the built `dist/` after writing the documents. */
  skipDist?: boolean;
}

/**
 * Build a repository fixture whose README/framework numbers are derived from
 * the fixture's own files through `gzipSync`, independently of the CLI's
 * measurement. Mutating one document line therefore simulates exactly one
 * stale value.
 */
function makeFixture(options: FixtureOptions = {}): Fixture {
  const dir = makeTempDir();
  const entry = Buffer.from('console.log("budget docs fixture");\n'.repeat(20));
  const zhenSha = incompressibleBytes(6 * KB);
  const css = Buffer.from('.budget{display:block}\n'.repeat(50));
  const assets = join(dir, 'dist', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(
    join(dir, 'dist', 'index.html'),
    `<!doctype html><script type="module" crossorigin src="/assets/${ENTRY_FILE}"></script>`,
  );
  writeFileSync(join(assets, ENTRY_FILE), entry);
  writeFileSync(join(assets, ZHEN_SHA_FILE), zhenSha);
  writeFileSync(join(assets, 'index-abc123.css'), css);

  const entryGzipBytes = gzipSync(entry).length;
  const cssGzipBytes = gzipSync(css).length;
  const zhenShaGzipBytes = gzipSync(zhenSha).length;
  const measured: Measured = {
    entryBytes: entry.length,
    entryGzipBytes,
    allJsGzipBytes: entryGzipBytes + zhenShaGzipBytes,
    cssGzipBytes,
    zhenShaGzipBytes,
  };

  const docs: DocTexts = {
    readme: [
      '# Playground fixture',
      '',
      '## 验证',
      '',
      '```bash',
      'npm run test:unit    # 1 passed',
      'npm run check:budget # 通过，实际输出：',
      `# Entry JS: ${kb(measured.entryBytes)} KB (${kb(measured.entryGzipBytes)} KB gzip)`,
      `# All JS chunks: ${kb(measured.allJsGzipBytes)} KB gzip (2D game budget 450 KB)`,
      `# CSS: ${kb(measured.cssGzipBytes)} KB gzip`,
      `# Zhen Sha view JS: ${ZHEN_SHA_FILE} ${kb(measured.zhenShaGzipBytes)} KB gzip (per-game budget 35 KB)`,
      '# Budget check OK: shell is engine-free and within the 2D download budget.',
      '```',
      '',
      '## 其他',
      '',
      '无关内容。',
      '',
    ].join('\n'),
    framework: [
      '# Framework fixture',
      '',
      '## 14. 性能与已知限制',
      '',
      `- 入口 JS 约 ${kb(measured.entryGzipBytes)} KB gzip；全部 JS chunk 合计 ≤450 KB gzip（当前约 ${kb(measured.allJsGzipBytes)} KB gzip），并匹配 \`dist/assets/zhen-sha-view-*.js\` 要求合计 ≤35 KB gzip（当前约 ${kb(measured.zhenShaGzipBytes)} KB gzip）：fixture。`,
      '',
      '## 15. 其他',
      '',
      '无关内容。',
      '',
    ].join('\n'),
  };

  const finalDocs = options.mutate?.(docs) ?? docs;
  writeFileSync(join(dir, 'README.md'), finalDocs.readme);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'framework.md'), finalDocs.framework);
  if (options.skipDist === true) {
    rmSync(join(dir, 'dist'), { recursive: true, force: true });
  }

  return { dir };
}

function replaceLine(text: string, marker: string, mutate: (line: string) => string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(marker));
  if (index < 0) throw new Error(`找不到包含「${marker}」的行`);
  lines[index] = mutate(lines[index] ?? '');
  return lines.join('\n');
}

function removeLine(text: string, marker: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(marker));
  if (index < 0) throw new Error(`找不到包含「${marker}」的行`);
  lines.splice(index, 1);
  return lines.join('\n');
}

interface MismatchCase {
  name: string;
  path: string;
  field: string;
  /** A value the mutated document now prints instead of the measured one. */
  detail: string;
  mutate: (docs: DocTexts) => DocTexts;
}

/**
 * Each case edits one line of a document that otherwise matches the fixture's
 * measured `dist`, so the CLI must report exactly that field.
 */
const MISMATCH_CASES: MismatchCase[] = [
  {
    name: 'README Entry JS raw size',
    path: 'README.md',
    field: 'Entry JS 原始体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      readme: replaceLine(docs.readme, 'Entry JS:', (line) =>
        line.replace(/Entry JS: [\d.]+ KB/, 'Entry JS: 999.99 KB'),
      ),
    }),
  },
  {
    name: 'README Entry JS gzip size',
    path: 'README.md',
    field: 'Entry JS gzip 体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      readme: replaceLine(docs.readme, 'Entry JS:', (line) =>
        line.replace(/\(([\d.]+) KB gzip\)/, '(999.99 KB gzip)'),
      ),
    }),
  },
  {
    name: 'README All JS chunks gzip size',
    path: 'README.md',
    field: 'All JS chunks gzip 体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      readme: replaceLine(docs.readme, 'All JS chunks:', (line) =>
        line.replace(/All JS chunks: [\d.]+ KB gzip/, 'All JS chunks: 999.99 KB gzip'),
      ),
    }),
  },
  {
    name: 'README CSS gzip size',
    path: 'README.md',
    field: 'CSS gzip 体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      readme: replaceLine(docs.readme, 'CSS:', (line) =>
        line.replace(/CSS: [\d.]+ KB gzip/, 'CSS: 999.99 KB gzip'),
      ),
    }),
  },
  {
    name: 'README Zhen Sha gzip size',
    path: 'README.md',
    field: 'Zhen Sha view JS gzip 体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      readme: replaceLine(docs.readme, 'Zhen Sha view JS:', (line) =>
        line.replace(
          /(Zhen Sha view JS: \S+\.js )[\d.]+ KB gzip/,
          '$1999.99 KB gzip',
        ),
      ),
    }),
  },
  {
    name: 'README Zhen Sha chunk file name',
    path: 'README.md',
    field: 'Zhen Sha view JS chunk 文件名',
    detail: 'zhen-sha-view-WRONG.js',
    mutate: (docs) => ({
      ...docs,
      readme: replaceLine(docs.readme, 'Zhen Sha view JS:', (line) =>
        line.replace(/(Zhen Sha view JS: )\S+\.js/, '$1zhen-sha-view-WRONG.js'),
      ),
    }),
  },
  {
    name: 'framework entry gzip size',
    path: 'docs/framework.md',
    field: '第 14 节 入口 JS gzip 体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      framework: replaceLine(docs.framework, '入口 JS 约', (line) =>
        line.replace(/入口 JS 约 [\d.]+ KB gzip/, '入口 JS 约 999.99 KB gzip'),
      ),
    }),
  },
  {
    name: 'framework All JS gzip size',
    path: 'docs/framework.md',
    field: '第 14 节 全部 JS chunk gzip 体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      framework: replaceLine(docs.framework, '入口 JS 约', (line) =>
        line.replace(
          /（当前约 [\d.]+ KB gzip），并匹配/,
          '（当前约 999.99 KB gzip），并匹配',
        ),
      ),
    }),
  },
  {
    name: 'framework Zhen Sha gzip size',
    path: 'docs/framework.md',
    field: '第 14 节 Zhen Sha view JS gzip 体积',
    detail: '999.99',
    mutate: (docs) => ({
      ...docs,
      framework: replaceLine(docs.framework, '入口 JS 约', (line) =>
        line.replace(
          /要求合计 ≤35 KB gzip（当前约 [\d.]+ KB gzip）/,
          '要求合计 ≤35 KB gzip（当前约 999.99 KB gzip）',
        ),
      ),
    }),
  },
];

function runCli(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The `  - ...` bullet lines of the CLI's failure block. */
function failureBullets(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('  - '));
}

describe('check-budget-docs success', () => {
  it('exits 0 with the fixed marker when both documents match the measured dist', () => {
    const fixture = makeFixture();

    const result = runCli(fixture.dir);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Budget docs OK:');
    expect(result.stdout).toContain('README.md');
    expect(result.stdout).toContain('docs/framework.md');
  });
});

describe('check-budget-docs mutation failures', () => {
  it.each(MISMATCH_CASES)(
    'exits 1 and names $path / $field when $name is stale',
    ({ mutate, path, field, detail }) => {
      const fixture = makeFixture({ mutate });

      const result = runCli(fixture.dir);

      expect(result.stdout).toBe('');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Budget docs failed:');
      expect(failureBullets(result.stderr)).toHaveLength(1);
      expect(result.stderr).toContain(path);
      expect(result.stderr).toContain(field);
      expect(result.stderr).toContain(detail);
    },
  );

  it('exits 1 and names README.md when the CSS line is missing', () => {
    const fixture = makeFixture({
      mutate: (docs) => ({ ...docs, readme: removeLine(docs.readme, 'CSS:') }),
    });

    const result = runCli(fixture.dir);

    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Budget docs failed:');
    expect(result.stderr).toContain('README.md');
    expect(result.stderr).toContain('「## 验证」段缺少包含「CSS:」的行');
  });

  it('exits 1 and names docs/framework.md when the section 14 budget line is missing', () => {
    const fixture = makeFixture({
      mutate: (docs) => ({ ...docs, framework: removeLine(docs.framework, '入口 JS 约') }),
    });

    const result = runCli(fixture.dir);

    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Budget docs failed:');
    expect(result.stderr).toContain('docs/framework.md');
    expect(result.stderr).toContain('第 14 节缺少包含「入口 JS 约」的行');
  });

  it('exits 1 with the marker when docs/framework.md cannot be read', () => {
    const fixture = makeFixture();
    rmSync(join(fixture.dir, 'docs', 'framework.md'));

    const result = runCli(fixture.dir);

    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Budget docs failed:');
    expect(result.stderr).toContain('docs/framework.md');
    expect(result.stderr).toContain('无法读取文档');
  });

  it('exits 1 with the reusable BudgetError prompt when dist is missing', () => {
    const fixture = makeFixture({ skipDist: true });

    const result = runCli(fixture.dir);

    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Budget docs failed:');
    expect(result.stderr).toContain('dist/index.html is missing');
    expect(result.stderr).toContain('npm run build');
  });
});
