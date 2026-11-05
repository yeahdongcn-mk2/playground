import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SOURCE = join(ROOT, 'src');
const STATIC_IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const failures = [];

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function isEngine(specifier) {
  return specifier === 'phaser' || specifier === 'three' || specifier.startsWith('three/');
}

function report(file, specifier, message) {
  failures.push(`${relative(ROOT, file)}: ${specifier} — ${message}`);
}

const files = walk(SOURCE).filter((file) => file.endsWith('.ts'));

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const path = relative(SOURCE, file).split('\\').join('/');

  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[1];
    if (!specifier) continue;

    if (path.startsWith('core/')) {
      if (isEngine(specifier)) {
        report(file, specifier, 'core/ must stay engine-agnostic');
      }
      if (/(?:^|\/)(?:games|engine)\//.test(specifier)) {
        report(file, specifier, 'core/ must not depend on games or engine adapters');
      }
    }

    if (path.startsWith('app/')) {
      if (isEngine(specifier)) {
        report(file, specifier, 'the shell must not import a game engine');
      }
      if (/(?:^|\/)engine\//.test(specifier)) {
        report(file, specifier, 'the shell must use the game registry, not engine adapters');
      }
      if (/games\/[^/]+\/(?:scene|view)(?:\.ts)?$/.test(specifier)) {
        report(file, specifier, 'the shell must not import a game view or scene directly');
      }
    }

    if (/^games\/[^/]+\/index\.ts$/.test(path)) {
      if (isEngine(specifier)) {
        report(file, specifier, 'game index must not statically import its engine');
      }
      if (specifier === './scene' || specifier === './view') {
        const isTypeOnly = new RegExp(
          `\\bimport\\s+type\\b[\\s\\S]*?from\\s+['"]${specifier.replace('.', '\\.')}['"]`,
        ).test(source);
        if (!isTypeOnly) {
          report(file, specifier, 'game index must lazily import its view/scene inside mount()');
        }
      }
    }
  }

  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[1];
    if (!specifier) continue;
    if (path.startsWith('core/')) {
      if (isEngine(specifier)) {
        report(file, specifier, 'core/ must stay engine-agnostic');
      }
      if (/(?:^|\/)(?:games|engine)\//.test(specifier)) {
        report(file, specifier, 'core/ must not depend on games or engine adapters');
      }
    }
    if (path.startsWith('app/') && isEngine(specifier)) {
      report(file, specifier, 'the shell must not load a game engine directly');
    }
  }
}

if (failures.length > 0) {
  console.error('Module boundary violations:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Module boundaries OK (${files.length} source files).`);
