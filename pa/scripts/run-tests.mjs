#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  // Detect which suite we're running based on cwd
  const isBot = process.cwd().includes('telegram-bot');
  const distDir = join(repoRoot, isBot ? 'projects/telegram-bot/dist' : 'pa/dist');
  const manifestPath = join(
    repoRoot,
    isBot ? 'projects/telegram-bot/tests/quarantine-manifest.json' : 'pa/tests/quarantine-manifest.json'
  );

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

  const testEnvPath = join(distDir, 'tests/test-env-setup.js');
  const testArgs = [
    '--test',
    ...testFiles,
  ];

  // Add test-env-setup preload if it exists (use --import with file:// URL for Windows compatibility)
  if (testFiles.length > 0) {
    testArgs.unshift('--import', pathToFileURL(testEnvPath).href);
  }

  const child = spawn(process.execPath, testArgs, {
    stdio: 'inherit',
    cwd: distDir,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}

main();
