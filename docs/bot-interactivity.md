# Bot interactivity contract (extracted from the root brain 2026-09-03, budget-pressure doctrine)

Active pointer: root `CLAUDE.md` § Standards & Conventions links here. Read before touching inline buttons, callback prefixes, keyboards, reactions, or rich messages. The prefix/action/gate table is below (single source; new prefixes join `callback-grammar.ts`).

- **A button is a typed command (2026-08-24, buttons program — internal design record)**: every inline button that maps to an existing command (`cf:` yes/no, `cc:` control card, `wf:` retry/switch/revert, `rs:` resend) is handled by ONE parser (`projects/telegram-bot/src/callbacks.ts`) that answers the callback first, then INJECTS a synthetic `TelegramUpdate` into the next poll batch — never a second code path — so button and typed behaviour cannot diverge; `pollOffset`/`state.last_update_id` come from the REAL batch only (a synthetic id in the offset would confirm-away real inbound messages). `callback_data` ≤64 bytes, prefix-routed, ids not prose; keyboards are removed/rewritten after a press (`editMessageReplyMarkup`); `editMessageText` STRIPS a keyboard unless `reply_markup` is passed again. Two gate classes: chat-gated (`reauth`, `cf`, `cc`, `wf`, `q`, `rm`) and operator-gated (`pm`, `dr`, `sk`, `mc`, `rs`, `dq` — require `PA_OPERATOR_USER_ID`; `sk:`/`dq:` two-step confirm; git-workflow skills never runnable from a button). Workers arm multi-option questions via the PA_META `question {text, options[1..4]}` action — options render as buttons, `q:<n>` answers by injecting the option text as a synthetic turn (`pending_question`; rejected while a `pending_action` is armed; grammar single-sources in `pa/src/lib/callback-grammar.ts`, which `callbacks.ts` re-exports — new prefixes are added THERE, never in callbacks.ts). pa-side keyboards ride `notifyUser({ replyMarkup })` / `telegram_notify.send_text(reply_markup=…)` on the LAST chunk (the `[PA_KEYBOARD]:` single-line envelope lets a skill's telegram_output request one, grammar-validated; protected skills refused). Reactions 👍/👎 on the message whose id is `pending_action.message_id` are the same yes/no (handler: `handleMessageReaction` in `callbacks.ts` — `main.ts` only dispatches it; needs `allowed_updates` incl. `message_reaction`, sticky server-side). `sendRichMessage` body is `{rich_message:{markdown}}` (live-verified), dead unless `PA_RICH_MESSAGES=1`. AI-210 (2026-09-06) makes the `cc:` pickers stage-then-apply: a value tap only STAGES the selection (`▸` marker, same-picker `editMessageReplyMarkup` re-render — no injection, no topic-state write), `cc:submit` then injects exactly the typed command the press used to inject, `cc:discard` is back with nothing applied; a staged entry stays fresh 10 min (`CARD_SELECTION_FRESH_MS`) vs 2 min bare, the sweep silently drops an expired selection, and staged selections are in-memory only (a restart drops them — nothing was applied).

**AI-199 addendum (2026-09-03):** `PA_RICH_MESSAGES=1` lives in `secrets.env`, and `pa run` injects secrets into every worker shell — so it leaks into any test suite spawned from a worker (the push gate failed 12 subtests this way: long test replies routed through `/sendRichMessage`, which `/sendMessage` filters never match). Both `run-tests.mjs` wrappers now apply `DEPLOYMENT_ENV_SCRUB` (`pa/src/lib/test-env-scrub.ts`) at suite spawn; `runner-env-scrub.test.ts` pins it. New deployment flags in secrets.env must be added to the scrub list.

## Prefix / action / gate table

| prefix | action | gate |
|---|---|---|
| `reauth` | Google re-auth link | chat |
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
