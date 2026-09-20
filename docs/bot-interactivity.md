# Bot interactivity contract (extracted from the root brain 2026-09-03, budget-pressure doctrine)

Active pointer: root `CLAUDE.md` § Standards & Conventions links here. Read before touching inline buttons, callback prefixes, keyboards, reactions, or rich messages. The prefix/action/gate table is below (single source; new prefixes join `callback-grammar.ts`).

- **A button is a typed command (2026-08-24, buttons program — internal design record)**: every inline button that maps to an existing command (`cf:` yes/no, `cc:` control card, `wf:` retry/switch/revert, `rs:` resend) is handled by ONE parser (`projects/telegram-bot/src/callbacks.ts`) that answers the callback first, then INJECTS a synthetic `TelegramUpdate` into the next poll batch — never a second code path — so button and typed behaviour cannot diverge; `pollOffset`/`state.last_update_id` come from the REAL batch only (a synthetic id in the offset would confirm-away real inbound messages). `callback_data` ≤64 bytes, prefix-routed, ids not prose; keyboards are removed/rewritten after a press (`editMessageReplyMarkup`); `editMessageText` STRIPS a keyboard unless `reply_markup` is passed again. Two gate classes: chat-gated (`reauth`, `cf`, `cc`, `wf`, `q`, `rm`) and operator-gated (`pm`, `dr`, `sk`, `mc`, `rs`, `dq` — require `PA_OPERATOR_USER_ID`; `sk:`/`dq:` two-step confirm; git-workflow skills never runnable from a button). Workers arm multi-option questions via the PA_META `question {text, options[1..4]}` action — options render as buttons, `q:<n>` answers by injecting the option text as a synthetic turn (`pending_question`; rejected while a `pending_action` is armed; grammar single-sources in `pa/src/lib/callback-grammar.ts`, which `callbacks.ts` re-exports — new prefixes are added THERE, never in callbacks.ts). pa-side keyboards ride `notifyUser({ replyMarkup })` / `telegram_notify.send_text(reply_markup=…)` on the LAST chunk (the `[PA_KEYBOARD]:` single-line envelope lets a skill's telegram_output request one, grammar-validated; protected skills refused). Reactions 👍/👎 on the message whose id is `pending_action.message_id` are the same yes/no (handler: `handleMessageReaction` in `callbacks.ts` — `main.ts` only dispatches it; needs `allowed_updates` incl. `message_reaction`, sticky server-side). `sendRichMessage` body is `{rich_message:{markdown}}` (live-verified), dead unless `PA_RICH_MESSAGES=1`. AI-210 (2026-09-06) makes the `cc:` pickers stage-then-apply: a value tap only STAGES the selection (`▸` marker, same-picker `editMessageReplyMarkup` re-render — no injection, no topic-state write), `cc:submit` then injects exactly the typed command the press used to inject, `cc:discard` is back with nothing applied; a staged entry stays fresh 10 min (`CARD_SELECTION_FRESH_MS`) vs 2 min bare, the sweep silently drops an expired selection, and staged selections are in-memory only (a restart drops them — nothing was applied).

**AI-199 addendum (2026-09-03):** `PA_RICH_MESSAGES=1` lives in `secrets.env`, and `pa run` injects secrets into every worker shell — so it leaks into any test suite spawned from a worker (the push gate failed 12 subtests this way: long test replies routed through `/sendRichMessage`, which `/sendMessage` filters never match). Both `run-tests.mjs` wrappers now apply `DEPLOYMENT_ENV_SCRUB` (`pa/src/lib/test-env-scrub.ts`) at suite spawn; `runner-env-scrub.test.ts` pins it. New deployment flags in secrets.env must be added to the scrub list.

## Prefix / action / gate table

| prefix | action | gate |
|---|---|---|
| `reauth` | Google re-auth link | chat |
| `auth` | open a pending auth request's link (any provider) | chat |
| `cf` | confirm/cancel pending (also 👍/👎) | chat |
| `cc` | control card + agent/model/effort picker — value taps STAGE (`▸`, no injection, 10-min freshness); `cc:submit` injects exactly the typed command the press used to; `cc:discard` = back, nothing applied (AI-210, 2026-09-06) | chat |
| `wf` | retry/switch/revert on worker errors | chat |
| `q` | answer a PA_META question option (injects option text) | chat |
| `qt` | answer a task-lane question into the task micro-thread | chat |
| `rm` | reminder done/snooze 1h/tomorrow (keyboard rendered only when the record requires a user decision — python-side producer) | chat |
| `pm` | self-improver HITL approve/reject/diff | operator |
| `dr` | draft approve/reject/show | operator |
| `sk` | run skill/job now (2-tap) | operator |
| `mc` | memory conflict accept/keep/ignore | operator |
| `rs` | resend orphan-reaped dispatch | operator |
| `dq` | DLQ replay (2-tap) | operator |
| `ru` | feedback-rule accept/reject (`pa rules accept`/`supersede`; weekly-digest `[PA_KEYBOARD]`) | operator |
| `si` | mute an alert-census family via fix-record (`pa fix <family>`; 2-tap; nightly report) | operator |
| `ch` | re-run a chain (2-tap; existence-checked; chain failure report) | operator |
| `wt` | re-register a terminal watch (`pa watch re-register`; check-failed/expired reports) | operator |
| `ow` | orphaned-edit disposition — land as-is / keep dirty 24 h / show diff (`pa orphan <land\|keep\|diff> <gid>`) | operator |

**Ask mirroring — voice-inbox button parity (2026-09-11):** when a voice-routed turn arms a confirm/question (`pending_action`/`pending_question`; voice-routed = `extractVoiceInboxTaskIds` matches the app-built `[Voice inbox task vi-…]` injection prefix), the bot also creates the matching typed widget (`confirm`/`choice`) in that voice conversation via `mirrorAskAsWidget` (`voice-input-mirror.ts` → `task_input.py create`), so the ask is answerable from either channel. The thread lane mirrors from the thread executor off the thread's stamped `voiceTaskIds`; the topic lane mirrors at the main.ts reply-send site and stamps the mirrored id on the pending ask (`voice_task`). An answer landing on the Telegram side cancels the mirrored widget (`cancelMirroredAsk` → `task_input.py cancel`, from the typed-answer blocks and the `cf:`/`q:`/👍👎 press handlers) so the app badge cannot lie. Non-goals: TTL expiry (the widget outliving the 5-min Telegram ask is the durable one), the task lane's `qt:` (voice routes never become topic-tasks), and non-voice topics (no vi- ids → no mirror).

**`ow:` orphaned-edit disposition (AI-214, 2026-09-08):** the daily `orphan-edit-watch`
job's last-resort lane. A family of working-tree paths dirty ≥6 h that a dispatched
completion agent could not resolve within ~48 h alerts the operator with
land-as-is / keep-dirty-24 h / show-diff buttons. A press is fire-and-forget (`mc:`
precedent): the handler spawns `pa orphan <sub> <gid>` in the bot cwd and toasts; the pa
CLI delivers the outcome notify (land names the landed sha; diff truncates to the char
cap). Refusals (unknown gid, paths re-reserved, git-workflow lock held, all paths
already clean) surface as pa-alerts notifies, never a bot error. Land commits verbatim
by pathspec; keep snoozes the family 24 h.

**`auth:` / `/secret` — auth broker Phase A Telegram fallback (2026-09-10):** generalizes
`reauth:`/`/auth` beyond Google. `auth:<provider>:<ir-12hex>` answers the press, toasts
`🔐 Opening the authorization link…`, and delivers the pending request's authorize URL
via the new `sendPlainMessage` (`telegram.ts`) — NOT `sendMessage`: `sendMessage` and
`sendMessageWithKeyboard` unconditionally send `parse_mode: 'MarkdownV2'` with
`sanitizeMdV2()` escaping, which backslash-mangles a raw URL into a non-tappable string
(`https\.example\.com/...\_id\=...`) — exactly the failure the 2026-08-15 OAuth-URL
lesson (root `CLAUDE.md`) exists to prevent, and this build proved it live (a first draft
of this feature shipped that exact bug before the fix). `sendPlainMessage(token, chatId,
text, threadId?, replyMarkup?)` is the bot-side twin of pa's plain-text
`sendToTelegram(text, config, token, false)` mode: same `telegramFetch` path and
chunking/retry discipline as `sendMessage`, but the payload carries no `parse_mode` key at
all, so Telegram's default plain-text parsing still auto-links bare URLs; text is run
through `redactSecrets` at this egress seam like every other new egress path (root
`CLAUDE.md` "Secret egress is redacted by default").

The URL itself comes through a new optional `CallbackDeps.authRequestUrl` seam. Its
in-module default is `voiceInboxInputRequestAuthUrl`
(`pa/src/lib/voice-inbox-ledger.ts`), which reads the voice-inbox LEDGER's
`input_requests.params_json`, not the auth broker's own request store. `auth_url` is
minted into that ledger column (`oauth-mint.ts`) and never carried by the broker's own
row shape — the original default read the wrong file and always resolved null in
production, fixed in the 2026-09-10 deep-recheck. An unresolvable request (ledger
missing, no matching row, or no `auth_url` yet) answers the callback and sends nothing
rather than a broken link. `/secret <request-id> <value>` is the command-line
twin: same deleteMessage + `[redacted]` archive as `/auth`, value piped to `pa auth
answer` on stdin, never argv, never logged.
