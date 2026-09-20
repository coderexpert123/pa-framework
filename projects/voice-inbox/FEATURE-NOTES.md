# voice-inbox feature mechanics — per-wave detail

Companion to `CLAUDE.md` (rules live there; this file carries the per-wave mechanics,
incident stories and verification harnesses they compress, relocated 2026-09-14 under
the push-gate trim). Sections are dated; newest last within each group. Wire contracts:
`CONTRACTS.md`. Operator/ops detail: `docs/voice-inbox-operations.md`.

## Answer rendering

### Tiered answers (2026-09-13, vi-ffb0a6d3cb44)

`answerTier(text)` gates every result_summary: an answer estimated at >15 rendered lines
(`estimateAnswerLines`, a deterministic block/shape walk at 46 chars/line) renders as a
tiered card — an `answerLead()` IN SHORT lead (stump openers <40 chars are skipped,
uncapped since vi-6ff65d97f391), section chips from heading/label-value/list-lead
anchors, and the full original render behind a `Show full answer · N words` quiet
disclosure (`tieredAnswerNodes` in app.js; open state lives in `state.expandedAnswers`,
and `renderBlocks`' optional 4th param maps a chip to its top-level node index). Short
answers render byte-identically as before; the Copy button stays outside the collapsed
detail so it works while collapsed. The same change ships the long-URL overflow fix
(`.turn-assistant, .recap-item-reply { overflow-wrap: anywhere }` — the 2318px-vs-390px
audit defect from vi-80d40a939c32) and bumped the shell to v45 (v44 was taken by the
concurrent recording-limit bump; riding convention). `stripAnswerMarkers` is the shape
layer's own minimal marker strip — a fourth pinned duplicate beside app.js's
`stripInlineMarkers`, kept in sync by the answer-shapes suite. Verification harness:
`scratch/verify_answer_tiers.py` (its negative control strips the overflow rule and MUST
detect the bad state).

### Comparison renderer (2026-09-15, answer presentation P2)

`renderStructuredAnswer` dispatches `type: "comparison"` to `renderComparison`; every other
type keeps the P1 fallback. `comparisonCards` is the shared core — one card per item
(`.cmp-card`: name, a `.cmp-attrs` dl, an `.cmp-actions` row), one DOM for both layouts, with
the CSS switching a desktop grid to a swipe row under 680px (`.cmp-swipe`, added at 3+ items
only). Attribute rows share one key order (`comparisonAttributeKeys`, first-seen union) so the
desktop grid scans column-to-column; values run through `renderLines`, so a bare URL is a real
link. Actions: `call` → `tel:`, `link` → a new tab with `rel="noopener"`, and `task`/`save`/
`share` → real buttons whose single wiring seam is `runStructuredAction` (P3 replaces that body
only). `answerRegionParts` is the structured/markdown seam in `renderTurnContent`: structured
data wins when it renders something, an empty render falls through to markdown. The tiered card
is now shared — `tieredCardNodes` builds the IN SHORT card, chips, toggle and disclosure for
both `tieredAnswerNodes` (markdown detail) and `tieredStructuredNodes` (structured detail); the
structured lead chain is `result_short` → `recommendation` → `answerTier`'s lead, and chips jump
to the item card itself (`chipRow` now takes `{ text, node }` anchors as well as
`{ shape, startIndex }`). Shell at `voice-inbox-shell-v68`.

### Action integration (2026-09-15, answer presentation P3)

`runStructuredAction(action, task, control, itemLabel)` dispatches the three wired kinds; the
renderer builds each button first and attaches the listener to it (`control.addEventListener`),
because the handler needs the control itself — the P2 doc comment's "the call site does not
change" promise was not keepable. `task` → `createTask({ text, feedbackAbout: task.task_id })`:
the new task is self-rooted (the API rejects `feedback_about` with `continues`), and
`route_task.py` resolves `feedback_about` to the answer's conversation and briefs the new task's
worker from it; the control disables on tap and re-enables only on failure, and there is no
`pollRoute` (the operator stays on the answer). A prompt-less action falls back to its label —
the server validator requires only `label` + `kind`. `save` → `vi.saved`, one localStorage key
holding `{ "<task_id>": ["<item name>", …] }` (the readMarks idiom: permissive parse, fail-closed,
200-task bound, emptied tasks dropped); the button toggles `Saved ✓` ↔ the worker's label in place
via `applySavedLabel`, and an unsave removes the bookmark. `share` →
`navigator.share({ title: <answer title>, text: <item name>, url: location.href })`, an
`AbortError` treated as the operator's own dismissal; a device without `navigator.share` gets NO
share control (the conversation share sheet's own rule). Shell at `voice-inbox-shell-v70`.
Hardened same-day (P3 deep-recheck, shell v71): comparison attribute rows read OWN properties only
(`Object.prototype.hasOwnProperty.call`, not `in`) — one card declaring a prototype-named key like
`toString` no longer leaks Object.prototype's function source into sibling cards; and `attributes`
must be a plain object in both `comparisonAttributeKeys` and `comparisonCards` (an array no longer
renders numeric-index rows — the validator's dict requirement, the fallback's own guard). And a
`link` action's `url` must match `^https?://` before it becomes an href — the markdown renderer's
own scheme rule, applied to structured actions (the server validator checks label+kind only, so a
`javascript:`/`data:` url otherwise became an executable anchor in the app origin); non-http(s)
links render no control. Shell at `voice-inbox-shell-v72`.
Hardened further (P3 deep-recheck, shell v73 — t-311/D2): `classifyBlock` tries line-start dash
items BEFORE the ≥2-enumerator route — a literal `- ` at column 0 is unambiguous, while a
bold-label lead ending in `**` never matches the enumerator lookbehind; the old order found marks
starting at item 2 only and folded the label AND item 1 into `lead` with a literal `- ` left
inside it. The same dash-first order now applies in `plainParagraphText` (the list row's clamped
snippet, `lineDashSplit` mirroring `answerLineDashSplit`), and `turnSummaryText` reads
`plainAnswerSnippet` for `result_summary` — the same structural read as the answer card instead
of a raw whitespace fold that leaked `**` and `- ` markers into the recap line. Pinned by the
`t-311/D2` fixtures in `answer-shapes.test.ts` (classifier) and `structured-answer.test.ts`
(snippet, mutation-proven — the old order cannot produce the asserted output). Same pass also
closed the emitter-side contract gap: `task_complete.py --help` — the shape reference the
injection guidance names — now names the per-kind action target fields (`call`→`value`,
`link`→`url` http(s), `task`→optional `prompt`); an action missing its target field renders no
control, and the documented `{label, kind}`-only shape let a worker emit a call/link that
validated yet painted nothing (pinned by `test_complete_structured_help_names_per_kind_action_fields`).
The same collapsed-consumer sweep closed the last raw-fold: `maybeNotify`'s failed-state toast now
flattens `result_summary` through `plainAnswerSnippet` (never `firstSentence` — its `:`-clamp would
cut "quota exceeded: 429" down to "quota exceeded"); pinned structurally in
`comparison-renderer.test.ts`. Shell at `voice-inbox-shell-v74`.

### Interactive form-sets (2026-09-15, answer presentation P4)

`renderStructuredAnswer`/`structuredDetail` dispatch `type: "form-set"` to
`renderFormSet(data, task)`; a payload the normaliser (`formsetSteps`)
rejects falls back to `renderStructuredFallback` — a readable step list,
never a blank card. One step per screen inside the answer card: choice and
confirm tap their option and slide on ~200 ms (a `navSeq` generation guard
cancels a stale hop so a changed mind never double-advances); choice steps
also carry a typed escape lane; text and file steps take an explicit Next;
Back is always on screen and walks the DERIVED path — visited indexes
recomputed from the answers every render, never stored, so a
backward-pointing branch is terminal, a self-target ends the flow, an unknown
target falls back to declaration order, and changing an earlier answer prunes
its stale trail. Step shape accepts the SPEC's `prompt` OR the widget
schema's `title`, `type` defaults `choice`, confirm defaults Yes/No; `locked`
steps carry `answer`. Drafts: `vi.formset.<task_id>` →
`{answers, at, done, updatedAt}` (the `vi.saved`/`vi.form.` idiom: permissive
parse, fail-closed, 30-day lazy sweep); `at` is the view pointer, a stale or
off-path value clamps to the furthest reachable step; a done draft re-renders
the completion state. File answers live in `formSetFiles` (page memory) — a
restored filename is dropped and the step asks again. Submit modes:
`create-task` → `createTask({ text, files, feedbackAbout: task_id })` (the
P3 idiom — its own conversation); `update-conversation` → `continuesTaskId`
then `refreshConversation().then(scrollFollowUpIntoView)`; `save-only` → the
done-marked draft IS the record (blocked outright when a file is staged —
a phantom filename submits nothing). `submit_early` adds a mid-flow Submit
early once any step is answered. `formsetAnswersText` writes the submission
as the operator would ("Title: answer" per VISITED step — skipped branches
never leak in). Server side, `task_complete.py --structured` validates the
whole step contract two-pass (ids `^[a-z0-9][a-z0-9-]{0,39}$` unique first,
then per-step shape: prompt-or-title, locked.answer, type allowlist, unique
option labels, preselected ∈ labels / free text on text steps only, branch
keys ∈ option labels or the locked answer, targets declared + non-self,
save-only forbids file steps) and the injection guidance names form-set
(`route_task.py` + `bridge-writer.ts`, byte-equal). Shell at
`voice-inbox-shell-v75`.

Recheck tightening (same day, three findings): the P1 fallback's step label
now reads `name → prompt → title` — a `title:`-spelled set that fails
normalisation still lists its steps (C2's both-spellings-bind rule reached
the safety net). The validator seeds a confirm-without-options step's labels
as Yes/No, so `preselected: "Yes"` validates and a `branch` key outside
Yes/No is rejected — before, the implicit option set went unchecked in both
directions. And a `save-only` done-draft strips file-step answers that have
no staged File — a name claiming a nonexistent attachment is the phantom the
mode exists to refuse, and an off-path file answer could otherwise persist
one.

Pass 2 added two more guards: the normaliser now requires the server's id
family `^[a-z0-9][a-z0-9-]{0,39}$` — a prototype-named id (`__proto__`)
records no answer (the `answers` setter ignores the write) and would
soft-lock the flow on a corrupt row. And a tap hop is guarded TWICE: `navSeq`
inside the render plus `formSetGenerations`, a per-task counter bumped by
every `renderFormSet` call — a teardown/rebuild (the same hazard
`audioPlayerState` exists for) kills a hop armed on the detached copy, which
otherwise fires `doSubmit` behind the rebuilt card's back. Pass 3 closed the
twin of that race: `submitFormset` reads the draft first, and a `done: true`
draft is the receipt — a rebuilt card restored from a pre-done draft can
still reach Submit, and re-sending files a duplicate task. Task modes report
`sent` (save-only `saved`) with no `createTask` call. Also in pass 3: the
branch map is `Object.create(null)` — `__proto__`/`constructor` are legal
option labels the validator accepts, and on a plain object the write is
swallowed while the read hits `Object.prototype` (truthy → the branch
silently falls through to declaration order, so a valid answer loses its
jump). The same pass: a `preselected` that names no option on a choice or
confirm step (a validator-bypassed payload) is dropped instead of applied —
a ghost answer the operator never made would otherwise light up in the
escape lane as if typed. The file step also gained a Remove control: the
save-only 'blocked' notice tells the operator to remove the attachment, and
the control has to exist for that instruction to be actionable — detaching
clears `formSetFiles`, the answer, and re-disables Next/Submit. Pass 7 caught
the restored-done line: a save-only record that never left the device now
says "saved on this device" on rebuild too, not "sent" — the done card reads
the mode, same as the submit path does.

### Device awareness: the surface hint (2026-09-16, answer presentation P6)

`createTask` in `public/app.js` reads `window.innerWidth <= 680 ? 'phone' : 'desktop'`
once per create and appends it to BOTH body shapes — `fd.append('surface', surface)` on
the multipart path and `payload.surface = surface` on the JSON path. None of the seven
call sites changed: the hint is a property of the app, not of any caller. `<= 680` is the
CSS phone breakpoint, not a second number; the plan's `< 680` disagreed with its own
`@media (max-width: 680px)` at exactly 680px.

`createTaskHandler` (`src/routes.ts`) reads the field from both shapes, allowlists
`phone|desktop` with `400 surface must be "phone" or "desktop"`, and passes it to the
ledger. An omitted hint stores NULL — never a `phone` default, which would have stamped
every non-PWA and every stale-shell task with a layout it never asked for and made the
NULL path unreachable. `publicTask` needed no edit: it is a spread-drop of two fields, so
the column reaches the client the moment it is on `TaskRow`; `routes.test.ts` asserts that
by reading `surface` back off `GET /tasks/:id`, so an allowlist rewrite of `publicTask`
fails there.

Schema **v13**: `surface TEXT`, nullable, appended at the tail of `tasks`.
`migrateAddV13Column` is the `table_info`-probe pattern of v7-v12 — idempotent, no
backfill, never demotes `user_version`. The v13 migration test builds a hand-made v12
file, asserts the column is absent first (the known-bad control), opens it, and pins the
seeded row's `surface` at NULL: an older answer must render exactly as before, which is
the regression that would otherwise change every historical answer silently. The same
bump exposed an inert check — `does not demote a newer user_version` seeded 13, which
`setUserVersion` now short-circuits on, so it was bumped to 14.

Rendering: `surfaceLayoutClass(task)` maps the hint to `cmp-phone`, `cmp-desktop` or
`''`, and `comparisonCards` APPENDS it to the existing count-modifier expression rather
than replacing it — `(cards.length >= 3 ? 'cmp-cards cmp-swipe' : 'cmp-cards') + …` — so
the P2 source pins keep matching and a task with no hint produces a byte-identical class
string. Everything that is not exactly `'phone'` or `'desktop'` contributes no class, so
the fail-open path and the historical path are one path.

The CSS override is **one-directional**, and that is the phase's real decision. The
source SPEC §6.2 said a phone-sourced answer reflows to the grid on desktop; the PLAN's
"Done when" said it renders phone-first at 1280px. Both-directions is self-refuting — if
CSS won at every width the class could never change a pixel — so the PLAN binds.
`styles.css` § device surface declares `.cmp-cards.cmp-desktop { display: grid }` and
re-declares the SAME two-class selector inside `@media (max-width: 680px)` as a flex
column: the specificities tie, so source order decides and the later media query wins.
There is deliberately no min-width rule taking the stack away from `cmp-phone` — a 390px
screen cannot show a 200px-minimum grid whatever asked for it, but a wide screen can show
a stack. Comparison only: P5 reserved `.cmp-` for exactly this, and `.lst-`/`.gde-`/
`.sum-` stay CSS-only.

Instrument honesty: node cannot compute a cascade, so `device-surface.test.ts` does not
claim to. It asserts the two mechanical properties that decide it — both selectors carry
exactly two classes, and the media-query copy is later in the file — plus the declarations
on each side; the known-bad states it discriminates are a bare `.cmp-cards` inside the
media query (loses the specificity tie) and the section placed above the P2 media query
(loses the order). The pixel proof is the 390px smoke test. Shell at
`voice-inbox-shell-v82`.

### Pattern renderers: listing, guide, summary (2026-09-15, answer presentation P5)

`renderStructuredAnswer`/`structuredDetail` dispatch `type: "listing"` to
`listingCards`/`renderListing`, `type: "guide"` to `guideSteps`/`renderGuide`
and `type: "summary"` to `summarySections`/`renderSummary` — every declared
type now has a dedicated view; the P1 `renderStructuredFallback` covers
unknown types only. A view that finds no usable item returns `{node: null}`
and the answer falls through to the markdown path, same as an empty
comparison. Item conventions: `item.summary` is the one-line gloss
(`item.description` the fallback, else the attribute pairs joined on one
line via `itemDetailLine`), `item.points` a bullet list (summary sections
and guide steps), `item.done` the guide's initial check state. The guide is
a checklist — "N of M done" + a `<progress>` bar repaint per toggle — whose
marks persist at `vi.guide.done` through `toggleNameInStore`, the P3
saved-item store generalized (`nameStore`/`nameStoreList`/`nameStoreHas`,
`isItemSaved`/`toggleSavedItem` kept as the vi.saved wrappers); the worker's
`done: true` marks seed a task with no stored list, and a seeded result is
kept even when empty so an unchecked default stays unchecked. Steps carry
the step number inside the check circle (the check icon swaps in on
`aria-checked`), and every pattern view returns `{text, node}` anchors so
the tiered card's chips land on the row, step or section they name. Layout:
`.lst-` rows, `.gde-` steps, `.sum-` section cards (two columns above
680px) — `.cmp-` stays comparison-only so P6's device classes never leak
onto these views; `.cmp-actions`/`.cmp-act`/`.cmp-lead`/`.cmp-attrs` are the
shared pieces. The server validator shape-checks `summary`/`description`
(string), `points` (non-empty-string array) and `done` (boolean) when
present — permissive, unknown fields still pass — and the injection
guidance names all five types. Shell at `voice-inbox-shell-v79` (v77 = the
P5 recheck pass-1 repaint fix: a toggled guide check repaints every step's
state from the store — a repeated step name no longer leaves its twin
stale — and the head counts painted steps, not distinct names; v78 = the
pass-2 fix: guide bullets render through `renderLines` like summary
points, so a URL inside a step stays a link; v79 = the pass-3 fix:
`itemLeadLine` (prose-only) feeds the summary card's detail line so
attributes no longer print twice when the section also draws the dl).

### Two uncapped versions (2026-09-13, vi-6ff65d97f391)

Schema v8 adds nullable `tasks.result_short` — a worker-written standalone short
summary written by `task_complete.py --short`, NEVER clamped or trimmed anywhere in the
pipeline; the injection twins teach it (`--short "<one or two plain sentences>"`, funded
by compressing existing template sentences inside the pre-verified steer budget — stress
render 3942 ≤ `ROUTE_TEXT_MAX` 3950). `tieredAnswerNodes` prefers the stored short
(marker-stripped) and falls back to the uncapped `answerLead` for pre-v8 rows (NULL);
the 240-char cap + ellipsis path is DELETED — fragments are added whole or not at all,
and the sentence window is unbounded so a long first sentence splits at its true end.
Verified at phone width (390x844): a stored 298-char short renders byte-exact, and the
fallback lead exceeds the old 240 cap with no ellipsis. Shell at `voice-inbox-shell-v48`
(v47 was taken by attachments).

### Plain-words short + rich markdown answers (2026-09-13, vi-ecbf5d33801a)

The operator refined the two-version contract by voice: the short is NOT a one-or-two-
sentence summary — it is however many simple sentences it takes to actually explain the
answer to an average non-technical user, in the product's own terms (still never capped,
still never a truncated start); and both versions actively use rich markup — the
injection's old "no markdown" sentence became a "format richly" sentence teaching the
card's vocabulary (### headings, **bold**, - or 1) lists, pipe tables with a |---| row,
code fences, [text](url) or bare links). The renderer caught up: markdown links render
as real `a` elements (http(s) only — `javascript:` and other schemes stay literal text,
pinned by the ADVERSARIAL corpus), inline `` `code` `` renders as a code node, table
cells parse inline markdown, and links nest inside **bold**. `stripAnswerMarkers` and
app.js's `stripInlineMarkers` both unwrap `[text](url)` so leads/chips/snippets stay
plain text. Steer budget re-measured: stress render 3917 ≤ 3950. Verified at phone
width via the extended harness (table/link/code facts, multi-sentence plain-words short,
scheme gate). SPEC: `plans/2026-09-13-inshort-plain-words-rich-html-SPEC.md`.

### Answer components and copyability (2026-09-11)

`public/answer-shapes.js` is the pure shape layer for `result_summary` (no DOM, no
storage; loaded by index.html before app.js): `splitAnswerBlocks` extracts fenced code
blocks first, then blank-line paragraphs; `classifyBlock` maps each paragraph to
`label-value | table | heading | list | prose` (the list rule mirrors app.js's untouched
`findEnumerators` plus a line-start dash-bullet case — the copy is pinned byte-exactly
by `src/tests/answer-shapes.test.ts`, third copy of the rule beside
`migrate_answer_format.py`); `looksStructured` flags prose that still looks structured;
`shapeFingerprint` is its structural signature. app.js's `ANSWER_COMPONENTS` registry
renders those kinds with a recursion depth cap of 2. `renderProseBlock` calls
`noteUnhandledShape`, which records structured-but-unhandled shapes in localStorage key
`vi.answer-shapes` (fingerprint → count/lastSeen/200-char example, 50 entries max) and
`console.info`s each new fingerprint once — detection is automatic, promotion into a
registry component is a human/agent decision (read the key, diff against the registry,
add a matcher + renderer). Every answer turn with a `result_summary` carries a Copy
button (raw `result_summary` string, byte parity with Telegram; async Clipboard API +
execCommand fallback); each code block carries its own. `answer-shapes.js` is a shell
asset: it goes in `SHELL_ASSETS`, and `voice-inbox-shell-v*` bumps whenever ANY shell
file changes — without the bump the installed TWA never fetches the new shell.

`scripts/migrate_answer_format.py` (2026-09-10) is the one-time backfill for
`result_summary` rows written before the formatting instruction landed:
`needs_migration()` finds flat/bold/heading legacy text, an external LLM command
reformats it, and an equivalence gate (`same_content()`, whitespace/`**`/`#`-insensitive)
plus a shape gate reject anything that changed a word, dropped a sentence, or left the
text still flat, before `--apply` (never the default) snapshots the ledger and updates
only the accepted rows.

## Attention + push

### Browser notifications mechanics (2026-09-11, vi-08b2360d27b3)

`maybeNotify()` rides the 4 s poll inside `refreshConversations()` BEFORE the signature
early-return, diffs `notifSeen` per conversation, fires only while `document.hidden` +
permission granted, on needs-you / `done` / `failed` transitions (tag `pa-<id>`, first
scan seeds only, never throws into the poll loop). The enable button in
`signOutBlock()` shows only at permission `default` and removes itself. `sw.js` gained
`notificationclick` (focus or open the app); ANY shell change bumps
`voice-inbox-shell-v*`. The code-driven channel (`pa ping`: Windows toast + private-chat
mirror, called by `task_complete.py` / `task_input.py`) is RETIRED to opt-in — no-ops
unless `PA_ATTENTION_ENABLED=1` (`PA_NOTIFY_DISABLED=1` stays the kill switch); the
spawn reports `disabled` honestly and never fails the ledger outcome. Gotcha:
`notifSeen` is a const Map kept fresh by clear-and-refill — do not reassign it.

### Web Push subscriptions + VAPID key vending (WP2, 2026-09-11)

`src/web-push-store.ts` owns `~/.pa/voice-inbox/push-subscriptions.json` and
`~/.pa/voice-inbox/vapid.json` on THIS side — `getSubscriptions`/`saveSubscription`/
`removeSubscription`/`pruneSubscriptions`/`getOrCreateVapidPublicKey`, each taking an
optional trailing `storageDir` test seam (mirrors `pa/src/lib/web-push.ts`'s own seam).
It does NOT duplicate the RFC 8291/8292 encrypt+dispatch engine — that stays in
`pa/src/lib/web-push.ts` (WP1), which is the only writer of actual push deliveries.
BOTH files are read/written by both processes; `getOrCreateVapidPublicKey` reproduces
`getOrCreateVapidKeys`'s exact algorithm (verified by round-trip: either side generating
first, the other reads the same public key back byte-for-byte) — do not change the JSON
shape here without changing it there in lockstep.

Routes (`src/routes.ts`, all under the same Bearer-auth gate as `/me`/`/topics`):
`GET /api/v1/push/vapid-public-key`, `POST /api/v1/push/subscribe`,
`POST /api/v1/push/unsubscribe`, `POST /api/v1/push/test`. `/test` shells out to the
compiled `pa/dist/bin/pa.js ping --payload-file <tmp> --no-toast --no-ping` (never
throws — spawn/timeout/parse failures all resolve `sent:0`) rather than re-implementing
encryption here. Gotcha: `pa ping`'s toast/telegram-mirror legs are opt-in-disabled by
default, but its webPush leg is NOT gated by that same switch — `/api/push/test` relies
on exactly this asymmetry (the two flags it passes silence only the other two legs).

`RouteDeps.pushStorageDir?` lets tests point subscription/VAPID storage at a temp dir
instead of the real `~/.pa/voice-inbox`; `server.ts` wires it to `voiceInboxDir()` (the
same default `web-push-store.ts`'s own functions fall back to when the field is
omitted).

## Audio

### Playback route + player (2026-09-11)

`GET /api/v1/tasks/:id/audio` (same Bearer-auth gate, tenant-scoped via `getTask`,
under `src/routes.ts`) streams the original recording for a voice task — available the
moment the upload lands (state `transcribing`) and unchanged once transcription
completes, since the file is written synchronously in `createTaskHandler` before the
task ever queues. 404 for a text task or a voice task whose file never landed (the
AI-223 too-short floor and the storage-failure path both leave none). The extension
varies by upload, so `findAudioFile` reads the task's `files/<task_id>/` directory
rather than assuming `.webm`. `ApiResponse.file` (`{path, contentType}`) is a third
response shape `server.ts` recognizes beside `body`/`html` — `sendFile` streams it
directly, no Range support: `public/app.js`'s player fetches the whole body with its
bearer header (an `<audio src>` attribute cannot carry one), then plays a `blob:` URL,
so native scrubbing needs no further round-trip. Shell bumped to v20.

### Playback failure handling (2026-09-12, vi-dd79dee2dae1)

A real operator recording confirmed via ffprobe that Chrome's MediaRecorder writes webm
with no duration in the container header (`Duration: N/A`) — the file itself carries
real, non-silent audio, but the `<audio>` element that replaces the button on tap
reported `duration === Infinity`/`NaN` and needed a seek-to-end-then-back to compute
the real duration before scrubbing/autoplay behave. The original handler also had no
`error` listener: any decode/stream failure left a dead, controls-less element in place
of the button with no way to retry. `audioPlayer()` (`public/app.js`) does the duration
fix-up on `loadedmetadata`, calls `.play()` explicitly (swallowing autoplay-policy
rejections — native controls stay visible for a manual tap), and on the element's
`error` event restores the original button plus a notice so a failure is always
recoverable. Shell bumped to v26.

### CSP root cause of the errors themselves (2026-09-12, vi-b65386204dfa)

The fix above made failures recoverable but didn't stop them — EVERY recording still
hit the `error` listener, `MediaError.code === 4` ("Media load rejected by URL safety
check"). `public/index.html`'s CSP was `default-src 'self'` with no `media-src`, and
per the CSP spec `'self'` does NOT match `blob:` URLs even when the blob was created
same-origin — `fetchAudioUrl()`'s whole design is a `blob:` URL (the `<audio src>`
attribute can't carry the bearer header the API needs), so the browser blocked every
playback at the CSP layer before it ever reached the decoder; ffprobe on the on-disk
files and a byte-diff of the API response both confirmed the audio itself was always
fine. Fixed by adding `media-src 'self' blob:` to the CSP meta tag. Verified with
headless Chrome via the DevTools protocol (fetch the real audio route with a minted
test session, assign the blob to an `<audio>` element, read `.error`): a fresh profile
against the old CSP reproduced `AUDIO_ERROR:4` with the exact `Log.entryAdded`
CSP-violation text, a fresh profile against the fixed CSP loaded the same file clean —
the "check must be able to fail" bar, not just a post-fix sanity check. Shell bumped
again (index.html is a shell asset).

## Capture reliability + restored quality (2026-09-13, vi-9c17b02e9171)

`public/app.js`'s capture path follows one rule: a recording runs until the operator
stops it, and what was captured is never silently discarded. Three mechanisms enforce
it. (1) The bitrate is deliberately UNPINNED (`new MediaRecorder(stream)` — browser
default, ~120 kbps measured; the 32 kbps pin from vi-ed1d56beebe1 was rejected as
quality loss); recordings of any size send (caps are opt-in since vi-39ab14f84f14), and
the time-or-size nudge (`RECORDING_NUDGE_MS` = 25 min, `RECORDING_NUDGE_BYTES` = 20 MB
— 20 MB lands near 29 min at the default bitrate) is a plain send-it reminder, not a
limit. (2) `visibilitychange → hidden` no longer stops/discards a recording — only
read-aloud, polling and SSE pause. (3) All teardown funnels through `finalizeCapture()`
(exactly-once via `cap.done`), driven by the recorder's own `stop`/`error` listeners
and audio-track `ended` — registered in `startCapture`, replacing the old
`recorder.onstop`-inside-stopCapture assignment, which was the root cause of total
capture loss on an OS-initiated stop (recorder.stop() then threw InvalidStateError and
the blob was never assembled). `stopCapture(discard)` is only the operator entry: it
marks `userStop`/`discarded`, then stops the recorder. A system stop sends the partial
with an honest "interrupted after m:ss" notice. `keepScreenAwake` holds a screen wake
lock during recording (silent no-op if unsupported or denied) — screen auto-lock was
the most common mid-speech cutoff trigger, and the lock is re-requested on visible if a
capture is still live. Shell at `voice-inbox-shell-v46`.

## Live updates (SSE, 2026-09-11, vi-6b1014ea197b) — mechanics

`GET /api/v1/stream` (Bearer via `?token=`, `EventSource` cannot set headers) is a
single one-way push channel, handled directly in `server.ts` before the request ever
reaches `routes.ts` (that router returns a resolved `Promise<ApiResponse>` and cannot
express "hold this connection open"). `src/event-stream.ts` owns two watchers, both
feeding the same `EventHub.broadcast(event)`: `startChangeWatcher` polls `PRAGMA
data_version` on its own dedicated ledger connection (a connection never sees its own
writes as a version bump, and the ledger is also written by out-of-process Python
worker scripts, so only a second, otherwise-idle connection sees every commit from
every source) and fires `changed`; `startShellWatcher` polls `public/sw.js`'s mtime and
fires `reload`. `changed` re-triggers `pollTick()` (near-instant refresh, same
de-duped re-render as the poll); `reload` calls `updateAndReload()`, which asks the
current service-worker registration to `update()`, reloads the tab on
`controllerchange` (or after a 3 s fallback if there was nothing new to install).
`startShellWatcher` is deliberately independent of the server process restarting: a
`public/`-only deploy never touches `dist/.build-stamp` (build.mjs only compiles
`src/*.ts`), so it never trips the watchdog's stale-build restart — server-process
freshness is the separate Task Scheduler watchdog on `dist/.build-stamp` vs
`server.lock` (`docs/voice-inbox-server-lifecycle.md`); do not duplicate that logic.

## Thread lifecycle list (2026-09-17, schema v14) — mechanics

The list is one Recent view (`GET /conversations?view=recent`) in two header-free bands
split by a gap: live (Recorded/Transcribing/Routed, Needs You, Ready, Failed, Running), then
history (Viewed, Concluded, Cancelled). A Recent | Older conversations switch heads the list
and the archive. The server sends each row's `status`, `status_rank` and `band` already
sorted; the PWA maps the token through `THREAD_STATUS_TEXT` to a word and through
`statusToneClass` to one of four tones.

The tones are attention (Needs You, Ready: accent ink), problem (Failed: full ink, weight
600 and a steady `--ring` inset ring on the row, because the theme has one accent hue),
neutral (in progress: dim) and muted (history: faint). Ready keeps the `.row-ready` accent
ring and pulse. Rows keep the two compact age chips (plus-circle = created, clock = last
updated), and `listSignature` keeps its one-minute bucket and adds `status`, `band` and
`failed_unresolved`, so a clock-only move (Viewed → Concluded) re-renders on the 4 s poll.

The server records the view time, so the per-device read marks are gone.
`postConversationViewed` posts once per answer (key `<conversation_id>|<answer_landed_at>`)
when an open conversation's answer is unviewed and the page is visible.
`uploadLegacyReadMarks` posts each old `vi.read` mark whose answer is still unviewed, with
the mark's own open time, then removes the store; a network failure keeps it for the next
load.

Rows never reshuffle under the finger: a poll re-render waits while a touch, wheel or scroll
happened within `LIST_IDLE_MS` (2.5 s) and the list is scrolled away from the top, and
`flushHeldListRender` applies it on idle or at the top. Retry, Cancel and Select re-render at
once. Failed rows carry Retry and Cancel; two or more add a bar with Retry all, Cancel all and
Select (checkboxes, then Retry selected, Cancel selected and Done).

Cancel always confirms in a sheet, because a Failed thread can also hold running work. The
"Not placed yet · N" row, the Finished pile and the All-conversations pill are gone, and no
list control opens the triage view any more (the view itself remains).
`read-state.test.ts` slice-executes the real functions.

## Sticky queue headers (2026-09-12, vi-39dd908f1ffd) — story

`app.js` re-renders the topbar inside a wrapper div (`#list-topbar-slot`) with no CSS
sizing of its own, which made it `.topbar`'s sticky containing block with zero spare
height — `position: sticky` had nowhere to hold it. Fixed with
`#list-topbar-slot { display: contents; }`, which removes the wrapper's own box so
`.topbar`'s containing block becomes the real page-height ancestor.

Gap found on the operator's "still broken after refresh" follow-up: the fix itself was
correct and live on the server the whole time (byte-identical, verified via direct
`curl` against the running instance), but the fix's own commit never bumped
`voice-inbox-shell-v*` per the shell-asset rule, and the original verification rendered
the raw DOM/CSS in headless Chrome rather than going through the actual PWA delivery
path (the service-worker's cache-first shell). Any browser/TWA that already had the old
service worker installed kept serving its cached pre-fix files — a plain refresh can't
dislodge a cache-first SW that never saw a reason to update. Lesson: verifying a
shell-file fix requires bumping `voice-inbox-shell-v*` and confirming the fix survives
the SW cache path, not just confirming the DOM/CSS renders right.

## Back-to-back voice notes (2026-09-12, vi-6cb5faaf1b74) — story

Two voice notes recorded 14 seconds apart, both about the same task, spawned two
unlinked conversations. Root cause: `listOpenConversations` built the routing worker's
"Open conversations" menu from each candidate's ROOT task's `request_text` — for a
voice task still mid-transcription that's the literal `VOICE_TRANSCRIBING_PLACEHOLDER`
(`"(voice recording)"`), not real content, and transcription (Groq/OpenAI/Deepgram)
routinely takes 1-4+ minutes, so the very-recent sibling most likely to be a
continuation is exactly the one most likely to still be mid-transcription when the
second note's routing entry is built. The menu gave the model a snippet
indistinguishable from no information, so it never emitted `--continues`, made an
independent routing call, and (compounding it) the deterministic fallback
(`pa/src/lib/maintenance/jobs/voice-inbox-fallback.ts`) then raced in and re-routed the
same task to its generic default 5 seconds after the model's own (already-independent)
route — `route_task.py`'s state gate allows re-routing FROM `routed` (needed for the
legitimate stale-routed replay), so nothing stopped the fallback from clobbering a
route a live worker had just made. Fixed both ends: honest transcribing label + recency
suffix, and the fallback's `handleReceived` re-reads the task's live state
(`isStillReceived`) immediately before calling `route_task.py`. Neither fix changes the
wire format of `conversationsSegment`'s own instruction sentence (bridge-writer.ts) —
only the snippet CONTENT `listOpenConversations` feeds into it.

## System status view (2026-09-12/13) — story

`GET /api/v1/system/status` (Bearer-gated, NOT tenant-scoped — the data is global)
serves live thread/queue/worker/CPU/mem/disk stats for the PWA's "System status" view
(`state.view === 'system'`, the gauge icon next to sign-out, 3s poll while visible).
Spec: `plans/2026-09-12-system-status-view-SPEC.md`. All reads of `~/.pa/
topic-threads`, worker pids, `blackboard.json` and psutil-derived system numbers are
owned by `scripts/system_status.py` — a one-shot script printing one JSON line (ported
from the retired dashboard's `server.py`; reusing its proven psutil logic beats
re-implementing Windows disk/process reads in Node). `src/system-status.ts` spawns it
with stale-while-revalidate semantics: the 2026-09-13 recurrence of vi-2d9444e29d52
showed the collector takes 10-25s on a degraded machine (the ~33k-file pa-dir walk
alone measured 11.5s) and the original 8s spawn timeout 500'd every poll whose
dir-size cache had lapsed; the first re-fix's 30s cold timeout still 500'd an
idle-then-first-click the same day (cold collections measured 13-35s). Final shape:
CACHE_TTL_MS 10s fresh, MAX_STALE_MS 10min hard floor, refresh in the background
deduped onto ONE in-flight spawn, TIMEOUT_MS 60s cold, and a keep-warm interval
(KEEP_WARM_INTERVAL_MS 30s, armed on the first request, `.unref()`ed so it never holds
the process open, cleared by `__resetSystemStatusForTests`) so clicks are always served
from a ≤30s-old snapshot. Any new module-level timer in this module must follow the
same reset/seam pattern or test runs leak it. `system_status.py`'s dir-size walk
refreshes every 300s (was 60s). Serving semantics pinned by
`src/tests/system-status.test.ts` (injected runner + clock). The earlier standalone
`projects/system-dashboard/` (python http.server, port 8942) is RETIRED — archived at
`projects/system-dashboard.retired-2026-09-12/` for reference only; do not run it or
fork a second copy.

## One mic glyph (2026-09-13) — story

The app has ONE mic mark — the `micMark` that prefixes every spoken turn — reused
everywhere a microphone is meant, never a second design. It sits beside the title in
`topBar()` (16px) and the login screen's "Voice Inbox" title (24px) as a `.brand`
inline-flex row in `public/styles.css` (`min-width: 0` keeps the topbar title's
ellipsis working inside it), and — the operator's actual request, corrected same day
after the lockup misread — it faces the bottom-bar record control (`micButton()`, 24px
inside the accent ring) on BOTH footers: the list/triage page and the
conversation-detail page. The solid `.mic-core` dot it replaced is deleted, which
sharpens the recording sheet's contrast: ring + glyph = idle, solid halo = recording.
The caption that used to spell out what the app does is gone; the glyph carries that
meaning now. Shell: v37 lockup, v41 record control (v41, not v40 — the
concurrently-built feedback-longpress feature's still-uncommitted bump took v40; the
record-control bump rides above it per the riding convention as v39).

## Task attachments (2026-09-13, vi-09a8fa82b5f0) — UTF-8 verification

The typed-text path is byte-exact end to end for non-ASCII (verified 2026-09-13 by
repro through the compiled handler): textarea → `JSON.stringify`/`FormData` (browsers
serialize strings as UTF-8 only) → relay byte-passthrough → `readBody` Buffer-concat →
a single `toString('utf8')` (JSON parse and multipart `text` part each decode once,
whole-buffer) → better-sqlite3. A lone U+FFFD in stored `request_text` therefore means
the string arrived pre-mangled from the client (keyboard/IME/paste artifact) — not a
server decode bug; em-dash, en-dash and ✓ all store byte-exact on both create paths.
The PWA's paperclip staging lives in all three sheets + both footers, with a per-turn
chip row (bearer fetch → blob → image overlay or download).

## Depth history + KB + share (2026-09-13/14, vi-19787afc4b2e; archive+search 2026-09-15, v69) — mechanics

Archive + search (2026-09-15, v69; the list itself is § Thread lifecycle list since
2026-09-17): the archive view (`state.view='archive'`, titled "Older conversations"): pages the WHOLE tenant from
offset 0 (`ARCHIVE_PAGE_SIZE=20`, no `startBase`) via
`GET /conversations?limit=&offset=`; server-side `?q=` search (AND across
whitespace terms, LIKE-OR across `request_text`/`transcript`/`result_summary`/`title`/
`recap`, ESCAPE `'!'`); `total` is the filtered count when `q` is set. Server
side: `countConversations(db, tenant, q?)` and
`listConversationsPage(db, tenant, {limit, offset, q})` gain the filter;
`conversationsListHandler` validates `q` (trim; empty → unfiltered; >200 →
400) and routes through the paged path when `q` is present (even at offset
0). KB view and share unchanged.

Earlier (vi-19787afc4b2e): Done block capped `DONE_BLOCK_CAP` (10) with
`Show more` (`DONE_BLOCK_STEP` 10); older view paged `OLDER_PAGE_SIZE` (20)
from `startBase` = payload length (the "only 2 items" bug — now fixed by
paging from offset 0). Server: `countConversations` + `listConversationsPage`
(SQL paging, `updated_at DESC, conversation_id DESC`). KB: book icon in
`topNavActions`; `kbSectionNodes` groups bullets into `ul`; collapsible
recap-idiom cards (`kbCardOpen` Set). Share: `openShareSheet` in feedback-sheet
idiom; mint → active flow.

Conversation footer (2026-09-15, v69): extras cluster collapsed to
`stopControl` (running only) + `moreActionsButton` (`⋯`); attach
media/files, thread link, share live in `openConversationActionsSheet`
(`.menu-row` entries); stop confirm is `openStopConfirmSheet` (a `.sheet`,
not an inline `.act-row` swap). `.footer-compact-row` has no `flex-wrap`
(wrap was the overlap mechanism under the absolute mic).

## Notification badge + dedupe (2026-09-17, v89) — mechanics

Operator report: mobile notifications carried the Chrome badge, and repeated
notifications were flagged as spam. Three changes:

- `badge` now points at `icons/badge-96.png` (new): the mic glyph extracted
  monochrome/alpha-only from `icon-192.png`. Android renders `badge`
  alpha-only; the colour launcher icon painted as a solid block and Chrome's
  own badge showed instead. Set in `sw.js` (push handler default +
  `SHELL_ASSETS`), `app.js` `showNotif`, and the pa dispatcher copy
  `pa/src/lib/web-push.ts`.
- `renotify: false` on both `showNotification` callers: same-tag pushes
  replace the one `pa-attention` notification without re-sounding.
- The push handler skips `showNotification` while any window client on this
  origin is `visible` — the row update already reaches the operator live,
  and an OS notification over the open app reads as spam.
- Page-side OS notifications are skipped once `pushSubscribed` is true
  (set by `subscribeWebPush` on an existing or freshly-registered
  subscription): the server already pushes on task completion/input, so
  `maybeNotify`'s in-app copy under a different tag made every event a
  doubled notification — the spam signal. In-app notifications remain the
  fallback only when no subscription exists.

Archive view cleanup (same bump): the `.summary` title block repeating
"Older conversations" under the backbar title and the active switch button
is gone; `Load more` no longer `scrollIntoView()`s the rows container back
to the viewport top on each page.

## Message-level + in-conversation feedback (2026-09-16, v85) — mechanics

Extends the 2026-09-13 long-press feature: the backend (`feedback_about` task id →
task-level framing + target-conversation briefing in `route_task.py`) was already
level-agnostic; this wave adds the visible controls. `messageFeedbackButton(task,
conv, variant)` renders a `flagIcon` per turn — bare `.turn-fb` (36px quiet flag)
inline at the end of every `.turn-said` row and absolute top-right on collapsed
`.recap-item`s (a sibling of the header button — `<button>` inside `<button>` is
invalid); `'chip'` gives the 44px `linkish icon-btn` beside Copy in the answer's
act-row. The flag's `pointerdown` is stopPropagation'd so a press can't also arm
the row's long-press timer; `contextmenu` still bubbles so right-click opens the
same sheet. An expanded recap item hides its header flag via
`.recap-item:has(> .recap-item-body:not([hidden])) > .turn-fb` — the body's
turn-said flag takes over. Thread-level inside the conversation lives as the
"Give feedback" `.menu-row` in `openConversationActionsSheet` (footer stays at its
two-control cap). All per-turn calls open `openFeedbackSheet({ about: task.task_id,
title: turnText(task) })` — the sheet's secondary pill names the message's own
first words, identifying the target directly; the long-press call sites were moved
to the same title so gesture and button show identical "about" text.

v86 unifies the mark: the list row's feedback affordance was the `⋯` text glyph
while every other surface drew the flag; the row's `ellipsis` button now renders
the same `flagIcon(18, 'currentColor')` (`.row-feedback-btn` gains inline-flex
centering for the svg, keeping its 36px/0.55-opacity quiet recipe) so the
feedback symbol is uniform across list and conversation surfaces.
`SHELL_VERSION`/`SHELL_CACHE` are pinned together at v86.

## Light and dark theme (2026-09-16) — mechanics

The app follows the device's light or dark setting through `prefers-color-scheme` alone;
there is no in-app toggle. `public/styles.css` declares every colour as a token in two
blocks: the dark scheme is the `:root` default and the light scheme overrides it inside
one `@media (prefers-color-scheme: light)` block. Both blocks declare the same 19 names;
`--pad` and other non-colour tokens live in the dark block only. A future manual toggle
would wrap the light block in one extra selector and move nothing else.

Roles follow the pair model shared by Material 3, Radix and Primer. `--ground`,
`--raised` and `--raised-hover` are surfaces; `--ink`, `--dim` and `--faint` are text.
`--ring` marks control borders at 3:1, while `--hairline` is a decorative separator.
`--accent` is the solid gold fill that carries text, with `--on-accent` dark in both
schemes because a bright gold needs dark text. `--accent-ink` is gold used as text,
stroke, border, ring or small indicator, with `--on-accent-ink` for a glyph on it. The
`--accent-tint*` ladder holds translucent containers, and `--scrim` plus
`--scrim-alpha` hold the modal wash. Choose by property: a rule painting `color`,
`border`, `outline`, `stroke` or an indicator uses `--accent-ink`; a text-bearing
fill uses `--accent`.

Nothing outside the two token blocks names a colour. Icons are drawn with
`stroke="currentColor"` and take a `tone-accent`, `tone-dim` or `tone-faint` class, so
an OS flip repaints icons already on screen. The section-chip scroll flash is the
`.chip-flash` class, and that rule must stay last in the file: it beats the
equal-specificity `.cmp-card` and `.sum-card` backgrounds only on source order. The
raw-html frame already follows the device through its own `color-scheme: light dark`
base style, and the worker injection text says "Never hard-code colours in HTML."

`index.html` and `share.html` carry `color-scheme` `dark light` plus one `theme-color`
meta per scheme, each equal to that scheme's `--ground`. The manifest holds one scheme, so
it keeps the dark ground and the installed app's splash stays dark under a light phone
setting. The auth-callback pages carry `color-scheme` `light dark` so they follow the
device with browser defaults.

Checks. `theme-tokens.test.ts` covers literals, the token set, contrast floors in both
schemes, the metas and the header. `theme-icons.test.ts` covers icon call sites, resolved
colours in scripts, tone classes and the chip flash. Each detector has an inline known-bad
fixture, and `THEME_PUBLIC=<dir>` points both suites at another `public/` tree.
`scripts/theme_gate.mjs` drives the real app in headless Chromium under both schemes and
reads computed styles only. It checks palette membership, fixed token values, a live flip
without reload (icons included), the theme-color metas, the raw frame and the chip flash.
Run it with `PLAYWRIGHT_CORE_PATH=<playwright-core dir> node scripts/theme_gate.mjs
[--public <dir>] [--shots <dir>]`. It prints one `THEME GATE: PASS|FAIL|SKIPPED` line and
exits 0, 1 or 2. A membership check alone cannot fail on a page whose tokens never switch,
which is why the fixed values and the live flip carry the gate. Full design, research
sources and contrast tables: `plans/2026-09-16-voice-inbox-light-dark-theme-SPEC.md`.

## Test & contract detail (from CLAUDE.md, 2026-09-14 trim)

### Injection-text pin sweep (full form)

The target injection text (incl. the auth broker's standing instruction) exists in
THREE hand-copies that move together (detail: `docs/auth-broker.md`), and its sentence
text is pinned in FIVE places: `scripts/route_task.py`, `src/bridge-writer.ts`,
`EXPECTED_TARGET_TEXT` in `tests/test_worker_scripts.py`, and the `AUTH_SENTENCE` +
`SUMMARY_SEGMENT` consts in `src/tests/bridge-writer.test.ts`; a future template edit
must sweep all five. The briefing slot is a `${}` interpolation INSIDE the pinned
backtick, never a `+`-joined segment outside it, because `sync-twins.test.ts`'s
extraction regex cannot see the latter. The briefing's format, selection rule and
budget live in `CONTRACTS.md`'s "Conversation briefing" section (golden implementation
`src/conversation-briefing.ts`, python twin `route_task.py`); the budget exists because
the bot's thread-lane steer limit (`STEER_MESSAGE_MAX`) is 4,000 characters, pinned in
CONTRACTS.md against a test that reads the bot's source.

### ROUTE_TEXT_MAX budget narrative

`ROUTE_TEXT_MAX` is `STEER_MESSAGE_LIMIT - 50` (recalibrated 2026-09-13 from -200: the
pinned 229-char surface sentence consumed the old margin and pushed the 1500-char
stress render past 3800). The remaining 50 chars are the growth buffer — a future
template addition fails `test_route_text_stays_under_the_steer_limit` first; do NOT
widen the limit again to absorb it, shorten the template or raise the bot limit
consciously.

The light/dark theme clause "Never hard-code colours in HTML." (2026-09-16, 33 characters)
took the 1,200-character stress render from 3,908 to 3,941 characters, leaving 9 of
headroom. That test measures the bare template, because a long request already pushes the
briefing budget below its minimum. On real routes with long requests the clause instead
shortens the conversation briefing by the same 33 characters.

### Schema-bump test sweep

A schema bump sweeps FOUR test surfaces in `src/tests/ledger.test.ts` — every
`user_version` equality pin, both C10 `slice(-N)` column-order pins, the previous
migration describe's reopen assertions, and every last-column-name pin
(`columnNames[columnNames.length - 1]`, plus the v5 `conversation_meta` column list) —
not just the newest describe.
`src/tests/answer-shapes.test.ts` pins the uncapped-lead invariants: fragments taken
whole, no ellipsis, a >160-char first sentence splits at its true end.

## Conversation briefing: lookup reference instead of full-text dump (2026-09-18, t-3) — mechanics

Operator-approved change (Option 2 of a 5-option fix for dropped conversation context /
status tags): rather than inlining the full conversation history, the briefing hands the
worker the linked conversation's id plus a runnable ledger lookup so the worker can pull
the full record itself if it needs it, instead of every prior turn's `request_text` and
`result_summary` being dumped inline.

`buildConversationBriefing` (`src/conversation-briefing.ts`) / `build_conversation_briefing`
(`scripts/route_task.py`) keep the existing head (`Conversation so far (...): N earlier
turn(s), oldest first.` + optional `Title:`/`Where it stands:`/`Next:` lines from
`conversation_meta`) and foot (`End of the conversation record.`) unchanged, but replace
the old per-turn `You asked:`/`Answered:` dump and its "{K} older turn(s) ..." drop line
with a single unconditional lookup line:

```
Full turn-by-turn record: sqlite3 "{ledger_path}" "SELECT created_at, request_text, result_summary FROM tasks WHERE conversation_id = '{conversation_id}' ORDER BY created_at ASC".
```

Workers already run direct `sqlite3` queries against this exact ledger file in production
traces, so this is a proven, working retrieval path, not a dead-end bare id. The dead
turn-rendering/selection code (`renderTurn`/`dropLine` in TS,
`_render_briefing_turn`/`_briefing_drop_line` in Python, plus the newest-first fill loop in
both) is deleted; the terminating guard (`result.length > maxChars` ⇒ `''`) is now a
simple all-or-nothing check since there is no more turn-selection/truncation to do.
`renderField`/`_render_briefing_field`, `ledgerPathOf`, `briefingBudget`, and all the
`CONVERSATION_BRIEFING_*`/`ROUTE_TEXT_MAX`/`STEER_MESSAGE_LIMIT` constants are unchanged —
they still gate whether/how big a briefing budget is, even though the actual output is now
much shorter and roughly constant-size.

The feedback re-pointing logic in `route_task.py` (`briefing_conversation_id = target_conv`
when a task is feedback about another conversation, around route_task.py:1079-1110) is
UNCHANGED — it still decides WHICH conversation gets briefed; this wave only changed WHAT
gets rendered for whichever conversation is being briefed. The named regression test
`test_route_feedback_carries_referenced_conversation_briefing` in
`tests/test_worker_scripts.py` (pinned against the 2026-09-15 "stuck thread ... looping 33
reroutes" incident) still asserts the briefing is built from the referenced conversation's
id, now via the lookup line's `conversation_id = '{target_conv}'` clause rather than a
turn dump.

### Attachments segment + UTF-8 chain (full form)

The injection texts carry the one canonical attachments segment
(`buildAttachmentsSegment` ↔ `build_attachments_segment`, sync-twins-pinned via the
shared `ATTACHMENTS_SEGMENT_SUFFIX` literal; the target template gained an
`{attachments}` slot — the interpolation map moved with it). A multipart `text` part
validates even when an `audio` part is present (defensive — no client path sends
both); its upper bound is the opt-in `max_text_chars` (no bound by default), which
replaced the earlier hardcoded 4000 (vi-39ab14f84f14). The PWA gained paperclip staging
in all three sheets + both footers and a per-turn chip row (bearer fetch → blob →
image overlay or download).

### Request log (full form)

`logs/requests.log` gets one JSONL line per HTTP request via `src/request-log.ts`:
`{ts, method, path, status, bytes_in, bytes_out, ms, session_ok}` in that exact key
order — no headers, no bodies, no query VALUES (`redactPathForLog` keeps keys only).
`session_ok` = the request was `/api` and did not fail auth (status ≠ 401); false for
static and 401s — never the token. Writes are fire-and-forget; a log failure degrades
to console.error, never a 500. Rotation is append-time size-cap: 5MB →
`logs/requests-<stamp>.log`, newest 4 shards kept — pa's archive pruner is NOT
involved (its suffix allowlist would keep these forever; this package never imports
pa/dist). Wired in server.ts only; routes.ts is untouched.

### Cancellation/steer detail

The ledger is the source of truth for cancellation; the bot reads it read-only through
`pa/dist/src/lib/voice-inbox-ledger.js` (fail-open — a read error returns an empty
set, never throws). `PA_WORKER_RESOURCE` is byte-identical to the worker-pids `skill`
key. `conversation_id` is `NOT NULL DEFAULT ''` and always set by `createTask`.
A recording can be made as a steer into the conversation it continues (`POST /tasks`
`steer` with `continues`, recorded in `tasks.steer_mode`); `route_task.py` writes a
`kind:"steer"` route-queue entry and decides nothing else; the bot resolves the target
from the ledger each tick and steers a thread, steers a topic dispatch, folds before
start, or holds — never an unrelated follow-up; `worker_dispatch_id`
(`PA_WORKER_DISPATCH_ID`) identifies the DISPATCH, and a bare topic resource is never
killed without it.

### Telemetry work-line render (full form)

`workLineText()` (app.js, 2026-09-10) renders the REAL telemetry text in the expanded
per-task event block: `payload.step` for `task.progress` (the `start` command's
`started` → "Started"), `payload.reason` for `task.failed`, and the fixed label plus
`payload.reason` as a second line for `task.routed`/`task.rerouted` — clamped by
default, expandable in place via its own per-step tap toggle (`workLineMeta()`,
2026-09-13, AI-230). `task_telemetry.py` leaves `summary` NULL for all of these, so
`EVENT_FALLBACK` is the last resort, never the render path (pre-fix every progress
line read "Progress update" with the step discarded).

### Ledger open convention (full form)

The five Python worker scripts open the SAME sqlite file with WAL +
busy_timeout 3000 and refuse to create anything: a missing file or schema errors with
`ledger missing: start the server first`. Each script sets the PRAGMA itself
(`route_task.py`/`task_telemetry.py`/`task_input.py`/`task_complete.py`/
`task_transcribe.py` — `migrate_answer_format.py` too); a new worker script repeats
all three, never just WAL.

### Test-harness gotchas (from CLAUDE.md, 2026-09-14 trim)

`relay_smoke.mjs` HANGS in teardown after its verdict — LOG lines are the verdict;
kill the child tree by captured PID. `bridge-writer.test.ts` "survives concurrent
appends" used to ELOCK on full-suite runs (AI-237, fixed 2026-09-14): N
same-process callers raced proper-lockfile's mkdir, whose retry budget
(~1.25s) is sized for cross-process holds — `appendRouteEntry` now serializes
in-process callers through a per-path promise mutex before locking, the
reservations.ts/topic-tasks.ts pattern. The slice-execute
source harnesses (`answer-shapes.test.ts` renderRawHtmlBlock, frame-route.test.ts
mount pins) must use a FRESH element recorder per `h()` call once the sliced
function pushes MORE THAN ONE node — a shared recorder lets the last element
overwrite the first's recorded attrs, and both entries read identical.
Route-source pins anchor on the longest unique form
(`!url.pathname.startsWith('/api/')`), never a substring that appears earlier in
the file.

### STATE_TEXT and THREAD_STATUS_TEXT pins

`public/app.js`'s `STATE_TEXT` (the task-level word, used inside a conversation and on the
triage row) has its keys pinned to `ledger.ts`'s `TASK_STATES` by `sync-twins.test.ts`
(AI-219, 2026-09-14). `THREAD_STATUS_TEXT` (a thread's word) is pinned, keys and words, to
`src/thread-status.ts`'s `THREAD_STATUS_WORDS` by the same file (2026-09-17). An unmapped
task state renders the non-terminal fallback rather than raw vocabulary.

## Raw-html answer lane (2026-09-14) — mechanics

From the CLAUDE.md bullet: a `:::raw-html` … `:::` fenced block in `result_summary`
renders in a sandboxed iframe — `allow-scripts`, NEVER `allow-same-origin`. The frame
document (`rawHtmlFrameDocument` in answer-shapes.js: base style + CSP meta + the
model html verbatim) is served by `GET /frames/raw` (server.ts pre-router zone +
`frame-route.ts`): the app base64url-encodes the document into the query and the
route serves it verbatim under its OWN inline-only CSP response header
(`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`). That
response header is what a srcdoc cannot do — a srcdoc frame inherits the app page's
stricter shell CSP and a frame meta can only tighten it — so served frames run model
styles/scripts while `default-src 'none'` keeps them network-dead. The query `token`
is mandatory (SSE precedent: an iframe navigation cannot set Authorization headers;
it also stops a public page embedding the URL into an unsandboxed frame). Over
`RAW_ROUTE_MAX_ENCODED` (12 000 encoded chars — twin constant, pinned by
frame-route.test.ts; keeps the URL under Node's 16 KB request-header cap) the frame
falls back to the inert srcdoc render behind a plain-language notice. The SW passes
`/frames/raw` straight to the network — never cached under its payload URL, never the
offline shell fallback. One frame ≈12 estimated lines (two tier); the IN SHORT lead
strips raw-html fences whole. Recurring shapes are the weekly digest's graduation
candidates (first-tag/class grouping).

## Row actions, violet multi-select, answer provenance (2026-09-18, v93, schema v15) — mechanics

Three operator-directed workstreams landed together; all provenance vocabulary
is plain-language (the answer register — the chip shows the model name itself,
never internals).

**Row actions sheet** (`openRowActionsSheet`, app.js): long-press and the flag
button open one contextual menu — "Give feedback" on every row, **Stop** on
in-flight rows (`ACTIVE_STATUSES`: running/recorded/transcribing/routed/
needs_you, reuses the existing stop-confirm), **Retry + Cancel** on failed,
**Select** on any row. Long-press is inert during select mode; the inline
Retry/Cancel buttons on failed rows stay. The feedback sheet's pill now reads
"Give feedback on this" and the per-message flag "Give feedback on this
message".

**Violet multi-select** (`state.failedSelect` generalized to any row): entered
from a row's own menu ("Select") or the bar's Select. Tapping a row toggles
(`aria-pressed`); the checkbox is gone. Selected rows carry a violet ring +
glow via the `--select*` tokens and `.row-selected` — deliberately NOT gold,
which means "ready". Bulk actions are intersection: Retry enables only when
every selected row failed; Cancel when any selected is non-terminal
(`TERMINAL_STATUSES`: viewed/concluded/cancelled/done). Stale ids are pruned.

**Answer provenance** (ledger schema v15 + bot env injection): answered cards
show a quiet chip (`answerProvenanceRow`, attached in `renderTurnContent` —
NEVER inside `answerRegionParts`, whose body is verbatim-pinned by
comparison-renderer.test.ts) that expands to model / effort / which assistant
ran it / how it was asked / the task reference. All three columns NULL → no
row at all (legacy cards byte-identical); a row with only `worker_effort` set
shows no chip but would show it in a chip-bearing row's details. The row only
renders when `task.result_summary` exists — a running card that already
stamped progress must not show a chip mid-run (verifier fix, 2026-09-18).

Data path: `tasks.worker_cli/worker_model/worker_effort` (migrateAddV15Provenance,
idempotent per-column ALTERs) are written by `task_telemetry.py` at
`task.progress` from env `PA_WORKER_CLI/_MODEL/_EFFORT`, stamped by
`buildWorkerProvenanceEnv` (`projects/telegram-bot/src/dispatch.ts`) through
`RunOptions.getEnv` at the two executor dispatch sites (task-executor,
thread-executor lifecycle). worker-exec evaluates getEnv with EACH failover
hop's own WorkerConfig and merges it AFTER the static `env` (and after
`filterSecretsForWorker`, so the stamp survives secret_allowlist stripping) —
the recorded CLI is the hop that actually answered, never the first-chosen
worker. Resolution mirrors `buildTopicTierExtraArgs` exactly — record `model`
pin in the overrides slot, topic `tunable_defaults` slice, worker's own spec →
`KNOWN_CLI_DEFAULT_*` fallbacks. The remaining gap is uninstrumented lanes:
fallback-job dispatches (voice-inbox-fallback) carry no getEnv → NULL
provenance → no chip (accepted gap).
