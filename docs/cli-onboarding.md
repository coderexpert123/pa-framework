# Onboarding a new CLI to the Personal Assistant

Checklist for wiring a new agent CLI (call it `foo`) into the bus, dispatch,
and brain layers. Every step names the exact file to touch — the failure mode
this doc exists to prevent is a CLI that runs but is invisible to the bus
because one of the four provider-identity surfaces was missed (AI-261 class
of bug).

## A. Provider identity — all FOUR must agree

1. **`pa/scripts/hooks/_host_pid.py`** — add `foo`'s executable image(s) to
   `HOST_IMAGES`: `'foo': frozenset({'foo', 'foo.exe'})`. Basename of the
   first cmdline token only; if `foo` launches via node/a shim with no
   recognizable image, skip this — the legacy registry-ancestor match covers
   it.
2. **`pa/src/lib/bus-queue.ts`** — two edits:
   - `detectBusProvider()`: add `foo`'s ambient env marker to the chain
     (`process.env.FOO_MARKER ? 'foo'`) ahead of the `'cli'` fallback.
   - `PROVIDER_HOST_IMAGE`: add `foo: /^(foo|foo\.exe)$/i` (same rule —
     image-less providers omit it).
3. **`_provider()` in the three hook scripts** (`bus-inject-claude.py`,
   `bus-inject-gemini.py` for the legacy event vocabulary,
   `bus-session-start.py`): add `foo`'s env marker before the final
   `'claude'`/`'gemini'` default. Prefer an explicit `PA_WORKER=foo` stamp
   in the hook command over ambient detection.
4. **The hook command itself** stamps `PA_WORKER=foo` — this is the
   authoritative provider signal; ambient env vars are only the fallback.

## B. Hook wiring — discover the schema, then wire three points

Every CLI's hook contract differs on three axes: **event names**, **payload
fields** (`session_id`? `hook_event_name`?), and **the response shape**
(`hookSpecificOutput.additionalContext` is the Claude/agy/Devin contract —
verify `foo`'s).

1. `SessionStart`-equivalent → `bus-session-start.py` (registers identity,
   reports roster).
2. Tool-event → `bus-inject-claude.py` — injects the pending-message count.
   **If `foo` has no post-tool event, use its pre-tool event** — the count
   is one call early, which is fine (Devin precedent). Scope the matcher to
   activity-representative tools only (~400ms Python startup per fire).
3. Turn-end event (`Stop`/`AfterAgent`/equivalent) → `bus-inject-claude.py`
   — peeks and injects the oldest undelivered envelope.

Two hard requirements, learned live:

- **`PA_HOOK_EVENT=<event>` in every command.** If `foo` doesn't stamp
  `hook_event_name` in payloads, the injector can't tell Stop from a tool
  event — the env var is the deterministic override the script reads first.
- **Never replace existing hooks** — append beside safety/audio entries.

Verify dispatch live, not just config load (agy 1.2.4 lesson — loads
`hooks.json`, logs `loaded N named hooks`, then dispatches nothing): read
the real event vocabulary off the binary (`grep -aoE "Name1|Name2|…"
<binary>` — event enums like `HOOK_STOP`/`HOOK_ON_SESSION_END` may not
appear as bare literals), then run a live session with a probe hook that
appends `$event :: $stdin` to a file per event. A registry entry / probe
line is the only proof dispatch happens; synthetic stdin tests only prove
the script contract.

If `foo` has no context-injecting hook surface at all (Codex: `notify`
programs only, output never reaches the model), document the limitation in
the bus protocol doc (`bus.md` in `pa/docs/`) and rely on the drain +
manual `pa bus inbox`/`bus_wait`.

## C. Worker dispatch (only if `foo` is a `pa run` worker)

1. `~/.pa/config.yaml` worker block — `command`, `args`, `input_mode`,
   `output_format`, `priority`, `manual_only` if gated.
2. `pa/src/rate-limits-foo.ts` parser + registration in the rate-limit
   router (source name `foo-text` convention) — headless failover depends
   on it.
3. Failover wrapper (`~/.local/bin/foo-failover.cmd` convention) if the CLI
   has no native retry; stderr markers must never contain "rate limit"/
   "quota" or the parser flags successful failovers (devin.cmd precedent).
4. PA-spawned workers no-op in the hooks automatically
   (`PA_WORKER_DISPATCH_ID`) — nothing to wire, but verify the env arrives.

## D. MCP

Register `pa-mcp` (and Playwright per the WORKERS_GUIDE onboarding rule)
through `foo`'s MCP mechanism (`foo mcp add --scope user` or its config
JSON). Headless workers get bus tools through this, not hooks.

## D2. Coexistence — registry-and-restore (Wave C WP-C2)

Every in-place edit pa makes to an existing CLI's config goes through
`pa/src/lib/coexistence.ts`: snapshot the pre-edit bytes, then apply ADDITIVE
keys only — an existing user key never gets overwritten
(`KeyCollisionError` routes to the ask flow). Reversal: `pa coexistence
restore <id>` / `pa coexistence restore --all`; visibility: `pa coexistence
list` and the `pa doctor` `coexistence` block. Per-CLI surface rows (evidence:
cli-onboarding §B + MEMORY worker rows; no CLI here documents a config-dir
override, so all rows are registry-and-restore):

| CLI | Config surface touched | Isolation |
|---|---|---|
| claude | `~/.claude/settings.json` (+ `settings.local.json` if present) — hooks appended BESIDE existing entries, never replaced | registry-and-restore (only in-place hook-dir surface documented in §B) |
| codex | user-level codex MCP config, around the official `codex mcp add --scope user` | registry-and-restore (hook row: N/A — notify-programs only, documented limitation in §B) |
| opencode | `~/.config/opencode/opencode.jsonc` (or the CLI's reported user config path), flat `mcp` map via canonical `pa mcp serve` | registry-and-restore, JSONC key-level (hook/bus wiring row: OPEN — see below) |
| devin | `%APPDATA%\devin\mcp_config.json` / `~/.config/devin/`, around `devin mcp add --scope user` | registry-and-restore; best-effort per D7 — attempt, report, never gate |

OPEN item (decision rule, do not block): opencode bus plugin for public
installs — plugin-dir injection evidence exists only as an operator-local
global-dir copy, not in §B. Filed as a backlog signpost; v1 ships MCP-only
for opencode. agy/zclaude/kgclaude are operator-private shims/endpoints —
no public coexistence rows.

## E. Brain + skills parity

1. `foo`'s user-level brain file (e.g. `%APPDATA%/foo/AGENTS.md`) — the
   CLI-PARITY block; Devin requires `SKILL.md` uppercase naming.
2. `pa/scripts/sync_cli_parity.py` — add a `foo` target; check
   `SKILL_MIRROR_ALLOWLIST`/`TARGET_SKILL_EXCLUDES` so a mirrored skill
   doesn't shadow a native `foo` command.
3. A `foo-sync` script in `~/.local/bin/` per the devin-sync convention.

## F. Docs — the four rows that keep the next audit honest

1. `bus.md` under `pa/docs/` — the installed-hook-wiring section (event
   names, matcher, detection env, limitations).
2. `docs/WORKERS_GUIDE.md` — worker row + MCP-onboarding confirmation.
3. `AGENTS.md` — a `foo` worker bullet beside the Devin CLI bullet (model,
   shim, failover, rate-limit source).
4. `docs/DEBUGGING.md` — `foo`'s transcript locations/resume semantics.

## Smoke test before declaring done

1. Interactive `foo` session in this repo → `pa bus registry` shows
   `foo@<repo>#<n>` with a **live pid** (not the hook-runner's).
2. `pa bus whoami` inside the session's shell returns exactly that address.
3. Send a message to it → the tool-event fire injects the pending count;
   the turn-end fire injects the body; `pa bus inbox` marks it read.
4. `pa run --worker foo` dispatch → rate-limit parser recognizes a real
   limit; no phantom `claude@`/`cli@` registration appears.
