# Agentic Brain — Telegram Bot (`projects/telegram-bot/`)

Auto-loads on any read under `projects/telegram-bot/`; carries bot-internal detail.
**Publishes to the public mirror** — no personal data/secrets/private-only detail
(`bot-instructions.md` excluded; naming it is fine). Provenance references in
comments/strings stay generic (A16 scrub, 2026-09-04): never cite `plans/`,
`backlog/` or `inventory/` paths — "the TOPIC design (DATE, internal)"
keeps date + topic without the path.

## Bot internals

- **`bot-instructions.md`**: appended to claude/zclaude spawns; **agy/codex NEVER receive
  it**; non-claude workers get `context.ts`'s thinner inline block. A rule for every
  worker goes in BOTH places — check by hand. Prompt-triangle bullets
  ship their verbatim-sync test in the SAME commit.
- Per-file detail: the repo's file inventory (router at repo root). Graceful shutdown:
  `pa bot stop` (`~/.pa/telegram-bot.stop` sentinel).
- **Agent/model switching**: `/agent zclaude|claude|codex|agy|agyc` sets
  `preferred_worker` (session-scoped, expires IST midnight; legacy `/model` works).
- **Dispatch failover**: the cascade lives in `dispatch.ts` (AI-173 phase 3, 2026-09-06):
  `dispatchMessage` (resume → preferred → default → `runWithFailover`; four /stop
  cancellation exits) and `tryClassifyAndNotify` moved verbatim; main.ts re-exports them +
  `buildDispatchExtraArgs` for existing `../main.js` importers. The orchestrator lane runs
  the SAME cascade core (AI-203 R10 closed; rate-limit ledger stamping included); the
  `executionMode=false` parse pin and AI-030 switch-back text are lane config, not mirrors.
  The pinned-status-card cluster stayed in main.ts (phase-5 seam candidate);
  `maybeUpdatePinnedStatusAfterDispatch` takes `refreshCard` as its first parameter.
  The poll-loop **enqueue normalizer** lives in `enqueue-normalizer.ts` (AI-173 phase 4,
  2026-09-06): the AI-095 placeholder write, `__skipVoice` (command-captioned media skips
  transcription), arrival prefetch, `__voiceResult` settle, stop flush-check and held
  absorb (`__heldAbsorbed`) moved verbatim; the steer fold and batch compile stayed in
  `runPollLoop` between them; `placeholderDispatchText` is re-exported.
- **Uniform tunables**: `/model`/`/effort` session-scoped; `/default` promotes to topic
  defaults; resolution session → topic → worker → CLI. Per-CLI: `tunables.<name>.args`
  (`{value}` substituted); `supersedes:` exclusive; clear tokens
  `clear`/`reset`/`default`/`unset`/`-`.
- **Deterministic command interception**: `/new`, `/code`, `/status`, `/skills`, `/help`,
  `/health`, `/ref <id>`, `/claims`, `/debug` (operator-gated) intercept in `processUpdate`
  pre-dispatch. The cascade
  lives in `command-router.ts` (AI-173 phase 2, 2026-09-06): `runCommandRouter(input, deps)`
  runs expiry → unknown-command guard → /auth → user-turn archive → command
  family → /update_brain, returns the six extraction fields; `main.ts` assigns and
  continues at /branch. A single-token slash command matching nothing gets a local
  `Unknown command` reply, never a worker (guard runs first; new commands must join
  `isKnownCommand`). Five deps are REQUIRED main.ts-locals
  (full list in the command-router inventory row); the rest inject with real defaults.
- **Per-topic grounding sources**: `/sources` declares per-topic grounding files;
  `context.ts`'s `## Topic sources` section (via `sources.ts`) injects content into
  every fresh dispatch — verbatim ≤4000 chars/source inside a ≤12000-char section
  (budget consts in `sources.ts`), oversize/missing sources render named
  pointer/UNAVAILABLE lines, never silence. Source content is framed untrusted
  (extended-dash anti-forgery markers) and secret-redacted (`redactSecrets`);
  declarations survive `/new` and `/reset` (`/sources reset` clears); injection is
  `buildPrompt`-only — resumed and task-lane prompts are excluded (grounding v2,
  2026-09-06, internal).
- **Orchestrator threads (AI-203, increment 1, 2026-09-06)**: `/orchestrator on|off|status` arms
  per-topic mode — the topic session becomes a pure orchestrator (interpret → route →
  report; no capabilities block; never executes) and execution runs in spawned threads stored at
  `~/.pa/topic-threads/<chatId>_<threadId>.json`; `/orchestrator off` = instant rollback.
  Full mechanics (validators, thread store, executor ladder, /stop + runSeq semantics,
  session-capture single-source): `docs/bot-orchestrator-threads.md` (2026-09-06).
  main.ts wires interception (post-router), dispatch branch, handlers.
  - **Command discovery invariant** (2026-09-06): every local command needs a `BOT_COMMANDS`
    row (it IS the menu and /help) and a guard-known form (router pin); `/stop`//`/steer` exempt
    (intercepted in the poll loop pre-router).
  - Increment 2 (2026-09-06): threads emit topic events (thread_spawned/steered/completed/
    failed/cancelled, ref=t-<n>; NOT task-lane activity); `takePendingInput` makes steer drain
    atomic (persist-failure-safe); thread dispatches strip `--append-system-prompt-file`
    (RunOptions.stripArgs); `/orchestrator status` shows updated-age + queued counts.
  - Increment 3 (2026-09-06): replying to a thread FYI steers that thread (raw reply anchor; pending_action outranks via pre-consume snapshot; ack archives worker 'local' after the fallback chain); AI-209 batches withhold/gate reply-shaped entries (W4); pin card Threads line; done-FYI reply hint; stop-hold lane keeps no reply shape (anchor loss there = next-increment candidate).
  - Increment 4 (2026-09-07): cap 10/topic with a FIFO spawn queue (status 'queued'; claim is the only start — steer-wakes included); steer_thread gains mode queue|interrupt — interrupt kills the in-flight run (runSeq signal + thread-scoped kill) and restarts with the message folded in; one reply may fan out N spawns+steers in envelope order (dr.routes).
- **Voice-inbox bridge: `/pair` (allowed chats only) mints an 8-char pairing code and
  writes `~/.pa/voice-inbox/pairing-codes.json` (bare JSON array — copy
  `projects/voice-inbox/scripts/mint_pairing.mjs` verbatim, schema canonical there;
  the app's `exchangePairingCode` is its only consumer). It also drains
  `~/.pa/voice-inbox/route-queue.jsonl`: each line is injected as a synthetic turn tagged
  `__synthetic: 'route'` (`message_id: 0`, no anchor), then the queue is rewritten
  minus the consumed lines (consume-after-inject: a crash pre-rewrite re-injects
  on restart; accepted). The drain takes the writers' proper-lock across
  read→inject→rewrite (a concurrent append can never be clobbered); wiring: a
  one-poll-tick local closure beside the 60 s `BotMaintenanceDeps`
  seams plus ONE `await` before `drainInjectedUpdates()`. **Pin self-heal (2026-09-06)**:
  `refreshPinnedStatusCardInPlace` re-asserts `pinChatMessage` on the SAME message id
  after every successful in-place edit (topic pins are write-only in the Bot API);
  re-assert count == the fixture's successful-edit count (poll-loop: 1 on id 42;
  integration-extra: 2 on id 100 — derive per fixture).
- **Auto topic descriptions**: LLM-set on creation/branch; registry-internal; names
  rewritten every change — hand edits survive only stop-edit-restart.
- **Google OAuth reauth**: `/auth <code> [state]` intercepts pre-archival (archived
  `/auth [redacted]`), exchanges via `finish_google_telegram_reauth.py`, deletes the code
  message, relaunches the saved `resume_action` via `oauth.ts`; **read the
  OAuth outage incident record before touching this flow**. `/reauth [skill]`: local,
  never LLM-inferred — spawns `start_google_telegram_reauth.py --reuse-pending`;
  link 12 h; `[skill]` retries via `--resume-skill`.
- **Inline buttons / callbacks**: a press is a typed command injected as a
  synthetic message (`callbacks.ts`) — button and typing can't diverge; keyboards are
  removed/rewritten after a press (AI-192: ackSelection re-attaches a fresh recorded
  cc: submenu — `editMessageText` strips keyboards otherwise; cc: presses toast only;
  the card refresh writes state into the pin).

  The full prefix/action/gate table lives in `docs/bot-interactivity.md` (single
  source; it mirrors `callbacks.ts`, and new prefixes join `callback-grammar.ts`).

- **PA_META envelope**: LLMs append `[PA_META]: {"actions":[...]}` as the last line.
  **`run_skill` is authorization-gated**: the git-workflow family + `self-improver`
  never fire from PA_META (`PA_META_PROTECTED_SKILLS`, mirrors pa's
  `PROTECTED_SKILLS`). **Replies are delivered UNREDACTED (AI-184, 2026-09-03)** — the
  operator's own chat keeps real text; the scrub lives on the
  persistence/worker-read paths (`conversation.ts addTurn`, `dlq.ts appendDlq`,
  logger contexts, rules-critic excerpts). **`watch_job`**: `logic.ts`
  shape-validates via pa's single `validateWatchInput`; `main.ts` AWAITS `addWatchJob`,
  appending the id or rejection — never silent. Read-only, no shell; read the
  async-watch design record before touching this path.
- **Multi-chat**: `TELEGRAM_CHAT_ID` comma-separate — supergroups negative, DMs positive; parse by sign.
- **Test rules** (7 rules: .ts-only src/tests; MdV2 bodies + stale-dist fail-closed + never latch where process.exit can fire + EXACT-equality pins; settled-end-state for fire-and-forget lanes; synthetic-id fixtures): extracted to `docs/bot-test-rules.md` (2026-09-07 split, budget-pressure contract response — same shape as the orchestrator-threads extraction).
- **Output cleaning**: `workers.ts` trims Gemini stdout; `logic.ts` strips
  thought-block/planning-header markers.
- **Premature-async-reply guard (AI-202, 2026-09-04)**: `isPrematureAsyncReply`
  (`logic.ts`) suppresses a contentless "launched, waiting" promise (the CLI-harness
  option-B outcome) at EVERY parseMetadata delivery site — `dispatch.ts` (blanked into
  the empty-response error), `orphan-reaper.ts` ×4 (next source),
  `task-executor.ts` (retry ladder, never the completion FYI). Always
  gated `meta === null` so a promise + registered `watch_job` is never suppressed;
  new parseMetadata consumers that post to a topic MUST call it.
- **Raw-send guard (2026-09-04)**: cross-topic delivery contract (`pa notify
  --topic-thread` only; NEVER raw Bot API calls) is byte-synced `context.ts` inline
  block ↔ `examples/bot-instructions.example.md` (sync test in `context.test.ts`)
  and mirrored in the task lane's `TASK_RULES`. pa's `detectRawTelegramSends`
  attaches `rawTelegramSends` to CommandResult; `dispatch.ts` fires ONE best-effort
  pa-support alert — alert-only, never blocking.
- **Task-lane FYI parity (2026-09-04)**: the `✅ Task done` completion FYI runs
  `normalizeMarkdown` before the 3500-char cap — same pipeline as the human lane's
  `buildWorkerResponse`; keep the two in step.
- **Deployment**: Task Scheduler, `-MultipleInstances Ignore`; persistent 409 → rotate via BotFather.
- **Standalone Python (Task Scheduler)**: no inherited bot env — self-contained
  `_load_secrets()` parsing `~/.pa/secrets.env` (`os.environ` wins); never hardcode
  tokens/chat IDs; sign-parse per Multi-chat
  (`projects/coding-dirs-updater/update_coding_dirs.py`).
- **agy native resume**: agy topics resume native conversations (`--conversation <id>`,
  captured on success, kill-drop on cancel); `AGY_NATIVE_RESUME_EXCLUDED_TOPICS` = off.
- **Same-turn KB notes**: on `PA_KB_SOURCES_PATH` — workers write `kb_note` facts via PA_META.
- **Voice transcription**: voice → transcribe → same text pipeline (`voice.ts` never
  throws; optional IPC; Python cloud-first; gc 30d). Transcription at ARRIVAL —
  the transcript becomes the queue entry's text (/stop//steer semantics, AI-092).
  **AI-191 voice commands**: a confident transcript match becomes the typed command
  at the stage; inference = safe allowlist only; voice never reaches /stop//steer.
- **Batched uptake at natural drain (AI-209, 2026-09-06)**: at the END of the
  topicPending turn-start callback (after held-absorb, before processUpdate), one
  compile folds ≥2 queued PLAIN messages into ONE combined dispatch in send order.
  A queued slash-command never folds as text and BOUNDS the batch (enqueue-time
  isCommand + compile-time prefix test on resolved transcripts); a voice head never
  folds — it dispatches alone so the attachment stage cannot overwrite a batch
  prompt; followers batch next drain). heldForTopic lands on each follower's
  durable record at consume time; the prompt carries `[msg <id>]` provenance
  headers; /stop or /steer mid-turn holds the WHOLE combined text. Test pin: an
  idle-topic same-getUpdates-batch pair NEVER folds — the per-update saveState
  yield runs the head's whole turn before the follower registers; fold tests
  must hold an in-flight turn first.
- **Archive joins**: join bot turns on `(thread_id, update_id)`, never `run_id`;
  task-lane traces join on `task_ref` (dispatch resource) — it already
  passes `resource: 'task-' + task.id`; no bot code may be edited to "help" this join.
- **Recall + decisions**: the recall/precedent bullets are byte-identical across the
  prompt triangle (sync test, `context.test.ts`). `rm:` presses write decisions.sqlite
  rows; reactions fill outcome. The gitignored `bot-instructions.md` never rides git —
  hand-sync on merge.
- **Topic brains**: bot READS only (`topic-brains.ts`, fail-to-absent; pointer line on
  fresh dispatches only); nightly consolidation is the single writer. Exempt registry
  `$PA_HOME/topic-brains/EXEMPT.json`: hard classes (`output-only`/`duplicate`/`one-off`/
  `pinned-guide`) skip nightly work + refuse `/update_brain`; `dormant` (30d) skips while
  stale. Workdir cascade `cwd_override` > brain Project pointer > topic home > BOT_CWD
  (agy/agyc/codex stay repo-root via shim pins; claude/zclaude per-topic dirs).
  `/update_brain` stages `.staged/{topicKey}.md`; refuses thread-0 + hard-exempt.
Incident records (harvest-vs-stale verdict, AI-199 env-leak root cause, teardown-guard wiring map, renderOpenItems fail-to-absent proof, DLQ terminal drop): `docs/bot-incident-records.md` — read before re-litigating any covered behavior.
- **Feedback Rules**: `context.ts` injects `## Standing rules` (12-rule/1500-char
  cap); `rules-critic.ts` logs violations to `rules-violations.jsonl` per reply. CLI:
  `pa rules`.

## Reliability internals

Drains/queue/maintenance: `docs/bot-drains-queue.md` (extracted 2026-09-03). Reliability/DLQ/reaper/DEGRADED: `docs/bot-reliability-internals.md`.


