# Orchestrator threads — wall-park on worker unavailability + voice-task surfacing

Split from `docs/bot-orchestrator-threads.md` on 2026-09-13 (budget pressure; content
unchanged, just relocated). Read together with that file — its "read before touching"
rule applies here too (`thread-executor.ts`, `topic-threads.ts`).

## Wall-park on worker unavailability (2026-09-12)

A thread whose dispatch returns the zero-attempt exhaustion error
(`NO_WORKERS_AVAILABLE_ERROR` from pa's worker cascade, matched by exact
equality) parks instead of failing: the record goes back to `queued` with a
future `parkedUntil` stamp and an episode counter `unavailableParks`, and the
attempt is NOT counted. Backoff ladder 5/15/30/60 minutes; after 6 parks in one
episode (≈ 3 h 50 m of backoff; 2026-09-13, lowered from 24 to surface sooner)
the next wall outcome fails the record directly — one attempt, the park count
preserved — with the count in the reason. Exactly one `⏸ … parked` FYI posts per
episode; pa's per-resource all-workers-rate-limited alert covers the rest. Every
real outcome (done, retry, failed) resets the counter. `claimThreadStarts`
skips queued records whose stamp is in the future (absent/past/unparseable =
claimable), so the 60 s reconcile drain is the revival mechanism — plus the
cooldown-expiry event below — no new timer. Notes: the park FYI is deliberately
not reply-to-steer anchorable; a `/stop` during a park keeps the stamp, so a
later steer-revival honors the remaining backoff (≤60 min); the drain-cap park
(`MAX_AUTO_RESUMES_PER_CHAIN`) is a different mechanism and writes no stamp.

The stamp has a second writer since 2026-09-13: the lazy stale demotion
(`demoteStale` in `topic-threads.ts`) requeues a 30-min-silent running record
as `queued` with a 5-minute stamp instead of failing it — a bot restart or
crash no longer strands in-flight threads terminally. The record claims itself
once the grace elapses, and the re-claim's own thread FYI is the visibility;
`unavailableParks` stays the wall-park valve's counter and is not touched by
the restart-requeue.

Revival is event-driven since 2026-09-13: the poll-tick drain reads pa's
cooldown ledger (`getCooldownStatus`) before the reconcile, and an entry whose
`cooldown_until` has passed is the "model is back" event — cooldown end times
come from the worker error messages themselves, so they are exact knowledge,
not estimates. On the event the tick evicts the entry via `clearWorkerCooldown`
(unblocking the dispatch cascade for that model) and `wakeWallParked`
(`topic-threads.ts`) rewinds `parkedUntil` to now on every wall-parked record,
so the same tick's reconcile re-claims them immediately. The event fires once
per cooldown by construction: eviction is the fired marker, and a still-limited
retry records a new cooldown with a new end — the next event. A wrong end
self-corrects through one retry-probe-repark cycle.

## Terminal failures surfaced to the voice-inbox ledger (2026-09-13)

A thread record carrying `voiceTaskIds` no longer leaves those tasks promising
work in the app after the thread dies. Every terminal `failed` write — the
2-attempt ladder exhausted AND the wall-park valve — marks each carried task
failed through the worker scripts' telemetry verb
(`task_telemetry.py --event task.failed`), which writes the `task.failed` event
the app renders and moves the task to `failed` through the mirrored transition
table. The call is best-effort, never blocks the failed write; its outcome rides
the `❌ Thread … failed` FYI. Success adds a one-line footer naming the surfaced
tasks. A `task …`-prefixed rejection (the app was reached and refused) adds a
declined notice; anything else is a reach-failure notice — the same split ask
mirroring uses. Parks and ladder retries never surface: a park means the work is
still queued, not dead.

A completing thread owes the same duty in reverse — as a late sweep, not an
immediate close (2026-09-13 race fix). The worker's own `task_complete.py`
call carries the full summary, so an executor closure fired the moment the
thread settles can win the race and lock the task to a 200-char slice of
`lastResult`; the worker's richer closure then bounces off the already-terminal
guard. The closure instead rides the 60 s reconcile pass: for every `done`
record with `voiceTaskIds` whose `updatedAt` — the settle time — is at least
`THREAD_VOICE_CLOSE_GRACE_MS` (180 s) old, still-open tasks are closed through
the same completion verb (`task_complete.py --task <id> --summary`, the
summary `lastResult` verbatim and uncapped). The grace exists so the
worker's own richer closure wins the race; the auto-closure is the fallback,
not the preemptor. Tasks the ledger already shows terminal are skipped, and
the terminal read does not even happen inside the grace. A refusal from the
verb (the worker closed it in the meantime) and a reach failure are both
logged, never sent, and neither blocks the reconcile pass.

Some still-open tasks are never this record's to close. A task routed to another topic belongs to
that destination. A task with no `routed_to` was never routed: an inbox routing run progressed it
and settled without `route_task.py` (2026-09-16, `vi-d79c09c5eb37`), so the sweep defers and pa's
`voice-inbox-fallback` job owns placing it. A task in `awaiting_input` defers too, because
`task_complete.py` cancels every pending ask in its conversation. The record's reply never stands
in for an answer these tasks have not yet received.

Voice-closure refusals and deferrals (2026-09-15). `lastResult` is passed verbatim, and a routing
thread's result is a process receipt `task_complete.py`'s summary guard refuses (`parser.error` →
exit 2) — every reconcile re-sent the identical string, wedging the task open. On the
`\bexited 2\b` signature the sweep retries ONCE with `THREAD_VOICE_REFUSED_RESULT_NOTE` (the
honest no-answer note); non-refusal failures stay single-attempt. The defer returns
`VOICE_CLOSE_DEFERRED_ROUTED`, never the raw refusal error, so the caller skips the warn branch —
the raw error would log a spurious "could not reach the Voice Inbox app" warn.

A settle can also leave a carried task unrouted. When a thread settles `done` and a carried task
still has no `routed_to` (state `received` or `running`), pa's `returnVoiceTaskForRouting` moves it
to `routed` for this thread's topic, with `routing_reason` set to `VOICE_ROUTE_RETRY_REASON`. The
retry message then rides the record's `pendingInput`, so the drain runs it as the next resumed turn.
Because `routed_to` is never cleared, a task is returned at most once.

The reconcile sweep covers settles the executor could not act on: a restart, or a task still
transcribing at settle. It acts only on a record under an hour old with no executor in flight and
nothing queued. If the retry run also ends unrouted, the sweep defers, and pa's
`voice-inbox-fallback` job places the task.
