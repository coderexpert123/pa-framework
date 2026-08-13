# Maintenance job catalog — operational detail

Extracted from CLAUDE.md during a 2026-08-07 `/shorten-brain` pass. The governing rule
("any recurring work that mutates durable state beyond one in-flight operation must be a
declared `MaintenanceJob`, not a bare timer") stays in CLAUDE.md's Standards &
Conventions section. This file is the full current job catalog — read it before adding,
removing, or debugging a maintenance job.

## Catchup -> Maintenance Runner -> declared jobs (AI-100, 2026-08-02)

`pa catchup`'s maintenance phase is one call — `runDueJobs('pa', jobsForHost('pa'), ...)`
— driving 10 declared jobs (`pa/src/lib/maintenance/registry.ts`: `orphanWorkerReapJob`,
`blackboardPurgeJob`, `stalenessCheckJob`, `skillLogRotateJob`, `archivePruneJob`,
`alertStateGcJob`, `weeklyLearnJob`, `sessionGcJob`, `voiceAttachmentGcJob`, and
`reservationGcJob` — the last added 2026-08-06 as part of the multi-session coordination
protocol, GC'ing expired rows in `~/.pa/reservations.json`) against the ledger
`~/.pa/maintenance-state.json`, un-gated by topic (fixed a live bug:
`alert-state-gc`/staleness migration had never run in production because it was gated on
`!opts.topic` while both registered scheduled tasks pass `--topic`).

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
