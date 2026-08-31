// Preloaded before the bot test suite (via `node --import`), BEFORE any module
// loads — so module-level singletons (notably the blackboard, which bakes in
// ~/.pa/blackboard.json at import time) point at an isolated temp PA_HOME, not
// the real ~/.pa that the live bot + sibling test files write concurrently.
// Without this, blackboard lock contention / log pollution on the shared real
// ~/.pa makes integration tests (runPollLoop, dispatch, ref-id) flake.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'node:test';

// D13 amendment (2026-08-23, WP-D): capture the real global fetch BEFORE any
// test file's top-level code runs, so pa/src/lib/telegram-proxy.ts's
// PA_NOTIFY_DISABLED kill switch can tell "the real fetch" apart from a test
// double a test later installs on globalThis.fetch. Must be the first
// statement in this preload.
(globalThis as unknown as { __PA_REAL_FETCH__?: typeof fetch }).__PA_REAL_FETCH__ = globalThis.fetch;

// Unconditional (2026-08-23, D14): no `PA_TEST_ALLOW_HOME_OVERRIDE` escape
// hatch — nothing in the calling path sets PA_HOME, so a conditional
// `process.env.PA_HOME || ...` here was pure dead-code cover, not a real
// override path. pa's own tests/test-env-setup.ts abandoned the conditional
// form deliberately on 2026-08-05 with the same rationale; the bot was the
// regression. Mirrors that file's shape exactly, including exit cleanup.
const suiteHome = mkdtempSync(join(tmpdir(), 'pa-bot-suite-'));
process.env.PA_HOME = suiteHome;

// DO NOT REGRESS: explicit, test-only signal consumed by pa/src/lib/log.ts.
// Individual bot test files set and then CLEAR their own temp PA_HOME; in the
// window after a clear, paHome() falls back to the real ~/.pa and any late
// fire-and-forget log line lands in the production forensic log. With this set,
// the logger redirects a real-~/.pa destination here instead. It is never set
// outside a test preload, so the logger's guard cannot fire in production.
process.env.PA_TEST_LOG_HOME = suiteHome;

// "No real external side-effects" flag: telegramFetch() returns a synthetic
// 200 {ok:true} Response under this flag and never touches the network
// (pa/src/lib/telegram-proxy.ts), and the reply-path dedup honours it too.
process.env.PA_NOTIFY_DISABLED = '1';
// The pa CLI tees an agy worker's output by exporting AGY_TEE_OUT to the worker
// process (worker-exec.ts keys the tee path off it when present). When a test run is
// HOSTED INSIDE such a worker — the push skill's gate runs via an agy dispatch — the
// variable leaks into every spawned test and worker-exec returns the inherited path
// instead of a per-contextId one, failing worker-exec-tee-path-result.test.ts with
// 'teePath should be keyed by contextId' (false red at the push gate, 2026-08-24).
// Scrub it before any module loads, like PA_HOME above.
delete process.env.AGY_TEE_OUT;


// Each test file runs in its own process, so each gets (and removes) its own
// suite home. Best-effort: never let teardown fail a run.
process.on('exit', () => {
  try {
    rmSync(suiteHome, { recursive: true, force: true });
  } catch {
    // Leftover temp dir is harmless; the OS reclaims it.
  }
});

// Best-effort drain of the structured logger's fire-and-forget append queue
// after each test, so a late append can't race a temp PA_HOME's removal.
//
// What this hook does NOT do — the ordering claim written here on 2026-07-21
// was wrong and is corrected: node:test runs afterEach hooks innermost-first,
// so a describe-scoped afterEach ALWAYS runs before this root-suite hook (26 of
// the bot suite's 42 afterEach registrations are describe-scoped; verified
// empirically). Only same-scope hooks run in registration order, which is the
// single case where "the preload goes first" holds. So this hook cannot be
// relied on to drain before a per-file teardown removes its PA_HOME.
//
// Keeping test records out of the real ~/.pa/app.log.jsonl is therefore NOT
// this hook's job: that is enqueue-time destination pinning plus the
// PA_TEST_LOG_HOME backstop above (both in pa/src/lib/log.ts).
// The import is dynamic so no pa module loads before PA_HOME is set above.
try {
  afterEach(async () => {
    try {
      const { flushLog } = await import('../../../../pa/dist/src/lib/log.js');
      await flushLog();
    } catch {
      // Logger unavailable (pa not built yet) — teardown must never fail a test.
    }
  });
} catch {
  // Root-hook registration from a preload is best-effort; tests still run.
}
