# Voice-inbox edge relay (`relay/`)

A long-poll pull relay that gives a localhost service a stable HTTPS URL on the
operator's own Cloudflare free account. The home machine makes outbound connections
only: its poller claims parked requests and delivers responses back. Nothing inbound
ever reaches the home network. No domain, no tunnel, no paid plan.

The relay is generic — any localhost HTTP service can front through it. The voice-inbox
PWA is the first consumer; nothing in `relay/` imports the app. The relay is
byte-faithful: response bytes and headers arrive verbatim, so the app's bearer-session
auth works unchanged.

The path of a request has four hops. The browser fetches the stable URL, and the
worker parks the request in a Durable Object mailbox. The home poller claims it with a
long-poll, executes it against `home_base_url`, and posts the response back. The
worker hands the response to the waiting browser.

## Layout

| Path | Role |
|---|---|
| `relay/protocol.js` | ONE source: constants, header filters, envelope codecs, base64, pure mailbox model. Runs in workerd and node:test unchanged. |
| `relay/worker.js` | Workers entry (routing, secret check, stream pass-through) + the `Mailbox` Durable Object. |
| `relay/wrangler.toml.example` | Tracked deploy template. The live copy (`wrangler.toml.live`) is generated and gitignored. |
| `relay/relay.config.example.json` | Poller timing defaults; `relay_setup.mjs` copies them into `relay.json`. |
| `relay/test/*.test.mjs` | node:test units — `npm test` scans this directory (plain `.mjs`, no build step). |
| `scripts/relay_setup.mjs` | One-command self-setup: auth, config, bucket, secret, deploy, auto-start. Idempotent. |
| `scripts/relay_poller.mjs` | Home-side long-poll poller. Zero npm dependencies. |
| `scripts/relay_start.ps1` | Detached launcher; single instance via the lock file. |
| `scripts/relay_smoke.mjs` | Real-runtime smoke: local workerd (`wrangler dev`) or `--live <url>`. |

## Endpoints

| Route | Auth | Behavior |
|---|---|---|
| `GET /healthz` | none | `200 {"ok":true}` — setup and smoke liveness. |
| any other method+path | none | The app's bearer auth is the gate (same threat model as the quick tunnel). Park, await, deliver. Over `MAX_BODY_BYTES` → `413 {"ok":false,"error":"payload too large"}`. |
| `POST /work?wait=<ms>` | secret | Long-poll claim: `200` request envelope, or `204`. `wait` clamps to `POLL_WAIT_MAX_MS`. |
| `GET /body/<key>` | secret | Streams the R2 object; only `req/` + `resp/` prefixes are valid. |
| `POST /resp?id=<id>` | secret | Delivers the response: JSON envelope, or raw stream + `x-relay-meta`. Unknown id → `410`. |

Error bodies are exact JSON: `401 {"ok":false,"error":"unauthorized"}`;
`410 {"ok":false,"error":"relay expired"}`; `500 {"ok":false,"error":"relay internal error"}`;
`504 {"ok":false,"error":"relay deadline exceeded"}` (deadline expiry, to the browser).

## Load-bearing semantics

- **Claims are at-most-once — never re-execute.** A claim is terminal: a claimed item
  is never re-queued. If the poller dies mid-request, the browser gets the 504 at the
  deadline and the user retries. Re-delivery would re-EXECUTE a POST against the app
  (duplicate task creation) to save one visible retry — the wrong trade. This is why
  the poller's PID lock is a convenience, not a correctness mutex: two live pollers
  split claims, never duplicate one.
- **The 55 s deadline.** A parked request dies 55 s after park (`REQUEST_DEADLINE_MS`)
  and the browser receives the 504 body. The poller's localhost timeout is 5 s shorter,
  so the home leg gives up first and the deadline response reaches the browser.
- **768 KiB is the inline↔R2 cutover, both directions.** `INLINE_BODY_MAX_BYTES` =
  768 KiB raw → ≈1.0 MiB base64 → ≤~1.1 MB envelope, under the DO's 2 MB key+value cap
  with ≥45% headroom. Static assets and JSON responses ride the mailbox inline; voice
  uploads and large or unknown-length bodies stream through R2 (`req/<id>.bin`,
  `resp/<id>.bin`). The worker decides inbound sizing; the poller decides response
  sizing; the mailbox never touches body bytes.
- **KV is forbidden for the work queue.** The queue lives ONLY in the Durable Object's
  `ctx.storage` (SQLite-backed, strong consistency, free-plan-legal). Workers KV is
  eventually consistent and would break claim exclusivity. Storage keys: `seq`,
  `item:<id>`, `resp:<id>`.
- **Header rules** (`protocol.js`): hop-by-hop drop lists in both directions;
  `content-length` is re-set from the true byte count; `accept-encoding` is forced to
  `identity` on the localhost leg (the home server never compresses); names are
  lowercased; values are preserved verbatim. Repeated names are joined by Headers
  iteration — the v1 limitation, documented not worked around (the app sets no
  repeated response headers).
- **Secret comparison**: both the presented `x-relay-secret` and `RELAY_SECRET` are
  SHA-256 hashed and the hex digests are compared with a constant-time comparator.
  The poller's secret arrives via the `VOICE_INBOX_RELAY_SECRET` env var; the worker's
  rides `wrangler secret put RELAY_SECRET`.

## Auth model (deploy credentials)

Token mode is primary; guided login is the fallback. Setup prints which mode it took.

- **Token mode** — active when `CF_RELAY_API_TOKEN` + `CF_RELAY_ACCOUNT_ID` both
  resolve; process env wins over `~/.pa/secrets.env`. Every wrangler child is then
  spawned with exactly `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in a minimal
  child env. The stored OAuth of any account is never consulted and never disturbed.
  Setup runs `wrangler whoami` first and asserts the relay account id in its output —
  Cloudflare's docs document no env-token-over-OAuth precedence sentence, so the
  design verifies the account instead of trusting precedence.
- **Token recipe** (dashboard → My Profile → API Tokens → Create Token → Custom):
  exactly `Workers Scripts Edit` + `Workers R2 Storage Edit` + `Account Settings Read`,
  account-scoped to the relay account. DO class migrations ride `Workers Scripts Edit`;
  there is no standalone "R2" permission. No Zone permissions, no KV, no Tail.
- **Login mode** (fallback) — no token pair: setup runs guided `wrangler login` (the
  browser opens) and confirms with `whoami`. This is the single-account personal user's
  path. A half-set pair (one key present) falls back to login — it must never silently
  deploy to a guessed account.
- **No bare wrangler invocation.** Every wrangler child in repo scripts originates in
  one helper (`runWrangler`); `grep -n "spawn" scripts/relay_setup.mjs` proves it. A
  bare `npx wrangler deploy` in the relay tree could hit the wrong account's stored
  OAuth.

## Runtime state

`~/.pa/voice-inbox/` unless noted. Runtime state stays outside the repo.

| Path | Contents |
|---|---|
| `relay.json` | Poller config: `worker_base_url`, `home_base_url`, plus the three timing keys. Written by setup. |
| `relay-poller.lock` | PID + timestamp; liveness-checked, a dead holder's lock is stolen. |
| `relay-poller-launcher.vbs` | Generated Task Scheduler launcher; sets `CurrentDirectory` to the package dir first. |
| `logs/relay-poller.log` | One JSONL line per proxied request: `{ts, id, method, path, status, ms, bytes}`. |
| `logs/relay-poller.err` | Human progress and failures (the launcher's stderr redirect). |
| `~/.pa/secrets.env` | `VOICE_INBOX_RELAY_SECRET` (poller↔worker shared secret); `CF_RELAY_API_TOKEN` + `CF_RELAY_ACCOUNT_ID` (deploy credentials, optional). |
| `relay/wrangler.toml.live` (in repo dir) | Generated deploy config; gitignored. Carries the worker + bucket names, never a secret value. |

## Free-tier budget

Verified against Cloudflare's published limits (2026-09-07). Idle cost fits one relay
per account with the tightest margin being DO duration.

| Limit | Free value | Relay use |
|---|---|---|
| Workers requests | 100k/day | 86,400 s / 25 s ≈ 3,456 idle polls/day (~3.5%) |
| Workers CPU | 10 ms/request | Envelope-only materialization; bodies are stream pass-through |
| DO duration | 13,000 GB-s/day | A continuously long-polled singleton ≈ 10,800 GB-s/day (~83%, single occupancy) |
| DO storage | key+value ≤ 2 MB | Inline envelopes ≤ ~1.1 MB |
| R2 | 10 GB-month; 1M Class A + 10M Class B ops/month; egress free | Idle cost zero; realistic use thousands of ops |
| workers.dev | 100k req/day, subdomain registered in the dashboard | No CLI command exists — setup guides the one-time step |

Escape hatch if Cloudflare tightens the duration cap: switch `/work` to short-poll
(2 s interval ≈ 43k requests/day, duration ~0). Documented, not built.

## Auto-start

Setup registers `PA-VoiceInbox-RelayPoller` (Task Scheduler, current user, no admin):
a 1-minute ensure-running tick that runs `scripts/relay_start.ps1` window-hidden
through a generated VBS launcher. The start script is idempotent — the tick is a no-op
while the poller is healthy. Verify liveness via the log files, never via the
launcher's exit code (the machine's detached-launcher rule). Non-Windows platforms
skip registration; run `node scripts/relay_poller.mjs` under your own supervisor.

## Toolchain pin

`wrangler@4.129.0`, pinned in `relay_setup.mjs` and `relay_smoke.mjs`
(`WRANGLER_PIN` / `WRANGLER_VERSION`) and in the docs. Re-pin policy: a deliberate
one-line bump in both scripts plus this README, never a bare `wrangler@latest` —
deploy-tooling drift must be a decision. `compatibility_date` bumps in the same edit
if a newer wrangler rejects the pinned date.

## Gates

```
npm test -- protocol.test.mjs        # pure units: mailbox model, headers, envelopes, base64
npm test -- relay-poller.test.mjs    # poller units: config, lock, backoff, request-builder
npm test -- relay-setup.test.mjs     # setup units: config build, URL parse, auth resolution, messages
node scripts/relay_smoke.mjs         # local real-runtime smoke (wrangler dev; no Cloudflare account)
node scripts/relay_smoke.mjs --live <stable-url>   # live smoke; ENFORCES median added latency <= 1000 ms
```

The compile gate before any live deploy: copy `wrangler.toml.example` to
`wrangler.toml`, then `npx -y wrangler@4.129.0 deploy --dry-run --outdir dryrun` in
`relay/`. The smoke prints `RELAY SMOKE OK (mode=local|live)` and exits 0 on success;
any failure names the scenario and exits 1.

The three unit gates are pure logic and share NO wire with each other's subjects: a
worker↔poller contract mismatch (claim method, header name, envelope shape) passes all
of them green. The smoke is the only gate that runs the real seam — treat it as
mandatory before any deploy, never optional.

## Fallback and retirement

The quick tunnel (`scripts/quick_tunnel.ps1`, ephemeral trycloudflare.com URL) is the
fallback path when workers.dev is unreachable from a network. The parked predecessor —
`worker/` (tunnel proxy) and `scripts/tunnel_up.ps1` — leaves the repo at relay
cutover; git history is its archive. Recovery on the fallback is: rerun
`quick_tunnel.ps1`, re-pair (the session dies with the old origin).
