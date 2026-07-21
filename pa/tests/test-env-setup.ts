// Sets global environment flags before any test file loads.
// Prevents real external side-effects (Telegram sends, etc.) during test runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PA_NOTIFY_DISABLED = '1';

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
const suiteHome = mkdtempSync(join(tmpdir(), 'pa-suite-'));

// Explicit, test-only signal consumed by pa/src/lib/log.ts: if a resolved log
// path still points at the real ~/.pa (a test cleared or overrode PA_HOME),
// the logger redirects here instead of polluting production. Never set outside
// a test preload — the logger's guard must not fire in production.
process.env.PA_TEST_LOG_HOME = suiteHome;

if (!process.env.PA_HOME) {
  process.env.PA_HOME = suiteHome;
}

// Each test file runs in its own process, so each gets (and removes) its own
// suite home. Best-effort: never let teardown fail a run.
process.on('exit', () => {
  try {
    rmSync(suiteHome, { recursive: true, force: true });
  } catch {
    // Leftover temp dir is harmless; the OS reclaims it.
  }
});
