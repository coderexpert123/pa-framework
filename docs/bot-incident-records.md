# Bot incident records (extracted from the scoped brain 2026-09-03, budget-pressure doctrine)

Active pointer: the scoped brain links here per incident class. RESOLVED incident records — verdicts, proof, do-not-regress warnings. Read before re-litigating or fixing covered behavior.

- **Harvest window vs task stale demotion — NO interaction (verified 2026-09-03,
  WP-D3 follow-up; hazard disproved, do not "fix"):** `cleanupOrphanedWorkers`
  (`pa/src/worker-pids.ts`) only acts on entries whose SPAWNER pid is dead — a live
  bot's dispatch is never "an in-flight orphan" at any age, so `harvestUntil`
  (stamped from `ORPHAN_HARVEST_WINDOW_MS`, worker-exec.ts) gates nothing while the
  bot lives. The startup reaper (`orphan-reaper.ts`) reads ONLY the pending-dispatch
  store, written only by the human lane (`main.ts` `addPendingDispatch` ×2) — task
  dispatches never enter it, so a re-claimed task can never be orphan-reaped. The
  REAL overlap is elsewhere: `demoteStaleRunningTasks`/`claimNextTask` demote a
  `running` record at 30 min while the original worker may still be executing
  (worker-exec total timeout 60 min default > 30-min stale window; a fully silent
  wedge self-kills at the ~5-min idle timeout and defers instead), so two workers
  can run one task and the original attempt's late success sends a duplicate
  "✅ Task done" FYI — `executeTopicTask` rechecks no claim ownership after
  dispatch. WAVE2 SPEC A.1's assumption "at-most-once per attempt (the worker is
  dead by then)" is the wrong part. Do NOT shrink the SHARED
  `ORPHAN_HARVEST_WINDOW_MS` to ≤30 min: the human lane's reaper waits up to
  `REAP_MAX_WAIT_MS`=45 min and NEEDS the 50-min protection (AI-114). **FIXED
  (adjudicated + landed 2026-09-03, claimfix):** (a) activity-gated demotion —
  running records carry `lastActivityAt`, heartbeat by the executor's
  PENDING-DISPATCH pump (option B: dispatch-pending, not chunk-level —
  executeTopicTask consumes no stdout chunks, and worker-exec's idle killer +
  maxTimer settle every promise, so pending ≡ possibly-producing), demotion only
  when SILENT past the window (`isStaleRunning`, one classifier for both demotion
  sites; 10s-throttled `touchTaskActivity`, fail-soft); (b) claim-ownership
  recheck — records carry a monotonic `claimGen` (minted at re-claim, the only
  bump site); `executeTopicTask` rechecks it once after the dispatch resolves,
  BEFORE the failure ladder and every success branch (retry/fail FYI, question
  park, watch_job/kb_note/run_skill, completion FYI) — a superseded attempt logs
  `task-attempt-superseded` and returns with no FYI and no store mutation.

- **Push-gate suite failures were ENV LEAKAGE, not contention (ROOT-CAUSED + FIXED
  2026-09-03, AI-199, `plans/2026-09-03-push-gate-env-investigation.md`):** the
  same-day 12-subtest gate failures (`worker-edit-audit-wiring` ×3, poll-loop
  /steer ×2 + local-command ×1 + voice ×6) were caused by `PA_RICH_MESSAGES=1`
  leaking from `secrets.env` into the gate shell (`pa run` injects ALL secrets into
  LLM-worker envs) — `sendReplyText` (main.ts) then routed worker replies over
  `/sendRichMessage` instead of `/sendMessage`, so every test filtering captured
  sends by `url.includes('/sendMessage')` failed, deterministically, on every gate
  run. Reproduced exactly in the live tree by injecting that ONE variable (fail 12,
  same suites/counts); green again with the fix. The earlier "resource exhaustion /
  low C: disk" theory (`plans/2026-09-03-push-gate-contention-investigation.md`) is
  DISPROVEN — the hand-built worktree gate passed only because a normal shell has
  no secrets in its env. Fix: both run-tests.mjs runners scrub deployment-env flags
  (`pa/src/lib/test-env-scrub.ts`) before spawning the suite; regression test
  `runner-env-scrub.test.ts` spawns the real runner with the flag injected and must
  stay green. **Test rule addition: gate-shell runs and CI now measure the same
  behavior; do not add a var to the scrub list that a test inherits on purpose.**

- **Teardown guard is LIVE, not inert (AI-172, 2026-09-03):** every poll-loop-family
  afterEach hook (`poll-loop*.test.ts`, `integration`, `voice-poll-loop`) awaits
  `waitForDrain()` before touching `PA_HOME`, and the family's one test-side
  fire-and-forget (`poll-loop-callbacks` background loop) is latched via
  `trackPendingWork`; `test-teardown-guard.test.ts` pins the latch. Latch shape:
  ONE parked waiter — a second concurrent `waitForDrain()` orphans the first, and
  `_resetTeardownGuardForTest()` strands a parked waiter permanently (pinned by
  test). `poll-loop-callbacks` deliberately does NOT neuter `process.exit` (the
  other family files do) — its loop's real exit kills the subprocess before
  afterEach; do not "fix" by adding awaits. What a test-side latch still cannot
  reach: outlive-the-loop async that is production-internal with no test seam
  (the bounded maintenance-pass drain, a mid-flight DLQ flush holding the module
  mutex, voice backfill timing) — covering those needs production seams, not more
  hooks.

- **DLQ terminal drop (AI-172, 2026-09-03):** `flushDlqInner` sends through
  `sendMessageWithDetails` (`telegram.ts`) and DROPS entries whose failure
  classifies as `isTerminalChatError` (warn log with chatId/threadId/updateId/
  status/error; never in `remaining`, never quarantined). All other failures keep
  the attempts/quarantine ladder. `sendMessageWithDetails` and `sendMessage` share
  ONE extracted core (`sendChunksWithDetails`) — never re-duplicate the send
  body. The terminal set (widened from 'chat not found'-only by operator
  decision 2026-09-03): 400 'chat not found'/'peer_id_invalid'/'chat_id_invalid',
  403 'chat not found'/'bot was blocked by the user'/'user is deactivated'/
  'bot was kicked from' — a blocked/deactivated recipient is exactly as
  undeliverable as a nonexistent chat. EXCLUDED, still retryable: 'have no
  rights to send a message' (admin-restorable rights) and group-migration
  errors (chat continues under a new id); unknown strings stay false (fail
  toward retry, never toward drop). Widening is shared by the AI-186 keyboard
  path too — the predicate is single-sourced in telegram.ts.

- **`renderOpenItems` (`context.ts`) is fail-to-absent, not just fail-silent (verified
  2026-09-03):** `listNotes`/`listTasks`/`listRunningTasks` (`pa/src/lib/topic-tasks.ts`)
  each read through a tolerant wrapper that catches ANY read failure (including the
  `~/.pa/topic-tasks/` directory not existing yet — write paths create it via
  `ensure*File`, read paths never do) and returns `[]`; `renderOpenItems`'s own
  try/catch sits on top as belt-and-braces. A missing topic store can never throw into
  `buildPrompt` or abort a dispatch before `sendMessage`. Regression test:
  `context.test.ts` "buildPrompt with a PA_HOME that has no topic store still builds and
  renders an empty Open items section". **This contract is real and unrelated to
  `worker-edit-audit-wiring.test.ts`** — a same-day investigation (see below) disproved
  the theory, previously recorded here, that a push-gate failure of that suite was a
  resource-contention flake explained by this contract.

