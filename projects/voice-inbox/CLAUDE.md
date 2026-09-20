# Agentic Brain — voice-inbox (`projects/voice-inbox/`)

Auto-loads on touch. Voice-task inbox app: Node 22 + TS ESM,
Python worker scripts, `node:http` server, no framework, no bundler — PWA + localhost
API: spoken/typed requests → tenant-scoped ledger → Telegram topics via a JSONL route
queue. Per-file detail: the repo inventory router.

RULES ONLY here. Mechanics/stories/harnesses: `FEATURE-NOTES.md`. Contracts:
`CONTRACTS.md`. Ops: `docs/voice-inbox-operations.md`; server lifecycle:
`docs/voice-inbox-server-lifecycle.md`. Config fields: `docs/voice-inbox-config.md`.

## Runtime state — `~/.pa/voice-inbox/`

- `ledger.sqlite` — source of truth. `openLedger()` applies schema v16 idempotently
  (the v1→v2 rebuild, the marker-gated v9 `input_requests` `form` CHECK rebuild, the
  additive v3/v4/v7/v8/v10–v16 columns — v15 `worker_*` provenance, v16 the seven
  `router_*` routing-metadata columns — and v14's one-time view stamp), never demotes
  `user_version`.
- `route-queue.jsonl` (cross-process), `pairing-codes.json` (reader/consumer only),
  `answers/` + `files/` (ledger stores pointers, never values), `logs/`,
  `server.lock` (launcher liveness gate — ops doc).

## Load-bearing contracts

- **Answer register (operator, 2026-09-14)**: every operator-facing text (summaries, cards, questions, status) is PLAIN language — no ids, schemas, exit codes, JSON, or technical terms. Telegram is NEVER mentioned: it is backing/logging infrastructure, invisible to the reader. Where something arrived, say "your inbox".
- **Ledger**: the only source of truth; every change is a row. Python workers open
  the SAME sqlite (WAL) and never create — missing file/schema
  errors `ledger missing: start the server first`. Every query takes
  `tenant_id` — no un-scoped accessor.
- `ledger.ts`'s transition table is the only
  state gate; python mirrors it and moves state ONLY via the shared helper's
  `transition_task` (its UPDATE predicate is the gate, never read-then-write).
  `LEDGER_SCHEMA_SQL`'s exact text is pinned. `awaiting_input` never completes;
  `task_complete.py` expires only its OWN asks and sets `next_action` only as the
  thread's newest task.
  Entering `routed` clears `worker_resource`/`worker_dispatch_id` in-transaction;
  terminal states keep identity as history — read STATE, never presence.
- **Voice pipeline** (2026-09-16): the server is a PIPE — it holds no secrets, calls no
  transcription provider and runs no transcription; keep it so. Voice POST →
  `files/<id>/audio.<ext>` + task `transcribing` + the inbox route entry. The BOT process
  transcribes: its poll-tick drain (pa `voice-inbox-transcribe-drain.ts` — sync `kick()`,
  never awaited, 3 slots, attempt deadline, exec process tree killed at its timeout) calls
  pa `voice-inbox-transcribe.ts`, the ONE transcription implementation the pa fallback job
  also calls, under the blackboard claim `voice-inbox-transcribe:<task_id>` →
  `task_transcribe.py` → `received` / `transcribe_failed`. The bot's route drain HOLDS a
  plain entry while its task is `transcribing` and drops it on `transcribe_failed`: routing
  workers never transcribe and never wait. AI-239 `task.failed` `code`: `too_short` =
  audio-unusable (terminal, PWA-hidden); `infra` on a STILL-`transcribing` task =
  NON-TERMINAL attempt marker (appendEvent), retries paced 2/5/10 min off the newest
  marker, bounded 4 markers / 45 min, then terminal `--code infra` + a page.
  - The pa fallback is a BACKSTOP whose lane can stall silently — never a correctness
    guarantee. Contract: CONTRACTS.md "Voice transcription and the cleaned request". VAD
    zero decoded turns = nothing-audible. Route-queue entries (inbox routing, not this
    hold) inject directly as synthetic updates; `STEER_MESSAGE_MAX` gates only steer
    entries. The bridge-writer stress render's 16,000-char check is a self-imposed
    regression guard, not an enforced cap.
- **Cleaned request**: `transcript` = IMMUTABLE raw ASR (speech-to-text). The routing worker may rewrite
  `request_text` via `task_request.py clean` (`received` only, voice only, growth-capped,
  no event) — cleanup, never authorship; best-effort, a failure leaves the raw text. The
  PWA renders `request_text` with the raw words one tap away ("Your exact words").
- **Worker selection is NOT this app's job**: `route_task.py` routes to a TOPIC; the
  bot's turn-routing policy applies downstream — no worker fields in the route
  contract.
- **Route-stage topic formation (2026-09-14)**: `route_task.py --create-topic` forms a
  topic only when the CALLER (today: the deterministic fallback) found no fit — the
  router never judges fit. Name: deterministic noun phrase (first ≤6 meaningful
  words, ≤40 chars, `New work <UTC date>` on garbage; NO LLM naming in v1).
  Same-named topic is REUSED (setup-topics' same-name skip), never duplicated; a
  matched topic lacking a description gets one backfilled. Mint: createForumTopic
  direct-first (token from env else `secrets.env`, redacted in errors; proxy pool
  only on provable pre-connect failure), then the setup-topics registry write
  (tmp+rename) as `{"name","description"}`. NO volume cap by design. ANY failure →
  the caller's `--topic` bucket with a reason note (`formed <name>: <why no match>` /
  `existing topic matched: <name>`); placement never depends on formation. The name
  seeds the initial conversation title (never-overwrite). `--create-topic` +
  `--continues` is a parse error. `VOICE_INBOX_TELEGRAM_API_BASE` is a TEST-ONLY
  seam; both suites (`test_worker_scripts.py`, pa `voice-inbox-fallback.test.ts`)
  drive the REAL subprocess. Callers passing --create-topic: the LLM routing turn,
  the pa fallback's received arm, and the typed routing action (pa
  voice-inbox-typed-route-action.ts, a confident no-match).
- **Routed-ask loopback (2026-09-14)**: the route stage NEVER closes the task
  it routed — both inbox texts teach "route it and stop; never run
  task_complete.py for it". Only the DESTINATION closes (worker task_complete.py
  from `routed`, or the bot's late closure sweep) — that completion is what
  carries the answer back to the operator's card. An early route-stage close is
  terminal: the destination's answer is refused (`done -> done`) and the card
  keeps the receipt. Never-injected routes stay the pa `voice-inbox-fallback`
  job's business (replay + page), NOT a closure sweep. So is a route stage
  that stops unrouted (`running`, no `routed_to`): retried once, then placed or failed. Pins:
  `tests/test_route_loopback.py`, `bridge-writer.test.ts`, bot
  `thread-executor.test.ts` T-SWEEP-7/8.
- **Surface provenance** (operator directive): every prompt states its origin
  surface; the worker tailors to it. Voice-inbox = OUR OWN PWA (long-press, capture
  sheets, any UI change possible); Telegram = Bot-API-constrained — never answer a
  voice-inbox request with Telegram constraints. Renders in `buildTargetInjectionText`
  + `route_task.py` + both inbox texts — pins move as one.
- **Seven-kind widget boundary**: `validateInputRequest` allows exactly
  `secret | text | choice | oauth | file | confirm | form`, exact-key params — unknown
  fields reject, hostile input never throws. The model writes only `prompt` copy/labels;
  `oauth.auth_url` is NEVER model-supplied. Answers validated per kind, never echoed
  (fixed ack); `file` multipart. `answerAndResume` every-caller rule (AI-221):
  CONTRACTS.md + auth-broker doc.
- **Form widget** (`form`, schema v9): the one-sheet questionnaire — `params.steps`
  1..8, one Submit sends
  `{kind:"form",answers:{<stepId>:…}}` for non-locked steps only; the server composes
  locked answers itself, one canonical JSON per step id through the unchanged
  value path. Full contract: CONTRACTS.md + `plans/2026-09-14-form-widget-SPEC.md`;
  workers create via `task_input.py create --kind form --steps-file <path>`.
- **Blocker escalation** (2026-09-14): a page the worker cannot control
  (captcha/login/consent) → `scripts/task_blocker_ask.py --task --screenshot
  --prompt [--options "a|b|c"]`, then END the turn. The script copies the
  screenshot into `files/<task_id>/` (blocker- prefix; the dir listing IS the
  registration) and asks via the `task_input.py create` subprocess — the only
  creator (it never opens the ledger). A refused ask keeps the screenshot as
  evidence. Resume is answerAndResume's steer (needs worker_resource), NOT the
  received-fallback. `context.test.ts` pins the prompt bullet.
- **Live screencast** (AI-246, 2026-09-14): the worker spawns
  `scripts/screencast_bridge.mjs --task <id>` in the background to CDP-stream
  the page it is on into an IN-MEMORY store (`screencast-store.ts`,
  newest-frame-only, TTL-evicted) — frames NEVER touch `files/<task_id>/` or
  any disk surface. Token split: the bridge POSTs with the shared
  `screencast_ingest_token` (Bearer, NOT a session, cross-tenant task-id
  authority); the PWA pulls with the paired-device Bearer (tenant-scoped).
  `taskDetail.live` = `store.has(id)`, routes-derived, no ledger column.
  The input queue (`screencast-input-store.ts`) is also in-memory, bounded
  per-task, never on disk. Operator input is fullscreen-gated: the PWA
  captures tap/type/scroll/navigate only while the live pane is in
  fullscreen; outside fullscreen the pane is watch-only (v1 behavior
  preserved). File layout: all `/api/v1/live/*` routes live in
  `routes-live.ts` (`handleLiveRoute`); all PWA pane code lives in
  `public/live-pane.js` (classic script loaded BEFORE app.js — app.js's
  boot() reaches `stopLiveWatch()` during its own eval). View-zoom is
  LOCAL (pinch/double-tap transform the image, never the remote page);
  remote `pinch`/`doubletap` stay in the input contract unbound.
  Contract: CONTRACTS.md "Live screencast".
- **Telemetry**: eleven event kinds — SQL CHECK, `TASK_EVENT_KINDS`, python copies =
  ONE vocabulary; every event carries a writer-minted `ref_id`. `EVENT_FALLBACK` is
  owned by contracts.ts; app.js carries the one client duplicate (sync-twin-pinned).
  The PWA renders the state word + `newestFailureReason()`, never model `summary`;
  `workLineText()` renders REAL payload text (`summary` stays NULL). Record control:
  tap-start, tap-stop-send, explicit Discard — no hold gesture.
- **Answer shapes**: `answer-shapes.js` = pure shape layer (blocks →
  `label-value|table|heading|list|prose`; the list rule has THREE pinned copies);
  `ANSWER_COMPONENTS` registry (depth cap 2); unhandled shapes auto-log to
  `vi.answer-shapes` — promotion a human decision. Copy buttons: per result_summary
  (raw string, Telegram byte parity) + per code block.
- **Tiers + short**: `answerTier` >15 estimated lines → tiered card (uncapped lead,
  chips, disclosure); short answers byte-identical. v8 `result_short` (`--short`) is
  NEVER clamped anywhere — the 240-cap path is DELETED. Short contract (tightened
  2026-09-15, P0 of the answer-presentation plan): the short is the VERDICT — one or
  two plain sentences an average non-technical reader understands, in the product's
  terms; never the reasoning, never a truncated start of the long answer. The full
  answer keeps every substantive detail. Both versions use rich markup; links
  render as real `a`, http(s) only (`javascript:` stays literal).
- **Structured answer data** (schema v12, 2026-09-15): a worker may pass
  `--structured <json>` alongside `--summary` — types `comparison|listing|guide|
  form-set|summary` (shape in `task_complete.py --help`; `form-set` carries `steps`,
  others `items` ≤20 with `name` + optional `attributes`/`actions`; 64 KB cap;
  unknown fields allowed). Written to `tasks.result_structured` by `task_complete.py`
  ONLY — never `transitionTask`; the markdown summary stays the full answer,
  structured data is ADDITIONAL. The PWA parses it first (`safeParseStructured` →
  `answerRegionParts`): a `comparison` renders as item cards — one DOM, a swipe
  row under 680px and a grid above, per-item action controls — behind the same
  tier gate as markdown, with the item names as chips. The task's `surface`
  (P6, schema v13: `phone` | `desktop`, read from the CREATING viewport at
  `<= 680px`, NULL on every pre-v13 row and on any client that omits it) picks
  that container's STARTING layout class — `cmp-phone` keeps the stacked/swipe
  layout at any width, `cmp-desktop` the grid — and never gates content. The
  680px media query always wins the grid back on a narrow screen, and a NULL
  `surface` adds no class at all, so an older answer renders byte-identically
  to pre-P6. `POST /tasks` reads `surface` from both body shapes and 400s on
  any other value; a `form-set` (P4)
  renders its `steps` as an interactive one-step-per-screen flow inside the
  answer card — choice and confirm tap their option and slide on ~200 ms,
  choice steps carry a typed escape lane, text and file steps take an
  explicit Next, Back walks the DERIVED path (visited indexes recomputed
  from answers every render, never stored: a backward-pointing branch is
  terminal, a self/unknown target ends or falls through to declaration
  order, a changed earlier answer prunes its stale trail); `locked` steps
  carry the worker's `answer`. Drafts live per task at
  `vi.formset.<task_id>` (`{answers, at, done, updatedAt}`, 30-day lazy
  sweep; file answers persist as File objects in page memory only — a
  restored filename is dropped and asked again). `submit` = `create-task`
  (default — `feedbackAbout`, its own conversation), `update-conversation`
  (`continuesTaskId` — a follow-up into the answer's conversation), or
  `save-only` (the done-marked draft is the record — never with a file
  step). A malformed `steps` payload falls through to the readable step
  list, never a blank card. A `listing` (P5) renders `items` as compact
  rows (name + one-line `summary`/`description` detail, actions through
  the shared row); a `guide` renders `items` as a numbered checklist —
  the operator's marks persist at `vi.guide.done` via `toggleNameInStore`
  (the P3 saved-item store generalized: `nameStore`/`nameStoreList`/
  `nameStoreHas`, with `isItemSaved`/`toggleSavedItem` as the vi.saved
  wrappers); the worker's `done: true` seeds a task with no stored list,
  an emptied seeded list stays `[]` so an unchecked default never
  resurrects, and a head count + progress bar repaint on every toggle. A
  `summary` renders `items` as section cards (`points` bullets, else
  the `.cmp-attrs` attribute dl). Item-level `summary`/`description`/
  `points`/`done` are shape-checked when present — permissive, unknown
  fields still pass. The injection guidance names all five types. Every
  other type keeps the P1 fallback. NULL, unparseable, or an empty
  structured render falls back to the markdown path. Actions (P3): `call` → `tel:`, `link` → a new tab,
  `task` → `createTask({ text: prompt, feedbackAbout: task.task_id })` (its own
  conversation — never `continues`; `route_task.py` briefs the new worker from
  the answer's conversation), `save` → a `vi.saved` localStorage bookmark
  (`{ "<task_id>": ["<item name>", …] }`, toggling, 200-task bound, `Saved ✓`),
  `share` → `navigator.share`, its control NOT rendered where the API is
  absent. A tapped `task` control disables one-shot; a save toggle repaints its
  own label in place (`applySavedLabel`). Injection guidance is the compact pointer (steer-limit
  budget) — the sync-twin pair carries it byte-equal. Action controls (`.cmp-act`) get an
  accent border/text (2026-09-16) because they sit on `--raised` cards where `.act-quiet` is
  also `--raised` — compound `.act.cmp-act` selectors, not bare `.cmp-act` (the bare form loses
  the cascade to the later `.act`/`.act-quiet` rules regardless of file position).
- **Raw-html lane** (operator freedom architecture, 2026-09-14): a `:::raw-html` …
  `:::` fenced block in `result_summary` renders in a sandboxed iframe —
  `allow-scripts`, NEVER `allow-same-origin` — served by `GET /frames/raw`
  (mandatory `token` query — SSE precedent) whose own inline-only CSP header lets
  model styles/scripts RUN; the inert srcdoc render is only the over-budget
  fallback (`RAW_ROUTE_MAX_ENCODED` twin + a plain-language notice). One frame
  ≈12 estimated lines (two tier); IN SHORT strips raw-html fences whole.
  Mechanics: `FEATURE-NOTES.md` § Raw-html.
- **Shell rule**: `public/*` are shell assets — ANY change bumps
  `voice-inbox-shell-v*` in `sw.js`, else the installed PWA/TWA never fetches it (a
  refresh can't dislodge a cache-first SW). Concurrent bumps RIDE above each other;
  verify through the SW cache path, not just the DOM.
- **Attention**: the operator channel is the PWA's Notifications API — `maybeNotify()`
  rides the 4 s poll, fires only hidden + granted, on needs-you/`done`/`failed`, never
  throwing into the poll. `pa ping` (toast + mirror) is RETIRED to opt-in — no-ops
  unless `PA_ATTENTION_ENABLED=1` (`PA_NOTIFY_DISABLED=1` kill switch). `notifSeen` is
  a const Map — clear-and-refill, never reassign.
- **Web Push**: `web-push-store.ts` owns subscriptions+vapid here; the encrypt/dispatch
  engine stays ONLY in `pa/src/lib/web-push.ts`; `getOrCreateVapidPublicKey` matches
  pa byte-for-byte. The webPush leg is NOT gated by `PA_ATTENTION_ENABLED`
  (toast/mirror are) — `/api/v1/push/test` relies on that asymmetry.
- **Audio**: `GET /api/v1/tasks/:id/audio` (Bearer, tenant-scoped) streams the original
  (404 text/none). `sendFile` has no Range — the client fetches with bearer, plays a
  `blob:` URL; CSP keeps `media-src 'self' blob:` — without it every playback blocks
  pre-decoder.
- **Capture**: a recording runs until stopped — audio never silently discarded;
  caps opt-in (the nudge is a reminder, not a limit); `visibilitychange → hidden`
  never stops one. Teardown funnels `finalizeCapture()` exactly-once — never
  `onstop`-inside-stopCapture; a system stop sends the partial with an honest notice.
- **SSE**: `GET /api/v1/stream` is handled in `server.ts` BEFORE `routes.ts`. Two
  watchers on one `EventHub`: `PRAGMA data_version` on a DEDICATED ledger connection
  (a connection never sees its own writes; python writes out-of-process) and `sw.js`
  mtime. SSE is PRIMARY; the 4 s poll stays — do not "clean up" it. Server freshness
  is the Task Scheduler watchdog — do not duplicate.
- **Thread status** (schema v16): ONE server derivation (`src/thread-status.ts`) —
  lowest rank wins; the answer lifecycle follows the NEWEST done task, landed at its
  newest `task.completed` event (never `updated_at`). View time is server-side
  (`conversation_meta.viewed_at`, written only while unviewed) — never a client timer or
  per-device marks. The PWA maps the token via `THREAD_STATUS_TEXT` (sync-twin-pinned)
  and never derives. Vocabulary, bands, retry/cancel: CONTRACTS.md "Thread status".
- **UI invariants**: `#list-topbar-slot { display: contents; }` is load-bearing (sticky
  containing block). ONE mic mark (`micMark`) everywhere a microphone is meant;
  ring+glyph idle, halo recording.
  - **Footer layout** (2026-09-15, v62→v69): `.footer-menu` uses flex + absolute mic centering
    (`position: absolute; left: 50%; transform: translateX(-50%)`), NOT a 3-column grid.
    The grid's `1fr auto 1fr` shifts the mic when left/right groups have unequal item
    counts; absolute positioning keeps the mic at true viewport center regardless. Do not
    revert to grid. The conversation footer's right cluster is capped at TWO controls —
    `stopControl` (running only) + `moreActionsButton` — because five extras overfilled
    the row and wrapped under the absolute mic; `.footer-compact-row` must never re-gain
    `flex-wrap`. Attach media/files, the assistant-chat thread link and share live in
    `openConversationActionsSheet` (`.menu-row` entries); `stopControl`'s confirm is a
    `.sheet` (`openStopConfirmSheet`), never an inline `.act-row` swap — the swapped row
    was wider than its trigger and reached under the mic.
  - **Attachment staging** (2026-09-15, v62): `makeAttachmentStaging()` returns
    `mediaButton`/`fileButton`/`openMediaPicker`/`openFilePicker` — NOT `button`/`openPicker`.
    Media input has `accept: 'image/*,video/*'`; file input is unrestricted. `opts.picker`
    in `openTextSheet` is a STRING (`'media'` or `'files'`), not boolean `true` — a bare
    `true` silently does nothing. All three sheets (recording, feedback, text) render
    `staging.mediaButton, staging.fileButton`.
  - **aria-live on notice slots** (2026-09-15, v62): every transient notice slot div
    (`#list-notice-slot`, `#system-body`, `#triage-notice-slot`, `#archive-notice-slot`,
    `#kb-rows`, `#kb-notice-slot`, `#conv-notice-slot`, login error notice) carries
    `aria-live: polite` — without it, screen readers are silent on every state change.
    New notice slots must add it.
  - **Attachment overlay** (2026-09-15, v62): `openImageOverlay` carries `role: dialog`,
    `aria-modal: true`, `tabindex: -1`, an `aria-label`, focuses the scrim on open
    (`scrim.focus()`), and handles Escape to close. The `tabindex` without the focus call
    is dead — both must be present.
  - **Theme** (2026-09-16): follows the OS light/dark setting in CSS alone. Colours live ONLY in the `styles.css` token blocks; no colour literal anywhere else in `public/`. Icons take `currentColor` plus a `tone-*` class. Detail: `FEATURE-NOTES.md` § Theme.
  - **Answer provenance chip** (WS3, 2026-09-18; decision 33, 2026-09-20): answered cards with `worker_model`/`worker_cli`/`worker_effort` show a quiet `.answer-provenance` row (collapsed label is the plain `How this was answered` — never the raw model/CLI name, which is technical noise on the default view; tap expands details: Model / Effort / Ran on / How it was asked / Reference + the routing rows from the v16 `router_*` columns — chosen-by, steer/wait, who decided, effort projection, fallback attempts — each rendered only when non-NULL; model/effort/steer/attempts NEVER appear outside the expanded view, and `continued-here`/NULL placement adds no routing UI anywhere). ATTACHED IN `renderTurnContent`, NOT `answerRegionParts` — the seam's body is pinned verbatim by `comparison-renderer.test.ts` ('single structured/markdown seam'); renderTurnContent is its only consumer. The ONE default-visible exception is a placement CHANGE: `diverted`/`new-conversation`/`split` render one plain `answer-routing` line above the affordance (secondary tone, never gold), linked to the origin conversation when `router_target` matches `vi-<12hex>`, never phrased as routing jargon. Fail-open: all-NULL fields → no chip and no routing nodes, legacy cards byte-identical. Secondary tone only — gold stays `ready`. `answer-provenance.test.ts` slices `answerProvenanceRow`.
- **Routing-menu honesty**: `listOpenConversations` offers every thread updated in 24 h
  with its status word, newest first inside `OFFER_LIST_MAX_CHARS` + an overflow line
  (`[Cancelled]` = context only); `(voice message still transcribing)` stays. The fallback's `handleReceived` re-reads live
  state (`isStillReceived`) right before `route_task.py` — skip, never clobber a live
  route; re-routing FROM `routed` is legal (stale replay) — the fallback self-gates.
- **System status**: `GET /api/v1/system/status` is Bearer, NOT tenant-scoped; reads
  owned by `scripts/system_status.py` (one-shot JSON — never re-implement Windows
  reads in Node); module timers need the `__resetSystemStatusForTests` seam.
  `projects/system-dashboard/` RETIRED — do not run or fork.
- **Attachments**: multipart strictly named `audio`/`files`/`text` — other names 400
  (create path only); stored under `files/<task_id>/` sanitized. Caps OPT-IN
  (`max_*` knobs — unset/0 = no limit). Post-row storage failure = VISIBLE failed
  transition, never a 500. `GET .../attachments/:name` serves only listed names —
  that IS the traversal guard. Segment twin-pinned (`ATTACHMENTS_SEGMENT_SUFFIX`);
  typed path UTF-8 byte-exact — a lone U+FFFD = client-side mangling.
  Worker-side attaches write the same dir directly (the listing IS registration):
  `task_blocker_ask.py` stores `blocker-*`, `task_complete.py --attach` (repeatable,
  AI-244) stores `result-*` result artifacts and adds `attachments:[names]` to the
  `task.completed` payload when non-empty (contracts.ts `TaskCompletedPayload`
  residual pending); missing path fails side-effect-free, a ledger refusal keeps
  the copies as evidence.
- **Depth/KB/share**: the Recent list (`?view=recent`) is header-free — live and
  history bands split by a gap; a poll re-render waits `LIST_IDLE_MS` after a
  touch/scroll unless at the top. Older conversations = the archive view
  (`state.view='archive'`):
  pages the WHOLE tenant from offset 0 (`ARCHIVE_PAGE_SIZE=20`, no
  `startBase`); server-side `?q=` search (AND across whitespace terms,
  LIKE-OR across `request_text`/`transcript`/`result_summary`/`title`/`recap`,
  ESCAPE `'!'`); `total` is the filtered count when `q` is set. KB: `GET /api/v1/kb`
  (Bearer, NOT tenant-scoped) → `src/kb.ts` — section lines keep
  raw bullets, ATX the only strip, client owns grouping (do not "fix" kb.ts).
  Share: hidden without `navigator.share`; `AbortError` = dismissal.
- **Request log**: `logs/requests.log` JSONL — exact key order, no query VALUES
  (`redactPathForLog`), fire-and-forget, own 5MB rotation — pa's pruner NOT involved;
  server.ts only.
- **Cancellation/identity**: the bot reads the ledger read-only via `pa/dist`'s
  voice-inbox-ledger (fail-open). `PA_WORKER_RESOURCE` = the worker-pids `skill` key
  byte-identical; `conversation_id` NOT NULL. `STATE_TEXT` keys are pinned to `TASK_STATES`
  (`sync-twins.test.ts`). `route_task.py` writes `kind:"steer"` only; the bot
  resolves per tick. `worker_dispatch_id` = the DISPATCH — never kill a bare topic
  resource without it.

## Config

`voice_inbox:` block of `~/.pa/config.yaml`; `inbox_topic` REQUIRED
(`<chatId>_<threadId>`); defaults + cap knobs opt-in. Env
`VOICE_INBOX_PORT`/`VOICE_INBOX_INBOX_TOPIC` win. Dist is
FLAT (`dist/server.js`); `--check` prints exactly `voice-inbox: config ok, ledger ok
(schema v16)` (the version interpolates `LEDGER_SCHEMA_VERSION` — bump it and
the string follows).

## Tests

- `npm ci && npm run build && npm test`; scoped in a shared tree:
  `PA_BUILD_LOCK=0 npm test -- <basename>`; python: `python -m pytest tests -q`.
- `PA_BUILD_LOCK=0` bypasses the reservation, NOT the stale-dist guard: after adding a
  `src/tests/` file, build first or the scoped run tests the previous copy.
  `PA_ALLOW_STALE_DIST=1` runs the STALE copy — a new test can "pass" unexecuted.
- Isolate under `PA_HOME=<tmp>`; `db.close()` before `rmSync` (EBUSY).
- Byte-sync pins: `test_worker_scripts.py` (schema + vocabulary — python owns it),
  `sync-twins.test.ts` (app.js↔contracts.ts/ledger.ts/thread-status.ts,
  bridge-writer↔route_task).
- Schema bump: sweep FOUR `ledger.test.ts` surfaces; injection text: THREE
  hand-copies, FIVE pins; `ROUTE_TEXT_MAX` = `STEER_MESSAGE_LIMIT - 50` — never widen.
- Full pin list + harness gotchas (relay_smoke teardown hang, bridge-writer ELOCK
  fix/AI-237, sliced-recorder rule, route-source pin anchoring): `FEATURE-NOTES.md`.

## Park rule

- Park at the highest completed prefix; never leave a prefix half-wired.
- (1) contracts/ledger/API/workers. (2) +E full PWA. (3) +D live loop through real
  bot + worker fleet. (4) +G exposed.
- The edge relay is the live edge; the quick tunnel (`scripts/quick_tunnel.ps1`) is
  the fallback — rerun + re-pair (the session dies with the old origin): ops doc.

## Edge relay

- Long-poll pull relay on the user's own Cloudflare account. Claims at-most-once —
  never re-execute; work queue in the DO only — KV forbidden. Detail + gotchas:
  `relay/README.md` + ops doc.
