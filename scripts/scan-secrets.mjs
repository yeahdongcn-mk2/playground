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
