# Telegram bot orchestrator threads — operational detail

Extracted from CLAUDE.md's bot-internals on 2026-09-06 (budget-pressure doctrine).
CLAUDE.md keeps the arming pointer; this file the full mechanics.
Read before touching `orchestrator.ts`, `thread-executor.ts`, `topic-threads.ts`, or
the `/stop` interaction with spawned threads — the runSeq gate and the resource split
are silent-failure guards; shortcuts here regress without a test failure.

## The block

- **Orchestrator threads (AI-203, increment 1, 2026-09-06; default-on AI-215, 2026-09-14)**:
  `/orchestrator on|off|status` arms per-topic orchestrator mode — the session becomes a
  pure orchestrator (interpret → route → report; never executes) and
  execution runs in spawned threads at
  `~/.pa/topic-threads/<chatId>_<threadId>.json`. DEFAULT-ON for every topic since AI-215: a
  keyless topic state (new topics, `/branch`) orchestrates because the gate reads
  `state.orchestrator_enabled !== false` (no state migration).
  `/orchestrator off` is the explicit opt-out (persists `orchestrator_enabled = false`, clears
  the session); `/orchestrator on` re-arms. Cancellation is resolved
  (AI-216 exact-resource kill + scoped `cancelOneThread`).
  - The orchestrator emits `spawn_thread`{title,prompt} / `steer_thread`{thread_id,message}.
    Validators live in `orchestrator.ts`; parsing uses `executionMode=false` ALWAYS so a
    confirmed-action turn can still route. `handleSpawn`/`handleSteer` write the store, fire
    `thread-executor.ts` fire-and-forget (fresh + native resume + pending-input drain +
    2-attempt ladder + 30-min lazy stale demotion) and return the frozen footer appended to
    the promising reply.
  - **Deprecation under the router (2026-09-19):** when `model_router.surfaces.placement`
    flips to `live`, ROUTED turns skip the persona branch — the placement engine decides
    in-place/move/create/split (pinned, command and fail-open turns keep the persona).
    `/orchestrator` still parses, replies its notice and writes state, so a config revert
    restores the persona byte-for-byte. Thread engine, store and `/stop` are unchanged.
  - Threads dispatch on a NON-topic resource (`topic-<key>-th<n>`), so `stopTopicWorkers` never
    matches them. `/stop` marks running threads `cancelled` (count in the reply); the
    executor's `runSeq` gate discards their results.
  - Orchestrator turns run the SHARED dispatch cascade (`dispatch.ts`, AI-173):
    `tryClassifyAndNotify` stamps pa's rate-limit ledger on failed orchestrator attempts;
    the `executionMode=false` parse pin and the AI-030 switch-back are lane config, not mirrors.
    `session-capture.ts` is the single source for the agy exclusion
    set, `threadIdFromResource`, the post-dispatch capture block and `findNextAvailableWorker`
    (main.ts re-exports only `AGY_NATIVE_RESUME_EXCLUDED_TOPICS` +
    `threadIdFromResource`; keep this true).
  - main.ts wires the interception (post-router), the dispatch branch and the handlers.
  - Thread-lane PA_META: `question` (non-voice → `rq:` buttons; voice → ask-mirror),
    `confirm_required` (voice-mirror only), `watch_job` (real 2026-09-16);
    `kb_note`/`run_skill` → loud not-available notice.

## Increment 3 (2026-09-06)

- **Reply anchor rule:** only a RAW `reply_to_message` to a thread FYI matches (`THREAD_FYI_ANCHOR_PATTERN`); quotes, turn text, and archive replays never match. Existence-checked; armed pending_action outranks (pre-consume snapshot); empty-text guard; NOT gated on orchestrator mode — a reply to a done-FYI is always a thread turn, questions included. Ack shape: lead + frozen footer, `assistantWorker: 'local'` assigned after the fallback chain, session passthrough.
- **Batch W4 guard:** reply-shaped followers are withheld from the AI-209 fold; reply-shaped heads never compile — a fold can neither lose an anchor nor steer a thread with combined text.
- **Card:** status card gains a Threads line (Tasks-line rule; two render sites only; staleness until next render).
- **Known limitation:** the /stop hold lane and held-absorb (`flushCheckAndAbsorbHeld`) rewrite text before the anchor read and capture no reply shape at hold time — an FYI reply inside a stop window, or absorbed as held text, loses its anchor. W4 governs queue entries and the compile head only; the hold lane is a third ungoverned shape-losing site.
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
  wake flipping status directly bypasses it (steer wakes were the uncapped hole).
- **Interrupt steer:** `steer_thread` gains `mode: queue|interrupt`
  (orchestrator-classified per message; both readings plausible ⇒ `interrupt`).
  Sequence: fold the message into `pendingInput` FIRST, bump `runSeq`, drop the
  session, set the value-scoped signal, kill exactly that thread's process tree
  (`stopThreadWorker`, exact resource equality), refire. The signal is
  load-bearing: a bare kill reads to `runWithFailover` as an ordinary worker
  failure whose cascade respawns the next candidate on the dead prompt. The
  dying run's `isCancelled` closure ORs the signal in, runSeq-scoped, so a
  later run on the resource is never cancelled by a stale signal — a bare
  resource-keyed kill stops the process but not the cascade.
- **Reconcile drain:** `reconcileThreadQueues` rides the bot's existing poll tick
  with an internal 60 s throttle — one-poll-tick family (route-queue precedent),
  not a declared maintenance job. While throttled it reads nothing but the dir
  listing. A queue whose only wakes are in-band wedges on restart;
  store-as-queue + this throttled reconcile is the minimal restart-proof shape.
- **Chain cap as a chunk bound:** `MAX_AUTO_RESUMES_PER_CHAIN` (5, value
  unchanged) re-parks the record as `queued` and wakes the queue. A large steer
  backlog drains in chunks of 5 per restart, not parking forever; worker spend
  stays proportional to queued input.
- **Frozen footers:** `_(Thread t-<n> queued — starts when one finishes.)_` ·
  `_(Interrupted thread t-<n> — restarting with your message.)_` ·
  `_(Queued for thread t-<n> — starts when a thread finishes.)_`. The queue
  footer names the thread id; the operator steers by id.
- **The anchor never interrupts:** a reply to a thread FYI always routes with
  mode `queue` — the increment-3 contract (delivered when the run finishes).
  Interrupt is an explicit orchestrator classification only.
- **Test seams pinned:** a poll-tick closure with internal state ships a
  `_reset...ForTest` hook (`_resetThreadQueueReconcileForTest`), reset in
  `afterEach` by every consuming test file. `PA_NOTIFY_DISABLED=1` blocks only
  the REAL fetch — `globalThis.fetch` doubles still run unless restored.
  Topic-events assertions read newest-last — the events file is append-only.

## AI-232 (2026-09-12)

- **Dependency primitive:** `ThreadRecord.dependsOn?: string[]` — ids in THIS topic
  that must reach `done` before the record may start. Write-once at `createThread`,
  never mutated afterwards. Sanitized fail-open at creation (well-formed `t-<n>`
  ids existing in the loaded store, de-duplicated, capped at
  `MAX_DEPENDS_ON_PER_THREAD` = 5; a spawn whose every id is invalid starts with no
  `dependsOn` — no rejection exists here either). The predicate is pure, takes a
  lookup function not the store's Map (`resolveDependencyState(dependsOn, lookup)`
  → `satisfied|blocked|unsatisfiable`), so a future non-thread scheduler reuses it
  verbatim.
- **The claim funnel is the single scheduler, with exactly two predicates:**
  the running cap and the dependency state. `claimThreadStarts` keeps a `queued`
  record startable only when `resolveDependencyState` says `satisfied`, so a
  dependent starts inside the same await chain as its dependency's terminal wake —
  no new timer, no new polling. `wakeQueue` is an unexported closure inside
  `executeTopicThread` and is NOT hookable; hook the store function, not the
  closure.
- **Cascade — unsatisfiable means cancelled, never an infinite wait:** every
  `claimThreadStarts` and `cancelOneThread` first runs `cascadeUnsatisfiable`:
  a `queued` record whose dependency resolved `failed`/`cancelled`/missing is
  flipped to `cancelled` with `lastError`
  `dependency <id> ended <status>; cancelled instead of waiting (AI-232)` and a
  `thread_cancelled` event detailed `dependency <id> <status>`. One ascending-`n`
  pass is transitively complete because every edge points from a higher `n` to a
  lower one. The cascade emits even though the record never ran — a scheduler
  decision is visible by design. A `missing` id implies a corrupt/hand-edited
  store — live dependents' dependencies are prune-protected.
- **Prune protection:** `createThread`'s over-20 prune skips any terminal record
  whose id appears in a live record's `dependsOn` — pruning a satisfied
  dependency would strand (or wrongly cancel) its dependent forever.
- **Dispatch dedup — the deterministic, non-LLM default:** `handleSpawn` runs
  `findDuplicateGoal` (`thread-dedup.ts`: normalized equality ⇒ `exact`;
  containment with the shorter side ≥ 24 normalized chars ⇒ `containment`;
  live `running`/`queued` records only, oldest twin wins). On a hit the new thread
  is created `queued` behind the twin (`dependsOn: [twin.id]`) — no drop, no
  merge, no LLM. The reply carries
  `_(Thread t-<n> queued behind t-<m> (<reason> goal match) — it starts automatically when t-<m> finishes and receives its result. Steer or /stop it if that is wrong.)_`
  and the `thread_spawned` event's detail is
  `queued behind t-<m> (<reason> goal match)`. A false positive costs a serialized
  chain, not lost work; steer or `/stop` is the escape hatch — `/stop` on a twin
  cascades its dependents immediately.
- **Model-requestable deps (2026-09-13):** a `spawn_thread` PA_META action may
  carry `depends_on` — up to 3 `t-<n>` ids — so the orchestrator itself can park a
  dependent on a shared subproblem. Three fail-open layers: the envelope gate
  `sanitizeSpawnDependsOn` (logic.ts; malformed/dup entries drop individually,
  >3 valid ids truncate — never a field rejection);
  `handleSpawn` unions the declared ids with the auto-dedup twin (twin first; declaring
  the twin's own id does not duplicate it); createThread's store sanitizer intersects
  with real ids, so an id matching nothing degrades to a plain spawn. Prompt teaching
  rides the §4.6 PA_META section (`spawn_thread{title,prompt,depends_on?}`).
- **Per-record model pin (WP-7):** `spawn_thread{…,model?}` and
  `pa topic-task add --model` pin a model id (`/^[a-zA-Z0-9._-]{1,64}$/`) on the
  record; `buildTopicTierExtraArgs` puts it in the overrides slot — above the
  topic's `tunable_defaults`, which executor lanes now honor too (session
  `/llm`/`/effort` overrides stay human-lane-only).
- **Result handoff:** a dependency-parked record starts FRESH, so the handoff
  attaches to the fresh prompt — `buildThreadPrompt`'s optional `upstream`
  parameter, rendered by `renderUpstreamResults` as `## Upstream results`, one
  line per dependency, `lastResult` ≤400 chars, `(no result recorded)` when
  absent. No dependencies ⇒ a byte-identical prompt to before.
- **Dynamic topic sections (2026-09-16 evangelism wave):** fresh/fallback
  dispatches carry `topic-pointers.ts`/`sources.ts` output (`ctx.pointers`/
  `sources`/`reservations`) between `## Your task`(+upstream) and `## Rules`;
  resumed turns and absent fields render nothing.
- **Scope: in-topic only** — one topic's own records, one store file, the bot's
  own funnel. No cross-topic subscription or thread-to-thread messaging — a
  thread never coordinates with other threads; the scheduler does. Operator
  commands (`pa notify`, `pa ping`, …) stay available inside thread workers —
  the scope rule bounds coordination, not operator paging.

## Wall-park, cooldown revival, voice-task surfacing

**Read `docs/bot-orchestrator-wallpark.md` before touching wall-park, the
`parkedUntil` stamp, the cooldown-expiry revival, or voice-task surfacing**
(relocated 2026-09-13).

## AI-228 — crash recovery for thread records (2026-09-14)

- **The zombie hole this closes:** a bot crash mid-thread-dispatch left the
  ThreadRecord at `running` with a frozen `updatedAt` — thread dispatches never
  write PendingDispatch records (the executor fires `runWithFailover` on
  resource `topic-<key>-th<n>` directly), so the AI-095 reaper never saw them,
  and only the lazy 30-min `demoteStale` sweep would eventually requeue.
  `reapOrphanedThreads` (orphan-reaper.ts) is the sibling pass: launched from
  main.ts's startup chain AFTER the awaited `cleanupOrphanedWorkers` kill pass
  (a live orphan inside its 50-min `harvestUntil` window keeps its registry
  entry; a dead one's is already gone). It enumerates every store
  (`listStoreKeys` + `listThreads` — the lazy demotion requeues the >30-min
  tail for free) and adopts each record still `running`; at process start,
  before any claim can fire, that IS the orphan set.
- **`settleOrphanedThread` is the idempotency primitive:** re-loads under the
  per-key lock and writes ONLY while `status === 'running' && runSeq` matches
  the adopted sequence — a claim, `/stop`, `demoteStale` or a settle racing the
  reaper no-ops instead of clobbering. `restartParkFields` is the single
  restart-park shape both `demoteStale` and the reaper's demote share:
  `queued` + `restart-parked: <reason> — auto-requeued` + a ~5-min
  `parkedUntil`. A crash is not an attempt outcome — `attempts`,
  `unavailableParks` and `pendingInput` are never in the shape.
- **Outcomes:** a harvestable result (registry `teePath` → `extractTeeResult`,
  or a resumed run's claude-family transcript → `extractFinalAssistantText`
  anchored at adopted `updatedAt − THREAD_HARVEST_LOOKBACK_MS`, gated on
  `TRANSCRIPT_QUIESCENT_MS` mtime quiescence + the AI-202 premature-async
  guard) → `done` + `lastResult` (uncapped, redacted) + `thread_completed` +
  the standard `✅ Thread <id> done:` FYI. All carried `voiceTaskIds` terminal
  + no result → `done` with an honest note, NO FYI (the ledger read fails
  OPEN ⇒ treated open ⇒ demote). Dead + no result → restart-parked demote;
  the reclaim is the funnel's (claimThreadStarts + reconcile + the claim's
  own 🧵 FYI). Live → `touchThread` replaces the dead pump and the record
  stays `running`. A post-anchor reply still inside the quiescence window
  waits a round rather than demoting under finished work.
- **Liveness:** `isThreadWorkerAliveOnMachine` shares the AI-241 OS-truth core —
  resource `topic-<key>-th<n>` (byte-identical to the executor's), needles =
  resumed session id + matching registry entries' `teePath` basenames. Accepted
  hole, test-pinned: a fresh-run claude orphan that lost its registry entry has
  no needle → false-negative to dead → demote-while-alive → duplicate run;
  bounded — a live orphan inside its harvest window keeps its entry.
- **Give-up tail:** orphans still alive past `REAP_MAX_WAIT_MS` + grace hand to
  a shared `unref()`'d 60 s interval that keeps pumping and settling until each
  exits or the process ends. pa's own orphan sweep kills it at `harvestUntil`,
  bounding the watch; the watcher clears itself when its last
  record settles and never blocks process exit.
