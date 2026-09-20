# Bot drains & queue discipline (extracted from the scoped brain 2026-09-03)

Auto-load pointer: the scoped brain links here. Extracted per the budget-pressure doctrine (fault-line split; root stays auto-loaded).

## The drains & maintenance surface

**Boot identity**: startup logs `dist identity sha=<12hex> mtime=<ISO>`
(`boot-identity.ts`), hashing `dist/main.js` ONLY (sibling-only dist changes don't move
the sha).

Read `docs/bot-reliability-internals.md` before touching reply delivery, the DLQ,
delivered-store dedup, pending-dispatches, the orphan-reaper, cancellation, or
health/DEGRADED shedding — its AI-092/AI-096 deviations are deliberate (**never "fix"
them back to defaults**, July crash RCA). **Restarts are invisible**: recovery QUEUES
follow-ups (never "please resend"), recovered replies ride normal `formatWorkerReply`,
exhausted recovery auto-requeues on a durable ladder (`requeue-drain`).

**Test-mode exit hook**: `runPollLoop()` ends via injectable `exitFn` (default
`process.exit`); a test that `await`s it MUST call `_setExitForTest(() => {})` first or
its file reads back dark. The no-op path drains `inFlight` first; production never
reaches it. AI-171 batch: the 5 bit-rot skips are fixed and un-skipped; the
only remaining suite skips are the 2 env-conditional `/code` guards in `logic.test.ts`
(run when `PA_REPOS_BASE` is set).

**Test teardown guard**: `waitForDrain()` is PARTLY ASPIRATIONAL (verified
2026-09-02): `trackPendingWork()` has ZERO call sites; 5 poll-loop afterEach hooks lack
the call. **Baseline-red scoped tests**: `/steer` (2 subtests) + `/update_brain` staging
are RED AT PRISTINE HEAD — scope around or diff vs HEAD baseline.
`telegram-keyboard.test.ts`'s `FetchResponse` demands `ok` even on throw-only stubs.

Declared bot jobs: log rotation, model sweep, compaction, proxy refresh,
grounding-check, registry-content-watch, alert-digest, dashboard-refresh,
**bot-self-restart** (idle-gated restart when dist is newer than the process;
`PA_BOT_SELF_RESTART=0` disables), queue-drain (WP-B: one 60s never-shed job; requeue/reminder/task/dlq sources).

**Maintenance kicks QUEUE, never overlap** (dlq-drain fix, 2026-09-03): a kick due while a prior pass is unsettled chains via `allSettled` behind it (main.ts kick block) — `runDueJobs` captures `now` once per pass, so an overlapping newer pass decides due-ness against the kicker's clock while the older pass holds the IN_FLIGHT slot (every decision lands skip:in-flight, wasting the only pass that saw the advanced clock — a cold-start-seeded 5-min source can then miss its window every pass). Kicks are never dropped; the runner's IN_FLIGHT guard stays the pa-host backstop.
- **`reminder-resume-drain` (AI-185, 60s)**: pops `~/.pa/pending-reminder-resume.json`,
  injects via `injectSystemReminderUpdate` (`__synthetic: 'system_reminder'`; text prefix
  `[System: reminder-triggered (queued <HH:MM> IST)]` — IST INSIDE the parens, SPEC §3.4
  byte-pinned with the oauth path G3). NOT cold-start-seeded — fires on the first tick
  after restart. Gotchas: logger entries serialize context FLAT (`entry.chatId`); the
  cold-start `updateJobState` name array does NOT gate registration
  (`createBotMaintenanceJobs`'s return array does). Type-branches BEFORE the above (AI-
  conversation-context reminder fix, 2026-09-12): a popped record with
  `resume_action.type === 'voice_inbox_resume'` skips `injectSystemReminderUpdate`/
  `allowedChatIds` entirely (that gate applies only to `topic_resume`'s Telegram target)
  and instead shells out to `projects/voice-inbox/scripts/create_conversation_task.py` to
  append a task into the `conversation_id` it carries, looked up fresh at fire time so it
  lands correctly even if the conversation's topic routing has since moved. Fail-open,
  same as every other source here: a spawn/parse/non-zero-exit failure is logged and
  swallowed, never crashing the drain.

**Task executor lane** (Wave-2 SPEC §3.1: `task-executor.ts` + `drainDueTopicTasks`):
**`topic-task-drain`** (60s) claims ≤2 tasks/tick globally off
`~/.pa/topic-tasks/<key>.json` into `<key>.running.json` — 2 slots/topic, stale
`running` >30 min → ready for EVERY enumerated topic before claims; ≤3 attempts,
10-min retry backoff; invalid prompt = WARN + failTask; foreign chats never claimed.
Dispatches never take the topic lock, never touch `state.turns`;
fire-and-forget (`activeTaskExecutions`). Task-lane PA_META = only `question` (parks
+ `qt:` keyboard), `watch_job`, `kb_note`, `run_skill`; `confirm_required` rejected.
RefKinds `task-pickup/done/retry/failed/question/route`; pickup/question ids are
reply anchors (reply → `routeReplyToTask` → `answerTask`; done completes the record
first); a `qt:` press answers the
parked task directly (convergence-not-injection). Human-lane `q:` flow:
`pending_question` gets `buildQuestionKeyboard` in the reply-send cascade
(pending-action confirm wins, failover wins); anchor `message_id` ONLY when
that keyboard attached (`!workerErrored && !wantsConfirm`); a `q:` press can't clear
the question — the injected option-text turn does; TTL is the only expiry.

