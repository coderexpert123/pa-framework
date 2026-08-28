#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
// V17: this script lives at <repo>/projects/telegram-bot/scripts/, THREE
// levels below the repo root, not two — the pre-existing '../..' resolved to
// <repo>/projects, which never contains pa/dist, so the lock loader below
// would have silently no-opped forever. This repoRoot was previously unused
// (every consumer used botRoot); it is now load-bearing for the loader.
const repoRoot = join(__dirname, '../../..');

// Loader for the compiled @build lock helper. Duplicated verbatim across the
// four .mjs entry points (two run-tests.mjs, two build.mjs) — they are
// separate entry points in two packages with no shared module. Only this
// six-line resolver is duplicated; the acquire/release POLICY lives in
// exactly one place: pa/src/lib/build-lock.ts, compiled to
// pa/dist/src/lib/build-lock.js. createRequire is required (not import()) —
// that module is CommonJS (pa/ has no "type":"module").
const requireCjs = createRequire(import.meta.url);
function loadBuildLock(repoRoot) {
  const p = join(repoRoot, 'pa/dist/src/lib/build-lock.js');
  if (!existsSync(p)) return null;
  try { return requireCjs(p); } catch { return null; }
}
async function withBuildLockOrRun(repoRoot, pkg, fn) {
  const bl = loadBuildLock(repoRoot);
  if (!bl) return await fn();
  return await bl.withBuildLock(bl.buildLockLabel(pkg), fn);
}

// A `<name>` positional filter matches a dist test file's basename if it
// equals `<name>`, `<name>.test.js`, or `<name>` with a trailing `.test.ts`
// rewritten to `.test.js`.
function matchesFilterName(filePath, name) {
  const base = basename(filePath);
  if (base === name) return true;
  if (base === `${name}.test.js`) return true;
  if (base === name.replace(/\.test\.ts$/, '.test.js')) return true;
  return false;
}

function matchesAnyFilterName(filePath, names) {
  return names.some((name) => matchesFilterName(filePath, name));
}

// D17: redirect the SPAWNED CHILD's TMP/TEMP only — never the parent process
// env, never creates a directory, never fails when neither candidate exists
// (a no-op on CI, which has neither PA_TEST_TMP_DIR nor C:/wt/tmp).
function computeTmpOverride() {
  const candidate = process.env.PA_TEST_TMP_DIR;
  if (candidate && existsSync(candidate)) {
    return { TMP: candidate, TEMP: candidate };
  }
  const fallback = 'C:/wt/tmp';
  if (existsSync(fallback)) {
    return { TMP: fallback, TEMP: fallback };
  }
  return {};
}

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

async function main() {
  const args = process.argv.slice(2);
  const quarantinedOnly = args.includes('--quarantined');
  const filterNames = args.filter((a) => a !== '--quarantined');

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

  let testsToRun;
  if (quarantinedOnly) {
    // Run ONLY quarantined tests (non-blocking for investigation)
    testsToRun = allTests.filter((t) => quarantinedFiles.has(t));
    if (testsToRun.length === 0) {
      console.log('No quarantined tests to run');
      process.exit(0);
    }
    console.log(`Running ${testsToRun.length} quarantined test(s)...`);
  } else {
    // Exclude quarantined tests from main suite
    testsToRun = allTests.filter((t) => !quarantinedFiles.has(t));
    if (manifest.length > 0) {
      console.log(
        `Excluding ${manifest.length} quarantined test(s): ${manifest.map((e) => e.file).join(', ')}`
      );
    }
  }

  // D18: the positional filter applies ON TOP OF the quarantine partition
  // above (a quarantined file is never run by name).
  if (filterNames.length > 0) {
    const filtered = testsToRun.filter((t) => matchesAnyFilterName(t, filterNames));
    if (filtered.length === 0) {
      const quarantinedHits = filterNames.filter((name) =>
        [...quarantinedFiles].some((qf) => matchesFilterName(qf, name))
      );
      const suffix = quarantinedHits.length > 0 ? ` (quarantined: ${quarantinedHits.join(', ')})` : '';
      console.log(`No test files matched: ${filterNames.join(', ')}${suffix}`);
      process.exit(1);
    }
    testsToRun = filtered;
  }

  // Empty check stays OUTSIDE the @build lock: a run with nothing to do must
  // not acquire the reservation at all.
  if (testsToRun.length === 0) {
    console.log('No tests to run');
    process.exit(0);
  }

  const code = await withBuildLockOrRun(repoRoot, 'bot', () => spawnTests(testsToRun, distDir));
  process.exit(code);
}

function spawnTests(testFiles, distDir) {
  return new Promise((resolve) => {
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

    // Dark-file detector (2026-08-28, deep-recheck): on Node 22.14 a test file
    // can pass as a single file-shell subtest with ZERO suites/tests registered
    // (node:test auto-run/handshake bug — poll-loop.test.js sat dark through
    // every local gate while suites reported green). The child's TAP stream
    // lists each file as `# Subtest: <file>`; a file whose `ok` line arrives
    // with no nested subtests in between contributed nothing. Capture the
    // stream and fail the run if any non-allowlisted file is dark, so a silent
    // skip can never again read as a pass.
    let tapBuffer = '';
    const child = spawn(process.execPath, testArgs, {
      stdio: ['inherit', 'pipe', 'inherit'],
      cwd: botRoot,
      env: { ...process.env, ...computeTmpOverride() },
    });
    child.stdout.on('data', (chunk) => { tapBuffer += chunk.toString(); });
    child.stdout.pipe(process.stdout);

    child.on('exit', (code) => {
      const dark = findDarkFiles(tapBuffer, testFiles.map((f) => relative(botRoot, f)));
      if (dark.length > 0) {
        console.error(`\nDARK FILE FAILURE: ${dark.join(', ')} — ran as a file-shell with zero tests (Node 22.14 test-runner bug class). Suite result is NOT trustworthy; see scripts/run-tests.mjs.`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/** Files allowlisted to contribute zero tests (legitimately-empty placeholders). */
const DARK_FILE_ALLOWLIST = new Set([
  // KNOWN-DARK (2026-08-28 deep-recheck): under the installed Node 22.14 test
  // runner, every integration-class bot test file passes as an empty shell with
  // ZERO suites registered (node:test runner bug; pure-sync describes register
  // fine). Splitting cannot fix it (each dark describe is dark SOLO); the fix
  // is the Node 22.14 → 22.23 upgrade (OPERATOR ACTION, alongside the GitHub
  // billing fix) — after upgrading, REMOVE these entries; all five files'
  // tests must then run. The bot's entire poll-loop/integration layer has been
  // silently skipped by every local gate on this machine. Do not add new files.
  'dist/tests/poll-loop.test.js',
  'dist/tests/integration.test.js',
  'dist/tests/poll-loop-integration-extra.test.js',
  'dist/tests/poll-loop-maintenance.test.js',
  'dist/tests/voice-poll-loop.test.js',
]);

/**
 * Parse a node:test TAP stream and return the relative paths of files that
 * appear as a `# Subtest: <path>` entry whose following ok/not-ok line arrived
 * with no nested `# Subtest:` between them — i.e. the file registered nothing.
 */
function findDarkFiles(tap, relFiles) {
  // TAP escapes backslashes (dist\\tests\\x.test.js on Windows) — collapse any
  // backslash run to a single slash before comparing.
  const norm = (p) => p.trim().replace(/\\+/g, '/');
  const lines = tap.split(/\r?\n/);
  const normalized = relFiles.map(norm);
  const dark = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^# Subtest: (.+)$/);
    if (!m) continue;
    const name = norm(m[1]);
    if (!normalized.includes(name)) continue; // describes are Subtests too — only match files
    let darkFile = true;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('# Subtest:')) { darkFile = false; break; }
      if (/^(not )?ok /.test(lines[j])) break;
    }
    if (darkFile && !DARK_FILE_ALLOWLIST.has(name)) dark.push(name);
  }
  return dark;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
