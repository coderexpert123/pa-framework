# Worker-pid registry & topic-lock invariants — bot kill/reap correctness

Split from `docs/bot-reliability-internals.md` 2026-09-14 (budget-pressure
doctrine: a second trim inside 24h splits at the natural fault line instead of
shaving again). Read before touching `worker-pids.ts`, `worker-exec.ts`'s kill
helpers, blackboard lock renewal (`startLockRenewal`/`updateHeartbeat`),
`orphan-worker-reap.ts`, or the orphan-reaper's dead-dispatch arm — these
invariants cover kill correctness, lock freshness and reap timing for the same
underlying registry, and each was added after a real incident.

## Worker-pid registry & topic-lock invariants (AI-112/113/114, 2026-08-08)

Three related fixes from the same incident (a `/stop` that couldn't kill a real
62-minute `agy` dispatch). Read together, not separately — they cover kill
correctness, lock freshness, and reap timing for the same underlying registry.

**AI-112 — kill the whole tree, not just the wrapper.** `worker-exec.ts`'s kill helpers
kill `child.pid` (the shell wrapper) AND every PID in `bgTaskMap` (live descendants,
heartbeat-refreshed from the real OS process tree) via the shared
`selectKillTargets()`/`killWorkerTree()` pair. The wrapper can die while the real CLI
child keeps running; killing only the wrapper leaves that child alive with its registry
row gone. `cleanupOrphanedWorkers` (`worker-pids.ts`) already did this for the
startup-orphan case — the two must not drift; a comment in each cross-references the other.

**AI-113 — every blackboard lock holder heartbeats its own row, nothing else's.**
`Blackboard.updateHeartbeat` matches on `(resource, agent, contextId)` all three
together — a heartbeat from `agent: 'agy'` cannot refresh a lock held under
`agent: 'telegram-bot'` on the same `resource`. The bot's topic-serialization lock
therefore needs its own renewal: `processUpdate` calls
`startLockRenewal(resourceId, 'telegram-bot', contextId, ...)` right after acquiring the
lock and `.stop()`s it in the same `finally` that releases it. **Do not remove this
pairing** — without it, any dispatch phase with no worker actively heartbeating (voice
transcription, between failover attempts, the post-worker send/DLQ tail) can silently
outlive the 10-minute TTL (`PA_HEARTBEAT_STALE_MS`) and let a second update into the
same topic. The renewal's own 6h cap (`PA_LOCK_RENEW_MAX_MS`) keeps this from becoming
an unconditionally-forever lock — a truly-hung dispatch still loses the lock via the
normal TTL/purge path once the cap stops renewal.

**AI-114 — the orphan sweep needs its own protection, not just the bot's.**
`pa/src/lib/maintenance/jobs/orphan-worker-reap.ts` calls `cleanupOrphanedWorkers()`
**every 60 seconds** from `pa catchup` — a separate process with no access to the bot's
`excludeSkills` protection set (kept in `main.ts` as defense-in-depth for a pre-upgrade
bot binary during rollout). Without its own protection that sweep silently defeated
AI-095's 45-minute harvest window — reaping a crashed-spawner's still-replying worker
within a minute instead of leaving it 45 minutes to finish and get harvested. Fixed by
making protection intrinsic to the registry row: bot topic dispatches stamp
`harvestUntil` (via `RunOptions.harvestWindowMs`, 50 minutes) on their worker-pid entry
at spawn time, and `cleanupOrphanedWorkers` honors it regardless of caller. `pa run`
skill dispatches don't set it and keep the original kill-within-60s behavior.

**AI-241 — the dead-dispatch arm decides from the OS, not registry membership
(2026-09-14, t-31 drop-proof design).** `isTopicWorkerAliveOnMachine`
(orphan-reaper.ts; the `isTopicWorkerAlive` dep consulted at
`evaluatePendingDispatch` Step 1) treats the worker-pids registry as a HINT —
candidate pids to resolve — never the verdict, because it lies stale after bot
restarts in both directions (entry lingers while the process is dead; entry
gone while the process lives). Prong 1 resolves registered wrapper +
descendant pids against process-tree's shared snapshot (`areProcessesAlive`,
plus a `getDescendantPids` tree-walk when the descendants list is empty — the
30 s heartbeat gap); prong 2, reached only when prong 1 found nothing alive,
scans the snapshot's command lines (`findProcessesByCommandLine`) for the
record's session id and tee-path basename — the live-but-unregistered case.
A cmdline miss (POSIX snapshots carry none) is "no evidence", never positive
proof of death. Mirrors the pa-side `collectDispatchAliveTargets` contract.
