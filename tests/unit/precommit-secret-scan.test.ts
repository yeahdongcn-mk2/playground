import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, '.pre-commit-config.yaml');
const SCANNER_PATH = join(ROOT, 'scripts', 'scan-secrets.mjs');

interface HookDefinition {
  id: string;
  entry?: string;
  args?: string[];
  exclude?: string;
  types?: string[];
  pass_filenames?: boolean;
}

interface RepoDefinition {
  repo: string;
  rev?: string;
  hooks: HookDefinition[];
}

interface PreCommitConfig {
  repos: RepoDefinition[];
}

const config = parse(readFileSync(CONFIG_PATH, 'utf8')) as PreCommitConfig;
const allHooks = config.repos.flatMap((repo) => repo.hooks);
const scannerHook = allHooks.find((hook) => hook.id === 'secret-scan');

function requireScannerHook(): HookDefinition {
  if (!scannerHook) {
    throw new Error('pre-commit hook "secret-scan" is not configured');
  }
  return scannerHook;
}

function runScanner(files: string[]): { status: number; stderr: string } {
  const result = spawnSync(process.execPath, [SCANNER_PATH, ...files], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'precommit-secret-scan-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir = tempDirs.pop();
  while (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = tempDirs.pop();
  }
});

// Built at runtime so this test file itself stays clean for the scanner that
// it exercises.
const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const FAKE_PRIVATE_KEY_HEADER = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
// The public AWS documentation example key, split so this test file itself
// stays clean for the scanner it exercises.
const FAKE_AWS_SECRET_KEY = ['wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYEXAMPLEKEY'].join('');
// The public JWT example from the scanner issue, split so no line in this test
// file looks like a complete token to the scanner it exercises.
const FAKE_JWT_SEGMENTS = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0In0',
  'abc',
];
const FAKE_JWT = FAKE_JWT_SEGMENTS.join('.');

const DATABASE_URL_SCHEMES = [
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'mongodb',
  'mongodb+srv',
  'redis',
  'rediss',
  'amqp',
  'amqps',
  'mssql',
  'sqlserver',
  'cockroachdb',
  'clickhouse',
  'oracle',
  'neo4j',
] as const;

// SQLAlchemy and async drivers extend a base protocol with `+driver`; the
// scanner matches that suffix case-insensitively. Neo4j's `+srv` routing
// suffix follows the same shape.
const DATABASE_URL_DRIVER_SCHEMES = [
  'postgresql+psycopg2',
  'postgresql+asyncpg',
  'postgresql+PSYCOPG2',
  'mysql+pymysql',
  'mysql+aiomysql',
  'mariadb+pymysql',
  'mongodb+srv',
  'mssql+pyodbc',
  'sqlserver+pyodbc',
  'cockroachdb+psycopg2',
  'clickhouse+native',
  'oracle+oracledb',
  'neo4j+srv',
] as const;

// Shared fake password for the database URL fixtures, split so no literal
// `scheme://user:password@host` value appears in this file.
const FAKE_DB_PASSWORD = ['s3cr3t', 'password'].join('');
// Fake JDBC property value, split so no complete `password=...` property
// appears literally in this file.
const FAKE_JDBC_PASSWORD = ['S3cr3t', '!'].join('');
// SQL Server JDBC escapes values containing `;`, `{`, `}` or `=` by wrapping
// them in braces. Built at runtime so this test file itself does not contain a
// complete real-looking value.
const FAKE_JDBC_BRACE_ESCAPED_PASSWORD = `{${FAKE_JDBC_PASSWORD};!}`;
// A brace-wrapped mixed-case word is a real escaped value, not one of the
// template forms the rule excludes. Built from parts so this test file itself
// stays clean for the scanner it exercises.
const FAKE_JDBC_BRACE_WORD_PASSWORD = ['{', 'S3cr3t', '}'].join('');
// Brace-wrapped mixed-case values with `_`/`-` separators. The rule treats
// separator-joined names as templates, so these real-looking values are
// deliberately not reported; the trade-off is pinned by a test below.
const FAKE_JDBC_BRACE_SEPARATOR_PASSWORDS = [
  ['{', 'S3cr3t', '_2024', '}'],
  ['{', 'S3cr3t', '-2024', '}'],
].map((parts) => parts.join(''));
// Real values that start with a placeholder word but continue after
// punctuation. Only a value that is the whole placeholder word is exempt, so
// these must still be reported.
const FAKE_JDBC_PLACEHOLDER_PREFIX_PASSWORDS = [
  ['pass', '!word'],
  ['secret', '!2024'],
  ['example', '.org'],
  ['changeme', ':abc'],
].map((parts) => parts.join(''));
// Used to build a fixture line whose password property is empty at end of URL.
const EMPTY_JDBC_PASSWORD = '';
// Percent-encoded `@` and `/`, which valid connection strings use instead of
// the raw delimiters.
const FAKE_DB_SPECIAL_PASSWORD = ['p%40ss', '%2Fword'].join('');
// Dunder names without a placeholder word segment are real values, not
// templates. Built from parts so this test file itself stays clean for the
// scanner it exercises.
const FAKE_DUNDER_PASSWORD = ['__', 'S3cr3t', '__'].join('');
const FAKE_JDBC_DUNDER_PASSWORD = ['__', 'DB_S3cr3t', '__'].join('');
const FAKE_JDBC_BRACE_DUNDER_PASSWORD = `{${FAKE_JDBC_DUNDER_PASSWORD}}`;
// A dunder placeholder name followed by more characters is a real value; only
// the whole dunder template is exempt.
const FAKE_JDBC_DUNDER_PREFIX_PASSWORD = ['__PASSWORD__', 'x'].join('');
// A brace-escaped real dunder value, built from parts so this test file itself
// stays clean for the scanner it exercises.
const FAKE_JDBC_BRACE_REAL_DUNDER_PASSWORD = `{${FAKE_DUNDER_PASSWORD}}`;
// Masked placeholder used by the Redis fixture, built from parts so no literal
// masked URL appears in this file.
const MASKED_PASSWORD_PLACEHOLDER = ['*', '****'].join('');
// Oracle thin puts the credentials in the path (`user/password@host`) instead
// of a `user:password@` authority. The prefix, suffix and passwords are built
// from parts so no complete inline-credential URL appears in this test file.
const ORACLE_THIN_URL_PREFIX = ['jdbc', 'oracle', 'thin', 'scott'].join(':') + '/';
const ORACLE_THIN_URL_SUFFIX = '@host:1521:orcl';
// The Issue's `scott/tiger@host:1521:orcl` example password.
const ORACLE_THIN_PASSWORD = ['tiger'].join('');
const FAKE_ORACLE_THIN_PASSWORD = ['S3cr3t', '!'].join('');
const FAKE_ORACLE_THIN_SPECIAL_PASSWORD = ['p', '%40', 'ss'].join('');
const ORACLE_THIN_PLACEHOLDERS = [
  'password',
  '${DB_PASSWORD}',
  '*****',
  '%s',
  '__PASSWORD__',
  '__DB_PASSWORD__',
  '%DB_PASSWORD%',
  '<password>',
  '[password]',
  'changeme',
  'YOUR_PASSWORD',
] as const;

function oracleThinUrl(password: string): string {
  return `DATABASE_URL=${ORACLE_THIN_URL_PREFIX}${password}${ORACLE_THIN_URL_SUFFIX}`;
}

describe('secret scan pre-commit hook', () => {
  it('is configured to scan every text file, not only staged changes', () => {
    const hook = requireScannerHook();
    expect(hook.entry).toBe('node scripts/scan-secrets.mjs');
    expect(hook.pass_filenames).not.toBe(false);
    expect(hook.types).toContain('text');
    expect(JSON.stringify(hook)).not.toMatch(/--staged/);
  });

  it('reads filenames from pre-commit instead of the git index', () => {
    const source = readFileSync(SCANNER_PATH, 'utf8');
    expect(source).toContain('process.argv.slice(2)');
    expect(source).not.toMatch(/--staged|git\s+diff/);
  });

  it('excludes lockfile and binary screenshot false positives without disabling the scan', () => {
    const hook = requireScannerHook();
    const exclude = hook.exclude;
    if (!exclude) {
      throw new Error('secret-scan hook needs an exclude pattern for known false positives');
    }
    const pattern = new RegExp(exclude);
    expect(pattern.test('package-lock.json')).toBe(true);
    expect(pattern.test('docs/screenshots/after-hub-desktop.png')).toBe(true);
    // Text files under docs/screenshots/ (such as its README) must stay in
    // scope; the exclusion only covers the binary captures.
    expect(pattern.test('docs/screenshots/README.md')).toBe(false);
    expect(pattern.test('src/app/app.ts')).toBe(false);
    expect(pattern.test('tests/unit/precommit-secret-scan.test.ts')).toBe(false);
  });

  it('fails on a fixture containing a fake AWS key, then passes after removal', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'fixture.ts');
    writeFileSync(fixture, `export const accessKeyId = '${FAKE_AWS_KEY}';\n`);

    const failing = runScanner([fixture]);
    expect(failing.status).not.toBe(0);
    expect(failing.stderr).toContain('aws-access-key-id');
    expect(failing.stderr).toContain('fixture.ts');

    writeFileSync(fixture, "export const greeting = 'hello';\n");
    expect(runScanner([fixture]).status).toBe(0);
  });

  it('fails on aws_secret_access_key assignments with a 40-character base64 value', () => {
    const dir = makeTempDir();
    const fixtures = [
      ['lowercase.ts', `export const aws_secret_access_key = '${FAKE_AWS_SECRET_KEY}';\n`],
      ['uppercase.env', `AWS_SECRET_ACCESS_KEY=${FAKE_AWS_SECRET_KEY}\n`],
    ] as const;

    for (const [name, content] of fixtures) {
      const fixture = join(dir, name);
      writeFileSync(fixture, content);

      const failing = runScanner([fixture]);
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain('aws-secret-access-key');
      expect(failing.stderr).toContain(name);
    }
  });

  it('does not flag bare or short AWS secret key lookalikes', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'near-misses.ts');
    writeFileSync(
      fixture,
      [
        'export const aws_secret_access_key = process.env.AWS_SECRET_ACCESS_KEY;',
        `export const checksum = '${FAKE_AWS_SECRET_KEY}';`,
        `export const aws_secret_access_key = '${FAKE_AWS_SECRET_KEY.slice(0, 39)}';`,
        '',
      ].join('\n'),
    );

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('fails on a three-segment JWT fixture starting with eyJ', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'jwt.ts');
    writeFileSync(fixture, `export const token = '${FAKE_JWT}';\n`);

    const failing = runScanner([fixture]);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('jwt-token');
    expect(failing.stderr).toContain('jwt.ts');
  });

  it('does not flag incomplete JWT lookalikes or ordinary base64 text', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'jwt-near-misses.ts');
    writeFileSync(
      fixture,
      [
        `export const headerOnly = '${FAKE_JWT_SEGMENTS[0]}';`,
        `export const twoSegments = '${FAKE_JWT_SEGMENTS.slice(0, 2).join('.')}';`,
        `export const trailingDot = '${FAKE_JWT_SEGMENTS.slice(0, 2).join('.')}.';`,
        "export const base64 = 'SGVsbG8sIHdvcmxkIQ==';",
        '',
      ].join('\n'),
    );

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('fails on database URLs with an inline password for every supported scheme', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'database-urls.txt');
    const urls = [
      ...DATABASE_URL_SCHEMES.map(
        (scheme) => `${scheme}://dbuser:${FAKE_DB_PASSWORD}@db.internal:5432/app`,
      ),
      // Redis allows an empty username, with the password after a bare colon.
      `redis://:${FAKE_DB_PASSWORD}@cache:6379/0`,
      // Percent-encoded delimiters inside a password are still reported.
      `postgres://dbuser:${FAKE_DB_SPECIAL_PASSWORD}@db.internal/app`,
    ];
    writeFileSync(fixture, `${urls.map((url) => `DATABASE_URL=${url}`).join('\n')}\n`);

    const failing = runScanner([fixture]);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('database-url-password');
    // Every URL must be reported, not just the first line of the fixture.
    for (const [index] of urls.entries()) {
      expect(failing.stderr).toContain(
        `database-urls.txt:${index + 1}: [database-url-password]`,
      );
    }
  });

  it('fails on SQLAlchemy and async driver DSNs with an inline password', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'driver-database-urls.txt');
    const urls = DATABASE_URL_DRIVER_SCHEMES.map(
      (scheme) => `${scheme}://dbuser:${FAKE_DB_PASSWORD}@db.internal:5432/app`,
    );
    writeFileSync(fixture, `${urls.map((url) => `DATABASE_URL=${url}`).join('\n')}\n`);

    const failing = runScanner([fixture]);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('database-url-password');
    // Every driver variant must be reported, not just the first line.
    for (const [index] of urls.entries()) {
      expect(failing.stderr).toContain(
        `driver-database-urls.txt:${index + 1}: [database-url-password]`,
      );
    }
  });

  it('does not flag masked, printf-style or dunder placeholders in the database URL password slot', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'database-url-placeholders.txt');
    // Dunder templates are exempt only when a known placeholder word or phrase
    // makes up their underscore-separated segments, so `__DB_PASSWORD__` is a
    // placeholder but `__S3cr3t__` (covered by the positive test below) is not.
    const placeholders = [
      MASKED_PASSWORD_PLACEHOLDER,
      '__PASSWORD__',
      '__DB_PASSWORD__',
      '__API_PASSWD__',
      '%s',
    ];
    // Generate every base and driver scheme instead of only representative
    // ones, so the shared placeholder shapes are covered across the whole list.
    const schemes = [...DATABASE_URL_SCHEMES, ...DATABASE_URL_DRIVER_SCHEMES];
    const urls = schemes.flatMap((scheme) =>
      placeholders.map((password) => `${scheme}://dbuser:${password}@db.internal/app`),
    );
    // Redis allows an empty username, with the password after a bare colon.
    urls.push(`redis://:${MASKED_PASSWORD_PLACEHOLDER}@cache:6379/0`);
    writeFileSync(fixture, `${urls.map((url) => `DATABASE_URL=${url}`).join('\n')}\n`);

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('still flags real database URL passwords that resemble placeholder shapes', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'database-url-placeholder-prefixes.txt');
    // `*****`, `%s` and dunder placeholder names only exempt the whole password
    // value. Real passwords that merely start with the same characters, or use
    // a dunder name without a placeholder word, must still be reported; the
    // regular and percent-encoded forms are baseline positives.
    const passwords = [
      FAKE_DB_PASSWORD, // regular real password
      FAKE_DB_SPECIAL_PASSWORD, // percent-encoded `@` and `/`
      ['%s', '3cr3t'].join(''),
      ['*', 'S3cr3t'].join(''),
      ['__PASSWORD__', 'x'].join(''),
      FAKE_DUNDER_PASSWORD, // `__S3cr3t__`
      FAKE_JDBC_DUNDER_PASSWORD, // `__DB_S3cr3t__`
    ];
    const urls = passwords.map(
      (password) => `postgres://dbuser:${password}@db.internal/app`,
    );
    writeFileSync(fixture, `${urls.map((url) => `DATABASE_URL=${url}`).join('\n')}\n`);

    const failing = runScanner([fixture]);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('database-url-password');
    // Every URL must be reported, not just the first line of the fixture.
    for (const [index] of urls.entries()) {
      expect(failing.stderr).toContain(
        `database-url-placeholder-prefixes.txt:${index + 1}: [database-url-password]`,
      );
    }
  });

  it('fails on JDBC property-style connection strings with a real password property', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'jdbc-database-urls.txt');
    const urls = [
      // SQL Server puts properties after `;`.
      `jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${FAKE_JDBC_PASSWORD}`,
      `jdbc:mysql://db.internal:3306/app;user=sa;password=${FAKE_JDBC_PASSWORD};useSSL=false`,
      // SQL Server JDBC brace-escapes values containing `;`/`{}`/`=`; the
      // escaped value is a real password, not a `{...}` template placeholder.
      `jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${FAKE_JDBC_BRACE_ESCAPED_PASSWORD}`,
      // A bare brace-wrapped word is not one of the name-like template forms.
      `jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${FAKE_JDBC_BRACE_WORD_PASSWORD}`,
      // A dunder name without a placeholder word segment is a real value, both
      // bare and brace-escaped; narrowing the `__...__` wildcard must not
      // exempt it.
      `jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${FAKE_JDBC_DUNDER_PASSWORD}`,
      `jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${FAKE_JDBC_BRACE_DUNDER_PASSWORD}`,
      `jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${FAKE_JDBC_BRACE_REAL_DUNDER_PASSWORD}`,
      // A dunder placeholder name only exempts the whole value; a real password
      // that continues after the closing `__` must still be reported.
      `jdbc:mysql://db.internal:3306/app;user=sa;password=${FAKE_JDBC_DUNDER_PREFIX_PASSWORD};useSSL=false`,
      // PostgreSQL/MySQL JDBC URLs put properties in the query string.
      `jdbc:postgresql://db.internal:5432/app?user=sa&password=${FAKE_JDBC_PASSWORD}`,
      // A placeholder word only exempts the whole value; a real password that
      // continues after punctuation must still be reported.
      ...FAKE_JDBC_PLACEHOLDER_PREFIX_PASSWORDS.map(
        (password) => `jdbc:sqlserver://host:1433;user=sa;password=${password}`,
      ),
    ];
    writeFileSync(fixture, `${urls.map((url) => `DATABASE_URL=${url}`).join('\n')}\n`);

    const failing = runScanner([fixture]);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('database-url-password');
    // Every URL must be reported, not just the first line of the fixture.
    for (const [index] of urls.entries()) {
      expect(failing.stderr).toContain(
        `jdbc-database-urls.txt:${index + 1}: [database-url-password]`,
      );
    }
  });

  it('does not flag JDBC connection strings without a real password property', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'jdbc-database-url-near-misses.txt');
    const urls = [
      // No password property at all.
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa',
      // An explicitly empty password, before another property and at the end
      // of the URL.
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=;useSSL=false',
      `jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${EMPTY_JDBC_PASSWORD}`,
      // Env-var interpolation, masking and template placeholders. Most values
      // are followed by another property, so the placeholder is terminated by
      // `;` or `&` rather than by the end of the line; the whole-value check
      // must not depend on the value ending there.
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=${DB_PASSWORD};useSSL=false',
      'jdbc:postgresql://db.internal:5432/app?user=sa&password=${DB_PASSWORD}&ssl=false',
      'jdbc:mysql://db.internal:3306/app;user=sa;password=*****;useSSL=false',
      'jdbc:mysql://db.internal:3306/app;user=sa;password=__PASSWORD__;useSSL=false',
      'jdbc:mysql://db.internal:3306/app;user=sa;password=__DB_PASSWORD__;useSSL=false',
      'jdbc:mysql://db.internal:3306/app;user=sa;password=__API_PASSWD__;useSSL=false',
      'jdbc:mysql://db.internal:3306/app;user=sa;password=%s;useSSL=false',
      'jdbc:mysql://db.internal:3306/app;user=sa;password=password;useSSL=false',
      'jdbc:mysql://db.internal:3306/app;user=sa;password=...;useSSL=false',
      // Query-string values end at `&`; trailing punctuation must not turn a
      // placeholder word into a reported secret.
      'jdbc:postgresql://db.internal:5432/app?user=sa&password=changeme&ssl=false',
      'jdbc:postgresql://db.internal:5432/app?user=sa&password=password&ssl=false',
      'jdbc:postgresql://db.internal:5432/app?user=sa&password=changeme?ssl=false',
      // Configuration files often wrap the connection string in quotes, and
      // prose/markdown may end it with a period, bracket or comma.
      '"jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=changeme"',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=changeme.',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=changeme)',
      'jdbc:sqlserver://host;databaseName=app;user=sa;password=changeme,',
      // A placeholder word at the very end of the URL is still the whole value.
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password=password',
      // Name-like brace templates remain placeholders: placeholder words with
      // a suffix, underscore/hyphen-separated names and other placeholder
      // shapes. Dunder names need a placeholder word segment too. Brace-wrapped
      // real values are reported (see the positive test).
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={DB_PASSWORD}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={{DB_PASSWORD}}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={db_password}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={DB-PASSWORD}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={password123}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={...}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={__PASSWORD__}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={__DB_PASSWORD__}',
      // Masked and printf-style brace placeholders are templates too, even
      // though other brace values are reported; these pin the `*****`/`%s`
      // branches inside the brace shape.
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={*****}',
      'jdbc:sqlserver://host:1433;databaseName=app;user=sa;password={%s}',
      // Property text without a `jdbc:<scheme>://` prefix keeps the previous
      // non-matching behaviour.
      'sqlserver://host:1433;databaseName=app;user=sa;password=real-looking-value',
      'some-key=value;password=real-looking-value',
    ];
    writeFileSync(fixture, `${urls.map((url) => `DATABASE_URL=${url}`).join('\n')}\n`);

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('treats underscore/hyphen-separated brace values as templates (documented trade-off)', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'jdbc-brace-name-tradeoff.txt');
    // `{DB_PASSWORD}`/`{DB-PASSWORD}` and real values such as
    // `{S3cr3t_2024}`/`{S3cr3t-2024}` are indistinguishable to the rule, so it
    // exempts both kinds to keep templates quiet. Tightening this behaviour
    // must also update the rule comment in scripts/scan-secrets.mjs and this
    // expectation.
    writeFileSync(
      fixture,
      `${FAKE_JDBC_BRACE_SEPARATOR_PASSWORDS.map(
        (password) => `DATABASE_URL=jdbc:sqlserver://host:1433;user=sa;password=${password}`,
      ).join('\n')}\n`,
    );

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('fails on Oracle thin connection strings with a real inline password', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'oracle-thin-urls.txt');
    // The Issue's `scott/tiger@host:1521:orcl` example plus real values that
    // resemble placeholder prefixes; the whole-value check must not exempt
    // them.
    const contents = [
      FAKE_ORACLE_THIN_PASSWORD,
      ORACLE_THIN_PASSWORD,
      FAKE_ORACLE_THIN_SPECIAL_PASSWORD,
      ['%s', '3cr3t'].join(''),
      ['__PASSWORD__', 'x'].join(''),
    ].map(oracleThinUrl);
    writeFileSync(fixture, `${contents.join('\n')}\n`);

    const failing = runScanner([fixture]);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('database-url-password');
    // Every URL must be reported, not just the first line of the fixture.
    for (const [index] of contents.entries()) {
      expect(failing.stderr).toContain(
        `oracle-thin-urls.txt:${index + 1}: [database-url-password]`,
      );
    }
  });

  it('does not flag Oracle thin connection strings without real inline credentials', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'oracle-thin-near-misses.txt');
    const urls = [
      // No credentials at all.
      `${['jdbc', 'oracle', 'thin'].join(':')}:@host:1521:orcl`,
      // An explicitly empty password.
      `${ORACLE_THIN_URL_PREFIX}${ORACLE_THIN_URL_SUFFIX}`,
      // Whole-value placeholders follow the same rules as URL userinfo.
      ...ORACLE_THIN_PLACEHOLDERS.map(oracleThinUrl),
    ];
    writeFileSync(fixture, `${urls.join('\n')}\n`);

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('does not flag database URLs without real inline credentials', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'database-url-near-misses.txt');
    const urls = [
      // No userinfo at all.
      'postgres://db.internal:5432/app',
      'mysql://db.internal/app',
      'mongodb://cluster0.example.mongodb.net/app',
      'redis://cache:6379/0',
      'amqp://broker:5672/vhost',
      // A username without a password.
      'postgres://dbuser@db.internal/app',
      // An explicitly empty password.
      'postgres://dbuser:@db.internal/app',
      // Env-var interpolation and common documentation placeholders.
      'postgres://dbuser:${DB_PASSWORD}@db.internal/app',
      'postgres://dbuser:$DB_PASSWORD@db.internal/app',
      'postgres://dbuser:$(DB_PASSWORD)@db.internal/app',
      'postgres://dbuser:{{DB_PASSWORD}}@db.internal/app',
      'postgres://dbuser:{DB_PASSWORD}@db.internal/app',
      'postgres://dbuser:%DB_PASSWORD%@db.internal/app',
      'postgres://dbuser:<password>@db.internal/app',
      'postgres://dbuser:[password]@db.internal/app',
      'postgres://dbuser:password@db.internal/app',
      'postgres://dbuser:pass@db.internal/app',
      'postgres://dbuser:passwd@db.internal/app',
      'postgres://dbuser:pwd@db.internal/app',
      'postgres://dbuser:secret@db.internal/app',
      'postgres://dbuser:changeme@db.internal/app',
      'postgres://dbuser:placeholder@db.internal/app',
      'postgres://dbuser:example@db.internal/app',
      'postgres://dbuser:xxx@db.internal/app',
      'postgres://dbuser:xxxxx@db.internal/app',
      'postgres://dbuser:YOURPASSWORD@db.internal/app',
      'mongodb://dbuser:CHANGE_ME@db.internal/app',
      'redis://dbuser:YOUR_PASSWORD@cache:6379/0',
      'redis://dbuser:your_password@cache:6379/0',
      'amqp://dbuser:REPLACE_ME@broker:5672/vhost',
      // A port/query combination that contains `@` is not userinfo.
      'redis://cache:6379?notify=ops@example.com',
      'postgres://localhost:5432?user=admin@example.com',
      'postgres://host?user=a:b@c',
      // Driver suffixes keep the same credential requirements.
      'postgresql+psycopg2://db.internal:5432/app',
      'postgresql+asyncpg://dbuser@db.internal/app',
      'postgresql+asyncpg://dbuser:@db.internal/app',
      'mysql+pymysql://dbuser:${DB_PASSWORD}@db.internal/app',
      'mysql+aiomysql://dbuser:password@db.internal/app',
      'mariadb+pymysql://dbuser:${DB_PASSWORD}@db.internal/app',
      'mongodb+srv://cluster0.example.mongodb.net/app',
      // The newly supported protocols apply the same userinfo, password and
      // placeholder rules.
      'mssql://db.internal:1433/app',
      'sqlserver://dbuser@db.internal/app',
      'cockroachdb://dbuser:@db.internal/app',
      'clickhouse://analytics:8123/app',
      'oracle://dbuser:password@db.internal/app',
      'neo4j+srv://cluster0.example.com/app',
      'mssql+pyodbc://dbuser:${DB_PASSWORD}@db.internal/app',
      'sqlserver+pyodbc://dbuser:YOUR_PASSWORD@db.internal/app',
      'cockroachdb+psycopg2://dbuser:${DB_PASSWORD}@db.internal/app',
      'clickhouse+native://dbuser:<password>@db.internal/app',
      'oracle+oracledb://dbuser:REPLACE_ME@db.internal/app',
      'neo4j+srv://dbuser:xxxxx@db.internal/app',
    ];
    writeFileSync(fixture, `${urls.map((url) => `DATABASE_URL=${url}`).join('\n')}\n`);

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('fails on fixtures containing common private key headers', () => {
    const dir = makeTempDir();
    const headers = [
      FAKE_PRIVATE_KEY_HEADER,
      ['-----BEGIN', 'SSH2', 'ENCRYPTED', 'PRIVATE', 'KEY-----'].join(' '),
      ['-----BEGIN', 'PGP', 'PRIVATE', 'KEY', 'BLOCK-----'].join(' '),
    ];

    for (const [index, header] of headers.entries()) {
      const fixture = join(dir, `key-${index}.txt`);
      writeFileSync(fixture, `${header}\nMIIE...\n`);

      const failing = runScanner([fixture]);
      expect(failing.status).not.toBe(0);
      expect(failing.stderr).toContain('private-key');
    }
  });

  it('does not treat long placeholder credentials in ordinary assignments as secrets', () => {
    const dir = makeTempDir();
    const fixture = join(dir, 'placeholders.ts');
    writeFileSync(
      fixture,
      "export const token = 'abcdefghijklmnopqrstuvwx';\nexport const password = 'placeholder_password_1234567890';\n",
    );

    expect(runScanner([fixture])).toEqual({ status: 0, stderr: '' });
  });

  it('leaves key checked-in files clean', () => {
    expect(
      runScanner([
        'README.md',
        'docs/framework.md',
        'docs/screenshots/README.md',
        'package.json',
        '.pre-commit-config.yaml',
        'scripts/scan-secrets.mjs',
        'tests/unit/precommit-secret-scan.test.ts',
      ]),
    ).toEqual({ status: 0, stderr: '' });
  });
});
