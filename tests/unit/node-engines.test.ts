import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Node floor comes from the highest `engines.node` in the dependency tree
 * (currently jsdom 30). Keep the manifests and every document that repeats the
 * floor in lockstep, and compare the declared branches with the locked jsdom
 * range so a future jsdom upgrade cannot silently invalidate the declaration.
 *
 * These cases only read repository files, never `node_modules`, so they keep
 * working on a fresh checkout before `npm ci`.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const PACKAGE_JSON_PATH = 'package.json';
const PACKAGE_LOCK_PATH = 'package-lock.json';
const README_PATH = 'README.md';
const FRAMEWORK_PATH = 'docs/framework.md';
const TECH_STACK_PATH = 'docs/tech-stack-decision.md';

interface NodeEngines {
  engines?: { node?: string };
}

interface LockPackage extends NodeEngines {
  version?: string;
}

const PACKAGE_JSON = JSON.parse(read(PACKAGE_JSON_PATH)) as NodeEngines;
const PACKAGE_LOCK = JSON.parse(read(PACKAGE_LOCK_PATH)) as {
  packages?: Record<string, LockPackage | undefined>;
};
const README = read(README_PATH);
const FRAMEWORK = read(FRAMEWORK_PATH);
const TECH_STACK = read(TECH_STACK_PATH);

interface NodeFloor {
  major: number;
  minor: number;
  patch: number;
}

function packageEngine(): string {
  const node = PACKAGE_JSON.engines?.node;
  if (node === undefined) {
    throw new Error(`${PACKAGE_JSON_PATH} is missing engines.node`);
  }
  return node;
}

function lockRootEngine(): string {
  const node = PACKAGE_LOCK.packages?.['']?.engines?.node;
  if (node === undefined) {
    throw new Error(`${PACKAGE_LOCK_PATH} is missing the root package's engines.node`);
  }
  return node;
}

function lockedEngine(packageName: string): string {
  const node = PACKAGE_LOCK.packages?.[`node_modules/${packageName}`]?.engines?.node;
  if (node === undefined) {
    throw new Error(`${PACKAGE_LOCK_PATH} is missing node_modules/${packageName}'s engines.node`);
  }
  return node;
}

/** The only line of `source` that contains every marker. */
function lineWithAll(source: string, markers: readonly string[], file: string): string {
  const matches = source
    .split(/\r?\n/)
    .filter((line) => markers.every((marker) => line.includes(marker)));
  expect(matches, `${file} should have exactly one line containing ${markers.join(' and ')}`).toHaveLength(
    1,
  );
  const [line] = matches;
  if (line === undefined) {
    throw new Error(`${file} is missing the line containing ${markers.join(' and ')}`);
  }
  return line;
}

/** The version inside the first backticked span of a document line. */
function backtickedVersion(line: string, file: string): string {
  const match = /`([^`]+)`/.exec(line);
  const version = match?.[1];
  if (version === undefined) {
    throw new Error(`${file} line has no backticked version: ${line}`);
  }
  return version;
}

/** Markdown table cells escape `|` as `\|`; compare the readable range. */
function unescapeMarkdownPipes(version: string): string {
  return version.replace(/\\\|/g, '|');
}

function parseFloors(range: string): NodeFloor[] {
  return range.split('||').map((part) => {
    const clause = part.trim();
    const match = /^(?:\^|>=)\s*(\d+)\.(\d+)\.(\d+)$/.exec(clause);
    const major = match?.[1];
    const minor = match?.[2];
    const patch = match?.[3];
    if (major === undefined || minor === undefined || patch === undefined) {
      throw new Error(`cannot parse Node range branch: ${clause}`);
    }
    return { major: Number(major), minor: Number(minor), patch: Number(patch) };
  });
}

function compareFloor(left: NodeFloor, right: NodeFloor): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

describe('Node engines contract', () => {
  it('keeps package.json and the package-lock.json root package in sync', () => {
    expect(lockRootEngine()).toBe(packageEngine());
  });

  it('documents the same Node floor in README.md', () => {
    const line = lineWithAll(README, ['要求 Node.js'], README_PATH);
    expect(backtickedVersion(line, README_PATH)).toBe(packageEngine());
  });

  it('documents the same Node floor in docs/framework.md', () => {
    const line = lineWithAll(FRAMEWORK, ['Node.js `'], FRAMEWORK_PATH);
    expect(backtickedVersion(line, FRAMEWORK_PATH)).toBe(packageEngine());
  });

  it('documents the same Node floor in the docs/tech-stack-decision.md runtime row', () => {
    const line = lineWithAll(TECH_STACK, ['Node 运行时'], TECH_STACK_PATH);
    const version = unescapeMarkdownPipes(backtickedVersion(line, TECH_STACK_PATH));
    expect(version).toBe(packageEngine());
  });

  it('keeps the documented Vitest engines row separate from the Node floor', () => {
    const line = lineWithAll(TECH_STACK, ['Vitest', '（Node `'], TECH_STACK_PATH);
    expect(backtickedVersion(line, TECH_STACK_PATH)).toBe(lockedEngine('vitest'));
  });

  it('declares a Node floor at least as high as the locked jsdom floor per branch', () => {
    const project = parseFloors(packageEngine());
    const jsdom = parseFloors(lockedEngine('jsdom'));

    for (const floor of jsdom) {
      const matching = project.find((candidate) => candidate.major === floor.major);
      expect(
        matching,
        `engines.node should keep a Node ${floor.major} branch to cover jsdom`,
      ).toBeDefined();
      if (matching === undefined) continue;
      expect(
        compareFloor(matching, floor),
        `project Node ${floor.major} floor ${matching.minor}.${matching.patch} is below jsdom floor ${floor.minor}.${floor.patch}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
