// Preloaded before the bot test suite (via `node --import`), BEFORE any module
// loads — so module-level singletons (notably the blackboard, which bakes in
// ~/.pa/blackboard.json at import time) point at an isolated temp PA_HOME, not
// the real ~/.pa that the live bot + sibling test files write concurrently.
// Without this, blackboard lock contention / log pollution on the shared real
// ~/.pa makes integration tests (runPollLoop, dispatch, ref-id) flake.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only set a temp PA_HOME if one isn't already provided by the runner.
if (!process.env.PA_HOME) {
  process.env.PA_HOME = mkdtempSync(join(tmpdir(), 'pa-bot-suite-'));
}

// "No real external side-effects" flag: telegramFetch() and the reply-path dedup
// honor this, so tests never hit the network or persist cross-test dedup state.
process.env.PA_NOTIFY_DISABLED = '1';
