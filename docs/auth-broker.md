# Auth broker (`pa auth`)

> Audience: anyone wiring a new provider into the phone-approval path, or debugging why a
> worker is stuck waiting on authorization.

The auth broker is a generalized phone-approval path for any tool a worker runs that needs
a human step: opening a URL, typing a code, supplying a key, or answering yes/no. Before
this feature, only Google reauth had a working link-and-resume flow; every other blocked
tool either stalled or asked in chat. A worker (or a human, via the bot) now runs `pa auth
request`, waits on `pa auth wait`, and resumes the blocked tool with the returned value —
one path for every provider. Phase A ships the CLI, the broker's own on-disk store, a
callback endpoint for OAuth code flows, the Telegram fallback, and a maintenance job that
reaps answered secrets. Provider profile learning and a broker-native device-flow driver
are Phase B (see Follow-ups below).

## The five shapes

Every auth request is one of five shapes. The shape decides which typed widget the
requester sees and what "done" means.

| Shape | Human action | Widget | Required params | Completes when |
|---|---|---|---|---|
| S1 | Open a URL, approve | `oauth` | `provider` | the provider redirects to the callback, or the Done button when `confirmable` |
| S2 | Open a URL, type the shown code | `oauth` | `provider`, `user_code` | the tool's own poll, or the Done button when `confirmable` |
| S3 | Read a code on another device, type it in | `secret` | — | the value arrives |
| S4 | Type an API key, password, or token | `secret` | — | the value arrives |
| S5 | Answer yes/no or choose one of several options | `confirm` or `choice` | `options` for `choice` | the choice arrives |

S2 is a *display* shape in Phase A: the caller already ran its own device-flow exchange
(for example a CLI's own `device-auth` mode) and just needs the code shown to the operator.
The broker does not run its own device-flow driver yet — that is Phase B.

Each shape has a default expiry, used when the caller does not pass `--expires`: S1 and S5
last 12 hours, S2 lasts 15 minutes, S3 and S4 last 1 hour.

## The `pa auth` command surface

```
pa auth request --shape S1|S2|S3|S4|S5 --provider <name> [--prompt <text>]
                [--url <https url>] [--code <user code>] [--option <label>]...
                [--task <vi-id>] [--tenant <t-id>] [--expires <seconds>]
                [--confirmable] [--json]
pa auth wait <request-id> [--timeout <seconds>] [--json]
pa auth answer --request <request-id> [--tenant <t-id>]      # value on stdin, never argv
pa auth learn --provider <name> --shape S1..S5 --command <text>
              [--env <VAR>] [--credential-path <path>] [--expires-days <n>] [--notes <text>]
```

`pa auth request` mints the widget and, when the caller passes no `--task`, files it into
a standing per-tenant conversation instead of creating a floating request with nowhere to
render. `pa auth wait` polls every 2 seconds until the request is answered, expires, or the
timeout (default 300 seconds) elapses. `pa auth answer` reads the value from stdin, never
from an argument — an argument would land in shell history and process listings. `pa auth
learn` records how to satisfy a provider for next time, in `~/.pa/auth-profiles.yaml`; it
does not itself run anything.

Exit codes follow the same contract as `pa watch`. `0` is success, `2` is a usage or
argument error. `3` means a validator or a missing precondition rejected the request, and
`4` means `wait` timed out or the request expired.

`--url` has one deliberate use: an S2 "display" request has no callback of its own, so a
caller that already has a URL to show passes it here. Everything else that touches a real
secret goes through stdin or the typed widget, never a flag.

## The callback endpoint

`GET /api/v1/auth/callback` on the voice-inbox server is the landing page a provider
redirects the phone back to after a web-based approval step. It is deliberately
un-authenticated — the phone has no session token at that point — and is resolved before
every other check the server runs.

The endpoint is single-use and time-boxed. It looks up the pending broker request by the
opaque `state` value on the redirect, rejects anything expired or already used, runs the
provider's configured token exchange, stores the resulting token file, and resumes the
worker that was waiting. A failure at any of those steps, including the provider itself
sending back an `error` parameter, returns the same generic "link no longer valid" page —
the page deliberately never reveals *why* a link failed, so it cannot be used to probe for
valid request ids.

Token files land under `~/.pa/auth/` and `~/.pa/`, written with mode `0600`. On Windows,
`mode` only toggles the read-only attribute — there is no POSIX permission bit to set — so
the endpoint also runs a best-effort `icacls` call to restrict the file's ACL to the
current user. That call is not guaranteed to succeed in every environment, and its failure
is swallowed rather than treated as an error; the Windows hardening is real but not as
strong as the POSIX mode bit, and this is stated here rather than implied.

## Provider config

Each provider that can use the generalized `oauth` widget is a config row, not a new code
path. A row describes how to build the authorize URL and how to exchange the returned code
for tokens:

```ts
export interface AuthProviderConfig {
  name: string;
  authorize:
    | { kind: 'script'; script: string; argv: string[] }
    | { kind: 'http'; authorize_url: string; scopes: string[]; client_id_key: string };
  exchange:
    | { kind: 'script'; script: string; argv: string[] }
    | { kind: 'http'; token_url: string; client_id_key: string; client_secret_key?: string };
  pkce: boolean;
  token_file: string;
}
```

`kind: 'script'` spawns a repo-relative script and parses its last JSON stdout line;
`kind: 'http'` posts directly to a token endpoint with PKCE when `pkce` is true. An argv
template may only use the placeholders `{chat_id}`, `{redirect_uri}`, `{code}`, and
`{state}` — anything else throws at render time rather than shipping an unrendered literal
to a spawned process.

Phase A registers exactly one provider, Google, and it uses the `script` kind on both
sides. Both point at the same start/finish script pair that already drives the
Telegram-based Google reauth flow, so the codebase still has only one Google token
exchanger. Adding a Phase B provider (Claude, Codex, Gemini, GitHub, Cloudflare, z.ai,
Groq, COROS, Strava) is meant to be a new config row here, not a new dispatcher.

## The profiles file

`~/.pa/auth-profiles.yaml` records how a provider was satisfied, for reuse the next time
the same tool needs authorization. `pa auth learn` upserts one entry per provider, replacing
it whole rather than merging fields:

```yaml
github:
  shape: S2
  command: gh auth login --with-token
  env: GH_TOKEN
  credential_path: keyring
  expires_days: 0
  notes: device flow must be enabled per app
  learned_at: 2026-09-10T06:00:00.000Z
```

Phase A only writes this file; nothing yet reads it back to skip a step automatically —
that consumption is part of the broker's own device-flow driver in Phase B.

## The Telegram fallback

Two paths exist for operators without the PWA open. An inline `auth:<provider>:<request
id>` button opens the pending request's authorization link. A `/secret <request-id> <value>`
command delivers a secret or API-key value the same way `/auth` already delivers a Google
code — the bot deletes the triggering message immediately, and the value never reaches a
log line, an argument list, or the bot's reply.

Telegram may already have shown a notification preview of that message before the bot
finishes deleting it. Message deletion closes the exposure in the chat itself; it does not
retroactively un-show a preview a phone's lock screen already rendered. Treat `/secret` as
"gone from the chat," not "never displayed."

## Answer retention

An operator-typed secret answer sits in plaintext on disk only long enough to be delivered.
Once the broker's own record shows a value was delivered, that answer file is deleted after
1 hour. A secret answered by a widget the broker never tracked — created directly by a
worker script rather than through `pa auth request` — is instead reaped 24 hours after the
underlying task record shows it as answered, which is the only signal available for that
path. The broker's own short-lived request rows are deleted 24 hours after they expire or
are delivered; they are handoff state, not an audit trail.

## Operator setup

Using the Google provider through the callback (instead of the older paste-back flow)
needs one registration step: add `<relay public base URL>/api/v1/auth/callback` as an
authorized redirect URI on the Google OAuth web client, and point the deployment's
`GOOGLE_AUTH_REDIRECT_URI` at that same URL. The relay's public base URL is the stable
address the edge relay already publishes for the voice-inbox app; see
`docs/voice-inbox-config.md` for where that value lives. The older bridge page
and the `/auth` paste-back command both keep working during the transition — nothing in
Phase A removes either.

## Known gaps and Phase B follow-ups

- **Provider label capitalization.** The PWA's oauth widget titlecases an unrecognized
  provider name for display (`github` renders as "Github", not "GitHub"). A real per-provider
  display-name table is Phase B work, once more providers exist to justify one.
- **The oauth widget's trailing sentence is Google-specific text.** It always reads "the
  task continues automatically once Google authorization completes," even for a
  non-Google provider. This is safe today because Google is the only Phase-A provider, but
  it needs generalizing before a second provider ships.
- **The broker-row shape is duplicated across two packages.** `pa`'s own copy
  (`pa/src/lib/auth/store.ts`) and the voice-inbox server's copy
  (`projects/voice-inbox/src/auth-providers.ts`) each independently implement the same
  frozen JSON row shape, by design — the two packages do not import each other's compiled
  output. `pa/tests/auth-store-cross-package.test.ts` pins the two copies byte-identical
  (regex-extracted from source, since `pa` cannot import the other package); it fails on
  either file drifting from the other, but a change intended to land in both still has to
  be made twice.
- **The `pa secrets set` command does not exist yet.** Phase A never writes
  `secrets.env` for this reason: durable provider credentials land in `~/.pa/auth/` instead,
  and an S4 API key is handed back to the caller as a pointer rather than persisted
  automatically. A parse-preserving secrets writer is tracked separately.
- **Provider profiles and smoke coverage** for the rest of the CLI fleet (Claude, Codex,
  Gemini, GitHub, Cloudflare, z.ai/Groq, COROS, Strava), plus the broker's own device-flow
  driver, ship in Phase B. The older bridge page and `/auth` command retire after that
  release, not before.
- **A dead widget can outlive its own expiry in the app.** Nothing today expires the PWA's
  view of a ledger request when the broker's own copy of that request expires first, so an
  operator can see a widget that looks live but can no longer be answered.
