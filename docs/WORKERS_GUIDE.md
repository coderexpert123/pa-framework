# Workers Guide

> Audience: anyone adding a new worker CLI to the framework or debugging worker failures.

## The worker contract

A "worker" is an external CLI process that the framework spawns to handle an LLM task. The framework expects:

| What | Details |
|---|---|
| **Stdin** | Receives prompt as text or NDJSON, depending on `input_mode` |
| **Args** | Receives arguments per `WorkerConfig.args`, with `{prompt}` and `{prompt_file}` substituted. A dispatch may pass `RunOptions.stripArgs` (flag names) to remove configured flags for that one run: bare form drops the flag and its following token, `=` form drops the token, repeats all drop; `extraArgs`/`getExtraArgs` output is never stripped. |
| **Env** | `RunOptions.env` is the secrets bag; during `runWithFailover` it is replaced per candidate by the `secret_allowlist`-filtered subset (absent = all keys pass) — every non-allowlisted key is dropped, so non-secret dispatch keys belong on `getEnv`, never `env`. `RunOptions.getEnv` is the per-hop hook — evaluated with each failover candidate's own `WorkerConfig` and merged AFTER the filtered `env`, so framework-stamped keys (`PA_TASK_ID`, the `PA_WORKER_CLI` provenance) reach allowlisted workers and always reflect the hop that actually ran. |
| **Stdout** | Plain text OR NDJSON events (when `output_format: stream-json`) |
| **Stderr** | Used for rate-limit pattern matching and error diagnostics |
| **Exit code** | 0 = success, non-zero = failure (logged + alerted) |
| **Process tree** | Children should die when parent dies — framework SIGKILLs the tree on timeout |

## Built-in workers

| Worker | input_mode | output_format | Rate-limit detection | Notes |
|---|---|---|---|---|
| `zclaude` | `stdin-json` | `stream-json` | Session-mode | Claude wrapper with extra features |
| `claude` | `stdin-json` | `stream-json` | Session-mode | Anthropic's Claude Code CLI |
| `agy` | `arg` | `plain-text` | Google-API stderr classifier (RESOURCE_EXHAUSTED, 429) | Antigravity CLI — setup-required |
| `codex` | `stdin-text` | `stream-json` | Text-pattern (`hit your usage limit`) | OpenAI Codex CLI |
| `devin` | `arg` | `plain-text` | Devin stderr classifier (`devin-text`) | Devin CLI — setup-required |
| `kgclaude` | `stdin-json` | `stream-json` | Text-pattern (`kgclaude:` resolver stderr) → default classifier | claude.exe wrapper on the Kaggle TPU endpoint — `manual_only`, needs `kgtpu serve` first |
| opencode | arg | plain-text | Text-pattern (none seeded — patterns must be observed phrases) | opencode run headless — manual_only until proven |

## Wrapper scripts

A worker's `command:` field is spawned verbatim — `worker-exec.ts` does no name-based rewriting or magic path resolution (removed 2026-07-10; see `pa/tests/worker-exec-command.test.ts`). If your CLI needs something the framework doesn't do for you, point `command:` at a small wrapper script instead of the bare CLI binary. Common reasons:

- **Env vars** the CLI needs set before it runs (e.g. a cloud project ID, an API base URL).
- **Token refresh** — some CLIs need a credential refreshed before each invocation.
- **Arg-quoting fixes** — a CLI that mishandles how `worker-exec.ts` passes arguments through `shell:true`.

Minimal example, `mycli-wrapper.cmd` (Windows):

```bat
@echo off
set YOUR_VAR=your-value
mycli %*
```

Minimal example, `mycli-wrapper.sh` (POSIX):

```sh
#!/bin/sh
export YOUR_VAR=your-value
exec mycli "$@"
```

Point the worker's `command:` at the wrapper's absolute path in `config.yaml`, e.g. `command: C:/Users/you/mycli-wrapper.cmd` or `command: ~/.local/bin/mycli-wrapper.sh`. Since `worker-exec.ts` spawns `command:` verbatim, this works for any worker without any framework changes.

## Adding a new worker — walkthrough (Ollama example)

Goal: add a local Ollama instance as a fallback worker for when external APIs are rate-limited or unavailable.

### Step 1: Verify the CLI works manually

```powershell
ollama --version
echo "what's the weather like" | ollama run llama3
```

If this works end-to-end, you can wrap it.

### Step 2: Add to `~/.pa/config.yaml`

```yaml
workers:
  # ... existing workers ...
  - name: ollama
    command: ollama
    args:
      - "run"
      - "llama3"
      - "{prompt}"
    input_mode: arg          # prompt is passed as final arg
    check: ollama --version
    check_timeout: 5
    rate_limit_patterns: []  # local model — no rate limits
    priority: 5              # lowest priority (only used when others unavailable)
    # manual_only: true      # OPTIONAL: exclude from automatic failover — the
    #                         # worker then runs ONLY when a dispatch explicitly
    #                         # names it (bot /agent <name>, skill `worker:`
    #                         # frontmatter, or a global worker_pin).
```

### Step 3: Verify `pa workers`

```
node pa/dist/bin/pa.js workers
```

Should list `ollama` with status `OK`.

### Step 4: Test execution

Create a test skill at `~/.pa/skills/ollama-test/skill.md`:

```yaml
---
worker: ollama
trigger_description: "Test the ollama worker"
---

What is 2 + 2? Respond with just the number.
```

Run:

```
node pa/dist/bin/pa.js run ollama-test --worker ollama
```

Expected output: `4` (or with reasoning if the model adds it).

### Step 5: Tune rate-limit patterns (if needed)

Ollama doesn't rate-limit, but if you wrap a remote model:

```yaml
rate_limit_patterns:
  - "context length exceeded"
  - "model is loading"
  - "timeout"
```

These substrings (case-insensitive) trigger a cooldown when matched in stdout/stderr.

## Failover behavior

When the orchestrator needs to run a skill:

1. Build the list of "preferred" workers per the [skill's worker selection precedence](SKILLS_GUIDE.md#worker-selection-precedence).
2. For each candidate (in priority order):
   - Skip if its `check` command fails or it's in a rate-limit cooldown.
   - Spawn it with the skill's prompt.
   - If it exits 0 → return the output.
   - If it exits non-zero → log, alert (`pa notify`), try next.
   - If it stalls (no stdout for `idle_timeout` seconds) → consult the evaluator (if configured). The evaluator decides: extend, kill, or fail-over.
   - If rate-limit pattern matched → set cooldown timer, fail-over.
   - If it exits 0 with empty output on a `telegram_output` skill → fail over to the next worker (silent no-op guard, 2026-08-21).
   - A dispatch cancelled by the caller (`/stop`) never advances the cascade — the kill is not a worker failure (AI-092).
3. If all candidates exhausted → return error, `pa notify` an "all workers failed" alert.

`no_fallback: true` on the skill disables steps 3 — once the preferred worker fails, the skill errors immediately.

## Evaluator's role

When a worker stalls (no stdout for `idle_timeout` seconds), the framework can ask another worker (the "evaluator") to decide what to do. The evaluator chain skips `manual_only` workers and workers in a rate-limit cooldown. An empty chain falls through to standard kill behavior — the stall is handled without a judge verdict, never blocked waiting for one.

The evaluator judges from the stalled worker's usable conversation-state tail and returns a JSON verdict (`extend`, `kill`, or `done`). Judge prompts shed the bot-instructions system prompt. Evaluator timeout/idle scale 1–3x under governor pressure, floored at the configured values. A state file written inside the firing timer's window (≤60s) extends without consulting the judge.

Configure in `config.yaml`:

```yaml
evaluator:
  worker: claude    # must match a workers[].name
  timeout: 60       # seconds for the evaluator itself
```

If the evaluator returns unparseable JSON, the framework defaults to "extend by idle_timeout" (one retry) before killing.

## Debugging worker failures

### Step 1: Check logs

```
node pa/dist/bin/pa.js logs my-skill
```

Shows the last few runs. Look for:

- `error`: full message
- `exitCode`: non-zero
- `stderr_excerpt`: first 200 chars of stderr
- `worker`: which worker was running

### Step 2: Check per-CLI transcripts

Each worker maintains its own session-state directory:

| Worker | Location | Format |
|---|---|---|
| claude, zclaude, kgclaude | `~/.claude/projects/<cwd-slug>/<session>.jsonl` | NDJSON |
| agy | `~/.gemini/antigravity-cli/conversations` | SQLite (*.db, WAL) |
| codex | `~/.codex/state_5.sqlite` | SQLite (use `sqlite3` to inspect) |
| opencode | ~/.local/share/opencode/opencode.db | SQLite (opencode session list/export) |

The `<cwd-slug>` for Claude is the cwd with `:`, `\`, `/`, spaces replaced with `-`. E.g., `D:\My Project` → `D--My-Project`.

### Step 3: Manual worker spawn

Reproduce the worker invocation manually:

```powershell
# From the skill's cwd:
echo "<the prompt>" | zclaude -p --dangerously-skip-permissions --output-format stream-json --input-format stream-json --verbose
```

This eliminates pa-framework as a variable.

### Step 4: Check `pa health`

```
node pa/dist/bin/pa.js health
```

Specifically the `workers` row — it shows which workers are available, which are cooling, which fail their `check`.

## Common worker issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `check` command hangs | Worker CLI tries to prompt for credentials | Add `--non-interactive` flag, set env vars to bypass prompts |
| `check` passes but `pa run` errors immediately | `command` path or `args` quoting wrong | Verify with manual invocation |
| Worker exits 0 but output is empty | `output_format: stream-json` mismatch | Set to undefined or match the actual format |
| Rate-limit patterns never match | Patterns case-mismatch or use regex syntax | The framework does case-insensitive substring match, NOT regex |
| Cooldown lingers forever | `rate-limit-state.json` corrupted | `rm ~/.pa/rate-limit-state.json` and restart |

## The `pa run` runtime block

Every LLM-worker skill dispatch (`no cmd:`) gets a `## PA runtime (this run)` section appended to its prompt — it names the operator-facing pa commands the worker can call (`pa ping` to page the operator, `pa notify --topic-thread` for cross-topic delivery, `pa watch add` for completion watches, `pa topic-task add` to queue topic work, `pa ref`, `pa health`/`pa doctor`, `pa recall`, `pa claims`/`pa claim`). Always-on since 2026-09-16 (evangelism wave WP-6); `cmd:` skills bypass the LLM path and never see it; `PA_RUNTIME_BLOCK_DISABLED=1` is the rollback. Source: `PA_RUNTIME_BLOCK` in `pa/src/commands/run.ts`.

## Cross-worker context

The framework doesn't share context across workers — each spawn is independent. If a skill needs context preserved across runs, store it in a JSON file in `cwd`.

For the Telegram bot, per-topic conversation state is maintained in `~/.pa/telegram-bot-topic-<chatId>_<threadId>.json` and replayed on each new message.

## Codex translation layer

Codex's `/skill-name` slash-command syntax conflicts with pa's natural prompt syntax. The framework rewrites `/skill-name` to `$skill-name` before passing to codex.

The list of recognized skill names lives in `~/.pa/codex-skill-translations.json` (scaffolded by `pa init`). Modify it to add custom skills you want auto-translated.

The same list is also used by the bot's `PASS_THROUGH_PATTERN` in `projects/telegram-bot/src/logic.ts` to recognize commands that should not be routed to LLMs. For example, `/deep-plan` should reach the deep-plan skill, not be interpreted as bot conversation.

## MCP integration

The pa CLI can run as a local MCP server, exposing read-only tools to LLM clients (Claude Code, Codex, agy, Devin, opencode). This enables agents to query pa state without spawning subprocesses.

### Available tools

| Tool | Purpose |
|---|---|
| `pa_ref_lookup` | Look up a ref-ID (e.g. "c-a59a") to find what message produced it |
| `pa_claims` | List active path reservations + recently modified files (multi-session coordination) |
| `pa_maintenance_status` | Show maintenance ledger (last run, outcome, consecutive failures/skips) |
| `pa_costs` | Usage/cost rollup by worker, model, and skill |
| `pa_slo_report` | SLO error budget report for bot-reply-delivery, daily-mail-brief, catchup-heartbeat (add your own services via `~/.pa/slo.yaml`) |
| `pa_recall` | Full-text search over archived conversation turns, worker run traces, per-topic brains, the Ecosystem KB, pending review-digest conflicts, decision rows, and the operator profile (interests/preferences/history) (2026-08-24/27, profile 2026-09-16). `q` required; `thread`/`source`/`limit` optional (`limit` clamped to 50). |
| `bus_send` | Send a message to another agent CLI via the pa bus (durable file-based queue). `to`/`body` required; `from`/`reply_to` optional. |
| `bus_inbox` | Pop the next message from a bus inbox (touches the cursor — the liveness record). `address` required; `peek` optional. |
| `bus_wait` | Wait for a new message on a bus address (fs.watch inside the MCP process). `address` required; `timeout_ms` optional (default 30000). |
| `bus_list` | List queued messages for an address, or all registered bus addresses when `address` is omitted. |
| `bus_whoami` | Print this MCP session's own bus address (provider@repo, cwd-derived). |

### Searching past context

`pa recall "<query>" [--thread <id>] [--source conversation|trace|brain|kb|review|decisions|profile] [--role user|assistant] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--limit <n>] [--json] [--reindex] [--rebuild]` searches everything a worker or the bot might otherwise re-ask about: past turns from any topic, past worker runs and their tool calls/commands/files/errors, topic brains, the Ecosystem KB, past judgment calls (decision rows, 2026-08-27), and the operator profile (interests, top-level preferences, live history rows, 2026-09-16). Precedent check before proposing: `pa recall "<intent>" --source decisions --json` returns past decisions with rationale and user reaction. `--reindex`/`--rebuild` alone (no query) run the incremental or full index pass and print a summary. Backed by `pa/src/lib/recall-store.ts` (FTS5 via `better-sqlite3`, in-process — no spawn); kept fresh every 10 minutes by the `recall-index` maintenance job (`docs/maintenance-jobs.md`). Full design: `docs/ARCHITECTURE.md` § "Recall (`pa recall`, 2026-08-24)".

### Starting the server

```bash
pa mcp serve
```

The server uses stdio transport — it reads JSON-RPC from stdin and writes responses to stdout.

### Registration

Run `pa mcp manifest` to print the manifest and registration instructions for your CLI:

```bash
pa mcp manifest
```

**Claude (`claude mcp add`):**
```bash
claude mcp add pa-mcp -- pa mcp serve
```

`--` separates the server name from the launch command. Stdio is the default transport, so no transport flag is needed (use `--transport http` only for URL servers). The `-s` scope flag chooses where the entry lands: `local` (default) writes `~/.claude.json` under the current project's entry, `user` makes it available in every project, and `project` writes a `.mcp.json` at the project root.

**Codex (`~/.codex/config.toml` — TOML, one `[mcp_servers.<name>]` table per server):**
```toml
[mcp_servers.pa-mcp]
command = "node"
args = ["<repo-root>/pa/mcp/server.mjs"]
```

Optional `[mcp_servers.<name>.env]` and `[mcp_servers.<name>.tools.<tool>]` (e.g. an `approval_mode` override) tables sit alongside. There is no `~/.codex/config.json` — Codex reads only the TOML file.

**agy (`~/.gemini/settings.json` — top-level `mcpServers` object):**
```json
{
  "mcpServers": {
    "pa-mcp": {
      "command": "node",
      "args": ["<repo-root>/pa/mcp/server.mjs"]
    }
  }
}
```

Entries use the same `{command, args, env, cwd}` stdio shape as Claude (plus `timeout` and `trust`). There is no `~/.agy/config.yaml` — agy's MCP servers are configured in `~/.gemini/settings.json` (a per-project `.gemini/settings.json` works the same way).

**Devin (`devin mcp add --scope user`):**
```bash
devin mcp add --scope user pa-mcp -- node <repo-root>/pa/mcp/server.mjs
```

Devin writes stdio servers to user-level `~/.config/devin/mcp_config.json` (on Windows this resolves to `%APPDATA%\devin\mcp_config.json`).

**opencode (`~/.config/opencode/opencode.jsonc` — flat `mcp` map, v1 shape):**
```jsonc
"mcp": {
  "pa-mcp": {
    "type": "local",
    "command": ["pa", "mcp", "serve"],
    "enabled": true
  }
}
```

Installed 1.18.31 honors flat `mcp.<name>` entries; the v2 `mcp.servers` nesting + `disabled` field must not be used. The launch command is the canonical `pa mcp serve` (never the `pa/mcp/server.mjs` source path).

**Project-root `.mcp.json` (project-scope and external servers):**

A repo can declare MCP servers at its root in a `.mcp.json` using the same `mcpServers` shape, with a per-entry `cwd` so the server runs from its own checkout. Claude Code picks these up per project and records the approval state in `~/.claude.json` (`enabledMcpjsonServers` / `disabledMcpjsonServers`). This deployment's repo carries one as a working precedent: it registers an external `brain` knowledge-store server — a `python -m` module run from that server's own checkout, selected via `cwd`, with an `--agent-id` argument scoping it to this deployment.

The manifest file at `~/.pa/mcp.json` contains the full tool definitions for reference.

### Tool schema

All tools return structured text responses. Example:

```json
{
  "name": "pa_ref_lookup",
  "arguments": {
    "id": "c-a59a"
  }
}
```

Returns:
```text
{
  "refId": "c-a59a",
  "kind": "turn",
  "timestamp": "2026-08-17T12:34:56.789Z",
  "worker": "agy",
  "chatId": 123456789,
  "threadId": 9855,
  "messageId": 12345,
  "text": "The assistant's reply...",
  "source": "conversation-history"
}
```

### Browser automation (Playwright MCP)

Playwright MCP is the default browser tool for every headless worker session: `claude -p`, zclaude, codex `exec`, agy dispatches, `devin` dispatches, and `opencode run` dispatches. Interactive Claude Code sessions keep the Claude in Chrome extension instead. The server definition is identical in all six CLIs and version-pinned.

Registration points, one server everywhere (`npx -y @playwright/mcp@0.0.80 --browser chrome --user-data-dir <profile-dir>`):

| Worker | Config file | Notes |
|---|---|---|
| claude, zclaude | `~/.claude.json` (user scope) | `claude mcp add -s user playwright -- <command>`; both workers share the harness config |
| codex | `~/.codex/config.toml` | `[mcp_servers.playwright]`; pair with `--dangerously-bypass-approvals-and-sandbox` for unattended use |
| agy | `~/.gemini/antigravity-cli/` (Antigravity's own config) | `agy mcp add playwright -- <command>`; NOT `~/.gemini/settings.json` — the fork ignores it (verified 2026-09-12) |
| devin | `~/.config/devin/mcp_config.json` (user scope) | `devin mcp add --scope user playwright -- <command>`; Devin's stdio MCP shape is `{command, args, env, cwd}` |
| opencode | `~/.config/opencode/opencode.jsonc` (user scope) | `mcp.playwright` flat-map entry, same pinned server |

The server runs headed by default and drives the installed Chrome stable binary, not a bundled Chromium. The persistent profile lives outside the repo under the user's PA home (default `~/.pa/browser-profile`), so signed-in sessions survive across runs.

Operating rules:

- **Print-mode tool timing.** In non-interactive (`-p` / `exec`) runs, MCP servers connect asynchronously: the first request round carries only built-in tools plus `WaitForMcpServers`, and browser tools join the toolset one to three rounds later. Any worker prompt that needs MCP tools must tell the model to call `WaitForMcpServers` first and not to fall back — models offered a "proceed without" path will bail and report the tools missing.

**Onboarding rule (2026-09-13):** any NEW worker type ships with the same MCP server definition as part of its config — browser automation in headless mode is standard equipment for every agent type, not a per-worker afterthought. The prompt-side awareness line (TASK_RULES/context blocks) is part of the same onboarding. **The full new-CLI checklist — bus provider identity (four surfaces that must agree), hook event wiring, dispatch config, MCP, brain parity — is `docs/cli-onboarding.md`.**

- **One profile, one browser.** Chrome locks the user-data-dir; concurrent browser sessions collide. Skills that use browser tools declare `exclusive_resource: browser-session` in frontmatter, and `pa run` serializes them. An ad-hoc dispatch that collides fails loudly with a profile-lock error — retry or report it.
- **PA launches Chrome for browser-session dispatches.** When `pa run` acquires the `browser-session` lock it starts the headed Chrome itself — `--remote-debugging-port=<browser.cdp_port>` (default 9222) on `$PA_HOME/browser-profile` — and injects `PLAYWRIGHT_MCP_CDP_ENDPOINT` into the worker environment. Playwright MCP inherits that env and attaches to the running Chrome instead of launching its own (the registration's `--user-data-dir` is ignored on a CDP attach — no re-registration). The env also carries `PA_BROWSER_CDP_PORT`, `VOICE_INBOX_PORT` and `PA_SCREENCAST_INGEST_TOKEN` so the worker can stream the live screen to the voice-inbox app. Interactive sessions (no PA env) still launch their own profile Chrome; PA's Chrome is reused when the port already answers and torn down PID-tree-only on lock release.
- **Operator take-over.** While a bridge streams the page, the operator can take it over in fullscreen — tap, type, scroll, navigate — from the voice-inbox live view; input is enabled only while the pane is fullscreen.
- **Sign-ins are manual and once.** The profile starts empty. The first time a site needs a login, the headed window opens on the operator's desktop and the operator signs in by hand; cookies then persist.
- **Never kill browsers by image name.** `taskkill /IM chrome.exe` takes down the operator's own browser. Kill only PIDs your own command spawned.
- **Anti-bot posture.** Headed real Chrome, a persistent profile, and a residential IP pass passive checks. Interactive challenges (CAPTCHA, Turnstile) stop the worker — it escalates to the operator. A site that keeps bouncing automation is a signal to find its API, not to add stealth patches.
- **jev-browser-wingman (optional step tool).** When the `wingman_do` and `wingman_check` tools are listed, a worker may hand one bounded step on the already-open page to them: pick a row, fill a form from values, click through a wizard. The tool attaches to the same Chrome over CDP, never navigates or opens tabs, falls back on sign-in, banking, mail and other sensitive pages, and returns `needs_confirmation` before any submit-like action. Playwright MCP stays the default and the fallback. Setup and the staged move of each CLI's Playwright registration onto the shared Chrome: `docs/pa-jev-browser-wingman.md`.

## Related docs

- [`CONFIGURATION.md`](CONFIGURATION.md) — `config.yaml` schema reference
- [`SKILLS_GUIDE.md`](SKILLS_GUIDE.md) — writing skills that use workers
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — `pa health` failure recovery
