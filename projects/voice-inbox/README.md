# voice-inbox

A voice-and-text task inbox for the pa assistant, served as a PWA. You speak or type a
request on the phone. The app stores it as a task in a tenant-scoped SQLite ledger and
hands it to the Telegram bot, which routes it to the right topic and dispatches a worker
there. Progress arrives back as telemetry events in the app. Anything secret the worker
needs is collected through typed input widgets — never chat messages.

## Why typed widgets

An assistant that asks for a password in chat writes that password into the conversation
archive. Voice inbox inverts the flow. The worker opens a typed card in the app — secret,
text, choice, confirm, file upload, or Google consent — and the answer is stored as a file
on the server. The worker receives only the file path, with an instruction never to repeat
the value in chat. The ledger stores pointers, not values.

## How a task flows

1. You submit text or a voice note in the PWA. A voice note is stored and transcribed
   by the topic worker before the task routes.
2. The API writes the task and appends a route entry to `route-queue.jsonl`.
3. The bot drains that queue and injects the entry into the inbox topic as a synthetic
   turn. The worker there picks the best topic and calls `scripts/route_task.py`.
4. That moves the task to the target topic. The worker executes it, emits progress events,
   and finishes with `scripts/task_complete.py`.
5. The PWA timeline renders every event with its ref-ID. Re-route and cancel are one tap.

## Running it

- Config: add a `voice_inbox:` block to `~/.pa/config.yaml` — see `docs/CONFIGURATION.md`,
  section "Voice inbox app". `inbox_topic` is required; the server refuses to start
  without it.
- Build: `npm ci && npm run build` in this directory.
- Check: `node dist/server.js --check` prints
  `voice-inbox: config ok, ledger ok (schema v9)`.
- Start: `node dist/server.js` (binds `127.0.0.1` only), or detach with
  `powershell -File scripts\run_server.ps1` (logs land under `~/.pa/voice-inbox/logs`).
- Pair: `node scripts/mint_pairing.mjs --user-id <telegram user id> --chat-id <chat id>`
  mints an 8-char code (the bot's `/pair` command writes the same file), then enter the
  code in the PWA. The session lasts 7 days.
- Smoke: `node scripts/smoke_local.mjs` boots the real server in a temp `PA_HOME` and
  prints `SMOKE OK: exchange=1 task=received routed-entry=1 events>=1`.
- Remote: for anything beyond localhost, follow "Self-setup" below — one command on a
  free Cloudflare account.
- Migrate stored answers: `python scripts/migrate_answer_format.py --dry-run` finds
  `result_summary` rows still in the pre-2026-09-09 flat/legacy shape, reformats each
  through an LLM command, and writes a reviewable preview under
  `~/.pa/voice-inbox/migrations/`; `--apply` snapshots the ledger first, then applies
  only the rows that pass the equivalence and shape gates.

## Exposure

The server binds `127.0.0.1` only. Remote access runs through the edge relay (next
section) — a stable workers.dev URL backed by the home machine's outbound-only
poller. The only app-side gate is the bearer session; putting Cloudflare Access in
front of the hostname is the named hardening follow-up. The quick tunnel
(`scripts/quick_tunnel.ps1`) remains the documented fallback.

## Self-setup: a stable URL on the free tier

The edge relay gives the PWA a stable HTTPS URL on a free Cloudflare account — no
domain, no tunnel. The home machine makes outbound connections only. Component detail,
auth model, and limits: `relay/README.md`.

Prerequisites:

- Node 22 or newer
- This repo cloned, with `npm ci && npm run build` run in this directory
- The app running per "Running it" above
- A free Cloudflare account

The one command:

```
node scripts/relay_setup.mjs
```

The command is idempotent — a re-run continues where the previous run stopped. It:

1. Preflights Node, dependencies, and the app config in `~/.pa/config.yaml`
2. Authenticates to Cloudflare (token or browser login — see below)
3. Generates `relay/wrangler.toml.live` from the tracked example
4. Creates the R2 bucket (or reuses an existing one)
5. Creates (or reuses) `VOICE_INBOX_RELAY_SECRET` in `~/.pa/secrets.env`
6. Deploys the worker and reads the stable workers.dev URL
7. Stores `RELAY_SECRET` on the worker
8. Writes `~/.pa/voice-inbox/relay.json` for the poller
9. Registers the `PA-VoiceInbox-RelayPoller` scheduled task (Windows, every minute)
10. Starts the poller now and verifies `/healthz` plus the poller log
11. Prints the stable URL and the pairing instructions

### One Cloudflare account? Just log in.

Run the command and let the browser open. Choose the free-plan account the relay
should live on. Setup confirms the login before it deploys anything.

### Multiple accounts? Create a token first.

If this machine uses more than one Cloudflare account, create a scoped API token
before running setup. Dashboard → My Profile → API Tokens → Create Token → Custom,
granting exactly `Workers Scripts Edit`, `Workers R2 Storage Edit`, and
`Account Settings Read`, scoped to the relay account. Put the token and the account
id in `~/.pa/secrets.env`:

```
CF_RELAY_API_TOKEN=<token>
CF_RELAY_ACCOUNT_ID=<account id>
```

Setup verifies the token's account before deploying. Never run a bare
`npx wrangler deploy` — deploy always through the setup script, which scopes the
credentials and asserts the account.

### If the deploy reports a missing subdomain

A fresh Cloudflare account has no workers.dev subdomain yet — a one-time Cloudflare
requirement with no command-line equivalent. Open dash.cloudflare.com → Workers &
Pages → Your subdomain, pick a name, then re-run setup; it continues where it
stopped.

Expected final output (the URL and limits reflect your config):

```
  Stable URL:  https://voice-inbox-relay.<your-subdomain>.workers.dev

  Limits:      uploads up to 25 MiB; a request must finish within 55 s or the app shows a retryable error.

  Pair your phone: run `node scripts/mint_pairing.mjs --user-id <id> --chat-id <id>` (or `/pair` in the bot), then open <stable-url> on the phone and enter the code

Setup complete — now pair your phone.
```

Limits: uploads ride the app's `max_upload_mb` (default 25 MiB). A request must
finish within 55 s or the app shows a retryable error. Idle polling uses about 3.5%
of Cloudflare's free 100,000 requests/day.

Troubleshooting — setup prints one of these messages and stops; fix the cause and
re-run:

| Message | Fix |
|---|---|
| `Not logged in to Cloudflare. Re-run this command — it will open your browser to log in.` | Re-run; the browser flow completes the login. |
| `If you use more than one Cloudflare account, create a scoped API token with exactly: Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read — then put CF_RELAY_API_TOKEN and CF_RELAY_ACCOUNT_ID in ~/.pa/secrets.env and re-run. Otherwise just re-run and log in with your browser.` | Multi-account machine: follow the token recipe above. Single account: just re-run. |
| `Your Cloudflare account has no workers.dev subdomain yet (a one-time Cloudflare requirement). Open https://dash.cloudflare.com → Workers & Pages → Your subdomain, pick a name, then re-run this command — it will continue where it stopped.` | Register the subdomain once, re-run. |
| `The worker name "<name>" is taken on your account. Re-run with: node scripts/relay_setup.mjs --name <name>-2` | Re-run with the suggested `--name`. |
| `The relay deployed but is not answering yet (free-tier deploys can lag ~30 s). Wait a minute and re-run — everything else is already done.` | Wait a minute, re-run. |
| `Cannot reach the internet. Check your connection and re-run — setup continues where it stopped.` | Restore connectivity, re-run. |
| `The relay API token did not authenticate. Check CF_RELAY_API_TOKEN in ~/.pa/secrets.env, or re-create it in the Cloudflare dashboard.` | Re-create the token with the recipe above. |
| `That API token belongs to a different Cloudflare account. Point CF_RELAY_ACCOUNT_ID at the token's account, or create the token on the relay account.` | Point `CF_RELAY_ACCOUNT_ID` at the token's account. |
| `The relay API token is missing permissions. It needs exactly: Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read.` | Edit the token's permission set to the recipe above. |

The old quick tunnel (`scripts/quick_tunnel.ps1`) remains as a fallback.

## Data locations

All runtime state lives under `~/.pa/voice-inbox/` — user runtime state stays outside the
repo by convention:

| Path | Contents |
|---|---|
| `ledger.sqlite` | Task ledger: tenants, tasks, input requests, telemetry events, sessions, consumed pairing codes |
| `route-queue.jsonl` | Cross-process route entries consumed by the bot drain |
| `pairing-codes.json` | Pending one-time pairing codes, consumed on exchange |
| `answers/<task_id>/` | Submitted widget answers, one file per request |
| `files/<task_id>/` | Uploaded files |
| `logs/` | Server stdout/stderr from the detached launcher |

## API summary

All endpoints live under `/api/v1` and take `Authorization: Bearer` except `/health` and
`/pair/exchange`:

| Method/Path | Purpose |
|---|---|
| `GET /health` | Liveness probe (no auth) |
| `POST /pair/exchange` | Swap a pairing code for a session token |
| `GET /me` | Tenant identity |
| `POST /tasks` | Create a task (JSON text, or multipart audio + files + text) |
| `GET /tasks/:id/attachments/:name` | Download one stored attachment (name must be in the task's listing) |
| `GET /tasks?status=&limit=` | List tasks |
| `GET /tasks/:id` | Task detail with events and input requests |
| `GET /tasks/:id/events?after=` | Incremental event poll |
| `POST /tasks/:id/inputs/:requestId` | Answer one input request |
| `POST /tasks/:id/cancel` | Cancel the task |
| `POST /tasks/:id/reroute` | Move the task to another topic |
| `GET /topics` | Known topic keys and labels |

## Tests

`npm test` runs the compiled TS suite: contracts, ledger, API routes, identity, bridge
writer, and the twin-sync pins. `python -m pytest tests -q` runs the worker-script suite,
which also owns the byte-sync pins against `src/ledger.ts`. Scoped runs in a shared tree
use `PA_BUILD_LOCK=0`. Architecture and contracts detail: `CLAUDE.md` in this directory.
