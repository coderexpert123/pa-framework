// Self-guard for test files that produce REAL side effects when PA_HOME leaks
// (worker-exec's exit alert, telegram sends). tests/test-env-setup.ts already
// does this for the whole bot suite, but ONLY via the `--import` preload — and
// the scoped runs this repo's own guidance recommends (`node --test
// dist/tests/x.test.js`) bypass it. On 2026-08-17 that leak sent 3 real
// Telegram alerts to pa-alerts and wrote 64 synthetic rows into the production
// forensic log (plans/2026-08-23-alerts-week-review.md §5.3).
// Import this FIRST, before any pa or bot module, in every test file that can
// notify.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.PA_TEST_LOG_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'pa-test-guard-'));
  process.env.PA_TEST_LOG_HOME = home;
  process.env.PA_HOME = home;
}
process.env.PA_NOTIFY_DISABLED = process.env.PA_NOTIFY_DISABLED ?? '1';

export {};
