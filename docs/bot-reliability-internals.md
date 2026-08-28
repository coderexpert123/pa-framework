# Telegram bot delivery/reliability internals — operational detail

Extracted from CLAUDE.md's Connections section during a 2026-08-07 `/shorten-brain` pass.
CLAUDE.md keeps one-line pointers; this file keeps the full correctness-critical
mechanics. Read this before touching reply delivery, the DLQ, delivered-store dedup,
pending-dispatches, orphan-reaper, or `health.ts`/DEGRADED shedding — these guards were
each added after a real duplicate-delivery or crash-loss incident, and shortcuts here
regress silently (no test failure, just an occasional duplicate or dropped reply in
production).

## DLQ -> Startup + Periodic Flush

`main.ts` calls `flushDlq(token)` at startup AND on a poll-loop maintenance timer
(~5 min). On a forever-daemon the startup-only flush never retried a reply that failed
mid-uptime — it silently expired after the 24h TTL (violating "no silent loss"), so the
retry now also runs in steady state. Same timer runs `compactDelivered()`; the pa-host
`session-gc` maintenance job runs `cleanupExpiredSessions()`. All are fire-and-forget. `compactDelivered`
and session GC are shed under DEGRADED; the DLQ flush deliberately is NOT (it IS reply
delivery, not housekeeping — shedding it for >24h would let queued replies expire at the
DLQ TTL), and an in-flight guard keeps at most one flush queued on the dlq mutex during
outages. (See `plans/2026-07-07-autonomous-scale-longevity-hardening.md` +
`plans/2026-07-08-autonomous-deep-recheck-pass1-fixes.md`.)

**Quarantine contract (2026-08-17):** Each DLQ entry tracks `attempts` (failed flush count).
At 5 failed attempts, the entry is marked `quarantined: true` and retry stops — it persists
indefinitely (no TTL purge) awaiting operator action via `pa dlq list|replay|discard`.
The first quarantine sends a one-time deduped page to pa-alerts (ref-ID + first 80 chars
preview). This prevents a chronically failing message from spamming Telegram while
preserving it for manual recovery. Replay resets `quarantined`+`attempts` and warns about
duplicate risk if the original send eventually succeeded.

## Delivery semantics

Inbound = exactly-once (offset + `watermark.ts`). Outbound = effectively-once / no
silent loss: connect-stage-only failover (see Telegram API routing) + a persistent
delivered-key guard (`delivered-store.ts`, key `chatId:threadId:updateId`, 24h TTL)
consulted by BOTH the reply path (main.ts) and `flushDlq` — closes the
partial-flush-crash and update-reprocessing duplicate paths. Irreducible duplicate only
in the connect+transmit-then-response-timeout window (Telegram has no idempotency key;
bots can't read back their own sends). When changing reply/DLQ code, preserve this
guard.

Crash-in-flight dispatches are covered too (AI-095): `pending-dispatches.ts` records
every dispatch before the worker spawns; on startup `orphan-reaper.ts` recovers the lost
reply from claude-family session transcripts (waiting for the orphan to finish —
main.ts excludes those topics from the AI-039 orphan-kill pass), or — for transcript-less
workers, i.e. agy — from the **stdout tee** (`worker-exec.ts` sets `AGY_TEE_OUT` on agy
dispatches; the shim's `worker_stdout_tee.js` mirrors stdout to
`~/.pa/logs/worker-tee/<contextId>.out`, which survives a bot-only kill because the shim
chain outlives the bot; the reaper's tee-fallback branch waits for the orphan then
harvests the file — `extractTeeResult` handles NDJSON `type:'result'` events AND
plain-text) — or auto-requeues the request through the normal dispatch pipeline (past
the ladder cap, a neutral notice);
recovered replies are dedup-guarded via the same delivered-store. Tee files are GC'd
after 24h by the declared `worker-tee-gc` job (AI-100). The poll loop's
stop-sentinel watcher (main.ts) aborts a slow proxied `getUpdates` so graceful shutdown
stays prompt.

**2026-08-17 additions (infra-audit Waves A/B):**

- `extractFinalAssistantText` is position-aware: a `tool_use` block only marks an entry
  mid-turn when it appears AFTER the last text block. A tool call before/between text
  blocks with a final text answer is a COMPLETED turn — the old any-tool_use-skip rule
  delivered death notices for perfectly good recovered replies that ended with a
  post-answer tool call.
- `main.ts` runs `watchdogStaleJobs()` on a 5-min gate (allowlisted due-check in
  `timer-inventory.test.ts`): it clears in-flight markers older than 10× a job's
  interval, so a job whose promise never settles (the 2026-08-17 model-override-sweep
  70-skip wedge) self-heals instead of skipping forever.
- Pinned-worker failure hint: when a topic's effective worker is an explicit choice
  (preferred/topic-default, not failover) and spawn-fails twice in a row, the failure
  reply appends "Pinned worker X is failing — /agent <alt> to switch" (rate-limited,
  resets after showing).
- Secret redaction on egress: `buildWorkerResponse` runs the final reply through
  `pa/src/lib/redact.ts`'s `redactSecrets` (literal secrets.env values + generic token
  shapes) — same net as pa's log/telegram paths. Do not add new reply-sending code that
  bypasses it.

**AI-095 follow-up (2026-07-08, closes two pre-existing gaps in the above):**

1. *Queued-update crash loss* — `main.ts`'s per-update loop writes an enqueue-time
   placeholder pending-dispatch record (`updateId, chatId, threadId, messageId,
   startedAt, userText` — no `cwd`/`session`) via `addPendingDispatch` BEFORE the poll
   offset covering that update is persisted, closing the window where a same-topic
   queued update (serialized in-memory via `topicPending`) could be lost with zero trace
   on a crash; the full record written later in `processUpdate` overwrites this
   placeholder at the same key. `isAcceptableUpdate(update, allowedChatIds)` is the
   single shared predicate both the enqueue-time write and `processUpdate`'s own guard
   call, so they can't drift.
2. *Gate during active recovery — QUEUE, never bounce (2026-08-27 seamless-restart-recovery
   wave; supersedes the 2026-07-08 deferral-notice behavior)* — `recovery-gate.ts`
   (`markTopicRecovering`/`clearTopicRecovering`/`isTopicRecovering`/`waitForTopicRecovery`)
   is owned entirely by `orphan-reaper.ts`: marks every topic with a pending record at reap
   start, clears a topic **per-round** and via a `finally` backstop. `processUpdate` no
   longer deflects a follow-up with a "please resend" notice — it WAITS on
   `waitForTopicRecovery` (waiter registry, typing pulse, `PA_RECOVERY_WAIT_MS` default
   50 min > the reaper's 45-min window) inside the already-held topic lock, then dispatches
   normally. `!skipWorker` gating is load-bearing and unchanged: a command (`/reset`,
   `/model`, `/stop`) on a recovering topic executes immediately. A timed-out wait (stale
   gate, reaper gone) logs and proceeds. **Recovered replies ride the SAME pipeline as
   normal replies** — `formatWorkerReply` (logic.ts; thought-strip, noise-strip,
   `normalizeMarkdown`, `redactSecrets`) with no "Recovered reply" prefix; restart
   narration is banned from every user-visible string. **Exhausted recovery auto-requeues**
   instead of death-noticing: `requeueSyntheticUpdate` (main.ts) injects the original
   request as a synthetic update reusing the original `update_id` (delivered-store keys
   align; offset comes from the real batch only), so the full normal path re-dispatches it.
   The requeue is a durable ladder — a failed requeued dispatch below `PA_REQUEUE_MAX`
   (default 2) parks (`requeueNotBefore`, `PA_REQUEUE_BACKOFF_MS` default 15 min) and the
   `requeue-drain` maintenance job re-injects when due; a /stop during the window cancels
   the parked record. Three hard rules: the "retrying automatically" status line goes
   OUT-OF-BAND (raw `sendMessage` + `appendRefIdAndLog`) — a reply-path send would
   `markDelivered` the key and the retry's REAL reply would be dedup-skipped at
   main.ts's reply block; a requeued record must NEVER be `finish()`ed by the reaper
   (`markDelivered` would silently drop the synthetic's reply — settle via
   `updatePendingDispatch` only); parked records return the NEW outcome `'parked'`
   (skipped entirely, never `'waiting'` — the drain owns them, so the topic's gate clears
   and the drain's synthetic is never wedged behind it). Voice placeholders carrying
   `voiceFileId` are re-downloaded and re-transcribed through the arrival pipeline instead
   of noticed.

## /stop -> executor cancellation (AI-092; voice-prefetch + flush semantics 2026-08-15)

`/stop`/`/steer` cancel a REQUEST, not just the worker holding it right now.
`worker-stop.ts` sets the topic marker; `dispatchMessage` hands `isTopicStopped` to pa as
`RunOptions.isCancelled` on all four dispatch paths (session resume, preferred, default,
`runWithFailover`) — `runWithFailover` polls it per candidate and again after a failed
attempt; `worker-exec` reads it to suppress the worker-exit page for a killed run.

**Do not regress this to caller-side checks between dispatch phases**: a /stop by
definition lands mid-run, inside the cascade where between-phase checks never execute —
the cancelled request got answered by the next worker instead (live incident 2026-08-02,
thread 29, plus a false pa-alerts page). The bot's post-cascade bail is deliberately
gated on `!result.success`, preserving the invariant that a worker which finished just
before the kill keeps its real reply. `plans/2026-08-02-autonomous-stop-cancellation-cascade.md`.

**2026-08-15 wave (voice prefetch + flush; plans/2026-08-15-voice-prefetch-stop-steer-flush*.md)**:

- Voice/audio/video notes transcribe AT ARRIVAL (`voice-prefetch.ts`, started in the
  poll loop's enqueue block, AFTER the AI-095 placeholder write). The transcript becomes
  the queued entry's text — from then on a voice note is exactly a text message. Never
  cancelled by stop/steer.
- `/stop` and `/steer` flush the topic's turn boundary: everything not-yet-dispatched
  and non-command becomes HELD context (`topic-queue.ts` held entries) carried by the
  next dispatch (`absorbHeldEntries`, arrival-ordered, promise-aware). An in-flight
  dispatch cancelled by the marker contributes its text via the reply-path A6 flush.
  The marker is ALWAYS set (no unmark-on-killed-0) and TTL is 15 min (covers the
  10-min transcription cap); it is updateId-gated so it can never touch newer messages.
- Command & caption parsing: `/stop`/`/steer` are detected from `msg.text ?? msg.caption`;
  bare `/steer` (text or voice) folds in-flight + queued context and dispatches immediately
  without degrading to `/stop` (2026-08-20). A caption that is any slash-command skips transcription entirely (`__skipVoice`).
- Do-not-regress: the stop/steer kill IIFE must NOT drain the queue for `/steer` (it
  resumes at the loop's next await — after the steer's own entry registered — and
  would cancel it); held absorption for a steer happens in ITS normalizer, never at
  interception time; prefetch deps need the secrets-bearing env + hoisted
  `transcription:` config (process.env alone silently strands prefetch on local
  whisper); placeholder-before-prefetch ordering is load-bearing (AI-095 tests gate
  on the first /getFile).

## Worker-pid registry & topic-lock invariants (AI-112/113/114, 2026-08-08)

Three related fixes from the same incident (a `/stop` that couldn't kill a real
62-minute `agy` dispatch). Read together, not separately — they cover kill correctness,
lock freshness, and reap timing for the same underlying registry.

**AI-112 — kill the whole tree, not just the wrapper.** `worker-exec.ts`'s kill helpers
kill `child.pid` (the shell wrapper) AND every PID in `bgTaskMap` (the live descendant
set, refreshed each heartbeat from the real OS process tree) via the shared
`selectKillTargets()`/`killWorkerTree()` pair — never just the wrapper. The wrapper can
die (or be killed) while the real CLI child it spawned keeps running; killing only the
wrapper leaves that child alive with its registry row gone. `cleanupOrphanedWorkers`
(`worker-pids.ts`) already did this correctly for the startup-orphan case — the two
should not drift apart; a comment in each cross-references the other.

**AI-113 — every blackboard lock holder heartbeats its own row, nothing else's.**
`Blackboard.updateHeartbeat` matches on `(resource, agent, contextId)` all three
together — a heartbeat from `agent: 'agy'` cannot refresh a lock held under
`agent: 'telegram-bot'` on the same `resource`, even though they're both scoped to the
same topic. The bot's own topic-serialization lock therefore needs its own renewal:
`processUpdate` calls `startLockRenewal(resourceId, 'telegram-bot', contextId, ...)`
right after acquiring the lock and `.stop()`s it in the same `finally` that releases the
lock. **Do not remove this pairing** — without it, any dispatch phase with no worker
actively heartbeating (voice transcription, between failover attempts, the post-worker
send/DLQ tail) can silently outlive the 10-minute TTL (`PA_HEARTBEAT_STALE_MS`, see
`docs/CONFIGURATION.md`) and let a second update into the same topic. The renewal has its
own 6h cap (`PA_LOCK_RENEW_MAX_MS`) specifically so this doesn't become an
unconditionally-forever lock — a truly-hung dispatch (healthy event loop, an `await`
that never resolves) still eventually loses the lock via the normal TTL/purge path once
the cap stops renewal.

**AI-114 — the orphan sweep needs its own protection, not just the bot's.**
`pa/src/lib/maintenance/jobs/orphan-worker-reap.ts` calls `cleanupOrphanedWorkers()`
**every 60 seconds** from `pa catchup` — a completely separate process from the bot, with
no access to the bot's own `excludeSkills` protection set built at startup
(`main.ts`, still kept as defense-in-depth for a pre-upgrade bot binary during rollout).
Without its own protection, that sweep silently defeated AI-095's 45-minute
harvest window every time — reaping a crashed-spawner's still-replying worker within a
minute instead of leaving it the intended 45 minutes to finish and get its reply
harvested. Fixed by making protection intrinsic to the registry row itself: bot topic
dispatches stamp `harvestUntil` (via `RunOptions.harvestWindowMs`, 50 minutes) on their
worker-pid entry at spawn time, and `cleanupOrphanedWorkers` honors it regardless of
which caller invokes it. `pa run` skill dispatches don't set it and keep the original
kill-within-60s behavior.

## AI-096 (resource-starvation resilience)

Two deliberate deviations from library/framework defaults, both from July crash RCA —
do not "fix" either back.

1. `safe-lock.ts`'s shared `proper-lockfile` options set `onCompromised` to log instead
   of throw/kill-process, and `stale: 30s` — both July crashes were the library's default
   (throw-on-compromise) behavior under load.
2. `health.ts`'s self-health probe (event-loop lag + fs latency) drives a DEGRADED mode
   where `main.ts` sheds non-essential work (typing indicators, the topic-sweep,
   `compactDelivered`/session-GC) — but never the DLQ flush itself (see Delivery
   semantics above). `worker-exec.ts` additionally enforces machine-wide worker
   admission control via `PA_MAX_CONCURRENT_WORKERS` blackboard slots (evaluators
   exempt).
