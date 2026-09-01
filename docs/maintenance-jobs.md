# Maintenance job catalog — operational detail

Extracted from CLAUDE.md during a 2026-08-07 `/shorten-brain` pass. The governing rule
("any recurring work that mutates durable state beyond one in-flight operation must be a
declared `MaintenanceJob`, not a bare timer") stays in CLAUDE.md's Standards &
Conventions section. This file is the full current job catalog — read it before adding,
removing, or debugging a maintenance job.

## Catchup -> Maintenance Runner -> declared jobs (AI-100, 2026-08-02)

`pa catchup`'s maintenance phase is one call — `runDueJobs('pa', jobsForHost('pa'), ...)`
— driving 21 declared jobs (`pa/src/lib/maintenance/registry.ts`: `orphanWorkerReapJob`,
`blackboardPurgeJob`, `stalenessCheckJob`, `skillLogRotateJob`, `archivePruneJob`,
`alertStateGcJob`, `weeklyLearnJob`, `sessionGcJob`, `voiceAttachmentGcJob`,
`workerTeeGcJob`, `reservationGcJob` — GC's expired rows in `~/.pa/reservations.json`
(2026-08-06) — `restoreDrillJob`,
`alertCensusJob`, `clobberSentinelJob`, `redteamRecurringJob`, `reviewConflictButtonsJob`,
`recallIndexJob`, and `sharedTmpSweepJob`, `skillEngagementAuditJob`, `watchJobsRunnerJob`
and `workerEditAuditSweepJob`) against the ledger
`~/.pa/maintenance-state.json`. **Total declared registry, both hosts: 31 jobs (21 pa + 10 bot)** as of the 2026-09-01 AI-175 wave (`docs/ARCHITECTURE.md`'s "Turn-trace
sidecar" / "Recall" sections; also see `pa/tests/maintenance-registry.test.ts`'s pinned
counts). The pass is deliberately not gated on `!opts.topic` (fixed
a live bug: `alert-state-gc`/staleness migration had never run in production because it was
gated that way while both registered scheduled tasks pass `--topic`). **Single-tick gate
(2026-08-23):** both per-minute Task Scheduler tasks (`--topic default`, `--topic
reminders`) used to run this whole pa-host pass, doubling every job's due-check rate;
`catchup.ts` now runs it only from `--topic default` — job cadence is still owned by each
declaration, enforced against the ledger.

**`orphanWorkerReapJob` harvest-window carve-out (AI-114, 2026-08-08):** this job calls
`cleanupOrphanedWorkers()` with no `excludeSkills` — it runs every 60 seconds from a
separate process (`pa catchup`) with no access to the bot's own startup-time protection
set, so it used to silently defeat AI-095's 45-minute harvest window for a
crashed-spawner's still-replying worker. Protection is now intrinsic to the registry row
itself (`WorkerPidEntry.harvestUntil`, stamped by dispatch callers that pass
`RunOptions.harvestWindowMs`) rather than caller-supplied, so this job automatically
honors it without needing its own `excludeSkills` set. See
`docs/bot-reliability-internals.md`'s "Worker-pid registry & topic-lock invariants"
section for the full mechanism.

**`stalenessCheckJob` is THE dead-man's switch (updated 2026-08-23):** runs every minute
(`shedWhenDegraded:true`) and alerts when a scheduled skill's last success is older than
max(2× its cron interval, 30 min). Parked skills (AI-098: consecutive failures ≥5) are
skipped entirely — `catchup.ts` already pages a separate "Skill parked after repeated
failures" alert for them, so reporting them here too would be a third copy of one
condition. `cost_tier: off_peak` periodic skills (cron has no fixed hour/minute, i.e. not
time-pinned) get their threshold widened by the 4h z.ai peak-billing window
(`isPeakWindow`, `scheduler.ts:28`), since `partitionOverdueByCostTier` defers exactly
these skills during that window by design (default Mon-Fri 06:00-10:00 UTC, overridable via
`cost_tier.peak_window_utc`); a time-pinned cron gets no widening, matching
`partitionOverdueByCostTier`'s own behaviour. The dedup key is transition-keyed —
`stalenessDedupKey`, a sha1 of the sorted stale-skill-name set — so the alert fires on a
CHANGE of the stale set rather than resending every tick with a new hours-ago number.

**`skillCadenceAuditJob` (added 2026-08-17, retired 2026-08-23)** double-paged parked
skills against `stalenessCheckJob`, so it no longer exists.

Built after an undeclared bot timer deleted 248 real Claude Code transcripts — full
audit + governing rule in `plans/2026-08-02-maintenance-framework.md`; enforced in CI by
`pa/tests/timer-inventory.test.ts`, which fails the build on a new undeclared timer.
Wave 1 is `pa`-host only.

**Wave 2 (2026-08-02, DONE)** migrated the bot's remaining poll-loop timers onto the same
runner via a new `projects/telegram-bot/src/maintenance-jobs.ts`
(`createBotMaintenanceJobs(deps)`, constructed per-process since bot jobs close over a
runtime token/chatIds/sentinelPath that don't exist until secrets load — `pa`'s static
registry can't express that, so `jobsForHost('bot')` staying empty is by design, not a
gap):

- `dlq-flush` (5m, `shedWhenDegraded:false` — it IS reply delivery)
- `delivered-store-compact` (5m)
- `model-override-sweep` (60s, injected not imported — avoids a `main.ts` import cycle)
- `bot-log-rotation-check` (10m, replaces the old magic-literal self-restart check)
- `proxy-pool-refresh` (env-driven, `shedWhenDegraded:false`)
- `grounding-check` (2026-08-05, AI-101, 6h, pattern-matches every topic's `description`
  for clobber-shaped text — ends in `?`, leaked bot-reply phrases,
  `[Voice message]`/`[ATTACHMENT:` artifacts — and pages pa-alerts deduped; deliberately
  does NOT flag a merely-missing description, a separate larger pre-existing gap, to
  avoid alert fatigue)
- `registry-content-watch` (2026-08-22, R10, 24h, asserts content invariants on topic
  descriptions — Path-0 pointer in 9855, no Palo Alto hallucination in 3376, routing
  gate in 7822; pages pa-alerts deduped on violation)
- `dashboard-refresh` (2026-08-28, 30m — re-renders the system-dashboard pinned message
  and updates `~/.pa/telegram-dashboard.json`. Non-destructive: reads, edits, re-pins.
  Skips when the dashboard was never bootstrapped (no chat_id/message_id state).
  Real implementation lives in bot's `maintenance-jobs.ts`; pa-side stub is for
  `pa maintenance list` visibility.)
- `bot-self-restart` (2026-08-24, 60s — see its own entry below)
- `requeue-drain` (2026-08-27, 5m, `shedWhenDegraded:false` — it IS request recovery,
  mirroring `dlq-flush`; seamless-restart-recovery wave): re-injects parked requeue-ladder
  dispatches whose `requeueNotBefore` backoff has elapsed — increments the persisted
  `requeueCount` BEFORE injecting (crash-safe), clears the park, injects the original
  request as a synthetic update through the full normal dispatch path. Cancels parked
  records whose topic received a `/stop` during the window. Declared INLINE in the bot's
  `maintenance-jobs.ts` (registry-content-watch precedent — no pa-tree stub; the pa-side
  registry count is test-pinned). Cold-start-seeded alongside `dlq-flush`.

`health-probe` was deliberately EXCLUDED — its 15s cadence is incompatible with the poll
loop's 30s long-poll floor and would falsely trigger permanent DEGRADED.
`pa/tests/timer-inventory.test.ts`'s scan now also covers `projects/telegram-bot/src`
(105 files total).

The poll loop's kick is a plain time throttle (`MAINTENANCE_KICK_INTERVAL_MS`, 20s)
decoupled from whether the previous pass has settled — NOT a `!maintenancePass` in-flight
gate — relying on the runner's existing per-job `IN_FLIGHT` guard for correctness; a
settlement-gated design silently broke re-evaluation under `poll-loop.test.ts`'s
near-instant mocked `getUpdates` (found and fixed during Wave 2 integration).

Cold-start seeding (`dlq-flush`/`delivered-store-compact`/`proxy-pool-refresh` stamped as
"just ran" at loop entry) preserves the pre-Wave-2 asymmetry where those three never
fired on the very first tick, while `model-override-sweep`/`bot-log-rotation-check` still
fire immediately — do not seed those two. `grounding-check` (added 2026-08-05) is also
NOT cold-start-seeded — same reasoning as `model-override-sweep`/`bot-log-rotation-check`.

**`restoreDrillJob` (2026-08-17, Wave D):** runs monthly (30d cadence, `shedWhenDegraded:true`)
and performs a verify-only restore drill. Downloads the newest `pa-secrets-*.pab` from Drive,
decrypts to a C: temp directory (never touches live `~/.pa`), validates file formats
(env files parse as KEY=VALUE, JSON files parse, SQLite files have magic header), and
reports pass/fail + duration to the ledger. Also checks the newest `pa-fitness-*.fab`
blob age and header; reports stale (>90 days) or invalid. All deterministic, no LLM.
Implementation: `pa/scripts/run_restore_drill.py` reuses Drive client and decrypt functions
from `backup_secrets.py` by import.

**`clobberSentinelJob` (2026-08-17, Wave D):** runs every 30 minutes (30m cadence, `shedWhenDegraded:true`)
and detects working-tree files reverted to an ancestor of HEAD. Imports the same detection function
as `pa reconcile --check` directly (no CLI shelling). Pages pa-alerts deduped per-file when drift
is found. Skips while `@build` or git-workflow locks are held (mid-commit reconcile reads are racy).
Never mutates anything — pure detection + notification only.

**`redteamRecurringJob` (2026-08-18, Wave G):** runs monthly (30d cadence, `shedWhenDegraded:true`)
and executes prompt-injection redteam regression tests against deterministic defense layers only
(no LLM). The script `pa/scripts/redteam_injection.py` tests three layers: (1) credential redaction
(`pa/src/lib/redact.ts`) verifies sk-/Bearer/ghp_/AIza/xoxb token patterns are redacted,
(2) PA_META protected-skill gate (`bot PA_META_PROTECTED_SKILLS`) rejects git-workflow skill
forgeries (commit/push/push-public/commit-and-push/investigate-flagged/update-brain), and
(3) legitimate PA_META envelopes (positive controls) pass unharmed. Fixture corpus contains
~25 adversarial inputs across all classes. On failure, pages pa-alerts deduped. Deterministic,
no LLM calls.

**`alertCensusJob` (2026-08-23, Wave J1):** runs daily (24h cadence, `shedWhenDegraded:true`)
and builds a 7-day census of alerts sent and suppressed per family, joined with owner
health. Writes `~/.pa/alert-census.json` for the self-improver and the weekly digest to
consume. Non-destructive: no retention targets. Pages pa-alerts at most once per day, only
when that day's alert volume is at or above `PA_ALERT_CENSUS_NOTIFY_PER_DAY` (default 50
sends/day).

**`reviewConflictButtonsJob` (2026-08-24, buttons program WP-P4):** runs daily (24h cadence,
`shedWhenDegraded:true`) and, for every unresolved conflict in
`~/.pa/review-digest-pending.jsonl` not yet posted, sends one message with an inline
`Accept A | Accept B | Ignore` keyboard (`mc:<conflictId>:a|r|x`, operator-gated), then
marks it posted so the daily tick never re-sends. Non-destructive: no retention targets.
The bot's button press spawns `pa/scripts/review_digest_action.py --conflict-id <id>
--action accept|reject|ignore`, the single writer of that file.

**`sharedTmpSweepJob` (2026-08-28, wave-4 tractable, pa host):** runs hourly (3_600_000 ms cadence,
`shedWhenDegraded:true`) and sweeps stale leak artifacts from the shared test scratch directory
(`PA_TEST_TMP_DIR`, default `C:/wt/tmp` on Windows). Destructive with one RetentionTarget: deletes
files/directories older than 1 hour that match the pattern allowlist `^(replay_lock_|render_lock_|pytest-of-)/`.
Pattern precision + age floor protect in-flight runs; durable session baselines live under
`C:/wt/<session>/` and `C:/wt/backup/` (outside the match set). Ownership class: `external-no-retention`
(Claude-session scratch; no tool owns retention here). Dated evidence: 2026-08-28 disk-full incident —
shared test scratch accumulates replay_lock/render_lock/pytest-of-* artifacts with no retention owner.
Implementation: `pa/src/lib/maintenance/jobs/shared-tmp-sweep.ts`.

**`recallIndexJob` (2026-08-24, recall-traces wave, pa host):** runs every 10 minutes
(`shedWhenDegraded:true`) and incrementally refreshes `~/.pa/recall.sqlite` (FTS5, via
`better-sqlite3` in-process — no Python, no spawn) from `conversation-history.jsonl` +
rotated shards, `turn-traces.jsonl` + rotated shards, per-topic brains, the Ecosystem KB
directory, `review-digest-pending.jsonl`, and `~/.pa/decisions.sqlite` (AI-164 decision
rows, indexed by rowid watermark). Non-destructive: no retention targets — the
DB is fully derived and rebuildable with `pa recall --rebuild`. Throws on `ok:false`
rather than swallowing it, so a broken index retries on the AI-098 backoff ladder instead
of hammering the store every tick. Note: `recall-store.ts` opens and closes a fresh
`better-sqlite3` connection per operation (WAL mode) — seeing `recall.sqlite-wal` on disk
mid-operation is expected, not a sign of a leaked handle. Full design:
`docs/ARCHITECTURE.md` § "Recall (`pa recall`, 2026-08-24)".

**`skillEngagementAuditJob` (2026-08-27, AI-168):** runs monthly (30d cadence,
`shedWhenDegraded:true`) and builds a census of skills with zero user-facing engagement
for ≥90 days (no successful run, no decision rows). Writes `~/.pa/skill-engagement.json`
for the weekly digest's Retire? section. Non-destructive: no retention targets. Report-only
by design — never deletes, disables, or unschedules anything.

**`botSelfRestartJob` (2026-08-24, recall-traces wave, bot host):** the pa-side registry
entry (`pa/src/lib/maintenance/jobs/bot-self-restart.ts`) is a metadata-only stub — it
exists so `pa maintenance list`/`status` and the pinned `MAINTENANCE_JOBS` count see the
job; running it via `pa maintenance run bot-self-restart` always returns
`{touched:0, detail:{unbound:true}}` and never restarts anything. The real, bound
implementation lives in `projects/telegram-bot/src/maintenance-jobs.ts`
(`boundBotSelfRestart`), runs every 60 seconds (`shedWhenDegraded:true`), non-destructive.
It restarts the bot — by writing the same `~/.pa/telegram-bot.stop` sentinel `pa bot
stop` uses, never in-process — only when ALL of: the newer of `pa/dist/.build-stamp` and
`projects/telegram-bot/dist/.build-stamp` is newer than this process's start time, past a
60-second grace window, the `@build` reservation is not held, and the bot is idle (no
in-flight dispatch, no topic carrying a `pending_action`, no blackboard `topic-*` lock
held by this PID). `PA_BOT_SELF_RESTART=0` disables it entirely
(`docs/CONFIGURATION.md`). If the dist stamp stays newer for 30+ minutes without the bot
ever going idle, it logs and pages a `bot-stale-code` warning instead of restarting.

**Archive-prune allowlist extended (2026-08-24, recall-traces wave):** rotated
`-turn-traces.jsonl` shards are now included in `archivePruneJob`'s target (via
`PRUNABLE_ARCHIVE_SUFFIXES` in `pa/src/lib/archive-files.ts`) and prune at the same 90
days as the other rotated log/archive shards — they are derived debugging data, not a
permanent record like the conversation-history shards.

**`watchJobsRunnerJob` (AI-170, 2026-08-31):** 60 s, pa host — the ONE runner for every async
watch (never a job per watch, never a bare timer). Read-only checks only (`file_exists`/
`file_gone`/`file_newer_than`/`file_contains`/`process_gone`) because an LLM registers these:
no shell, no network, no writes. 10 per tick, 25 active. Every terminal state but a cancel
SENDS, and the send precedes the status write. `shedWhenDegraded: false`; row-level target on
`~/.pa/watch-jobs.json`, pruned 14 d after `terminalAt`. Mechanics:
`plans/2026-08-31-ai170-async-watch-SPEC.md`.

**`workerEditAuditSweepJob` (added 2026-09-01, AI-175).** Every 15 minutes, closes
dispatch edit-audit windows the bot never closed — it crashed or restarted mid-dispatch.
A window whose `botPid` is dead closes immediately; one whose PID is alive closes after
`PA_WORKER_EDIT_WINDOW_MAX_MS` (2 h). Closing takes the after-snapshot, filters findings
against active and recently-released reservations, and emits at most one `Unreserved
worker edits` alert. Windows live in `~/.pa/worker-edit-audit/`; the retention target is
the 24 h backstop for a window the sweeper could not parse. Design:
`plans/2026-09-01-ai175-worker-edit-enforcement-SPEC.md`.
