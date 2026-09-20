# Agentic Brain — Telegram Bot (`projects/telegram-bot/`)

Auto-loads on any read under `projects/telegram-bot/`.
**Publishes to the public mirror** — no personal data/secrets/private-only detail
(naming `bot-instructions.md` is fine). Provenance stays generic (A16 scrub):
never cite `plans/`/`backlog/`/`inventory/` paths — "the TOPIC design (DATE,
internal)" keeps date + topic without the path.

## Bot internals

- **`bot-instructions.md`**: appended to claude/zclaude spawns; **agy/codex NEVER receive
  it**; non-claude workers get `context.ts`'s thinner inline block. `## Factual
  Integrity`/`## Ref-IDs` stay claude/zclaude-only; `## Voice Messages` is triangle-pinned
  (orchestrator inline). Every-worker rules go in BOTH places — check by hand.
  Prompt-triangle bullets ship their verbatim-sync test in the SAME commit.
- Per-file detail: the repo's file inventory (root router). Graceful shutdown:
  `pa bot stop` (`~/.pa/telegram-bot.stop` sentinel).
- **Agent/model switching**: `/agent zclaude|claude|codex|agy|agyc` sets
  `preferred_worker` (session-scoped, expires IST midnight; `/model` legacy).
- **Turn routing policy** (`routing.ts`): when `routing_policy.enabled`,
  `applyRoutingPolicy` (main.ts, post-router, pre-lanes) classifies the operator's
  request code/general (`routing_policy.judge`) — a voice-inbox turn classifies its
  ledger request, not the injected text — and swaps the default
  worker: code → `code_worker` off-peak / `peak_code_worker` inside
  `cost_tier.peak_window_utc`. `/agent` pin > same-turn router change > policy >
  topic default > chain; fail-open. Detail: docs/CONFIGURATION.md § RoutingPolicyConfig.
- **Model-router orchestrator (one ask, 2026-09-19)**: on routed turns
  (`model_router.enabled`, non-command) ONE TypeSafe ask decides worker+model+effort
  and — when candidate/in-flight inputs are supplied — placement, steer/wait and a
  probability-ordered failover `chain`; the judge ladder does NOT run on routed turns.
  `deprecate_pins` defaults ON (block present) for TURN DISPATCH only: every pin surface
  (`/agent`, `/model`, `/effort`, `/default`, `worker_pin`) stops steering routed dispatch
  (commands still parse+reply; landed pins persist as stickiness incumbents).
  FIXTURE RULE: a test fixture carrying a `model_router` block that expects today's
  pin behavior must set `deprecate_pins: false` explicitly. Surfaces stage dark-first:
  `fallback` (chain at the failover seam), `steer` (router steer via steer-exec),
  `placement` (engine in `router-placement.ts` — flips with
  `surfaces.placement: live`, retires the persona branch for routed turns;
  `docs/bot-orchestrator-threads.md`). Detail: `docs/model-router.md`.
- **Dispatch failover** (`dispatch.ts`, AI-173): `dispatchMessage` (resume →
  preferred → default → `runWithFailover`), `tryClassifyAndNotify`,
  `buildDispatchExtraArgs` live here; main.ts re-exports for `../main.js`
  importers. The orchestrator lane runs the SAME cascade core; `executionMode=false`
  parse pin and AI-030 switch-back text are lane config, not mirrors.
  `maybeUpdatePinnedStatusAfterDispatch` takes `refreshCard` first. Poll-loop **enqueue
  normalizer** (`enqueue-normalizer.ts`): AI-095 placeholder write, `__skipVoice`
  (command-captioned media skips transcription), arrival prefetch, `__voiceResult`
  settle, stop flush-check, held absorb (`__heldAbsorbed`); steer fold + batch compile
  stayed in `runPollLoop`.
- **`runPollLoop` test seam (2026-09-14)**: `runPollLoop` calls `process.exit(0)` on natural loop exit. Poll-loop tests MUST call `_setExitForTest(() => {})` first — TAP output is otherwise cut mid-flush and the file registers as a dark file with no tests (the `poll-loop-callbacks.test.ts` incident).
- **Uniform tunables**: `/model`/`/effort` session-scoped; `/default` promotes to topic
  defaults; resolution session → topic → worker → CLI. Per-CLI: `tunables.<name>.args`
  (`{value}` substituted), `supersedes:` exclusive, clear tokens
  `clear`/`reset`/`default`/`unset`/`-`. Executor lanes honor `tunable_defaults` + a
  per-record `model` pin via `dispatch.ts buildTopicTierExtraArgs`; session overrides stay
  human-lane-only.
- **WS3 provenance env (2026-09-18)**: executor lanes stamp `PA_WORKER_CLI/_MODEL/_EFFORT`
  via `dispatch.ts buildWorkerProvenanceEnv` → `RunOptions.getEnv`; worker-exec evaluates
  getEnv with EACH failover hop's own WorkerConfig, so the ledger records the worker that
  actually ran, never the first-chosen one. Keys land AFTER `filterSecretsForWorker` — they
  survive secret_allowlist stripping while static `RunOptions.env` keys do not. PA_TASK_ID
  rides the same hook. task_telemetry.py records them into the ledger (schema v15);
  resolution mirrors buildTopicTierExtraArgs. Unstamped lanes ⇒ NULLs ⇒ PWA chip fails
  open. The thread lifecycle RE-READS the record before building
  opts — pins live in the STORE, not on a local fixture. The router-metadata wave
  (2026-09-20) extends the same hook: the dispatch cascade's `getEnv` addition stamps the
  seven `PA_ROUTING_*` keys (built by `buildRoutingProvenanceEnv`), and thread spawns
  persist them on `ThreadRecord.routing`.
- **Steer mechanics — one owner (2026-09-19)**: the inline `/steer` mechanics
  (stop-marker + PID-captured kill + queued-entry drain + no-source recovery +
  own-audio prefetch + steerContext handoff) live in `steer-exec.ts
  executeSteer` — the poll-loop handler AND the model-router steer surface
  (`model_router.surfaces.steer: 'live'`, wired in processUpdate) call the SAME
  function; the §4.3 per-turn double-fire guard (`markRouterSteered`/
  `takeRouterSteered`, frozen footer `_(steer already applied by routing)_`)
  lives there too. Never fork a second fold. Detached kill/recovery promises ride
  runPollLoop's `inFlight` set (poll-loop-detached-tracking invariant now spans both
  files).
- **Deterministic command interception**: `/new`, `/code`, `/status`, `/skills`, `/help`,
  `/health`, `/ref <id>`, `/claims`, `/debug` (operator-gated) intercept in `processUpdate`
  pre-dispatch. The cascade lives in `command-router.ts`: `runCommandRouter(input, deps)`
  runs expiry → unknown-command guard → /auth → user-turn archive → command family →
  /update_brain, returns the six extraction fields. A single-token unknown slash
  command gets a local `Unknown command` reply, never a worker; new commands join
  `isKnownCommand`. Five deps are REQUIRED main.ts-locals; the rest inject real defaults.
- **Per-topic grounding sources**: `/sources` declares per-topic grounding files,
  injected on fresh human/thread/task dispatches (orchestrator: names-only pointer) via
  the `## Topic sources` section — verbatim ≤4000 chars/source in a ≤12000-char section;
  oversize/missing sources render named pointer/UNAVAILABLE lines, never silence. Content
  is framed untrusted (anti-forgery markers) and secret-redacted; declarations survive
  `/new`/`/reset` (`/sources reset` clears); resumed/execution-mode prompts excluded.
- **Prompt-triangle bullets (2026-09-13/14)**: live prompt surfaces = `context.ts` inline + `task-executor.ts` TASK_RULES + `examples/bot-instructions.example.md` + gitignored live `bot-instructions.md` (hand-synced); every bullet below is byte-identical across all four, `includes()`-pinned in `context.test.ts` (apostrophe-free: `'` breaks the pin). Bullets: **Browser-MCP** (in-session tools; WaitForMcpServers first); **Visual-answer** (rich shapes over prose walls); **Promises-need-a-mechanism** (spawn dependent or watch_job first); **Progress-posting** (task_telemetry --event task.progress); **PA_META envelope wire** (agy/codex + thread spawns see only TASK_RULES; Types: thread question/confirm/watch_job, task adds kb_note/run_skill); **task_complete flags** (--short lead, --recap/--next); **Summary standard** (plain OUTCOME, never receipts; ledger guard refuses); **Blocker escalation** (screenshot + task_blocker_ask.py + end turn); **Operator-commands** (pa pointers).
- **Orchestrator threads (AI-203; default-on AI-215)**:
  DEFAULT-ON for every topic — a keyless topic state (new topics, `/branch`)
  orchestrates; the session becomes a pure orchestrator and execution runs in
  spawned threads (`~/.pa/topic-threads/<chatId>_<threadId>.json`).
  `/orchestrator off` = explicit opt-out (persists `orchestrator_enabled = false`,
  clears the session); the gate reads `state.orchestrator_enabled !== false`
  (no state migration). Cancellation is resolved (AI-216 exact-resource kill + scoped
  `cancelOneThread`); residual risk is aggregate backpressure. Mechanics:
  `docs/bot-orchestrator-threads.md`.
  - **`buildOrchestratorPrompt` (FRESH prompt) must interpolate `userMessage`** (fixed
    2026-09-09; latent since AI-203 WP-2 — fresh dispatches reached the worker with NO user
    content; the fresh prompt is built once, reused by every failover attempt). Header tests
    miss a missing interpolation — diff the fresh/resumed twin, pin the passed-in text.
    Records: `docs/bot-incident-records.md`.
  - **Command discovery invariant** (2026-09-06): every local command needs a `BOT_COMMANDS`
    row (it IS the menu and /help) and a guard-known form; `/stop`//`/steer` exempt
    (intercepted pre-router).
  - Threads emit topic events (ref=t-<n>; NOT task-lane activity); `takePendingInput`
    makes steer drain atomic. Replying to a thread FYI steers it (raw anchor;
    pending_action outranks); AI-209 batches withhold reply-shaped entries. Cap 10/topic,
    FIFO spawn queue — `claimThreadStarts` is the ONLY queued→running start; steer_thread
    queue|interrupt (interrupt kills via runSeq signal + thread-scoped kill, restarts
    folded in); one reply may fan out N spawns+steers in envelope order.
  - **Wall-park (2026-09-12)**: a zero-attempt "no workers available" dispatch parks the
    thread (`queued` + future `parkedUntil`, attempts not counted) instead of burning the
    2-attempt ladder; ladder 5/15/30/60 min, valve at 6 parks; one `⏸` FYI per episode.
    Revival is timerless: `claimThreadStarts` gate + 60 s reconcile + the cooldown-expiry
    event (`clearWorkerCooldown` rewinds `parkedUntil`). Terminal failures mark carried
    `voiceTaskIds` failed; success closes still-open voice tasks after a 180 s grace (the
    worker's richer closure wins). Sweep refusal/deferral rules:
    `docs/bot-orchestrator-wallpark.md`.
  - **Model-requestable deps (2026-09-13)**: `spawn_thread` gains `depends_on` (≤3
    `t-<n>` ids) — park a dependent spawn on a shared subproblem. Three fail-open layers:
    `sanitizeSpawnDependsOn` → `handleSpawn` unions with the auto-dedup twin (twin first) →
    createThread's sanitizer intersects with real ids; an unknown id = plain spawn.
  - **Executor-lifetime pump unref'd + footer fixtures need distinct goals (2026-09-14)**:
    the WP-H pump is never the exit-blocking handle — an executor that never settles (a
    stalled FYI double, a hung dispatch) hangs the runner past its last test though all
    passed. A spawn whose goal exactly matches a live thread's takes the AI-232 twin-dedup
    footer, not the plain footer the tests pin — fixture goals stay per-thread distinct.
- **Voice-inbox bridge** (`/pair`, drain, cancel/steer, pin self-heal, ask mirroring, transcription/typed-route holds): `projects/telegram-bot/VOICE-INBOX-BRIDGE.md` (normative; "Ask mirroring" carries the three-valued mirror-error split — `awaiting_input` stays FIRST, also starts with `task `). **Transcription (2026-09-16)**: the poll tick calls `voiceTranscribeDrain.kick()`, sync and unawaited, just before `routeQueueDrain()`; the route drain HOLDS a plain entry whose task is `transcribing` (`taskStatesFn`) and drops it on `transcribe_failed`. Never await transcription, a log flush or `updateJobState` on the tick.
- **Auto topic descriptions**: LLM-set on creation/branch; names rewritten every
  change — hand edits survive only stop-edit-restart.
- **Google OAuth reauth**: `/auth <code> [state]` intercepts pre-archival, exchanges via
  `finish_google_telegram_reauth.py`, deletes the code message, relaunches the saved
  `resume_action` via `oauth.ts`; **read the OAuth outage incident record first**.
  `/reauth [skill]`: local, never LLM-inferred — spawns `start_google_telegram_reauth.py
  --reuse-pending`; link 12 h; `[skill]` retries via `--resume-skill`. `/secret <request-id>
  <value>`: the provider-generic twin — same deleteMessage + `[redacted]` archive, value
  piped to `pa auth answer` on stdin, never argv (docs/bot-interactivity.md).
- **Inline buttons / callbacks**: a press is a typed command injected as a synthetic
  message (`callbacks.ts`) — button and typing can't diverge; keyboards are
  removed/rewritten after a press (AI-192: ackSelection re-attaches a fresh cc: submenu —
  `editMessageText` strips keyboards otherwise; cc: presses toast only; card refresh writes
  state into the pin). Prefix/action/gate table incl. `ow:`: `docs/bot-interactivity.md`
  (single source; new prefixes join `callback-grammar.ts`).

- **PA_META envelope**: LLMs append `[PA_META]: {"actions":[...]}` as the last line.
  Parse ladder in `parseMetadata` (`worker-reply.ts`): plain →
  lone-backslash repair (sets `repaired` → orchestrator footer) → lenient
  sanitize-and-reparse: strips raw C0 except `\n`, re-runs the
  repair; wins carry no `repaired` flag; structural defects fail loud via `parseError`.
  **Unknown action types reject LOUDLY (2026-09-15)**: the `{"type":"T",...}` template
  placeholder is gone from all four surfaces (a model copied it verbatim and the action
  vanished silently) — the loop warns `unknown PA_META action type` and footers
  `_(action dropped: unknown type '…')_`; `PA_META_DOWNSTREAM_TYPES` types ride through.
  A mojibake envelope still means the encoding class (worker-exec `StringDecoder`, see
  pa's brain).
  **`run_skill` is authorization-gated**: git-workflow family + `self-improver` never
  fire from PA_META (`PA_META_PROTECTED_SKILLS`, mirrors pa's `PROTECTED_SKILLS`);
  roster renders via `renderSkillRosterSection` on human/task/orchestrator lanes — never
  threads.
  **Replies are delivered UNREDACTED (AI-184)** — the operator's chat
  keeps real text; the scrub lives on the persistence/worker-read seams (root brain's
  redaction rule). **`watch_job`**: shape-validated via pa's single `validateWatchInput`;
  `main.ts` AWAITS `addWatchJob`, appending the id or rejection — never silent,
  read-only, no shell (ARCHITECTURE § Async watch jobs).
- **Multi-chat**: `TELEGRAM_CHAT_ID` comma-separate — supergroups negative, DMs positive.
- **Test rules**: `docs/bot-test-rules.md` (10 rules) — read before writing bot tests.
- **Output cleaning**: `workers.ts` trims Gemini stdout; `worker-reply.ts` strips
  thought-block/planning markers (AI-173 phase 6; `logic.ts` re-exports).
- **Premature-async-reply guard (AI-202)**: `isPrematureAsyncReply`
  (`worker-reply.ts`) suppresses a contentless "launched, waiting"
  promise at EVERY parseMetadata delivery site — `dispatch.ts`, `orphan-reaper.ts`
  ×4, `task-executor.ts` (retry ladder, never the completion FYI). Gated
  `meta === null` so a promise + registered `watch_job` is never suppressed; new
  parseMetadata consumers MUST call it.
- **Raw-send guard**: cross-topic delivery goes through `pa notify --topic-thread`,
  NEVER raw Bot API calls. The contract is byte-synced `context.ts` inline block ↔
  `examples/bot-instructions.example.md` (sync test in `context.test.ts`), mirrored in
  the task lane's `TASK_RULES`. pa's `detectRawTelegramSends` alert is best-effort.
- **Task-lane FYI parity (2026-09-04)**: the `✅ Task done` completion FYI runs
  `normalizeMarkdown` before the 3500-char cap — same pipeline as the human lane's
  `buildWorkerResponse`; keep the two in step.
- **Self-restart busy check (2026-09-16)**: `boundBotSelfRestart` (`maintenance-jobs.ts`)
  writes the stop sentinel only when `shouldSelfRestart` sees every busy signal at 0, incl.
  `pollLoopInFlight` — the live size of `runPollLoop`'s in-process `inFlight` Set. A turn
  joins that Set before classification and leaves only in `.finally()` on settle, so it
  counts busy across the window before a pending-dispatch record or topic lock registers
  (the gap a live incident exploited). Callback handlers and detached
  `/stop`/steer-recovery blocks ride the same Set; no
  `void (async` may live in `runPollLoop` (pinned: `poll-loop-detached-tracking.test.ts`).
- **Deployment**: Task Scheduler cadence, BotFather rotation on persistent 409,
  launcher + staleness watchdog: `docs/bot-launch-cadence.md` — read before launcher
  work. The node launch is UNAWAITED (2026-09-13: `IgnoreNew` refused later ticks
  behind an awaited launcher); only the `tasklist` gate may await.
- **Standalone Python (Task Scheduler)**: no inherited bot env — self-contained
  `_load_secrets()` parsing `~/.pa/secrets.env` (`os.environ` wins); never hardcode
  tokens/chat IDs; sign-parse per Multi-chat.
- **agy native resume**: agy topics resume native conversations (`--conversation <id>`,
  captured on success, kill-drop on cancel); `AGY_NATIVE_RESUME_EXCLUDED_TOPICS` = off.
- **Same-turn KB notes**: on `PA_KB_SOURCES_PATH` — workers write `kb_note` facts via PA_META.
- **Voice transcription**: voice → transcribe → same text pipeline (`voice.ts` never
  throws; optional IPC; Python cloud-first; gc 30d). Transcription at ARRIVAL —
  the transcript becomes the queue entry's text (AI-092). A confident transcript match
  becomes the typed command at arrival (AI-191); inference = safe allowlist only; voice
  never reaches /stop//steer.
- **Batched uptake at natural drain (AI-209)**: at the END of the topicPending turn-start
  callback (after held-absorb, before processUpdate), one compile folds ≥2 queued PLAIN
  messages into ONE combined dispatch, send order. A queued slash-command never folds as
  text and BOUNDS the batch; a voice head never folds — it dispatches alone;
  followers batch next drain. heldForTopic lands on each follower's durable record at
  consume time; the prompt carries `[msg <id>]` headers; /stop or /steer mid-turn
  holds the WHOLE combined text. Fold-test pin: `docs/bot-test-rules.md`.
- **Archive joins**: join bot turns on `(thread_id, update_id)`, never `run_id`;
  task-lane traces join on `task_ref` (passed as `resource: 'task-' + id`);
  no bot code may be edited to "help" this join.
- **Recall + decisions**: `topic-pointers.ts` owns the brain/recall/decisions pointer
  lines + `## Live reservations` on every executor lane (orchestrator: spawn-voice,
  no reservations); thread/task prompts carry them between the task block and
  `## Rules`. `rm:` presses write decisions.sqlite rows; reactions fill outcome;
  `bot-instructions.md` never rides git.
- **Topic brains**: bot READS only (`topic-brains.ts`, fail-to-absent; fresh-dispatch
  pointer only); nightly consolidation is the single writer. Exempt registry
  `$PA_HOME/topic-brains/EXEMPT.json`: hard classes (`output-only`/`duplicate`/`one-off`/
  `pinned-guide`) skip nightly work + refuse `/update_brain`; `dormant` (30d) skips while
  stale. Workdir cascade `cwd_override` > brain Project pointer > topic home > BOT_CWD
  (agy/agyc/codex stay repo-root via shim pins; claude/zclaude per-topic dirs).
  `/update_brain` stages `.staged/{topicKey}.md`; refuses thread-0 + hard-exempts.
Incident records: `docs/bot-incident-records.md` — read before re-litigating any covered behavior.
- **Feedback Rules**: `context.ts` injects `## Standing rules` (12-rule/1500-char
  cap); `rules-critic.ts` logs violations per reply. CLI: `pa rules`.

## Reliability internals

Drains/queue/maintenance: `docs/bot-drains-queue.md`. Reliability/DLQ/reaper/DEGRADED: `docs/bot-reliability-internals.md`.

- **Orphan reaper covers thread records (2026-09-14)**: `reapOrphanedThreads`
  (orphan-reaper.ts) settles records a crash left `running` — launched AFTER the awaited
  orphan-kill pass (ordering load-bearing); runSeq-gated settles, honest-note settles fail
  OPEN on the ledger read. Outcomes + idempotency: `docs/bot-orchestrator-threads.md`.
- **No cap on thread results or sweep summaries (2026-09-13, vi-d935e5e13537)**:
  `lastResult` is stored verbatim (no 4000 slice); the late voice-closure sweep passes
  it to the ledger uncapped — it renders as the operator's answer card, which tiers
  long answers itself. Never reintroduce a length cap on this path; send-side surfaces
  cap at their own limits. Gotcha: a verifier mutation pass left `return; // MUTATION (c)`
  atop `sweepSettledVoiceTaskClosures`, disabling the sweep tree-wide — mutation passes
  MUST revert; red-first proofs on a mutated tree prove nothing
  (record: `docs/bot-incident-records.md`).
- **Routing ownership is set by WHERE, never by transient state (2026-09-16)**:
  a routing thread never closes a voice task it routed elsewhere (`routedTo`
  set), whatever the task's non-terminal state — the destination owns the
  answer. The sweep also defers a never-routed task (`routedTo` null: pa's
  fallback places it) and any `awaiting_input` task (closing cancels the ask);
  a `state === 'routed'` check let the thread race ahead once the destination
  started.


