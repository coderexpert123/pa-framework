# Telegram bot orchestrator threads — operational detail

Extracted from CLAUDE.md's bot-internals section on 2026-09-06 (budget-pressure
doctrine: split at the natural fault line). CLAUDE.md keeps the arming pointer;
this file keeps the full correctness-critical mechanics. Read this before touching
`orchestrator.ts`, `thread-executor.ts`, `topic-threads.ts`, or the `/stop`
interaction with spawned threads — the runSeq gate and the resource split are
silent-failure guards, and shortcuts here regress without a test failure.

## The block

- **Orchestrator threads (AI-203, increment 1, 2026-09-06)**: `/orchestrator on|off|status` arms
  per-topic orchestrator mode — the topic session becomes a pure orchestrator (interpret → route →
  report; no capabilities block; never executes) and execution runs in spawned threads stored at
  `~/.pa/topic-threads/<chatId>_<threadId>.json`. Opt-in per topic; `/orchestrator off` is the
  instant rollback.
  - The orchestrator emits `spawn_thread`{title,prompt} / `steer_thread`{thread_id,message}
    (validators in `orchestrator.ts`; parsed with `executionMode=false` ALWAYS so a confirmed-action
    turn can still route); `handleSpawn`/`handleSteer` write the store, fire `thread-executor.ts`
    fire-and-forget (fresh + native resume + pending-input drain + 2-attempt ladder + 30-min lazy
    stale demotion) and return the frozen footer appended to the promising reply.
  - Threads dispatch on a NON-topic resource (`topic-<key>-th<n>`), so `stopTopicWorkers` never
    matches them. `/stop` therefore marks running threads `cancelled` (count stated in the reply)
    and the executor's `runSeq` ownership gate silently discards their results.
  - Orchestrator turns run the SHARED dispatch cascade (`dispatch.ts`, AI-173 phase 3):
    `tryClassifyAndNotify` now stamps pa's rate-limit ledger on failed orchestrator attempts;
    the `executionMode=false` parse pin and the AI-030 switch-back are lane config, not mirrors.
    `session-capture.ts` is the single source for the agy exclusion
    set, `threadIdFromResource`, the post-dispatch capture block and `findNextAvailableWorker`
    (main.ts re-exports `AGY_NATIVE_RESUME_EXCLUDED_TOPICS` + `threadIdFromResource` only;
    `findNextAvailableWorker` is not re-exported, 2026-09-06 — keep this line true).
  - main.ts wires the interception (post-router), the dispatch branch and the handlers.
