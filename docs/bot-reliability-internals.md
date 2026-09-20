# Telegram bot delivery/reliability internals — operational detail

Extracted from CLAUDE.md 2026-08-07 (`/shorten-brain`); CLAUDE.md keeps one-line
pointers, this file the full correctness-critical mechanics. Read before touching
reply delivery, the DLQ, delivered-store dedup, pending-dispatches, orphan-reaper, or
`health.ts`/DEGRADED shedding — every guard here was added after a real
duplicate-delivery or crash-loss incident, and shortcuts regress silently (no test
failure, just an occasional duplicate or dropped reply in production).

## DLQ -> Startup + Periodic Flush

`main.ts` calls `flushDlq(token)` at startup AND on a poll-loop maintenance timer
(~5 min) — startup-only never retried a mid-uptime failure (it silently expired at the
24h TTL, violating "no silent loss"). Same timer runs `compactDelivered()`; the pa-host
`session-gc` job runs `cleanupExpiredSessions()`; all fire-and-forget. `compactDelivered`
and session GC are shed under DEGRADED; the DLQ flush deliberately is NOT (it IS reply
delivery — shedding it >24h would let queued replies expire at the DLQ TTL), and an
in-flight guard keeps at most one flush queued on the dlq mutex during outages.

**Quarantine contract (2026-08-17):** each DLQ entry tracks `attempts` (failed flush
count); at 5, it is marked `quarantined: true` and retry stops — it persists indefinitely
(no TTL purge) awaiting operator action via `pa dlq list|replay|discard`. The first
quarantine sends a one-time deduped pa-alerts page (ref-ID + preview) — a
chronically failing message can't spam Telegram but stays recoverable. Replay resets
`quarantined`+`attempts` and warns about duplicate risk if the original send eventually
succeeded.

## Delivery semantics

Inbound = exactly-once (offset + `watermark.ts`). Outbound = effectively-once / no
silent loss: connect-stage-only failover (see Telegram API routing) + a persistent
delivered-key guard (`delivered-store.ts`, key `chatId:threadId:updateId`, 24h TTL)
consulted by BOTH the reply path (main.ts) and `flushDlq` — closes the
partial-flush-crash and update-reprocessing duplicate paths. Irreducible duplicate only
in the connect+transmit-then-response-timeout window (no idempotency key; bots can't
read back their own sends). When changing reply/DLQ code, preserve this guard.

Crash-in-flight dispatches are covered too (AI-095): `pending-dispatches.ts` records
every dispatch before the worker spawns; on startup `orphan-reaper.ts` recovers the lost
reply from claude-family session transcripts (waiting for the orphan to finish —
main.ts excludes those topics from the AI-039 orphan-kill pass), or — for transcript-less
workers, i.e. agy — from the **stdout tee** (`worker-exec.ts` sets `AGY_TEE_OUT` on agy
dispatches; the shim's `worker_stdout_tee.js` mirrors stdout to
`~/.pa/logs/worker-tee/<contextId>.out`, which survives a bot-only kill because the shim
chain outlives the bot; the reaper's tee-fallback branch waits for the orphan then
harvests the file — `extractTeeResult` handles NDJSON result events and plain text) —
or auto-requeues through the normal dispatch pipeline (past the ladder cap, a neutral
notice). Recovered replies dedup-guard via the same delivered-store; tee files GC after
24h via the declared `worker-tee-gc` job (AI-100). The poll loop's stop-sentinel watcher (main.ts) aborts a slow proxied
`getUpdates` so graceful shutdown stays prompt.

The same startup pass covers orchestrator THREAD records (AI-228, 2026-09-14): a
crash mid-thread-dispatch left `ThreadRecord`s wedged `running` (the thread lane
never writes a PendingDispatch — its workers run on `topic-<key>-th<n>`
resources), so `reapOrphanedThreads` runs alongside `reapOrphanedDispatches`
AFTER the awaited `cleanupOrphanedWorkers` kill pass (a live orphan inside its
harvest window keeps its registry entry; a dead one's is already gone). Each
still-`running` record is adopted with its `runSeq` as the ownership gate,
liveness-checked by the AI-241 OS-truth core (session-id + registry-teePath
needles — a fresh-run orphan with no entry has none, an accepted false-negative
→ demote), and settled via `settleOrphanedThread`'s conditional write: harvest
(tee/transcript, same extractors + quiescence + premature-async guard) → `done`
+ `thread_completed` + the standard ✅ FYI; all carried voice tasks already
terminal → `done` with an honest note, no FYI (ledger fails OPEN); dead + no
result → restart-parked `queued` via the shared `restartParkFields` shape;
live → `touchThread` + keep `running`. Orphans still alive at give-up hand to
an unref'd detached watcher until they exit.

**2026-08-17 additions (infra-audit Waves A/B):**

- `extractFinalAssistantText` is position-aware: a `tool_use` block only marks an entry
  mid-turn when it appears AFTER the last text block. A tool call before/between text
  blocks with a final text answer is a COMPLETED turn — the old any-tool_use-skip rule
  delivered death notices for good recovered replies ending with a post-answer tool call.
- `main.ts` runs `watchdogStaleJobs()` on a 5-min gate (allowlisted due-check in
  `timer-inventory.test.ts`): it clears in-flight markers older than 10× a job's
  interval, so a job whose promise never settles (the 2026-08-17 model-override-sweep
  70-skip wedge) self-heals instead of skipping forever.
- Pinned-worker failure hint: when a topic's effective worker is an explicit choice
  (preferred/topic-default, not failover) and spawn-fails twice in a row, the failure
  reply appends "Pinned worker X is failing — /agent <alt> to switch" (rate-limited).
- Secret redaction on egress: `buildWorkerResponse` runs the final reply through
  `redactSecrets` (literal secrets.env values + generic token shapes) — same net as pa's
  log/telegram paths (`worker-reply.ts` since AI-173 phase 6). Do not add reply-sending code that bypasses it.

**AI-095 follow-up (2026-07-08, closes two pre-existing gaps in the above):**

1. *Queued-update crash loss* — `main.ts`'s per-update loop writes an enqueue-time
   placeholder pending-dispatch record (`updateId, chatId, threadId, messageId,
   startedAt, userText` — no `cwd`/`session`) via `addPendingDispatch` BEFORE the poll
   offset covering that update is persisted, closing the crash window where a same-topic
   queued update (serialized via `topicPending`) could vanish without trace; the full
   record written later in `processUpdate` overwrites the placeholder at the same key.
   `isAcceptableUpdate(update, allowedChatIds)` is the single shared predicate both the
   enqueue-time write and `processUpdate`'s guard call, so they can't drift.
2. *Gate during active recovery — QUEUE, never bounce (2026-08-27 seamless-restart wave;
   supersedes the 2026-07-08 deferral-notice behavior)* — `recovery-gate.ts`
   (`markTopicRecovering`/`clearTopicRecovering`/`isTopicRecovering`/`waitForTopicRecovery`)
   is owned by `orphan-reaper.ts`: marks every topic with a pending record at reap start,
   clears per-round and via a `finally` backstop. `processUpdate` no longer deflects a
   follow-up with a "please resend" notice — it WAITS on `waitForTopicRecovery` (waiter
   registry, typing pulse, `PA_RECOVERY_WAIT_MS` default 50 min > the reaper's 45-min
   window) inside the already-held topic lock, then dispatches normally. `!skipWorker`
   gating is load-bearing: a command (`/reset`, `/model`, `/stop`) on a recovering topic
   executes immediately. A timed-out wait (stale gate, reaper gone) logs and proceeds.
   **Recovered replies ride the SAME pipeline as normal replies** — `formatWorkerReply`
   (`worker-reply.ts` (AI-173 phase 6; `logic.ts` re-exports); thought-strip, noise-strip,
   `normalizeMarkdown`, `redactSecrets`), no
   "Recovered reply" prefix; restart narration is banned from user-visible strings.
   **Exhausted recovery auto-requeues** instead of death-noticing: `requeueSyntheticUpdate`
   (main.ts) injects the original request as a synthetic update reusing the original
   `update_id` (delivered-store keys align; offset comes from the real batch only) so the
   normal path re-dispatches it. The requeue is a durable ladder — a failed requeued
   dispatch below `PA_REQUEUE_MAX` (default 2) parks (`requeueNotBefore`,
   `PA_REQUEUE_BACKOFF_MS` default 15 min) and the `queue-drain` job's `requeue` source
   re-injects when due; /stop during the window cancels the parked record. Three hard
   rules: the "retrying automatically" status line goes OUT-OF-BAND (raw `sendMessage` +
   `appendRefIdAndLog`) — a reply-path send would `markDelivered` the key and the retry's
   REAL reply would be dedup-skipped; a requeued record must NEVER be `finish()`ed by the
   reaper (that `markDelivered` would silently drop the synthetic's reply — settle via
   `updatePendingDispatch` only); parked records return the NEW outcome `'parked'`
   (never `'waiting'` — the drain owns them, so the topic's gate clears and its synthetic
   never wedges behind it). Voice placeholders carrying `voiceFileId` are re-downloaded
   and re-transcribed through the arrival pipeline instead of noticed.

## /stop -> executor cancellation (AI-092; voice-prefetch + flush semantics 2026-08-15)

`/stop`/`/steer` cancel a REQUEST, not just the worker holding it right now.
`worker-stop.ts` sets the topic marker; `dispatchMessage` hands `isTopicStopped` to pa as
`RunOptions.isCancelled` on all four dispatch paths — `runWithFailover` polls it per
candidate and again after a failed attempt; `worker-exec` reads it to suppress the
worker-exit page for a killed run.

**Do not regress this to caller-side checks between dispatch phases**: a /stop by
definition lands mid-run, inside the cascade where between-phase checks never execute —
the cancelled request got answered by the next worker instead (live incident 2026-08-02,
thread 29). The bot's post-cascade bail is deliberately gated on `!result.success`,
so a worker that finished just before the kill keeps its real reply
(2026-08-02 stop-cancellation-cascade design record).

**2026-08-15 wave (voice prefetch + flush, internal design record)**:

- Voice/audio/video notes transcribe AT ARRIVAL (`voice-prefetch.ts`, in the poll
  loop's enqueue block, AFTER the AI-095 placeholder write); the transcript becomes the
  queued entry's text — a voice note is then exactly a text message, never cancelled by
  stop/steer.
- `/stop` and `/steer` flush the topic's turn boundary: everything not-yet-dispatched
  and non-command becomes HELD context (`topic-queue.ts` held entries) carried by the
  next dispatch (`absorbHeldEntries`, arrival-ordered, promise-aware); an in-flight
  dispatch cancelled by the marker contributes its text via the reply-path A6 flush.
  The marker is ALWAYS set (no unmark-on-killed-0), TTL 15 min (covers the 10-min
  transcription cap), updateId-gated so it can never touch newer messages.
- Command & caption parsing: `/stop`/`/steer` are detected from `msg.text ?? msg.caption`;
  bare `/steer` (text or voice) folds in-flight + queued context and dispatches immediately
  without degrading to `/stop` (2026-08-20). A caption that is any slash-command skips
  transcription entirely (`__skipVoice`).
- Do-not-regress: the stop/steer kill IIFE must NOT drain the queue for `/steer` (it
  resumes at the loop's next await — after the steer's own entry registered — and would
  cancel it); held absorption for a steer happens in ITS normalizer, never at
  interception; prefetch deps need the secrets-bearing env + hoisted `transcription:`
  config (process.env alone strands prefetch on local whisper); placeholder-before-prefetch
  ordering is load-bearing (AI-095 tests gate on the first /getFile).

## Worker-pid registry & topic-lock invariants

Split to `docs/bot-worker-pid-registry.md` 2026-09-14 (budget pressure — the
same-file-trim doctrine's second-trim-in-24h response is a split at the fault
line, not another shave). Read it before touching `worker-pids.ts`,
`worker-exec.ts` kill helpers, blackboard lock renewal, `orphan-worker-reap.ts`,
or the reaper's dead-dispatch arm. It carries: AI-112 whole-tree kill,
AI-113 per-holder lock renewal (`startLockRenewal` pairing — do not remove),
AI-114 `harvestUntil` intrinsic protection, AI-241 OS-truth dead-dispatch arm.

## Poll-loop batch isolation & the voice-inbox route hand-off (2026-09-12 stale-route fix)

`runPollLoop`'s `for (const update of batch)` loop used to `await enqueueUpdateForDispatch(...)`
unguarded. A throw there escaped the whole loop into the poll iteration's outer `catch`,
which logged nothing — abandoning every update still left in that tick's batch with zero
trace. For a voice-inbox route hand-off (`__synthetic: 'route'`) this was a true silent
drop, not just a delay: `drainVoiceInboxRoutes()` rewrites
`~/.pa/voice-inbox/route-queue.jsonl` to remove the consumed line BEFORE the batch loop
runs (consume-after-inject), so once the throw ate the update, no copy of the routing
decision existed anywhere — the task sat in `routed` with no worker until the 20-minute
`voice-inbox-fallback` stale-routed sweep
(`pa/src/lib/maintenance/jobs/voice-inbox-fallback.ts`, `DEFAULT_ROUTED_STALE_MS`)
re-routed it under a watchdog-authored reason (live incidents
vi-508d4d7adbae/vi-be92df93d4ff, ~21-23 min silent each).

Fixed two ways, both in `runPollLoop`:

1. The `enqueueUpdateForDispatch` call is wrapped in its own try/catch — a throw for one
   update logs loudly (`logger.warn('poll', ...)`, carries
   `update_id`/`topicKey`/`synthetic`) and `continue`s to the next update in the batch.
2. When the failed update is a route hand-off, it is re-injected immediately via
   `injectUpdate` (the mechanism `requeueSyntheticUpdate` uses) with `__routeRetryCount`
   incremented, so it retries on the NEXT poll tick — seconds away, not 20 minutes.
   Capped at `ROUTE_INJECT_RETRY_LIMIT` (3); past the cap it logs at `error` and is left
   to the stale-routed sweep as the last-resort net, not the first one.

The poll iteration's outer `catch` also logs a `poll iteration failed` warning (beyond
the `AbortError` check) — a defense-in-depth net for any OTHER tick-level throw that
isn't one of the per-update isolation cases, so "no attempt, no skip, no failure logged"
can't recur through a different path.

## AI-096 (resource-starvation resilience)

Two deliberate deviations from library/framework defaults, both from July crash RCA —
do not "fix" either back.

1. `safe-lock.ts`'s shared `proper-lockfile` options set `onCompromised` to log instead
   of throw/kill-process, and `stale: 30s` — both July crashes were the library's
   throw-on-compromise default under load.
2. `health.ts`'s self-health probe (event-loop lag + fs latency) drives a DEGRADED mode
   where `main.ts` sheds non-essential work (typing indicators, the topic-sweep,
   `compactDelivered`/session-GC) — never the DLQ flush (see Delivery semantics).
   `worker-exec.ts` additionally enforces machine-wide worker admission control via
   `PA_MAX_CONCURRENT_WORKERS` blackboard slots (evaluators exempt).

---
