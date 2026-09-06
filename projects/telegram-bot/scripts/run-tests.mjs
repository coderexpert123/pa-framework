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

// Deployment-env scrub (AI-199, 2026-09-03): `pa run` hands every secrets.env
// value to LLM workers, so a suite run from inside a worker shell (the push
// skill's gate) inherits deployment config as process.env — and runtime code
// reads some of it (PA_RICH_MESSAGES=1 rerouted worker replies over
// /sendRichMessage; 12 subtests failed on every gate run, never locally, never
// on CI). The policy (variable list + rationale) lives in exactly one place:
// pa/src/lib/test-env-scrub.ts, compiled to pa/dist/src/lib/test-env-scrub.js.
// A missing compiled module (pre-build bootstrap) runs unscrubbed — the same
// fallback policy as the lock loader above.
function loadTestEnvScrub(repoRoot) {
  const p = join(repoRoot, 'pa/dist/src/lib/test-env-scrub.js');
  if (!existsSync(p)) return null;
  try { return requireCjs(p); } catch { return null; }
}

function scrubDeploymentEnv(repoRoot, env) {
  const scrub = loadTestEnvScrub(repoRoot);
  if (!scrub) return env;
  return scrub.stripDeploymentEnv(env);
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
// env. PA_TEST_TMP_DIR wins when it is set and exists; otherwise the
// deployment's conventional fast-drive scratch directory is used when it
// exists; with neither present there is no override (a no-op on CI). Never
// creates a directory, never fails when neither candidate exists.
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
      process.exitCode = 0;
      return;
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
      process.exitCode = 1;
      return;
    }
    testsToRun = filtered;
  }

  // Empty check stays OUTSIDE the @build lock: a run with nothing to do must
  // not acquire the reservation at all.
  if (testsToRun.length === 0) {
    console.log('No tests to run');
    process.exitCode = 0;
    return;
  }

  // AI-180: refuse to run tests against a dist that does not belong to this
  // checkout (missing stamp, sha drift, or src newer than the last build).
  // EVERY run checks — scoped runs included: PA_BUILD_LOCK=0 bypasses the
  // lock, never the guard. The policy (incl. the PA_ALLOW_STALE_DIST=1
  // warn-and-continue escape hatch) lives in pa's assertDistFresh (this
  // runner passes pkg:'bot' so the BOT's stamp/src roots are checked); a
  // missing compiled module/function (fresh clone, pre-build bootstrap)
  // skips it.
  const blGuard = loadBuildLock(repoRoot);
  if (blGuard && typeof blGuard.assertDistFresh === 'function') {
    try {
      await blGuard.assertDistFresh({ pkg: 'bot', repoRoot });
    } catch (e) {
      console.error(`Refusing to run tests against this dist (AI-180): ${e?.message ?? e}`);
      process.exitCode = 1;
      return;
    }
  }

  const code = await withBuildLockOrRun(repoRoot, 'bot', () => spawnTests(testsToRun, distDir));
  // exitCode + natural exit, NOT process.exit(): a forced exit truncates this
  // process's own still-pending stdout writes — the child's relayed TAP (and
  // with a fast small file, effectively ALL of it) never reaches the caller.
  // Natural exit flushes pending writes before the process goes away.
  process.exitCode = code;
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
      env: scrubDeploymentEnv(repoRoot, { ...process.env, ...computeTmpOverride() }),
    });
    child.stdout.on('data', (chunk) => { tapBuffer += chunk.toString(); });
    child.stdout.pipe(process.stdout);

    // 'close', not 'exit': 'exit' can fire BEFORE the piped stdout has flushed,
    // so an immediate process.exit() truncated both the TAP relayed to our own
    // stdout and (for a fast, small file) the tail of tapBuffer the dark-file
    // detector judges — surfaced by the AI-180 guard test's tiny smoke file.
    // 'close' fires only after the child's stdio streams have fully ended.
    child.on('close', (code) => {
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
  // HISTORICAL (2026-08-28 deep-recheck; re-verified 2026-08-31; ROOT-CAUSED
  // AND FIXED 2026-09-01): these five files used to register zero suites
  // under `node --test`, misdiagnosed at the time as a node:test runner bug
  // (registrations "always happened", process just never reported them). The
  // real cause: `runPollLoop()` (main.ts) unconditionally called the real
  // `process.exit(0)` at the natural end of its poll loop. `node --test`
  // isolates each test file into its own subprocess, and every test in these
  // five files that `await`s runPollLoop() to completion drove that exit,
  // killing the file's subprocess before node:test's own TAP output for it
  // reached the parent — reading back as an empty shell with zero suites.
  // `poll-loop-callbacks.test.ts` (never dark) carried the tell: lines 5-29
  // document this exact landmine and deliberately avoid awaiting runPollLoop
  // to completion to dodge it. Fix: an injectable `exitFn` + `_setExitForTest`
  // test hook (main.ts) — production behavior unchanged, tests inject a
  // no-op. All five files now register real suites and pass (bit-rot findings
  // from reviving them: the revived-bot-tests bit-rot findings record (2026-09-01, internal),
  // ~30 individually-skipped, dated, evidence-specific TODOs across the five
  // files). This allowlist now stays EMPTY — do not add new files without the
  // same root-cause rigor.
]);

/**
 * Parse a node:test TAP stream and return the relative paths of files that
 * appear as a `# Subtest: <path>` entry whose following ok/not-ok line arrived
 * with no nested `# Subtest:` between them — i.e. the file registered nothing.
 * ALSO: a child that ran NOTHING emits no TAP at all — no header, no file
 * shells (healthy files get NO file shell either, so shell absence alone is
 * not evidence) — yet still exits 0: the nested `node:test run()`
 * recursion-guard skip when test-runner env (NODE_TEST_CONTEXT) leaks into a
 * spawned runner, or a crash before any output. If no expected file appeared
 * AND the stream has no TAP header, every file is dark.
 */
function findDarkFiles(tap, relFiles) {
  // TAP escapes backslashes (dist\\tests\\x.test.js on Windows) — collapse any
  // backslash run to a single slash before comparing.
  const norm = (p) => p.trim().replace(/\\+/g, '/');
  const lines = tap.split(/\r?\n/);
  const normalized = relFiles.map(norm);
  const seenAnyExpectedFile = lines.some((l) => {
    const m = l.match(/^# Subtest: (.+)$/);
    return m ? normalized.includes(norm(m[1])) : false;
  });
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
  if (dark.length === 0 && !seenAnyExpectedFile && !/^TAP version /m.test(tap)) {
    return normalized.filter((name) => !DARK_FILE_ALLOWLIST.has(name));
  }
  return dark;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
