# Contracts — voice-inbox (`projects/voice-inbox/`)

This file holds the cross-boundary data contracts of the voice-inbox app: the surfaces
that two or more processes share, and the exact shapes every writer and reader must
agree on. `CLAUDE.md` summarizes the project and points here for contract detail; the
sections below are normative. Runtime state lives under `~/.pa/voice-inbox/`.

## Route-queue contract (two writers, one file)

`~/.pa/voice-inbox/route-queue.jsonl`, one JSON object per line. The **first eight keys
are the frozen prefix and their order never changes**: `q_id, ts, task_id, tenant_id,
chat_id, thread_id, text, ref_id`. Optional keys are **appended after `ref_id`** in this
fixed order and are **omitted entirely** (never `null`) when not applicable:

| key | type | written by | meaning |
|---|---|---|---|
| `kind` | `"cancel"` \| `"steer"` | `bridge-writer.ts` (cancel; steer via `answer-resume.ts`), `route_task.py` (steer) | verb entry: the drain acts on it |
| `worker_resource` | string | `bridge-writer.ts` only | exact worker-pids `skill` key to act on (cancel only) |
| `worker_dispatch_id` | string (12 hex) | `bridge-writer.ts` only | the dispatch that must still be registered under that key for a kill to be allowed (cancel only) |
| `steer_mode` | `"queue"` \| `"interrupt"` | `route_task.py`, `bridge-writer.ts` (`answer-resume.ts`, always `"queue"`) | how the steer is delivered |
| `steer_conversation` | string (`vi-<12 hex>`) | `route_task.py`, `bridge-writer.ts` (`answer-resume.ts`) | the conversation the steer targets; the bot resolves everything else from it |

A line with no `kind` is a route entry, injected exactly as today. `kind:"cancel"` is acted
on and NEVER injected. `kind:"steer"` is acted on, folded into a sibling route line, held
for the next tick, or — only past the D10 deadline — injected. A steer entry carries NO
`worker_resource` and NO `worker_dispatch_id`: the bot re-reads the ledger every tick,
because a verdict frozen at routing time goes stale (K7).

Cancel entry, authoritative example:

```json
{"q_id":"rq-…","ts":"…","task_id":"vi-…","tenant_id":"t-…","chat_id":-100…,"thread_id":29,"text":"[Voice inbox task vi-… cancelled by the operator]","ref_id":"s-…","kind":"cancel","worker_resource":"topic--100…_29","worker_dispatch_id":"a1b2c3d4e5f6"}
```

Steer entry, authoritative example:

```json
{"q_id":"rq-…","ts":"…","task_id":"vi-…","tenant_id":"t-…","chat_id":-100…,"thread_id":29,"text":"[Voice task vi-… routed from inbox — reason: …] …","ref_id":"s-…","kind":"steer","steer_mode":"interrupt","steer_conversation":"vi-…"}
```

The steer entry's `text` is byte-identical to the plain target injection text and carries no
steer framing (K6).

Writers: `bridge-writer.ts` (task creation and thread retry → inbox topic; API reroute →
target topic; task or thread cancel → `kind:"cancel"` verb entry) and `route_task.py` (worker decisions, including
`--continues` merges). BOTH guard appends with the same proper-lockfile mutex — the
python side is a mkdir-compatible replica: `<queue>.lock` dir, 5 s stale, fail-loud past
~1.25 s of retries, and a live holder is never stolen. Consumer: the bot drain. A `kind:"cancel"` line is
acted on (stop the worker, flip the thread, purge pending dispatches) and never injected; a
route line is injected as a `__synthetic: 'route'` turn — unless its task is still `transcribing` (held: neither injected nor consumed) or `transcribe_failed` (consumed, never injected), § Voice transcription and the cleaned request — then the file is rewritten without
consumed lines (a crash between inject/act and rewrite re-injects/re-acts — accepted). The
§-build-spec injection texts exist in TWO codebases (`buildTargetInjectionText` +
`TARGET_INJECTION_TEMPLATE`); `sync-twins.test.ts` pins them byte-equal, so edit both or
fail a gate.

### Answer resume (2026-09-10)

`answerAndResume` (`src/answer-resume.ts`, auth broker Phase A, AI-220) is the ONE function
that records an answer to an input request AND resumes the worker waiting on it. This is
the fix for the AI-221 bug, where the old direct `answerInputRequest` call answered a
request silently and left the worker parked. Every caller that resolves an input request (the JSON
answer handler, `pollOauthResolutions`, the `/api/v1/auth/callback` endpoint, and `pa auth
answer`) goes through it; there is no second copy of the resume logic.

It writes the value (or accepts an already-written pointer, e.g. an oauth token marker
file), calls `answerInputRequest`, then queues **at most one** `kind:"steer"` route-queue
entry — only when `task.routed_to` is a parseable topic key AND `task.worker_resource` is a
non-empty string (a standing auth task with no dispatch has neither, and queues nothing;
`pa auth wait` is its consumer instead). `steer_mode` is always `"queue"` — an answer never
interrupts. The queued line's `text` wraps the answer-pointer sentence:

```json
{"q_id":"rq-…","ts":"…","task_id":"vi-…","tenant_id":"t-…","chat_id":-100…,"thread_id":29,"text":"[Voice inbox task vi-…] Answer for ir-… is at <path> — read it; never repeat its value in chat. Continue the task from where it paused, then finish with task_complete.py.","ref_id":"s-…","kind":"steer","steer_mode":"queue","steer_conversation":"vi-…"}
```

An `appendRouteEntry` failure never loses the answer: it degrades to
`steer_skipped_reason: 'append-failed'` and the request stays `answered` regardless — the
value must land even when the resume signal cannot. The answer-pointer sentence itself is a
cross-language twin: `buildAnswerPointerText` (TS) and `task_input.py`'s `cmd_check` pointer
line (python, unchanged) are pinned byte-equal by `sync-twins.test.ts`.

## Routing retry (2026-09-16)

A voice task whose routing run settles without routing it is returned for routing once. The repair
is one legal transition through `transitionTask`: `received`/`running` → `routed`, `routed_to` = the
settling thread's topic key, `routing_reason` = pa's `VOICE_ROUTE_RETRY_REASON`
(`pa/src/lib/voice-inbox-route-retry.ts`, exact string), event `task.routed` with payload
`{routed_to, reason}`. Entering `routed` clears the failed run's worker identity, and `route_task.py`
accepts the task again. The retry message forbids a progress post first: `task_telemetry.py` moves a
`received` or `routed` task to `running`, and `route_task.py` refuses a `running` task once
`routed_to` is set (it accepts `running` only while `routed_to` IS NULL, 2026-09-17).

| side | rule |
|---|---|
| writer: pa `returnVoiceTaskForRouting`, called from the bot | only when `routed_to` IS NULL, re-read inside an IMMEDIATE transaction; at most once per task because `routed_to` is never cleared |
| reader: bot late closure sweep | a task in the retry shape routed to the record's own key defers; the record's reply is never its answer |
| reader: pa `voice-inbox-fallback` (stale `routed`, dead-dispatch `running`) | the retry shape is placed like a never-routed task (`task.rerouted` from the retry key), never replayed into that topic |

Any real routing overwrites `routing_reason`, which ends the retry shape.

## Typed input widgets — the form kind (schema v9, 2026-09-14)

The typed-input vocabulary is seven kinds: `secret | text | choice | oauth | file |
confirm | form` (contracts.ts INPUT_KINDS = the SQL CHECK = the five worker scripts'
copies, pinned by tests/test_worker_scripts.py::test_input_kinds_sync). `form` is the
one-sheet questionnaire: `params.steps` is an array of 1..8 steps — non-locked steps
`{id, title, decide, options:[{label, note}], preselected?}` (id
`^[a-z0-9][a-z0-9-]{0,39}$` unique; title ≤60; decide ≤200; 1..6 options, label ≤60,
note ≤200; preselected must equal exactly one label), locked steps exactly
`{id, title, decide, locked: true, answer}` (answer 1..200, no options). Unknown
fields reject at every level. The serialized steps array caps at 20 000 chars.

Answers: the client sends `{kind:"form", answers:{<stepId>:"<label or free text>"}}`
— non-locked steps only, each entry a 1..500-char string (free text is always valid,
even when it matches no option). The server composes locked steps' recorded answers
itself at validation time — a client entry for a locked id is IGNORED, never stored —
and stores ONE canonical JSON object mapping EVERY step id to its answer, through the
unchanged value path (answer file + pointer + resume steer, § Answer resume). Missing
or empty non-locked step → 400 naming the step id. The ack stays the fixed
`{"ok":true,"status":"answered"}`; the value is never echoed. Workers create forms
with `task_input.py create --kind form --steps-file <path>` (never JSON on the
command line). The public share view strips pending-request params, so a form never
renders there.

### Feedback framing + surface line (schema v7, 2026-09-13)

Schema: `tasks.feedback_about TEXT` — v7, additive and nullable (NULL for every normal
task, migration-free, `user_version` never demoted):

```
  steer_mode      TEXT,                     -- v4: 'queue' | 'interrupt' when this task was recorded as a steer
  feedback_about  TEXT,                     -- v7: 'vi-<12 hex>' conversation or task this feedback is about; set only via POST /tasks, NULL otherwise
  result_short    TEXT                      -- v8: worker-written standalone short summary (the card's IN SHORT lead); NEVER capped or trimmed
```

POST wire contract (the cross-package contract — the PWA and the API build both ends
independently against this text):

- Field name: `feedback_about` — JSON body key on text creates, multipart part name on voice creates.
- Value: a `vi-<12 hex>` id. Conversation-level feedback sends the conversation id; turn-level feedback sends that task's id.
- Optional; ABSENT for every normal task. Client-supplied, never model-writable (no worker script writes it; only POST /tasks accepts it) — EXCEPT for inheritance (t-3, 2026-09-18) described next.
- Inheritance across continuation turns (t-3, 2026-09-18): `feedback_about` is client-writable only at conversation creation (the 400 above rejects it combined with `continues`), so without this rule a turn 2+ task in a feedback conversation would carry NULL and drop the "this thread is feedback about X" marker the root turn set. `createTaskHandler` (routes.ts) reads the conversation ROOT task's `feedback_about` and passes it to `createTask` whenever `continues` is set and the client supplied no `feedback_about` of its own — every task in a feedback conversation ends up carrying the same value the root did, not just the root.

`ConversationSummaryRow.feedback_about` (ledger.ts `summarizeConversation`) is the conversation ROOT task's `feedback_about` — the same value every task in the conversation now carries per the inheritance rule above, so reading it off the root is equivalent to reading it off any task and cheaper. `GET /conversations` (`publicConversationSummary`) and `GET /conversations/:id` (`conversationDetailHandler`) both add a `feedback` field alongside it: `FeedbackRef | undefined` (bridge-writer.ts), omitted entirely when `feedback_about` is null. `FeedbackRef` carries `conversationId` (t-3: the conversation `about` actually lives in — equal to `about` at 'conversation' level, the containing conversation's root id at 'task' level) so the PWA's origin banner (public/app.js `feedbackOriginBanner`, at the top of the conversation view) always has a navigable target even when the feedback is about a single mid-conversation task rather than a conversation root. The public share view (`publicShareHandler`) is unaffected: `feedback_about` was already exposed per-task there via `publicShareTask` before this change (see below), so the new conversation-level field adds no new exposure and is left in the spread.
- Validation (WP-A): non-string / not matching `^vi-[0-9a-f]{12}$` → `400 {"ok":false,"error":"feedback_about must be a \"vi-<12 hex>\" task or conversation id"}`; combined with `continues` → `400 {"ok":false,"error":"feedback_about cannot be combined with continues"}`; id not found in this tenant → `404 {"ok":false,"error":"not found"}` (same convention as `continues`). `steer` needs `continues`, so steer+feedback is rejected transitively.

Framing (rendered only when `feedback_about` is set; taken from the stored marker, never
from request text):

| Form | Exact string (`<about>` = stored `feedback_about` value) |
|---|---|
| conversation-level, with title | `(operator feedback about voice-inbox conversation <about>, "<title>")` |
| task-level, with title | `(operator feedback about voice-inbox task <about>, "<title>")` |
| no title (meta row absent or title null/empty) | `(operator feedback about voice-inbox conversation <about>)` / `(operator feedback about voice-inbox task <about>)` |

- Title sanitize (both languages): collapse whitespace (`\s+` → single space), trim, `"` → `'`, clamp 60 chars; empty after sanitize → use the no-title form.
- When rendered, the framing is one segment followed by a **single space**, placed per template (placement table below).
- Never render the framing in any `[Voice …]` bracketed form.

Level resolution (pinned, identical in TS and python). Given `F` = the stored
`feedback_about` of the task being injected:

1. Look up the task with `task_id = F` (TS: `getTask(db, tenantId, F)` — tenant-scoped; python: `SELECT conversation_id FROM tasks WHERE task_id = ?` with `F`).
2. If that row exists AND `row.conversation_id !== F` → **task-level** framing about `F`; title = `conversation_meta.title` for `row.conversation_id` (TS: `getConversationMeta(db, tenantId, row.conversation_id)`; python: `SELECT title FROM conversation_meta WHERE conversation_id = ? AND tenant_id = ?`).
3. Else (no such row, or the row is its own conversation root) → **conversation-level** framing about `F`; title from `conversation_meta` for `F`.

(Tie-break on the root is deliberate: a root task's id IS the conversation id; the two readings coincide.)

Placement per template:

| Template | Placement |
|---|---|
| `buildTargetInjectionText` (src/bridge-writer.ts), `TARGET_INJECTION_TEMPLATE` (scripts/route_task.py), `EXPECTED_TARGET_TEXT` (tests/test_worker_scripts.py) — three byte-synced copies of one text | the framing slot sits between the briefing and the request: `[Voice task {TASK} routed from inbox — reason: {REASON}] {BRIEFING}{FRAMING}{REQUEST}. This task arrives from …` |
| `buildInboxInjectionText` | framing inside the head chunk, right after `[Voice inbox task <id>] `; the surface sentence sits between the conversation-briefing segment and the final `Do not answer the request here; do not ask the operator anything here.` chunk — which the routed-ask no-close teaching (2026-09-14: route it and stop, never `task_complete.py` for it) extends |
| `buildVoiceInboxInjectionText` | framing inside the head chunk, right after `[Voice inbox task <id>] `; the surface sentence sits between the choose-autonomously segment and the final `Do not answer the request here; do not ask the operator anything here.` chunk — which the routed-ask no-close teaching (2026-09-14: route it and stop, never `task_complete.py` for it) extends |

The surface line — `This task arrives from the voice-inbox app (our own PWA — its UI is
fully ours; long-press menus, custom sheets and inline widgets are all possible); design
any UI answer for that surface, not for Telegram's Bot-API constraints.` — renders
UNCONDITIONALLY in all four injection texts (`buildTargetInjectionText`, its
`route_task.py` twin, `buildInboxInjectionText`, `buildVoiceInboxInjectionText`), with no
surface field and no condition: all four only ever carry voice-inbox-originated tasks. It
is inline literal text in every copy — never a shared const, never an interpolation — so
it must not appear in `sync-twins.test.ts`'s interpolation map.

The sync pins move together: `sync-twins.test.ts`'s `INTERP_MAP` `framing` entry,
`normalizePython`'s `{framing}` rewrite, and `EXPECTED_TARGET_TEXT` in
`tests/test_worker_scripts.py` pin the framing slot and the surface sentence across the
byte-synced copies — edit all of them at once or fail a gate.

The recent-conversations offer is suppressed for feedback tasks: a feedback task must never
be invited to merge into the conversation it is about, so its inbox entry's text carries
no `Recent conversations (last 24 hours, newest first):` segment.

`publicTask`/`publicShareTask` expose `feedback_about` deliberately — it is operator-set
metadata the PWA renders, the same class as `steer_mode` (`worker_resource` /
`worker_dispatch_id` remain the only dropped internal fields).

## Conversations (schema v5, 2026-09-08 redesign)

`conversation_id` is `NOT NULL DEFAULT ''` on `tasks` and is **always written explicitly**
by `createTask` — self-rooted (equal to the task's own id) unless an explicit
`conversationId` is passed (the `continues` create path). A conversation's `state` is its
**newest task's** state, by `(created_at DESC, task_id DESC)`. Its `status` is the thread
status (§ Thread status, view time, retry and cancel), and its `updated_at` is the newest
`updated_at` across all its tasks (schema v14).

The routing offer (`listOpenConversations`, rendered by `bridge-writer.ts`'s
`conversationsSegment`) lists EVERY conversation updated within the last 24 hours
(`RECENT_WINDOW_MS`) that has a status, whatever its state, newest update first. Each entry
reads `<id>=<snippet> (updated <age>) [<status word>]`: the snippet is the root task's
`request_text` in at most 60 characters (whitespace collapsed, `;` dropped), and the age
reads `moments ago`, `N minute(s) ago` or `N hour(s) ago`. There is no count cap. The
`;`-joined entries have their own budget, `OFFER_LIST_MAX_CHARS` (4,000 characters): whole
entries fill newest first, the first entry that would cross the budget stops the fill, and
the rest are counted in an `(and K more recent conversation(s) … not listed)` line.
`STEER_MESSAGE_MAX` does not apply, because the bot injects inbox texts as plain route
entries.

A conversation whose root task has not been transcribed yet still carries the literal
`(voice recording)` placeholder (`VOICE_TRANSCRIBING_PLACEHOLDER`) as its `request_text`, so
its snippet renders `(voice message still transcribing)` instead. The recency label is often
the only signal that links a voice note to one sent moments before it: two notes 14 seconds
apart (vi-6cb5faaf1b74, 2026-09-12) landed in separate conversations before it existed.

The offer tells the router that a `[Cancelled]` entry is context only, and that when unsure it
omits `--continues` so the request starts a new conversation. Merging into an
already-terminal conversation is **allowed for the operator** (the explicit `continues`
create path — replying into a finished answer is the common case) and **refused for the
model** only when the target conversation's newest task is `cancelled` (`route_task.py
--continues`) — an explicit operator stop must never be undone by a model's guess.

GET /api/v1/conversations (vi-19787afc4b2e): the response ALWAYS carries `total` =
COUNT(DISTINCT conversation_id) for the tenant. A new `offset` query param pages depth
history: absent or `0` keeps the existing listConversations path (the 500-task grouping
window); `offset >= 1` walks `listConversationsPage`, which pages conversation
identities by `GROUP BY conversation_id ORDER BY MAX(updated_at) DESC,
conversation_id DESC` and summarizes each page entry from its FULL task list — correct
at any depth, where the window path silently truncates. Invalid `offset` (negative,
non-integer) is 400 `offset must be a non-negative integer`, the limit-validation
convention. The PWA renders depth history as the "Older conversations" view
(`?limit=20&offset=N`, show-more while `offset < total`); its Recent list reads
`?view=recent` (§ Thread status, view time, retry and cancel).

A new `q` query param filters the list server-side: whitespace-
tokenized terms, AND across terms, each term a case-insensitive
`LIKE` (ESCAPE `'!'`) against any of `tasks.request_text`,
`tasks.transcript` (a voice task's raw words once its request was cleaned),
`tasks.result_summary`, `conversation_meta.title`,
`conversation_meta.recap`. A conversation surfaces when ANY task or
meta row in it matches EVERY term. Validation: trim; empty →
unfiltered (200); length > 200 → 400 `q must be a string of at most
200 characters`. When `q` is present the handler routes through
`listConversationsPage` with the filter at the grouped-query level
(not post-filter), and `total` is the filtered count. No FTS, no
ranking — contains-match at this corpus size.

## Thread status, view time, retry and cancel (schema v14, 2026-09-17)

A thread's status is derived on the server by ONE pure function, `deriveThreadStatus` in
`src/thread-status.ts`. `summarizeConversation` calls it for every list, detail and offer
row, and nothing else derives a status — the PWA only maps the token to its word
(`THREAD_STATUS_TEXT`, pinned to `THREAD_STATUS_WORDS` by `sync-twins.test.ts`). Every task
contributes at most one rank, and the thread shows the lowest rank present:

| rank | token | word | band | contributed by |
|---|---|---|---|---|
| 1 | `recorded` / `transcribing` / `routed` | Recorded / Transcribing / Routed | live | a task in `received` / `transcribing` / `routed`; the newest such task names the token |
| 2 | `needs_you` | Needs You | live | a task in `awaiting_input`, or a pending input request |
| 3 | `ready` | Ready | live | a done task exists and the thread is not viewed for the newest done task's answer, at any age |
| 4 | `failed` | Failed | live | a task in `failed` / `transcribe_failed` with `retried_by` NULL and no `too_short` code |
| 5 | `running` | Running | live | a task in `running` |
| 6 | `viewed` | Viewed | history | viewed less than 1 hour ago (`VIEWED_WINDOW_MS`) |
| 7 | `concluded` | Concluded | history | viewed 1 hour or more ago, thread updated within 24 hours (`RECENT_WINDOW_MS`) |
| 8 | `cancelled` | Cancelled | history | a task in `cancelled`, thread updated within 24 hours |
| 9 | `done` | Done | older | viewed 1 hour or more ago, or a cancelled task, with the thread last updated over 24 hours ago |

**The answer and its view.** The answer lifecycle follows the thread's NEWEST done task by
`created_at`. Its landed time, `answer_landed_at`, is that task's newest `task.completed`
event time, or its `updated_at` only when it has no such event. Event rows are never
rewritten, so the time never moves: a later write that bumps `updated_at` (the Telegram
message-id capture) cannot make a viewed answer Ready again. A thread is viewed when
`conversation_meta.viewed_at` is set and not earlier than `answer_landed_at`.

Clock-only moves (Viewed → Concluded → Done) write nothing; every read recomputes. A thread
with no contribution — only a `too_short` failure, or only retried failures — has `status`,
`status_rank` and `band` all `null` and is hidden from the Recent list and the offer.
`ConversationSummaryRow` and `GET /conversations/:id` carry `status`, `status_rank`, `band`,
`viewed_at`, `answer_landed_at` and `failed_unresolved` (the rank-4 count), and each task
carries `retried_by`. The share view drops all six, because they encode the operator's
viewing.

**Recent list.** `GET /api/v1/conversations?view=recent` returns every live- and
history-band thread, sorted `status_rank ASC, updated_at DESC, conversation_id DESC`, and
ignores `limit`; `total` stays the tenant's whole count. `q` or `offset` alongside it is 400
`view=recent takes no q or offset`; any other `view` value is 400
`view must be "recent" when present`.

**View time.** `POST /api/v1/conversations/:id/viewed` takes `{}` or `{"at": "<ISO-8601>"}`
and replies `{ok: true, changed, viewed_at}`. It writes only while the thread is unviewed for
its current answer, so re-opening never restarts the Viewed hour. `at` is normalized, clamped
to now, and honoured only when the thread has no view time at all: it exists for the PWA's
one-time upload of a device's old read marks (`vi.read`, removed after the upload), and
nothing else backdates. A malformed `at` is 400 `at must be an ISO-8601 timestamp`; a
conversation with no task under the tenant is 404 `not found`; another method is 405.

The v14 migration stamps `viewed_at` once, only while `user_version < 14` and never over an
existing value, on every thread that has a done task and whose newest update is over 24 hours
old; the stamp is that thread's answer landed time. Old answers therefore do not resurface
as Ready.

**Retry.** `POST /api/v1/conversations/:id/retry` creates one NEW task in the same
conversation per unresolved failure, oldest failure first, and stamps the failed row's
`retried_by` in the same transaction; the new task's `task.received` payload carries
`retry_of`. The retry copies the request, transcript, feedback link, surface, the recording
(`audio.*`) and the operator's attachments (the listing minus `blocker-*` and `result-*`),
never `steer_mode`. It queues through the create path's inbox entry with the continuation
segment.

A `transcribe_failed` recording re-enters `transcribing` for the bot's transcription drain;
one with no recording on file is `skipped` and not stamped. A storage failure moves the new
task visibly to `transcribe_failed` or `failed`, as the create path does. The reply is
`{ok: true, retried: [...]}`, each element `{task_id, outcome: 'retried', new_task_id, state,
queued}` or `{task_id, outcome: 'skipped' | 'refused', reason}`; no task is 404
`not found`, and nothing to retry is 409 `nothing to retry`.

**Cancel.** `POST /api/v1/conversations/:id/cancel` moves every task in `received`,
`transcribing`, `routed`, `running` or `awaiting_input`, and every unresolved failure, to
`cancelled` through `transitionTask` (`task.cancelled` `{by: 'operator'}`). The
`failed → cancelled` and `transcribe_failed → cancelled` transitions exist for this operator
path. A `kind:"cancel"` route entry is appended only for a task that was `running` or
`awaiting_input`, because a failed row's worker identity is history and must never aim a kill.

The reply is `{ok: true, tasks: [...]}`, each element `{task_id, outcome: 'cancelled',
stop_requested}` or `{task_id, outcome: 'refused', stop_requested: false, reason}`; a repeat
call returns `tasks: []`, and no task is 404 `not found`. Cancelling a Failed follow-up
leaves an unviewed earlier answer Ready, with no special case. Bulk Retry and Cancel are the
client calling these endpoints once per thread; there is no bulk endpoint.

**Worker-side transitions.** Every python state write goes through the SHARED LEDGER
HELPER's `transition_task` after `begin_immediate`: one
`UPDATE … WHERE task_id = ? AND state IN (<legal sources>)`, a rowcount check, and the
paired event in the same transaction, so no writer slips between a read and a write.
Leaving `awaiting_input` for any state but `running` expires that task's OWN pending input
requests (`cancelled` when the task is cancelled).

`awaiting_input → done` is illegal. `task_complete.py` refuses it with
`task <id> is awaiting_input; it is waiting on the operator's answer, and completing it would drop that question — withdraw the question first (task_input.py cancel --task <id>) or wait for the answer, then run task_complete.py again`.
`route_task.py` accepts `received`, `routed`, and `running` while `routed_to` IS NULL; it
refuses anything else with
`task <id> is <state>; routing is valid from received or routed, or from running before any route`.

## Knowledge-base view (GET /api/v1/kb, 2026-09-13)

`GET /api/v1/kb` (Bearer-gated, NOT tenant-scoped — same precedent as
`/system/status`: machine-global knowledge, not tenant data) returns
`{ok: true, kb: {topics: KbDoc[], domains: KbDoc[]}}` where KbDoc =
`{id, title, summary, consolidated, sections: [{heading, lines}]}`. Sources are fixed
server-side — no request input reaches a path: `~/.pa/topic-brains/<id>/BRAIN.md` and
the Ecosystem KB directory, resolved by kb.ts's `defaultKbRoots()` (topics ride
`paHome()`; domains ride recall.ts's `PA_KB_SOURCES_PATH` knob when set — that value is
a FILE and its directory is the KB — with the fixed machine root
`D:/My Repos/notes/Ecosystem KB` as fallback). The parser drops agent-facing chrome
(HTML comments, blockquote lines, `Other topics:` / `Central brain:` footers) so the
view is human by construction. Caps: 256 KB per file (larger skipped), 200 lines per
section, 60 topic docs (consolidated DESC, missing last), 20 domain docs (title ASC).
A missing root directory yields an empty list, never an error; an unexpected read
failure is 500 `knowledge base unavailable`. Tests use the `RouteDeps.kbRoots` seam —
they never read the operator's real directories.

## Steering (schema v5)

`steer_mode` (`"queue" | "interrupt" | null`) is recorded on the task at **create time** and
is `NULL` for every non-steer task. `route_task.py` only WRITES the route-queue verb entry
at routing time (see above) — it never resolves the steer target and never picks a branch,
because a verdict frozen at routing time goes stale before the bot's drain reads it.

The steer target is resolved from the ledger, in ONE place, every drain tick: the
`worker_resource` AND `worker_dispatch_id` AND `task_id` of the newest task in the same
conversation that carries a non-empty `worker_resource`, ordered by `updated_at DESC,
task_id DESC`, regardless of that task's state (D4). The **operative** copy of this rule is
`voiceInboxConversationState` in `pa/src/lib/voice-inbox-ledger.ts`, read read-only by the
bot on every drain tick. A second, **non-operative** copy lives here in `ledger.ts`'s
`conversationWorkerResource`, used only to label the create response's snapshot; drift
between the two is cosmetic because the snapshot decides nothing.

Steering fires on **first routing only**: `route_task.py` accepts `received → routed` and
`routed → routed`, but a steer entry is written only from `received` — a re-route records
`steer_outcome: "none"` with reason `re-route: steering fires only on first routing`. Firing
twice would deliver the same follow-up twice.

`worker_dispatch_id` identifies a DISPATCH, where `worker_resource` identifies only a LANE.
A bare topic resource (`topic-<chatId>_<threadId>`, no `-thN`) is reused by every message in
that topic, so no kill may act on a bare topic resource without a matching dispatch id — a
kill on the resource alone can land on a stranger's worker that started after the intended
one ended.

The bot steers the thread lane (a spawned thread's resource, `-thN` shape) or the topic lane
(a bare topic resource — the dominant case in practice). It folds the steer into a sibling
route-queue line before the target starts, or holds the entry and retries on the next drain
tick, bounded by a ten-minute deadline past which it is injected as an ordinary turn. A
steer **never** degrades to an unrelated follow-up message: if a steer needs to be done, it
needs to be steered.

The bot logs exactly one `steer_outcome` per steer entry it settles, one of:

| `steer_outcome` | meaning |
|---|---|
| `interrupted-thread` | thread lane, running record, interrupt — the process tree was killed and refired |
| `queued-into-thread` | thread lane, running record, queue — delivered after the current run |
| `folded-before-start` | a queued thread record, or the route-queue fold — the run BEGINS with both |
| `woke-terminal-thread` | thread lane, terminal record — the finished thread was woken with the message |
| `interrupted-dispatch` | topic lane — the identified dispatch was killed and origin+steer re-injected as one turn |
| `queued-into-topic` | topic lane — injected as a session-resuming turn, behind or after the running dispatch |

plus, only past the ten-minute deadline, `injected-after-deadline`.

## Conversation summary lines (schema v5, 2026-09-10)

Three worker-set fields — `title`, `recap`, `next_action` — stored in `conversation_meta`
(`conversation_id` PRIMARY KEY, one row per conversation), clamped to 60 / 400 / 200 chars
(`value.strip()[:CAP]` python, `value.trim().slice(0, CAP)` TS — a hard slice, no ellipsis).
**The server stores and returns these values; it NEVER derives them.** `ConversationSummaryRow`
carries all three as `meta?.field ?? null`, and the PWA (`conversationLines` in `public/app.js`)
owns the whole client-side fallback for a `null` field. A written back-fill was rejected
because it would be byte-indistinguishable from a worker-set value and could clobber one —
the fallback is read-time and client-side instead, which costs no migration and cannot clobber.

Three writers, one shared python helper (`set_conversation_meta`, the SHARED LEDGER HELPER
block below) and one TS twin (`setConversationMeta` in `ledger.ts`):

| writer | title | recap | next_action |
|---|---|---|---|
| `route_task.py --title` | writes **only when no title is stored** (`title_if_absent=True`) | — | — |
| `task_complete.py --title/--recap/--next` | overwrites unconditionally | overwrites unconditionally | writes `--next`'s value **or clears to NULL when `--next` is absent** — the one exception to "omitted leaves alone": a completed conversation has no pending action item. Only the conversation's NEWEST task (`created_at DESC, task_id DESC`) touches it: an older task completing leaves `next_action` alone whatever `--next` says (schema v14) |
| `task_input.py create --title/--recap/--next` | overwrites unconditionally | overwrites unconditionally | `"__keep__"` sentinel when `--next` is not supplied — a question leaves a standing action item alone unless it names a new one |
| `task_input.py cancel` | — | — | — |

The initial-only rule on `route_task.py --title` is the mechanism behind "a worker-set title
never regresses to ASR (speech-to-text) text". `route_task.py` accepts both `received → routed` and a
`routed → routed` re-route, and an unconditional write on the re-route path would silently
overwrite a title a working worker already chose — the exact regression this wave exists to
remove, arriving by a second door. `--title` and `--recap` reject an empty or whitespace-only
value (an argparse error); `--next ""` is accepted and clears.

`conversation_meta` rows orphaned by a `--continues` merge (keyed to a conversation id that no
longer has tasks) are accepted and unread — `summarizeConversation` is only reached for
conversations that have tasks. They are bounded at a few hundred bytes each, with no reaper
and no declared maintenance job.

`ConversationSummaryRow.latest_step` is a fourth, separately-sourced field: the newest task's
newest `task.progress` event payload's `step` text, or `null` when there is none. It is not
stored in `conversation_meta` and not worker-written — `listConversations` overlays it onto
each row from the `events` table after summarizing. The server passes it through raw and never
derives a display word from it.

**The `# BEGIN SHARED LEDGER HELPER` block is a FIVE-copy byte-identical block**, not the
three-copy target-injection text the rest of this file and `CLAUDE.md` name — it is pinned by
`test_shared_helper_blocks_byte_identical` across `route_task.py`, `task_telemetry.py`,
`task_input.py`, `task_complete.py` and `task_transcribe.py`. Any new shared constant or
function (including a `VALUE_FLAGS` entry) moves in all five scripts at once, never one.
Since schema v14 the block also holds `begin_immediate`, `source_states_for` and
`transition_task`, the only path a script takes to change a task's state (§ Thread status,
view time, retry and cancel).

## Duplicate-close guard (`task_complete.py --covered-by`, 2026-09-12)

Incident vi-499aac51e800: a worker closed the operator's request with "already transcribed
and routed … closes out a duplicate/stale ledger entry" — no covering task existed, and the
request silently vanished until the operator asked where it had gone. Since then, a
completion whose summary matches a close-out phrasing (regex `DUPLICATE_CLAIM_RE`, tuned
against all 259 real completion summaries in the ledger so ordinary prose that merely
mentions duplicates, "the same task system" or things "already sent" never trips it), or
that passes `--covered-by`, is accepted only after the LEDGER itself confirms the claim:

1. the covering task exists in the same tenant;
2. it has actually progressed (`running`/`awaiting_input`/`done` — a `received` cover has
   done nothing yet);
3. it carries the SAME request — content-word Jaccard overlap ≥ 0.15, calibrated on the
   incident pair (0.071) against paraphrased true duplicates (0.20+), pinned from both
   sides by `test_covered_by_overlap_calibration_pins_the_incident_gap`;
4. it is a DIFFERENT task — a self-cover would pass every other check (100% overlap with
   its own running state), so it gets its own refusal.

A refused completion writes nothing (the task stays in its current state); the worker
either names a real covering task or does the work and completes with a plain outcome
summary. The guard lives in `task_complete.py` only — the sole completion writer (the API
never transitions a task to `done`) — outside the SHARED LEDGER HELPER block, so the
five-copy byte pin is untouched.

`task_complete.py --short` (schema v8, 2026-09-13, vi-6ff65d97f391; semantics tightened
2026-09-15, answer-presentation P0) writes `tasks.result_short` — the ANSWER'S VERDICT:
one or two plain sentences an average non-technical reader understands, in the
product's own terms, carrying the conclusion and not the reasoning. The full answer
keeps every substantive detail; the short never restates it and never truncates it —
a verdict, not a compressed copy. The value is OPTIONAL and NEVER clamped in code: it
stores byte-exact, with no length limit applied anywhere in the pipeline (the
one-or-two-sentence rule is GUIDANCE to the worker, never a code cap). A
blank/whitespace `--short` is an argparse error and writes nothing (the task stays in
its prior state); omitting it leaves any existing value (and NULL on pre-v8 rows)
untouched via COALESCE. NULL means the PWA renders its uncapped deterministic
`answerLead` fallback; a stored short renders as-is (markers stripped).

## Structured answer data (`--structured`, schema v12, 2026-09-15)

`task_complete.py --structured <path>` stores a JSON object in
`tasks.result_structured` — the machine-readable companion to the markdown
`--summary`. The summary stays the FULL answer; structured data is ADDITIONAL,
never a replacement. Written by `task_complete.py` ONLY (the sole completion
writer); `transitionTask` never touches the column. NULL means the PWA renders
the markdown path; unparseable JSON at render time falls back the same way.

Shape (documented in `task_complete.py --help` — the injection text points
there, because the full shape does not fit the steer-limit budget):

```
{ "type": "comparison"|"listing"|"guide"|"form-set"|"summary",
  "title": "...", "recommendation": "...",
  "items": [ { "name": "...", "attributes": { "<label>": "<value>" },
               "actions": [ { "label": "...",
                              "kind": "call"|"link"|"task"|"save"|"share" } ] } ] }
```

`form-set` carries `steps` instead of `items`. Validation (client-permissive,
server-strict): `type` required and one of the five; non-form-set requires
`items` ≤20, each with a non-empty `name`, optional `attributes` object, optional
`actions` array whose entries carry a non-empty `label` and a known `kind`;
`form-set` requires a `steps` array; 64 KB encoded cap; unknown fields allowed
(forward-compatible). Malformed input is an argparse error — nothing is written.

Render dispatch (`public/app.js`): `safeParseStructured` → `renderStructuredAnswer`
per-type (P1 ships the fallback renderer for every type; dedicated renderers land
in later phases) → markdown fallback. `SHELL_VERSION`/`SHELL_CACHE` move together
on any `public/*` change.

## Task attachments (2026-09-13)

`POST /api/v1/tasks` multipart gains strict part naming: `audio` = the
recording, `files` (with filename, repeatable) = attachments, `text` = typed
text; any OTHER file part is a 400 (`unexpected file part "<name>"`). The
file-kind ANSWER handler keeps its own loose first-file-part rule — the
strictness is create-path only. Files-only creates are legal: source `text`,
`request_text` = `ATTACHMENTS_PLACEHOLDER` (`'(attachments)'`, ledger.ts,
beside `VOICE_TRANSCRIBING_PLACEHOLDER`).

Storage: `files/<task_id>/` alongside the audio (same directory is the truth
for what a task carries). Names pass the existing `sanitizeUploadName`, never
match `/^audio\./i` (prefix `file-` when they would), and de-conflict with
`-2`, `-3`, … before the extension. Caps are all pre-row (no task, no event)
and OPT-IN (vi-39ab14f84f14, 2026-09-13): count ≤ `max_task_attachments`
(400), per file ≤ `max_upload_mb` (413), total ≤ `max_attachment_total_mb`
(413), typed `text` ≤ `max_text_chars` (400, JSON and multipart) — each
enforced ONLY when its knob is set; unset/0 = no limit (the default), so
nothing is rejected or trimmed for size by default. Post-row
storage failure is VISIBLE (§1.9): voice → `transcribe_failed`, text →
`failed` + `task.failed` event, and the create response reports that state.

Caps are config: `voice_inbox.max_upload_mb` / `max_task_attachments` /
`max_attachment_total_mb` / `max_text_chars` in `~/.pa/config.yaml`; unset,
null, empty, or 0 all mean NO LIMIT — an explicit positive integer enforces
(the `min_audio_bytes` pattern without its default). `server.ts`'s request
body cap = 1 MB slack + `max_upload_mb` MB + `max_attachment_total_mb` MB
when each is set; when NEITHER upload knob is set the transport cap is
unlimited (Infinity).

Payloads: task detail and conversation detail tasks carry
`attachments: [{name, bytes}]` (excludes `audio.*`/`tmp-*`, name-sorted). The
public share view never carries it. Serving:
`GET /api/v1/tasks/:id/attachments/:name` (Bearer, tenant-scoped) streams a
file ONLY when the name equals an entry of the task's listing — the listing
check IS the traversal guard; anything else is 404 `not found`.

Injection texts carry ONE canonical attachments segment —
`Attachments (<n>): <p1>; <p2>. Open them from disk when the task needs them;
audio or video attachments can be transcribed with transcribe_voice.py. `
(trailing space; `''` when none) — rendered by `buildAttachmentsSegment`
(src/bridge-writer.ts) and `build_attachments_segment`
(scripts/route_task.py), pinned byte-equal by `src/tests/sync-twins.test.ts`
(shared `ATTACHMENTS_SEGMENT_SUFFIX` literal + golden render) with
golden/dir-listing/overflow tests in `tests/test_worker_scripts.py`. The
segment sits right after the `Request:` sentence (inbox text), right after
the `A voice recording is saved at …` sentence (voice inbox text), and in the
new `{attachments}` slot of `TARGET_INJECTION_TEMPLATE` /
`EXPECTED_TARGET_TEXT` (after `{request_text}. `, before the surface
sentence) — the slot's value is threaded through
`buildTargetInjectionTextWithBriefing` (API reroute) and counts into the
briefing budget base in both languages. route_task.py lists the task's files
dir (excluding `audio.*`/`tmp-*`, name-sorted), capped at 10 paths with a
trailing `… and <k> more in <dir>` display element (defensive only).

Worker-side attaches (AI-244, 2026-09-14): two scripts write straight into
`files/<task_id>/` — the dir listing IS the registration, no API call and no
ledger column. `task_blocker_ask.py --screenshot` stores `blocker-<name>`;
`task_complete.py --attach <path>` (repeatable) stores `result-<name>`. Both
apply the backend's copy semantics verbatim: `sanitizeUploadName` basename, a
distinguishing prefix so the stored name can never match the excluded
`^audio\.`/`^tmp-` patterns, `-2`/`-3` de-conflict before the extension, and
`tmp-*` staging-then-rename so a partial copy never registers. A missing
`--attach` path fails side-effect-free (all paths checked before the first
copy); a ledger-stage refusal keeps the copies as evidence and a corrected
re-run de-conflicts. When `--attach` lands, the `task.completed` event's
`payload_json` carries `"attachments": [<stored names>]` — an optional key,
omitted entirely when there are none; the script's JSON ack adds
`attachments` + `attachment_paths` under the same rule.

## Transcribe failure classes — the `task.failed` `code` field (AI-223, AI-239)

`task_transcribe.py --fail --reason <r> [--code <c>]` appends an optional
machine-readable `code` LAST in the `task.failed` payload; the reason text is
unchanged either way. Two code values are defined:

- `too_short` — audio-unusable (sub-floor/empty/near-silence artefact).
  Terminal `transcribe_failed`. It contributes no thread status, so a thread
  holding only it is hidden from the Recent list and the router offer, and Retry
  and Cancel skip it; the list row still carries the `too_short` flag
  (`isTooShortFailure` — newest `task.failed` event on a `transcribe_failed` row
  carrying `code: 'too_short'`).
- `infra` — transcription INFRASTRUCTURE failure (envelope `error_code`
  `no-engine`/`cloud-auth`/`ffmpeg-missing`/`other`, including an exec timeout), the
  2026-09-13 stranding class where good audio sits on disk. TWO shapes share the code:
  a `task.failed` event with `code: 'infra'` on a task STILL in `transcribing` is a
  NON-TERMINAL attempt marker — written only by the shared transcription action
  (`pa/src/lib/voice-inbox-transcribe.ts`, called by the telegram bot's poll-tick drain
  and the pa `voice-inbox-fallback` job) and the create path's queue-write-failure catch,
  via the ledger's own `appendEvent`, never a hand-built write. It changes no state. It
  paces the next attempt: 2 min after the first marker, 5 min after the second, 10 min
  after the third or later, measured from the newest marker's `ts`.

  It counts toward the
  retry bound (`PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS`, default 4; plus, with
  at least one recorded marker, the `PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS`
  age bound — default 45 min by `created_at`; a never-attempted over-age task still gets
  its first real try, while an over-age attempt the marker channel cannot record
  terminates directly). The bound is checked before the pacing, so a give-up is never
  delayed. Past the bound the task goes terminal `transcribe_failed` with
  `code: 'infra'` on the terminal event — visible in the list/triage count and paged to
  pa-alerts. Workers never transcribe and never run `task_transcribe.py`.
- absent — generic terminal failure (unchanged; surfaces).

A `task.failed` event on a non-terminal task is therefore legal and expected;
readers must key "is it dead" off `tasks.state`, never off event presence.

## Voice transcription and the cleaned request (2026-09-16)

The API server stores the recording and creates the task in `transcribing`; it never
transcribes. Transcription runs in the telegram bot process, on its poll tick, through ONE
implementation shared with the pa fallback job.

**Where it runs.** `pa/src/lib/voice-inbox-transcribe-drain.ts`
(`createVoiceInboxTranscribeDrain().kick()`) is called synchronously once per bot poll
iteration and never awaited. A kick scans the ledger at most once per 5 s for
`transcribing` tasks with no `worker_resource`, oldest first, and starts at most 3
concurrent attempts, fire-and-forget.

Every attempt calls `transcribeVoiceInboxTask`
(`pa/src/lib/voice-inbox-transcribe.ts`). The pa `voice-inbox-fallback` job calls the same
function for `transcribing` tasks older than 2 min, as a backstop. That job runs on the pa
catchup maintenance lane, which can stall silently, so nothing in this contract depends on
it for correctness.

**Claim.** Every attempt, from either caller, first takes the blackboard lock
`voice-inbox-transcribe:<task_id>` (agent `voice-inbox-transcribe`, try-once, a fresh
contextId per attempt) and releases it when the attempt ends. A busy claim skips the task;
the drain retries it 30 s later.

A dead holder's claim is evicted at once, and a hung live
holder's claim expires after the blackboard's stale window plus grace. After taking the
claim, the attempt re-reads the task and does nothing unless it is still `transcribing`.
The ledger transition table, enforced again by `task_transcribe.py`, is the final guard:
a second write-back is refused.

**Bounds.** The drain kills the `transcribe_voice.py` exec — its whole process tree, by
the PID it spawned — after `PA_VOICE_INBOX_TRANSCRIBE_DRAIN_TIMEOUT_MS` (default 300 000 ms);
the fallback allows 600 000 ms. `task_transcribe.py` calls are killed the same way after
30 s. A timeout is an infra failure (`error_code: other`). A drain attempt still unsettled
at the exec timeout plus 120 s frees its slot regardless, and its task becomes eligible
again after its retry backoff.

**The route-entry hold.** The bot's route drain looks up the task state of every plain
route line (no `kind`). A line whose task is still `transcribing` is held — neither
injected nor consumed — and injects on the first drain after the task leaves
`transcribing`.

A line whose task is `transcribe_failed` is consumed without injection.
An unknown task, an absent or unreadable ledger, and `PA_VOICE_INBOX_TRANSCRIBE_DRAIN=0`
all inject as before. The routing worker therefore receives the voice inbox text only
after the transcript exists.

**Cleaned request.** `tasks.transcript` holds the raw transcript and is never rewritten
after `task_transcribe.py --transcript` writes it. That write also sets `request_text` to
the same text. The routing worker reads both with `task_request.py show --task <id>` and
may then run `task_request.py clean --task <id> --text "<cleaned request>"`, which
rewrites `request_text` only. `clean` refuses unless the task is a `voice` task in
`received` with a non-empty transcript; it refuses a blank value and a value longer than
twice the transcript plus 200 characters.

It writes no event, bumps `updated_at`, and
writes nothing when the value equals the current `request_text`. Cleanup, never
authorship: drop disfluencies, fix mis-hearings, resolve pronouns against the
conversation; never add intent, answer, or change scope. The step is best-effort — a
refused or skipped `clean` leaves the raw text, and routing proceeds either way. Every
downstream reader of `request_text` (the target injection text, conversation briefings,
open-conversation snippets, the share view) sees the cleaned text.

**Display and search.** The PWA renders `request_text` as the operator's turn. When it
differs from `transcript` on a voice task, the raw words sit behind a "Your exact words"
disclosure. The rewrite reaches the PWA through the SSE `changed` ping and the 4 s poll,
and both render signatures include `request_text`. Search (`GET /conversations?q=`)
matches `tasks.transcript` as well as `tasks.request_text`.

## Live updates (SSE)

`GET /api/v1/stream` — auth via `?token=<bearer>` (the one exception to "Auth is
`Authorization: Bearer` on everything except `/health` and `/pair/exchange`": `EventSource`
has no headers option, so the query-string token is the accepted mechanism for this one
endpoint only). Two named events, both a bare ping with no payload — the client always
re-fetches via its existing tenant-scoped GETs rather than trusting an inline payload:

- `event: changed` / `data: {}` — ledger data moved (a task/conversation/event row
  changed). Detection: `src/event-stream.ts`'s `startChangeWatcher`, `PRAGMA data_version`
  polling on a dedicated connection, 1 s interval.
- `event: reload` / `data: {}` — the PWA shell itself changed on disk. Detection:
  `startShellWatcher`, `public/sw.js` mtime polling, 5 s interval.

A `:`-comment line (`: connected`) opens the stream; a `:`-comment heartbeat (`: hb`)
follows every 20 s to hold the connection through idle-timing proxies/tunnels between
real events.

`?shell=<version>` (optional query param, vi-7790f35108f8): the connecting client
declares the `SHELL_VERSION` its page runs (`public/app.js`; equals `sw.js`'s
`SHELL_CACHE` version, pinned by `src/tests/sync-twins.test.ts`). When it differs from
the on-disk `SHELL_CACHE` — or is absent, meaning a shell older than the handshake —
the server writes one `event: reload` immediately after `: connected`, once per
(session token hash, on-disk version): the mtime-watch broadcast only reaches clients
connected at the moment `sw.js` changed, so a page booted later from a stale
service-worker cache would otherwise run old code indefinitely and render newly
shipped input-request kinds as the unsupported-type card. An unreadable `sw.js`
declares no version and never nudges.

## pairing-codes.json shape

Bare JSON array of `{code, telegram_user_id, telegram_chat_id, first_name, created_at,
expires_at}` — the raw 8-char code sits in the file (the operator types it); only its
sha256 lands in the ledger's `pairing_codes` row on consume. Any new writer (the bot's
`/pair` handler) must copy `scripts/mint_pairing.mjs`'s write; the consumer is
`exchangePairingCode`.

## Conversation briefing (2026-09-10)

Amended (t-3, 2026-09-18): the per-turn dump described below was replaced with a
single runnable ledger-lookup reference line. See "Rendered format" and "Selection
rule" below for the current behavior.

The target-topic worker (`buildTargetInjectionText`) and, once a task is a known
continuation, the two inbox routing texts (`buildInboxInjectionText`,
`buildVoiceInboxInjectionText`) each carry a bounded prose recap of the conversation's
prior turns. This lets a bare follow-up like "make it shorter" get answered without the
worker asking what "it" refers to. `answer-resume.ts`'s steer text carries no briefing:
it resumes a worker that is mid-task and already holds the conversation in its live
context, so its whole point is a pointer to one answer, not a recap.

### Constants

Declared once per language: `src/conversation-briefing.ts` (the golden implementation)
and `scripts/route_task.py`, after the `# END SHARED LEDGER HELPER` marker — the
five-copy shared block itself is untouched.

| Name | Value | Meaning |
|---|---|---|
| `CONVERSATION_BRIEFING_MAX` | `1200` | Hard cap on the whole briefing string. |
| `CONVERSATION_BRIEFING_MIN` | `200` | Below this budget no briefing is built at all. |
| `CONVERSATION_BRIEFING_FIELD_MAX` | `400` | Per-field clamp for a request or an answer. |
| `INBOX_BRIEFING_MAX` | `300` | Cap for the two inbox texts (routing needs the head, not the turns). |
| `ROUTE_TEXT_MAX` | `3950` | Whole-injection-text ceiling = `STEER_MESSAGE_LIMIT - 50` (recalibrated 2026-09-13: the feedback surface sentence consumed the 200-char margin). |
| `STEER_MESSAGE_LIMIT` | `4000` | Hand-copy of the bot's `STEER_MESSAGE_MAX`, pinned by a test that reads `voice-inbox-steer.ts` at run time. |
| `BRIEFING_TRIM_MARKER` | `" [trimmed]"` | Appended to a clamped field. |

### Rendered format

Every line is `\n`-terminated, so a non-empty briefing always ends with `\n`. An empty
briefing is the empty string `''` — never a stub, never whitespace.

```
Conversation so far ({conversation_id}): {N} earlier turn(s), oldest first.
Title: {title}
Where it stands: {recap}
Next: {next_action}
Full turn-by-turn record: sqlite3 "{ledger_path}" "SELECT created_at, request_text, result_summary FROM tasks WHERE conversation_id = '{conversation_id}' ORDER BY created_at ASC".
End of the conversation record.
```

Line 1 is always present, and `{N}` is the TOTAL number of prior turns. `Title:` /
`Where it stands:` / `Next:` are each omitted when the `conversation_meta` value is NULL
or empty after trimming. The lookup line is a single unconditional line: rather than
inlining every prior turn's `request_text`/`result_summary`, it hands the worker a
runnable `sqlite3` command against the ledger — workers already run direct `sqlite3`
queries against this exact ledger file in production, so this is a proven retrieval path,
not a dead-end bare id. `{ledger_path}` renders forward-slashed, the convention
`buildVoiceInboxInjectionText` already uses for the audio path. No line ever carries the
literal `[Voice task ` or `[Voice inbox task ` shape: the field renderer rewrites it to
`(voice task ` / `(voice inbox task ` before clamping, so a briefing can never inject a
spurious id into `taskIdsInText`'s scan.

Field rendering, identical in both languages: collapse every whitespace run to one
space, trim, then clamp at `CONVERSATION_BRIEFING_FIELD_MAX` characters with
`BRIEFING_TRIM_MARKER` appended when the trimmed result is still longer.

### Selection rule

Prior turns are every task of the conversation except the one being written now, read in
`listConversationTasks`'s order (`created_at` ascending, then `task_id` ascending), for
the COUNT only (`{N}` in line 1) — there is no more turn content to select or drop. A
conversation with no prior turns yields `''`. Otherwise the header (line 1 plus any
present Title/Where it stands/Next lines), the lookup line, and the footer (`End of the
conversation record.`) are assembled unconditionally — the lookup line is present
whenever `N > 0`, never conditional on truncation or turn count. The result is returned
only when it does not exceed the caller's `maxChars`; otherwise the function returns `''`
(an all-or-nothing guard — there is no turn-selection/truncation step left to fall back
on).

### Budget formula

Both languages compute the per-call budget by rendering the injection text once with an
empty briefing, then filling in the real one:

```
base       = render(briefing = '')
budget     = min(CONVERSATION_BRIEFING_MAX, ROUTE_TEXT_MAX - len(base))
briefing   = budget >= CONVERSATION_BRIEFING_MIN ? build(..., max_chars = budget) : ''
final_text = render(briefing)
```

This two-pass shape is unchanged, though the briefing it now guards is fixed-ish size
(head + one lookup line + foot) rather than a variable turn-fill, so in practice the
`budget >= CONVERSATION_BRIEFING_MIN` gate is what decides whether a briefing is built at
all — the built briefing itself rarely comes close to `CONVERSATION_BRIEFING_MAX`. For
the two inbox texts the cap is `INBOX_BRIEFING_MAX` instead of `CONVERSATION_BRIEFING_MAX`;
at 300 characters the head plus lookup line plus foot fits comfortably, so a routing
decision still gets the full reference, not a partial one.

### Which text carries what

| Text | Carries | Cap | Cross-language pin |
|---|---|---|---|
| `buildTargetInjectionText` (worker that does the work) | the full briefing | `CONVERSATION_BRIEFING_MAX`, then the budget formula | YES — `sync-twins.test.ts` and `test_worker_scripts.py`'s `EXPECTED_TARGET_TEXT`/`GOLDEN_BRIEFING` |
| `buildInboxInjectionText` (text task, routing worker) | the briefing, only when `continuation` is present | `INBOX_BRIEFING_MAX` | none |
| `buildVoiceInboxInjectionText` (voice task, routing worker) | the briefing, only when `continuation` is present | `INBOX_BRIEFING_MAX` | none |
| `answer-resume.ts`'s steer text | nothing — deliberately unchanged | — | none |

The two inbox texts get a briefing only when the conversation is already decided; that
is the only case where a briefing changes a routing decision.

### Two rules a future editor will otherwise break

The briefing slot is a `${}` interpolation INSIDE the pinned backtick literal in
`buildTargetInjectionText`, never a `+`-joined segment placed outside it.
`sync-twins.test.ts` extracts shared text by walking backtick and `${}` tokens with a
regex, so a bare `briefingSegment(x) +` next to a template literal matches neither
alternative and is silently skipped — the two languages could then diverge with a green
pin. The test's interpolation map must list every interpolation used inside the pinned
backtick; an unlisted one throws. Concretely, before `briefing` was added to the map the
test threw `unknown interpolation in buildTargetInjectionText: "briefing" — extend the
sync-twins interpolation map` — proof the parser actually walks the construct rather than
passing by coincidence.

The pinned literals carry no backslash escapes. The Python side unescapes with
`.replace(/\\(.)/g, '$1')`, turning a literal `\n` into the letter `n`; the TypeScript
side unescapes only `` \` ``, `\$` and `\\`, so a real newline inside a backtick stays a
newline. A `\n` written into the pinned text would make the two languages compare the
letter `n` against a real newline forever. The briefing's own newlines live in the
runtime value the interpolation substitutes, never in the pinned literal itself.

## Live screencast (AI-246, 2026-09-14)

A worker can stream the headed Chrome it is driving to the voice-inbox PWA as live
JPEG frames, so the operator can watch a page the worker is on (payment, login,
OTP). Expanded to fullscreen, the live pane is also a remote control (v2): the
operator's taps, typing, scrolls, and navigation flow back into the same page
through the input routes below. Outside fullscreen the pane stays watch-only.

**The frame store is in-memory only** (`src/screencast-store.ts`): a
`Map<taskId, {buf, ts, width, height}>` holding only the NEWEST frame per task —
`putFrame` replaces, never appends, and rejects frames over
`screencast_max_frame_bytes` (default 512 KiB). Entries TTL-evict on read and via
a 10 s sweeper (`screencast_frame_ttl_seconds`, default 30). Frames NEVER touch
`files/<task_id>/` or any other disk surface — the store is the only surface, and
a test asserts no file appears under `files/<task_id>/` after a full ingest→pull
cycle.

**Two tokens, two sides of the wire.** The ingest side authenticates with the
shared ingest token, the pull side with the operator's paired-device session
token — they are different credentials on purpose, because the worker carries no
paired-device token:

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/v1/live/:taskId/frame` | `Authorization: Bearer` == `screencast_ingest_token` (constant-time compare; NOT a session — mounted above `authenticateSession`; task existence checked cross-tenant by id — the token is the authority) | 503 disabled → 401 → 404 → 413 over cap → 200 `{ok:true}` |
| `GET /api/v1/live/:taskId/frame` | paired-device Bearer, tenant-scoped | 401 → 404 → 204 no/stale frame → 200 `image/jpeg` (`no-store`) |
| `GET /api/v1/live/:taskId` | paired-device Bearer, tenant-scoped | `{ok:true, live, ts, width, height, operator_input_at?}` — `operator_input_at` is a ms epoch present only after the operator's first accepted input command on that task (omitted while none exists) |
| `DELETE /api/v1/live/:taskId` | ingest token | `clear`; 200 `{ok:true}` (idempotent — unknown task still 200), 503 disabled |
| `POST /api/v1/live/:taskId/input` | paired-device Bearer, tenant-scoped (the operator's enqueue — the ingest token is refused here) | 503 disabled → 401 → 404 → 400 bad shape → 413 rate-limit → 200 `{ok:true, seq}` |
| `GET /api/v1/live/:taskId/input?since=<seq>&wait_ms=<ms>` | `Authorization: Bearer` == `screencast_ingest_token` (the bridge's long-poll — a paired-device token is refused here; task existence checked cross-tenant by id) | 503 disabled → 401 → 404 → 400 bad `since`/`wait_ms` → 200 `{ok:true, cmds, maxSeq}` as soon as a command with seq>`since` exists, else 204 after ≤25 s (`wait_ms` only shortens; `since` defaults to 0) |

The single source of the ingest token is `~/.pa/config.yaml`
`voice_inbox.screencast_ingest_token` (env override
`VOICE_INBOX_SCREENCAST_INGEST_TOKEN`); PA reads the same key and injects it into
the worker env as `PA_SCREENCAST_INGEST_TOKEN`. When unset the ingest and DELETE
routes answer 503 and `live` is always false.

**The producer is the worker, not PA** — it spawns the bridge in the background
when the operator should watch, exactly like `task_blocker_ask.py`:

```
node <repo>/projects/voice-inbox/scripts/screencast_bridge.mjs --task <task_id>
```

The bridge reads `PA_BROWSER_CDP_PORT`, `VOICE_INBOX_PORT` and
`PA_SCREENCAST_INGEST_TOKEN` from env (all injected by PA for browser-session
dispatches; the token is required — absent, it fails fast). It picks the first
`type:"page"` CDP target, runs `Page.startScreencast` (jpeg), acks every frame,
throttles by dropping, and POSTs each frame to the ingest route. Stop = kill the
process: on SIGINT/SIGTERM it sends `Page.stopScreencast` and best-effort
`DELETE`s the live entry before exiting.

**Operator input (v2) is fullscreen-gated.** The PWA captures input only while
the live pane is fullscreen (Fullscreen API, with a CSS `position:fixed`
fallback where the API is unavailable or denied) — outside fullscreen the pane
is watch-only and sends nothing, the v1 behavior. `POST .../input` carries ONE
JSON command per call: `tap`, `doubletap`, `longpress`, `scroll`, `pinch`,
`type`, `key`, `navigate`, `back`, `forward`, `reload`. **`pinch` and
`doubletap` remain in the contract (bridge and server still accept them) but
the default PWA gesture map no longer emits them (v3, 2026-09-15): two-finger
and double-tap gestures drive LOCAL view-zoom/pan on the frame image — the
remote page is never scaled.**

Coordinates are PAGE pixels (`0..pageWidth`/`0..pageHeight`, a generous
4096×4096 bound when the live dims are unknown); `navigate` `url` allows
http/https/data only. Field bounds: `text` ≤ `screencast_input_max_text`
(4096), `url` ≤ `screencast_input_max_url` (2048), `durationMs` 1..60000,
`key`/`code` ≤64 chars, `modifiers` ≤8 strings. A per-task sliding-second
budget (`screencast_input_rate_per_sec`, 20) is the 413.

**The input queue is in-memory only** (`src/screencast-input-store.ts`): a
bounded per-task queue (`screencast_input_max_queue`, 64) with per-task
monotonic `seq` that survives drains and clears. Overflow drops the OLDEST
queued command — enqueue never fails for fullness; commands are consumed by the
bridge's drain, not aged out (no TTL — the cap is the only bound a dead bridge
needs). Commands NEVER touch `files/<task_id>/` or any other disk surface — the
same never-on-disk invariant the frame store carries, with the same failable
test. The bridge long-polls `GET .../input?since=` and injects each command into
the page over its existing CDP WebSocket (`Input.*`/`Page.*`/`Runtime.*`); a
server without the input routes answers 404/503 and the bridge quietly runs
screencast-only. `screencast_input_enabled` (default true) gates both input
routes, and the auth split is deliberate — a paired-device token cannot drain
input and the ingest token cannot enqueue it.

**`taskDetail` gains `live: <bool>`** — `screencastStore.has(task_id)`, a
routes-derived field (no ledger column; on `taskDetail` only, not on
conversationDetail's embedded tasks). The PWA polls `GET .../frame` at ~5 fps
while the live pane is visible and uses `GET /api/v1/live/:taskId` as the cheap
liveness check.

**`operator_input_at` (WP-J) rides both surfaces** — `taskDetail`'s task JSON
and `GET /api/v1/live/:taskId` carry it identically: a ms epoch recording the
task's most recent ACCEPTED operator input, present only after the operator's
first accepted input command on that task (the key is omitted entirely while
none exists). It lives in the input store alongside the seq counter, so it
survives a queue clear / bridge restart; `answerAndResume` reads the same
record and appends a takeover line to the steer text so a resuming worker
re-checks real page state instead of acting on stale blocker assumptions.
