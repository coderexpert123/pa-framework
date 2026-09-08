# Bot test rules (extracted from projects/telegram-bot/CLAUDE.md 2026-09-07 — budget-pressure split; the pointer line lives in the scoped brain)

- **Test rule**: src/tests holds only `.ts` — run-tests.mjs enumerates dist/tests ONLY, so a compiled `.js` stranded in src/tests sits dark forever (last stray untracked 2026-09-06, AI-211).
- **Test rule**: send bodies MdV2-escaped (strip `\`); gates fail-closed on stale dist — build first (`PA_ALLOW_STALE_DIST=1` escape). Never latch
  (trackPendingWork) a test-side fire-and-forget where REAL `process.exit` can fire (poll-loop-callbacks) — the latch turns the no-op drain into a
  real wait and darkens the file; latch only in exit-neutered files (AI-172). Frozen-string pins assert
  EXACT equality, never startsWith/includes — a prefix pin can't count colons and passed an inherited `label::` defect (AI-209, 2026-09-06).
- **Test rule**: fire-and-forget lane tests (executor wake/resume) must accept the SETTLED durable end-state (executor-bumped `runSeq`, completion-written `lastResult`), not only a transient `status: 'running'` poll — on a fast host the whole run closes before the first read (CI-linux-only red, 2026-09-06); keep the in-flight branch for slow hosts.
- Test fixtures use the synthetic id family (-1001234567890, threads 5001/5002), never real chat/thread ids or repo paths — the public mirror tracks src/tests.

- **Test rule**: a forced `sleep` gap between timestamp-ordered fixture groups is not a clock guarantee — on coarse-`Date.now()` runners (CI-macOS) the sleep can elapse inside one clock tick and both groups stamp the same millisecond; loop until the clock itself confirms the gap (`while (Date.now() - from < N) await sleep(...)`) wherever a test asserts timestamp-derived ordering (task-lane-activity CI red 34062205071, fixed d16a7fe, 2026-09-07).
