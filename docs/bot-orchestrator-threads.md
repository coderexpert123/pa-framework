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

## Increment 3 (2026-09-06)

- **Reply anchor rule:** only a RAW `reply_to_message` to a thread FYI matches (`THREAD_FYI_ANCHOR_PATTERN`); quotes, turn text, and archive replays never match. Existence-checked; an armed pending_action outranks the anchor (pre-consume snapshot); empty text guards; NOT gated on orchestrator mode — a reply to a done-FYI is always a thread turn, questions included. Ack shape: lead + frozen footer, `assistantWorker: 'local'` assigned after the fallback chain, session passthrough.
- **Batch W4 guard:** reply-shaped followers are withheld from the AI-209 fold; reply-shaped heads never compile — a fold can neither lose an anchor nor steer a thread with combined text.
- **Card:** status card gains a Threads line (Tasks-line rule; two render sites only; staleness until next render).
- **Known limitation (candidate next increment):** the /stop hold lane and held-absorb (`flushCheckAndAbsorbHeld`) rewrite text before the anchor read and capture no reply shape at hold time — an FYI reply arriving inside a stop window, or absorbed as held text, loses its anchor. W4 governs queue entries and the compile head only; the hold lane is a third, ungoverned shape-losing site.
- Cross-module pattern pin: thread-executor.test.ts ↔ orchestrator.ts.

## Increment 4 (2026-09-07)

- **FIFO spawn queue:** the per-topic running cap is 10, and the cap binds every
  start, not only spawns. An over-cap `createThread` parks the record as `queued`
  (no rejection exists); `claimThreadStarts` is the ONLY `queued`→`running`
  transition — lowest `n` first, under the per-key lock, after lazy stale
  demotion. Every start path claims: spawn handlers, steer wakes, the executor's
  terminal wake, a drain-cap restart, and the poll-tick reconcile.
- **Why the claim is the gate:** a cap enforced at create-time only is not a cap.
  Every transition INTO the constrained state needs the same gate — an in-band
  wake that flips status directly bypasses it entirely (steer wakes were the
  uncapped hole).
- **Interrupt steer:** `steer_thread` gains `mode: queue|interrupt`
  (orchestrator-classified per message; both readings plausible ⇒ `interrupt`).
  The interrupt sequence: fold the message into `pendingInput` FIRST, bump
  `runSeq`, drop the session, set the value-scoped signal, kill exactly that
  thread's process tree (`stopThreadWorker`, exact resource equality), then
  refire. The signal is load-bearing: a bare kill reads to `runWithFailover` as
  an ordinary worker failure, and its cascade respawns the next candidate on the
  dead prompt. The dying run's own `isCancelled` closure ORs the signal in,
  scoped by runSeq, so a later run on the same resource is never cancelled by a
  stale signal — a resource-keyed kill without a cancellation signal kills the
  process but not the cascade.
- **Reconcile drain:** `reconcileThreadQueues` rides the bot's existing poll tick
  with an internal 60 s throttle — one-poll-tick family (route-queue precedent),
  not a declared maintenance job. While throttled it does no store read beyond
  the dir listing. A queue whose only wakes are in-band wedges on restart; the
  store-as-queue plus this one throttled reconcile is the minimal restart-proof
  shape.
- **Chain cap as a chunk bound:** `MAX_AUTO_RESUMES_PER_CHAIN` (5, value
  unchanged) now re-parks the record as `queued` and wakes the queue. A large
  steer backlog drains in chunks of 5 per restart instead of parking forever;
  worker spend stays proportional to real queued input.
- **Frozen footers:** `_(Thread t-<n> queued — starts when one finishes.)_` ·
  `_(Interrupted thread t-<n> — restarting with your message.)_` ·
  `_(Queued for thread t-<n> — starts when a thread finishes.)_`. The queue
  footer names the thread id because every sibling footer does and the operator
  steers by id.
- **The anchor never interrupts:** a reply to a thread FYI always routes with
  mode `queue` — the increment-3 contract (delivered when the run finishes).
  Interrupt is an explicit orchestrator classification only.
- **Test seams this increment pinned:** a poll-tick closure with internal state
  ships a `_reset...ForTest` hook, and every consuming test file resets it in
  `afterEach` (`_resetThreadQueueReconcileForTest`). `PA_NOTIFY_DISABLED=1`
  blocks only the REAL fetch — doubles installed on `globalThis.fetch` still
  run, so a stalled fetch double keeps running across tests unless the test
  restores the original. Topic-events assertions read newest-last: the events
  file is append-only and earlier tests' lines stay in it.
