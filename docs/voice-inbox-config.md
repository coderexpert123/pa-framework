# Voice inbox app

> Configuration reference for `projects/voice-inbox` — split out of
> `docs/CONFIGURATION.md` on 2026-09-14 (knobs-catalog budget doctrine: the
> project-scoped block lives beside the app, not inside the framework catalog).

The voice inbox PWA + API reads one `voice_inbox:` block; omit it and only
the app is unconfigured. Startup is refused until `inbox_topic`
names the new-task topic.

| Key | Default | Meaning |
|---|---|---|
| `inbox_topic` | — (required) | `<chatId>_<threadId>` topic key that receives new tasks |
| `port` | `8787` | API port; binds `127.0.0.1` only — a tunnel dials it locally (1..65535) |
| `max_upload_mb` | unset (no limit) | Opt-in upload cap for voice notes and `file` widgets; unset/0 = no limit (default), explicit N (1..1024) enforced with 413 |
| `max_text_chars` | unset (no limit) | Opt-in cap on the `text` part of `POST /tasks` (JSON and multipart); unset/0 = no limit (default), explicit N (1..1000000) enforced with 400 |
| `session_ttl_hours` | `168` | Bearer session lifetime after pairing (1..8760) |
| `pairing_ttl_minutes` | `10` | One-time code lifetime (1..1440) |
| `min_audio_bytes` | `8192` (8 KB) | AI-223: a voice upload's audio part under this size is rejected at `POST /tasks` with `400 {error:"recording too short"}` — no task row, no event (0..100000000) |
| `max_task_attachments` | unset (no limit) | Opt-in max attachment files per task at `POST /tasks`; unset/0 = no limit (default), explicit N (1..100) enforced with 400, no task row |
| `max_attachment_total_mb` | unset (no limit) | Opt-in max TOTAL attachment bytes per task, MB; unset/0 = no limit (default), explicit N (1..1024) enforced with 413, no task row. `server.ts` request body cap = 1 MB slack + `max_upload_mb` MB + this MB when each is set; when NEITHER upload knob is set the transport cap is unlimited (Infinity) |

## Voice transcription drain (telegram bot process, 2026-09-16)

The telegram bot transcribes new voice-inbox recordings on its poll tick, through the same
transcription action the fallback job below uses. Both read their env from the process
environment (`~/.pa/secrets.env`):

| Variable | Default | Purpose |
|---|---|---|
| `PA_VOICE_INBOX_TRANSCRIBE_DRAIN` | unset (enabled) | `0` turns off the bot's transcription drain AND its hold on voice route entries; recordings then wait for the fallback job's backstop. |
| `PA_VOICE_INBOX_TRANSCRIBE_DRAIN_TIMEOUT_MS` | `300000` (5 min) | Hard timeout on one `transcribe_voice.py` run in the drain. Past it the process tree is killed and the attempt counts as an infra failure, retried after 2, 5 or 10 minutes. |

The fallback's `PA_VOICE_INBOX_FALLBACK_MIN_AUDIO_BYTES`, `…_TRANSCRIBE_INFRA_ATTEMPTS` and
`…_TRANSCRIBE_INFRA_WINDOW_MS` knobs below bound the drain too — one implementation, one
policy.

## Deterministic inbox fallback (pa host job `voice-inbox-fallback`, 2026-09-09)

A pa-host maintenance job — not the app process — that places a stuck task (transcribes,
routes, or re-routes) when no LLM worker did so in time. No LLM involved; full mechanism:
`docs/maintenance-jobs.md`'s `voiceInboxFallbackJob` entry. Thresholds are env vars
(`~/.pa/secrets.env`) — pa's `config.yaml` has no `voice_inbox` block, so these are
not `voice_inbox:` keys:

| Variable | Default | Purpose |
|---|---|---|
| `PA_VOICE_INBOX_FALLBACK` | unset (enabled) | `0` disables the job entirely. |
| `PA_VOICE_INBOX_FALLBACK_TRANSCRIBING_STALE_MS` | `120000` (2 min) | How long a `transcribing` task with no `worker_resource` sits (by `created_at`) before the fallback's backstop transcribes it. The bot's drain normally transcribes within one poll tick. |
| `PA_VOICE_INBOX_FALLBACK_RECEIVED_STALE_MS` | `360000` (6 min) | How long a transcribed (`received`) task with no `worker_resource` sits (by `created_at`) before the fallback routes it deterministically. |
| `PA_VOICE_INBOX_FALLBACK_ROUTED_STALE_MS` | `1200000` (20 min) | How long a `routed` task with no `worker_resource` sits (by `updated_at` — time since routing, not creation) before the fallback re-injects the route. |
| `PA_VOICE_INBOX_FALLBACK_MIN_AUDIO_BYTES` | `8192` (8 KB) | Audio files under this size fail honestly (`transcribe_failed`) instead of being sent to a transcription engine — the 2026-09-09 incident's sub-second-capture floor. |
| `PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS` | `4` | AI-239: recorded infra-failure markers (`task.failed` events with `code: 'infra'` on a still-`transcribing` task) at which the fallback stops retrying transcription and marks the task terminally `transcribe_failed` (code `infra`, paged to pa-alerts). Audio-side failures (`missing-file`, `oversize`, `too_short` shapes) are never retried. |
| `PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS` | `2700000` (45 min) | Backstop bound on the same retry: a `transcribing` task older than this (by `created_at`) goes terminal even when markers could not be recorded. |
| `PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC` | unset (derived) | Override for the deterministic routing target; unset uses `voice_inbox.default_topic`, else derives `<inboxChatId>_0` (the inbox chat's general topic) from `voice_inbox.inbox_topic`. |

One knob lives in `config.yaml` instead — `voice_inbox_fallback.keyword_topics`
(e.g. `{ "invoice": "CHATID_THREADID" }`): a lowercase substring match against
the transcript/request text, first match wins, empty (the default) falls through
to general-knowledge. Read by the job from the shared file, independent of pa's
typed config loader.

Env overrides win over the file: `VOICE_INBOX_PORT`, `VOICE_INBOX_INBOX_TOPIC`,
`VOICE_INBOX_MIN_AUDIO_BYTES`. Transcription keys are not voice-inbox config: the
telegram bot process reads them from `~/.pa/secrets.env` when it transcribes —
the API server holds none.

Pairing: an 8-char code (unambiguous charset — no 0/O/1/I/L) minted by the
bot's `/pair` command in an allowed chat, or `node scripts/mint_pairing.mjs` for
dev/emergency. Single-use, expiring after `pairing_ttl_minutes`, and
sha256-hashed once exchanged for the session token.

Remote access runs through the edge relay; `node scripts/relay_setup.mjs` writes
`~/.pa/voice-inbox/relay.json`:

| Key | Default | Meaning |
|---|---|---|
| `worker_base_url` | — (set by setup) | Stable workers.dev URL of the deployed relay worker |
| `home_base_url` | `http://127.0.0.1:<voice_inbox.port>` | Localhost app the poller executes claimed requests against |
| `poll_wait_ms` | `25000` | Long-poll wait per `/work` claim (the worker clamps it to 25 s) |
| `request_deadline_ms` | `55000` | Parked-request lifetime; the browser sees a 504 past it |
| `localhost_timeout_ms` | `50000` | Home-leg timeout, 5 s under the request deadline |

The poller reads `VOICE_INBOX_RELAY_SECRET` from `~/.pa/secrets.env` — setup
generates and reuses it. Setup registers the `PA-VoiceInbox-RelayPoller`
scheduled task (every minute, ensure-running). The deploy credentials
`CF_RELAY_API_TOKEN` + `CF_RELAY_ACCOUNT_ID` live in the same
`secrets.env`. Detail: `projects/voice-inbox/relay/README.md`.
