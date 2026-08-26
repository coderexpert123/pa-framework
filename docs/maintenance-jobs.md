# Maintenance job catalog — operational detail

Extracted from CLAUDE.md during a 2026-08-07 `/shorten-brain` pass. The governing rule
("any recurring work that mutates durable state beyond one in-flight operation must be a
declared `MaintenanceJob`, not a bare timer") stays in CLAUDE.md's Standards &
Conventions section. This file is the full current job catalog — read it before adding,
removing, or debugging a maintenance job.

## Catchup -> Maintenance Runner -> declared jobs (AI-100, 2026-08-02)

`pa catchup`'s maintenance phase is one call — `runDueJobs('pa', jobsForHost('pa'), ...)`
— driving 17 declared jobs (`pa/src/lib/maintenance/registry.ts`: `orphanWorkerReapJob`,
`blackboardPurgeJob`, `stalenessCheckJob`, `skillLogRotateJob`, `archivePruneJob`,
`alertStateGcJob`, `weeklyLearnJob`, `sessionGcJob`, `voiceAttachmentGcJob`,
`workerTeeGcJob`, `reservationGcJob` — added 2026-08-06 as part of the multi-session
coordination protocol, GC'ing expired rows in `~/.pa/reservations.json` — `restoreDrillJob`,
`alertCensusJob`, `clobberSentinelJob`, `redteamRecurringJob`, `reviewConflictButtonsJob`,
and `recallIndexJob`) against the ledger
`~/.pa/maintenance-state.json`. **Total declared registry, both hosts: 25 jobs (17 pa +
8 bot)** as of the 2026-08-24 recall-traces wave (`docs/ARCHITECTURE.md`'s "Turn-trace
sidecar" / "Recall" sections; also see `pa/tests/maintenance-registry.test.ts`'s pinned
counts). The pass is deliberately not gated on `!opts.topic` (fixed
a live bug: `alert-state-gc`/staleness migration had never run in production because it was
gated that way while both registered scheduled tasks pass `--topic`). **Single-tick gate
(2026-08-23):** both registered Task Scheduler tasks fire every minute
(`catchup --topic default` and `catchup --topic reminders`), and each used to run this
whole pa-host pass — roughly doubling every job's due-check rate. `catchup.ts` now runs
the pass only from the `--topic default` invocation; cadence itself is still owned by each
job's own declaration and enforced against the ledger, so this gate only picks which of
the two per-minute invocations drives it.

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
these skills during that window by design; a time-pinned cron gets no widening, matching
`partitionOverdueByCostTier`'s own behaviour. The dedup key is transition-keyed —
`stalenessDedupKey`, a sha1 of the sorted stale-skill-name set — so the alert fires on a
CHANGE of the stale set rather than resending every tick with a new hours-ago number.

**`skillCadenceAuditJob` (added 2026-08-17, retired 2026-08-23).** Its threshold
(max(2× interval, 26h)) was always ≥ staleness-check's, so it could only ever fire
strictly later about a skill staleness-check had already reported. Its `[PARKED]`
annotation labelled the alert text but never `continue`d past it, so a parked skill was
still alerted — once from staleness-check, once from skill-cadence-audit, and once from
the AI-098 parked-skill page itself. This section previously claimed the annotation
"avoided double-reporting"; that claim was false, and the retirement above is the fix.

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
- `bot-self-restart` (2026-08-24, 60s — see its own entry below)

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

**`recallIndexJob` (2026-08-24, recall-traces wave, pa host):** runs every 10 minutes
(`shedWhenDegraded:true`) and incrementally refreshes `~/.pa/recall.sqlite` (FTS5, via
`better-sqlite3` in-process — no Python, no spawn) from `conversation-history.jsonl` +
rotated shards, `turn-traces.jsonl` + rotated shards, per-topic brains, the Ecosystem KB
directory, and `review-digest-pending.jsonl`. Non-destructive: no retention targets — the
DB is fully derived and rebuildable with `pa recall --rebuild`. Throws on `ok:false`
rather than swallowing it, so a broken index retries on the AI-098 backoff ladder instead
of hammering the store every tick. Note: `recall-store.ts` opens and closes a fresh
`better-sqlite3` connection per operation (WAL mode) — seeing `recall.sqlite-wal` on disk
mid-operation is expected, not a sign of a leaked handle. Full design:
`docs/ARCHITECTURE.md` § "Recall (`pa recall`, 2026-08-24)".

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
