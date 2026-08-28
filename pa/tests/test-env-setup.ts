// Sets global environment flags before any test file loads.
// Prevents real external side-effects (Telegram sends, etc.) during test runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D13 amendment (2026-08-23, WP-D): capture the real global fetch BEFORE any
// test file's top-level code runs, so pa/src/lib/telegram-proxy.ts's
// PA_NOTIFY_DISABLED kill switch can tell "the real fetch" apart from a test
// double a test later installs on globalThis.fetch. Must be the first
// statement in this preload — a test file that mocks globalThis.fetch at
// import time still runs after this preload's module body finishes.
(globalThis as unknown as { __PA_REAL_FETCH__?: typeof fetch }).__PA_REAL_FETCH__ = globalThis.fetch;

process.env.PA_NOTIFY_DISABLED = '1';
// The pa CLI tees an agy worker's output by exporting AGY_TEE_OUT to the worker
// process (worker-exec.ts keys the tee path off it when present). When a test run is
// HOSTED INSIDE such a worker — the push skill's gate runs via an agy dispatch — the
// variable leaks into every spawned test and worker-exec returns the inherited path
// instead of a per-contextId one, failing worker-exec-tee-path-result.test.ts with
// 'teePath should be keyed by contextId' (false red at the push gate, 2026-08-24).
// Scrub it before any module loads, like PA_HOME above.
delete process.env.AGY_TEE_OUT;


// Machine-wide worker admission control (AI-096) shares its slot pool across
// the concurrently-running test-file processes (the blackboard path is baked
// at import, before per-test PA_HOME overrides apply). Under the production
// default of 3 slots, parallel test files' real executeWorker spawns contend
// and spuriously time out ("All worker slots busy") on loaded machines —
// observed 5+ times across 2026-07-10 alone. Raise the cap for tests;
// worker-slots.test.ts exercises admission control itself and sets/deletes
// this explicitly per test, so it is unaffected by this default.
process.env.PA_MAX_CONCURRENT_WORKERS = process.env.PA_MAX_CONCURRENT_WORKERS || '64';

// DO NOT REGRESS: the suite must never be able to reach the real ~/.pa.
//
// Before 2026-07-21 the pa suite ran with PA_HOME unset unless an individual
// test set it, so every log line emitted outside a temp-PA_HOME window landed
// in the production forensic log (~/.pa/app.log.jsonl) — fake worker failures,
// fake exhaustion alerts, fake telegram sends with resolvable refIds. Three
// separate windows produce that: (a) files that never set PA_HOME at all,
// (b) the gap between helpers.cleanup()'s reset and the next beforeEach, and
// (c) fire-and-forget async work that outlives its test (worker-exec's exit
// alert, the bg-task orphan sweep, a killed worker's late 'close' event).
// Pinning the destination at enqueue time (pa/src/lib/log.ts) fixes none of
// those, because at enqueue time PA_HOME genuinely is unset.
//
// So: give the WHOLE RUN a temp PA_HOME here, in the preload, before any
// module loads (module-level singletons — notably the blackboard — bake their
// path at import time). A test that forgets to set one still cannot reach
// production. Tests that set their own PA_HOME are unaffected; helpers.ts
// cleanup() resets to this suite default instead of deleting the variable.
//
// pa/tests/test-env-guard-gate.test.ts (2026-08-23) now enforces, mechanically,
// that every test file which can bypass this preload (a direct scoped run)
// imports pa/tests/test-env-guard.ts first — see that file's own header.
const suiteHome = mkdtempSync(join(tmpdir(), 'pa-suite-'));

// Explicit, test-only signal consumed by pa/src/lib/log.ts: if a resolved log
// path still points at the real ~/.pa (a test cleared or overrode PA_HOME),
// the logger redirects here instead of polluting production. Never set outside
// a test preload — the logger's guard must not fire in production.
process.env.PA_TEST_LOG_HOME = suiteHome;

// Unconditional (2026-08-05, no `if (!process.env.PA_HOME)` guard) — code-fixer.ts's
// attemptCodeFix() and self-improver.ts's rollback() take a REAL blackboard lock
// (skill-exclusive:git-workflow) during their own tests. If PA_HOME were ever
// externally set (it isn't today — checked the shell, secrets.env, and CI workflows —
// but `run.ts` spawns cmd-based skills with `{...process.env, ...secrets}`, so it
// propagates if it's ever set anywhere upstream), a conditional guard here would let
// a test process contend for the PRODUCTION lock under a different PID than whatever
// legitimately holds it, hanging for the full GIT_LOCK_WAIT_MS wait. Always override.
process.env.PA_HOME = suiteHome;

// Each test file runs in its own process, so each gets (and removes) its own
// suite home. Best-effort: never let teardown fail a run.
process.on('exit', () => {
  try {
    rmSync(suiteHome, { recursive: true, force: true });
  } catch {
    // Leftover temp dir is harmless; the OS reclaims it.
  }
});
