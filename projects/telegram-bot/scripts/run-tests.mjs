#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

// .mjs files cannot carry TypeScript syntax — the original draft's `interface`
// declaration broke `npm test` at parse time (caught by the push gate, 2026-08-18).
function loadManifest(manifestPath) {
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function listTestFiles(distDir) {
  const testDir = join(distDir, 'tests');
  const entries = readdirSync(testDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
    .map((e) => join(testDir, e.name))
    .sort();
}

function main() {
  const args = process.argv.slice(2);
  const quarantinedOnly = args.includes('--quarantined');

  // Bot wrapper lives at <bot>/scripts/ — the BOT root is one level up
  // (repoRoot/'dist' pointed at projects/dist: ENOENT, fixed 2026-08-18).
  const botRoot = join(__dirname, '..');
  const distDir = join(botRoot, 'dist');
  const manifestPath = join(botRoot, 'tests/quarantine-manifest.json');

  const allTests = listTestFiles(distDir);
  const manifest = loadManifest(manifestPath);
  const quarantinedFiles = new Set(
    manifest.map((e) => {
      const basename = e.file.replace(/\.test\.ts$/, '.test.js');
      return join(distDir, 'tests', basename);
    })
  );

  if (quarantinedOnly) {
    // Run ONLY quarantined tests (non-blocking for investigation)
    const testsToRun = allTests.filter((t) => quarantinedFiles.has(t));
    if (testsToRun.length === 0) {
      console.log('No quarantined tests to run');
      process.exit(0);
    }
    console.log(`Running ${testsToRun.length} quarantined test(s)...`);
    runTests(testsToRun, distDir);
  } else {
    // Exclude quarantined tests from main suite
    const testsToRun = allTests.filter((t) => !quarantinedFiles.has(t));
    if (manifest.length > 0) {
      console.log(
        `Excluding ${manifest.length} quarantined test(s): ${manifest.map((e) => e.file).join(', ')}`
      );
    }
    runTests(testsToRun, distDir);
  }
}

function runTests(testFiles, distDir) {
  if (testFiles.length === 0) {
    console.log('No tests to run');
    process.exit(0);
  }

  // Windows: node's --import/--require reject bare absolute paths (ERR_UNSUPPORTED_ESM_URL_SCHEME
  // on 'd:' protocol). Run from the BOT ROOT with RELATIVE paths instead — the same
  // shape the package.json test script used before the wrapper existed.
  const botRoot = join(__dirname, '..');
  const relFiles = testFiles.map((f) => relative(botRoot, f));
  const testEnvRel = relative(botRoot, join(distDir, 'tests/test-env-setup.js'));
  const testArgs = [
    '--import',
    `./${testEnvRel.split('\\').join('/')}`,
    '--test',
    ...relFiles.map((f) => `./${f.split('\\').join('/')}`),
  ];

  const child = spawn(process.execPath, testArgs, {
    stdio: 'inherit',
    cwd: botRoot,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}

main();
