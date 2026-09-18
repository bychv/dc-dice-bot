/**
 * Test runner — runs every `tests/**\/*.test.ts` in one Node process.
 *
 * The sandbox forbids piped child processes (esbuild/vitest/tsx all spawn one), so tests use
 * `node:test` in-process with Node's native TypeScript support:
 *
 *   node scripts/run-tests.ts            # everything
 *   node tests/dice/engine.test.ts       # a single file
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testsDir = fileURLToPath(new URL('../tests', import.meta.url));

function collect(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, acc);
    } else if (entry.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const files = collect(testsDir).sort();

if (files.length === 0) {
  console.error('no test files found under tests/');
  process.exit(1);
}

console.log(`running ${files.length} test file(s):`);
for (const f of files) console.log('  ' + f.slice(testsDir.length + 1));

let importFailures = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    importFailures++;
    console.error(`\nFAILED TO LOAD ${file}\n`, err);
  }
}

if (importFailures > 0) {
  console.error(`\n${importFailures} test file(s) failed to load`);
  process.exitCode = 1;
}
