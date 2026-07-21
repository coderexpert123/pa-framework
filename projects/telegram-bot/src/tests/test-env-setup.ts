// Preloaded before the bot test suite (via `node --import`), BEFORE any module
// loads — so module-level singletons (notably the blackboard, which bakes in
// ~/.pa/blackboard.json at import time) point at an isolated temp PA_HOME, not
// the real ~/.pa that the live bot + sibling test files write concurrently.
// Without this, blackboard lock contention / log pollution on the shared real
// ~/.pa makes integration tests (runPollLoop, dispatch, ref-id) flake.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'node:test';

// Only set a temp PA_HOME if one isn't already provided by the runner.
const suiteHome = process.env.PA_HOME || mkdtempSync(join(tmpdir(), 'pa-bot-suite-'));
process.env.PA_HOME = suiteHome;

// DO NOT REGRESS: explicit, test-only signal consumed by pa/src/lib/log.ts.
// Individual bot test files set and then CLEAR their own temp PA_HOME; in the
// window after a clear, paHome() falls back to the real ~/.pa and any late
// fire-and-forget log line lands in the production forensic log. With this set,
// the logger redirects a real-~/.pa destination here instead. It is never set
// outside a test preload, so the logger's guard cannot fire in production.
process.env.PA_TEST_LOG_HOME = suiteHome;

// "No real external side-effects" flag: telegramFetch() and the reply-path dedup
// honor this, so tests never hit the network or persist cross-test dedup state.
process.env.PA_NOTIFY_DISABLED = '1';

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
