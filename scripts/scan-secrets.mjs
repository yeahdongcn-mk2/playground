/**
 * Scan files passed on the command line for obvious committed secrets.
 *
 * pre-commit passes every selected path as an argument. With
 * `pre-commit run --all-files` that is the whole tracked tree, so this hook is
 * not limited to staged changes. Exit code 1 means a finding was reported.
 *
 * The rules intentionally favour a small set of high-signal patterns over a
 * broad entropy heuristic: keeping false positives low lets the hook stay
 * enabled for every text file instead of being narrowed or disabled. There is
 * deliberately no generic "password/token = long literal" rule, because docs
 * and tests legitimately contain placeholders such as
 * `password = 'placeholder_password_1234567890'`.
 */
import { readFileSync } from 'node:fs';

// Documentation/env-template values that are never treated as a real password.
// The common words only count when the whole value is that word, so values
// such as `password123` are still reported.
const PLACEHOLDER_PASSWORD_WORDS = String.raw`password|passwd|pass|pwd|secret|changeme|change[_-]me|placeholder|example|your[_-]?(?:password|pass)|replace[_-]me|x{3,}`;

// `$VAR`, `${VAR}` and `$(VAR)` interpolation is a placeholder only when a
// placeholder word or phrase makes up one or more underscore-separated
// segments of the variable name, matching the dunder rule below. A broad
// whole-value `$VAR` shape would exempt any shell variable, including real
// passwords such as `$PASSWORDx` and `$PASSWORD123`, while this segmented name
// keeps `$DB_PASSWORD`, `$YOUR_PASSWORD` and `$CHANGE_ME` quiet. The
// `${VAR:-fallback}` form is deliberately reported in these slots: the fallback
// can contain a real secret, so only the plain `${VAR}`/`$(VAR)`/`$VAR` forms
// are treated as templates. All three password slots (URL userinfo, Oracle
// thin and JDBC properties) use this name shape, and all three report
// `${VAR:-fallback}`. The rule comment and a test pin that trade-off.
const PLACEHOLDER_PASSWORD_INTERPOLATION_NAME = String.raw`(?!\d)_*(?:[A-Za-z0-9]+_)*(?:${PLACEHOLDER_PASSWORD_WORDS})(?:_[A-Za-z0-9]+)*_*`;

// `__UPPER_SNAKE__` names are templates only when a known placeholder word or
// phrase makes up one or more underscore/hyphen-separated segments, so
// `__PASSWORD__`, `__DB_PASSWORD__` and `__CHANGE_ME__` are exempt while a real
// password such as `__S3cr3t__` is still reported. A name whose placeholder
// word is only part of a longer segment (`__DBPASSWORD__`, `__PASSWORD123__`)
// is reported too. A bare `__...__` wildcard would exempt any such real value
// and is deliberately avoided. The JDBC branch also requires the template to
// be the whole value, so a value such as `__PASSWORD__x` is still reported
// there.
const PLACEHOLDER_PASSWORD_DUNDER_SHAPES = String.raw`__(?:[A-Za-z0-9]+_)*(?:${PLACEHOLDER_PASSWORD_WORDS})(?:_[A-Za-z0-9]+)*__`;

// Masked, ellipsis, dunder and printf-style values that are placeholders only
// when they fill the whole password value (`*****`, `...`, `__PASSWORD__`,
// `%s`, `%d`, `%i`, `%f`) in the URL userinfo, Oracle thin and JDBC property
// branches. The printf shapes are the string and integer/float conversion
// specifiers commonly used in format strings, so `%d` is a placeholder but a
// real password that continues after it, for example `%d3cr3t`, is not. The
// rule regex is case-insensitive, so uppercase forms such as `%S` and `%D` are
// exempt too. The URL/Oracle branches require the `@` delimiter; the JDBC
// property branch requires that no further word characters follow. Either way
// a real password that merely starts with one of those shapes, for example
// `%s3cr3t` or `...S3cr3t`, is reported as a secret.
const PLACEHOLDER_PASSWORD_WHOLE_SHAPES = String.raw`\*+|\.{3,}|${PLACEHOLDER_PASSWORD_DUNDER_SHAPES}|%[sdif]`;

// SQL Server JDBC escapes values containing `;`, `{`, `}` or `=` by wrapping
// them in braces, for example `password={S3cr3t;!}`. A JDBC value that starts
// with `{` is therefore not automatically a template placeholder. Only a
// template that fills the whole value is exempt: a name-like placeholder word
// with an optional suffix (`{password123}`), a name with an
// underscore/hyphen separator (`{DB_PASSWORD}`, `{DB-PASSWORD}`) or another
// whole-value placeholder shape (`{...}`, `{*****}`, `{__PASSWORD__}`,
// `{__DB_PASSWORD__}`, `{%s}`, `{%d}`, `{%i}`, `{%f}`). Other brace values such
// as `{S3cr3t}` or `{ABC123}` are reported as real brace-escaped passwords, and
// so is a brace template followed by more content (`{password123}x`). A brace
// value with `_`/`-` separators is treated as a template even when its segments
// are mixed case, so `{S3cr3t_2024}` is not reported; that is an accepted
// trade-off for keeping `{DB_PASSWORD}`/`{DB-PASSWORD}` quiet. Dunder names use
// the same placeholder-word shape as the URL branch, so `{__S3cr3t__}` is
// reported. The brace shape only counts when no further value characters
// follow it; the URL userinfo and Oracle thin branches keep their own looser
// brace form (a balanced `{{...}}`, or `{` followed by a letter/underscore and
// a closing brace) and also require it to fill the whole password.
const PLACEHOLDER_JDBC_BRACE_SHAPES = String.raw`\{\{?(?:(?:${PLACEHOLDER_PASSWORD_WORDS})[A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+|\.{3,}|\*+|${PLACEHOLDER_PASSWORD_DUNDER_SHAPES}|%[sdif])\}\}?`;

// Interpolation/template placeholder shapes used for the URL userinfo and
// Oracle thin password slots. These shapes only exempt the value when they
// fill the whole password, which the rule enforces with a `(?=@)` lookahead: a
// real password that merely starts with one of these shapes, for example
// `$PASSWORDx`, `{S3cr3t`, `<password>x`, `[password]x` or `%DB_PASSWORD%x`,
// is still reported. The `$` forms use the segmented variable-name shape
// above; a variable name cannot start with a digit, and leading/trailing
// underscores are allowed. Angle/bracket/percent forms keep their existing
// content rules. The brace form is deliberately looser than the JDBC brace
// escape shape: a whole password that is either `{{...}}` or `{` followed by
// a letter/underscore and a closing brace is a template, so `{DB_PASSWORD}`,
// `{{DB_PASSWORD}}`, `{password123}`, `{ABC123}`, `{S3cr3t}` and `{S3cr3t;!}`
// stay exempt while unbalanced forms (`{S3cr3t`, `{S3cr3t}}`, `{{S3cr3t}`) and
// `{DB_PASSWORD}x` are reported. JDBC brace values are handled by
// PLACEHOLDER_JDBC_BRACE_SHAPES above and keep their stricter semantics.
// Masked, ellipsis, dunder and printf-style forms are listed separately in
// PLACEHOLDER_PASSWORD_WHOLE_SHAPES and already require the whole value; JDBC
// property values apply the same whole-value rule to their bare values. The
// JDBC `$`, `<...>`, `[...]` and `%NAME%` shapes share this `$` name shape but
// take the JDBC value boundary, so they live in PLACEHOLDER_JDBC_SHAPES below.
const PLACEHOLDER_PASSWORD_BRACE_SHAPES = String.raw`\{\{[^}]*\}\}|\{(?!\{)[A-Za-z_][^}]*\}`;
const PLACEHOLDER_PASSWORD_SHAPES = String.raw`\$(?:\{${PLACEHOLDER_PASSWORD_INTERPOLATION_NAME}\}|\(${PLACEHOLDER_PASSWORD_INTERPOLATION_NAME}\)|${PLACEHOLDER_PASSWORD_INTERPOLATION_NAME})|${PLACEHOLDER_PASSWORD_BRACE_SHAPES}|<[^>\s]*>|\[[^\]\s]*\]|%[A-Za-z_][A-Za-z0-9_]*%`;

// JDBC property values are matched up to whitespace, `;`, `?` or `&`. The
// whole-value check below requires that no value content (alphanumerics, `_`
// or `-`) follows the shape before that boundary; trailing punctuation such as
// a closing quote is tolerated, matching the other JDBC whole-value shapes.
// The `$` forms reuse the same segmented variable-name shape as the URL
// userinfo and Oracle thin slots, so `$DB_PASSWORD` is a template while
// `$PASSWORDx` is a real password, and `${VAR:-fallback}` is deliberately
// reported here too: the fallback can hide a real secret. The angle/bracket/
// percent shapes likewise count only when nothing follows them before the
// value ends, so `<password>x`, `[password]x` and `%DB_PASSWORD%x` are
// reported. JDBC brace values keep their own whole-value rule in
// PLACEHOLDER_JDBC_BRACE_SHAPES and are not repeated here.
const PLACEHOLDER_JDBC_WHOLE_VALUE = String.raw`(?![^\s;?&]*[A-Za-z0-9_-])`;
const PLACEHOLDER_JDBC_SHAPES = String.raw`\$(?:\{${PLACEHOLDER_PASSWORD_INTERPOLATION_NAME}\}|\(${PLACEHOLDER_PASSWORD_INTERPOLATION_NAME}\)|${PLACEHOLDER_PASSWORD_INTERPOLATION_NAME})${PLACEHOLDER_JDBC_WHOLE_VALUE}|${PLACEHOLDER_JDBC_BRACE_SHAPES}(?![^\s;?&]*[A-Za-z0-9_-])|<[^>\s]*>${PLACEHOLDER_JDBC_WHOLE_VALUE}|\[[^\]\s]*\]${PLACEHOLDER_JDBC_WHOLE_VALUE}|%[A-Za-z_][A-Za-z0-9_]*%${PLACEHOLDER_JDBC_WHOLE_VALUE}`;

const RULES = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/,
  },
  {
    id: 'private-key',
    description: 'PEM private key block',
    // Matches RSA/EC/DSA/OpenSSH/encrypted keys, RFC 4716 SSH2 keys and PGP
    // private key blocks.
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'stripe-secret-key',
    description: 'Stripe secret key',
    pattern: /\bsk_live_[0-9A-Za-z]{24,}\b/,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key',
    // Only the named assignment is matched: the `aws_secret_access_key` key
    // followed by `=`/`:` and exactly 40 base64 characters (quotes around the
    // key and value are optional). A bare 40-character string is deliberately
    // not flagged, because that would be a generic entropy rule and would also
    // match checksums, hashes and test fixtures.
    pattern:
      /\baws_secret_access_key['"]?\s*[:=]\s*['"`]?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/i,
  },
  {
    id: 'jwt-token',
    description: 'JSON Web Token',
    // JWT compact serialization is exactly three base64url segments separated
    // by dots. A JWT header is a JSON object, so its base64url encoding always
    // starts with `eyJ`; requiring that prefix plus all three segments keeps
    // standalone base64 text and two-segment lookalikes out of the results.
    // The signature length is intentionally not checked: docs and test
    // fixtures use short example signatures. `(?![A-Za-z0-9_-])` avoids
    // reporting a prefix of a longer base64url run.
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/,
  },
  {
    id: 'database-url-password',
    description: 'database URL with an inline password',
    // Credentials embedded in the authority of a database/broker URL:
    // `scheme://user:password@host`, for PostgreSQL, MySQL/MariaDB, MongoDB,
    // Redis, AMQP, Microsoft SQL Server (`mssql`/`sqlserver`), CockroachDB,
    // ClickHouse, Oracle and Neo4j. The scheme is the bare protocol plus an
    // optional `+driver` suffix, so SQLAlchemy, JDBC-style, async and
    // cluster/srv DSNs such as `postgresql+psycopg2`, `postgresql+asyncpg`,
    // `mysql+pymysql`, `mysql+aiomysql`, `mariadb+pymysql`,
    // `mssql+pyodbc`, `cockroachdb+psycopg2`, `clickhouse+native`,
    // `oracle+oracledb`, `mongodb+srv` and `neo4j+srv` are covered too.
    // The username may be empty (Redis puts the password after a bare `:`).
    //
    // JDBC property-style connections are covered as well: any
    // `jdbc:<scheme>://` URL whose properties contain a real `password=` value
    // is reported, with properties separated by `;` (SQL Server style) or by
    // `?`/`&` (PostgreSQL/MySQL style). This applies to every scheme in the
    // list above, for example
    // `jdbc:sqlserver://host;databaseName=app;user=sa;password=...`.
    //
    // Oracle thin URLs carry the credentials in the path instead of a
    // `user:password@` authority, so they need their own branch. The form
    // `jdbc:oracle:thin:<user>/<password>@<host>:<port>:<sid>` is reported, and
    // the password between `/` and `@` reuses the same placeholder and
    // empty-value exclusions as the URL userinfo branch. URLs without
    // credentials (`jdbc:oracle:thin:@host:1521:orcl`), with an empty password
    // (`jdbc:oracle:thin:scott/@host:1521:orcl`) or with a whole-value
    // placeholder (`${DB_PASSWORD}`, `*****`, `%s`/`%d`/`%i`/`%f`,
    // `__PASSWORD__`, `password`, ...) are not reported, while real values such
    // as `S3cr3t!` and percent-encoded forms such as `p%40ss` are.
    //
    // The following are deliberately not reported so that connection strings
    // in docs and env templates do not trip the hook:
    //   - URLs without userinfo (`scheme://host/db`);
    //   - JDBC URLs without a `password=` property;
    //   - an empty password (`scheme://user:@host/db`, `...;password=`);
    //   - whole-value env-var interpolation and obvious placeholders, for
    //     example `$DB_PASSWORD`, `${DB_PASSWORD}`, `$(DB_PASSWORD)`,
    //     `{{DB_PASSWORD}}`, `{DB_PASSWORD}`, `%DB_PASSWORD%`, `<password>`,
    //     `[password]`, `password`, `changeme`, `YOUR_PASSWORD`,
    //     `YOURPASSWORD`, `REPLACE_ME` and `xxxxx`. These only count when they
    //     fill the whole password value, so a real password that merely starts
    //     with the shape (`$PASSWORDx`, `{S3cr3t`, `<password>x`,
    //     `[password]x`, `%DB_PASSWORD%x`) is reported. In the URL userinfo,
    //     Oracle thin and JDBC property slots the `$` forms additionally
    //     require a placeholder-word variable name (`$DB_PASSWORD` is a
    //     template, `$PASSWORDx` is not), matching the dunder rule; the JDBC
    //     property value ends at whitespace, `;`, `?` or `&`. This `$` name
    //     constraint applies to all three slots, and `${VAR:-fallback}` is
    //     deliberately reported as well: the fallback can contain a real
    //     secret, so only the plain `$VAR`/`${VAR}`/`$(VAR)` forms are exempt.
    //     The URL userinfo/Oracle thin brace form is looser than the JDBC
    //     brace shape: a balanced `{{...}}` or `{` followed by a
    //     letter/underscore and a closing brace is a template, so
    //     `{DB_PASSWORD}`, `{{DB_PASSWORD}}`, `{password123}`, `{ABC123}`,
    //     `{S3cr3t}` and `{S3cr3t;!}` stay exempt while unbalanced forms
    //     (`{S3cr3t`, `{S3cr3t}}`, `{{S3cr3t}`) and `{DB_PASSWORD}x` are
    //     reported;
    //   - masked, ellipsis and printf-style placeholders that fill the whole
    //     password value in the URL userinfo, Oracle thin and JDBC property
    //     branches: `*****`, `...`, `%s`, `%d`, `%i`, `%f` and dunder templates
    //     whose underscore-separated segments include a placeholder word, for
    //     example `__PASSWORD__`, `__DB_PASSWORD__` and `__API_PASSWD__`.
    //     These only count as the exact value, so a real password that merely
    //     starts with one of those shapes (for example `...S3cr3t`, `%d3cr3t`
    //     or `__PASSWORD__x`) is still reported, as is a dunder value without a
    //     placeholder word such as `__S3cr3t__`. The Oracle thin password slot
    //     shares these whole-value shapes with URL userinfo. For JDBC property
    //     values the whole value ends at whitespace, `;`, `?` or `&`, so a
    //     placeholder followed by another property or a closing quote stays
    //     exempt while `*S3cr3t`, `...S3cr3t`, `%s3cr3t` and `%d3cr3t` are
    //     reported. The same JDBC boundary applies to the `$`, `<...>`,
    //     `[...]` and `%NAME%` shapes above. The JDBC property branch
    //     additionally treats whole-value brace-wrapped values as placeholders.
    // A JDBC placeholder word counts when the whole value is that word, so
    // values terminated by `;`, `&`, `?`, a closing quote or other punctuation
    // are still placeholders, while a value continuing after such punctuation
    // (for example `pass!word` or `changeme:abc`) is reported. Brace-escaped
    // SQL Server values are reported unless the whole value is a name-like
    // template such as `{DB_PASSWORD}` or `{password123}` or another brace
    // placeholder shape such as `{...}`, `{*****}`, `{__PASSWORD__}` or
    // `{%s}`/`{%d}`/`{%i}`/`{%f}`; a brace template followed by more content
    // (for example `{password123}x`) is reported, as are `{S3cr3t}`, `{ABC123}`
    // and `{__S3cr3t__}`. Values with `_`/`-` separators are always
    // treated as templates, even when mixed case, so a brace-escaped real
    // password such as `{S3cr3t_2024}` is deliberately not reported: template
    // names and real values are indistinguishable there, and keeping
    // `{DB_PASSWORD}` / `{DB-PASSWORD}` quiet matters more for documentation
    // and env templates.
    // The trade-off is pinned by a test, so tightening the rule also requires
    // updating that test and this comment.
    // The host part is required, so a bare `user:password@` mention without a
    // URL scheme or host is not reported. A raw `/` in a password is not
    // matched because it would be ambiguous with the URL path; valid
    // connection strings percent-encode it (`%2F`), which is still detected.
    // Non-JDBC property text (for example `server=...;password=...` without a
    // `jdbc:<scheme>://` prefix) keeps the original behaviour and is not
    // reported only because it contains a password property.
    pattern: new RegExp(
      String.raw`\b(?:(?:postgres(?:ql)?|mysql|mariadb|mongodb|rediss?|amqps?|mssql|sqlserver|cockroachdb|clickhouse|oracle|neo4j)(?:\+[a-z0-9_]+)?:\/\/[^\s/:@?#]*:(?!(?:${PLACEHOLDER_PASSWORD_SHAPES})(?=@)|(?:${PLACEHOLDER_PASSWORD_WHOLE_SHAPES})(?=@)|(?:${PLACEHOLDER_PASSWORD_WORDS})(?=[@/?#]|$))[^\s@/?#]+@[^\s/?#@]+|jdbc:oracle:thin:[^\s/:@?#]*\/(?!(?:${PLACEHOLDER_PASSWORD_SHAPES})(?=@)|(?:${PLACEHOLDER_PASSWORD_WHOLE_SHAPES})(?=@)|(?:${PLACEHOLDER_PASSWORD_WORDS})(?=[@/?#]|$))[^\s@/?#]+@[^\s/:@?#]+:\d+:\w+|jdbc:[a-z0-9]+:\/\/\S*?[;?&]password=(?!${PLACEHOLDER_JDBC_SHAPES}|(?:%[A-Za-z]|\*+|\.{3,})(?![^\s;?&]*[A-Za-z0-9_-])|${PLACEHOLDER_PASSWORD_DUNDER_SHAPES}(?![^\s;?&]*[A-Za-z0-9_-])|(?:${PLACEHOLDER_PASSWORD_WORDS})(?![^\s;?&]*[A-Za-z0-9_-]))[^\s;?&]+)`,
      'i',
    ),
  },
];

function isBinary(buffer) {
  // NUL bytes are a reliable binary signal; pre-commit also filters with
  // `types: [text]`, this guard keeps direct invocations quiet on binaries.
  return buffer.subarray(0, 8000).includes(0);
}

function scanFile(path) {
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    // pre-commit may hand over a path that was just deleted; there is no
    // content left to scan, so treat it as clean.
    if (error.code === 'ENOENT') {
      return { problems: [] };
    }
    throw error;
  }

  if (isBinary(buffer)) {
    return { problems: [] };
  }

  const problems = [];
  const lines = buffer.toString('utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        problems.push(`${path}:${index + 1}: [${rule.id}] ${rule.description}`);
      }
    }
  }
  return { problems };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('scan-secrets: expected filenames passed by pre-commit');
  process.exit(2);
}

const problems = files.flatMap((path) => scanFile(path).problems);
if (problems.length > 0) {
  console.error(`scan-secrets: found ${problems.length} potential secret(s):`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
