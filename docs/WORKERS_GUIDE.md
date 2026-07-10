# Workers Guide

> Audience: anyone adding a new worker CLI to the framework or debugging worker failures.

## The worker contract

A "worker" is an external CLI process that the framework spawns to handle an LLM task. The framework expects:

| What | Details |
|---|---|
| **Stdin** | Receives prompt as text or NDJSON, depending on `input_mode` |
| **Args** | Receives arguments per `WorkerConfig.args`, with `{prompt}` and `{prompt_file}` substituted |
| **Stdout** | Plain text OR NDJSON events (when `output_format: stream-json`) |
| **Stderr** | Used for rate-limit pattern matching and error diagnostics |
| **Exit code** | 0 = success, non-zero = failure (logged + alerted) |
| **Process tree** | Children should die when parent dies — framework SIGKILLs the tree on timeout |

## Built-in workers

| Worker | input_mode | output_format | Rate-limit detection | Notes |
|---|---|---|---|---|
| `zclaude` | `stdin-json` | `stream-json` | Session-mode | Claude wrapper with extra features |
| `claude` | `stdin-json` | `stream-json` | Session-mode | Anthropic's Claude Code CLI |
| `gemini` | `stdin-text` | `stream-json` | Text-pattern (RESOURCE_EXHAUSTED, 429) | Google Gemini CLI |
| `codex` | `stdin-text` | `stream-json` | Text-pattern (`hit your usage limit`) | OpenAI Codex CLI |

## Wrapper scripts

A worker's `command:` field is spawned verbatim — `worker-exec.ts` does no name-based rewriting or magic path resolution (removed 2026-07-10; see `pa/tests/worker-exec-command.test.ts`). If your CLI needs something the framework doesn't do for you, point `command:` at a small wrapper script instead of the bare CLI binary. Common reasons:

- **Env vars** the CLI needs set before it runs (e.g. a cloud project ID, an API base URL).
- **Token refresh** — some CLIs need a credential refreshed before each invocation.
- **Arg-quoting fixes** — a CLI that mishandles how `worker-exec.ts` passes arguments through `shell:true`.

Minimal example, `gemini-wrapper.cmd` (Windows):

```bat
@echo off
set GOOGLE_CLOUD_PROJECT=your-project-id
gemini %*
```

Minimal example, `gemini-wrapper.sh` (POSIX):

```sh
#!/bin/sh
export GOOGLE_CLOUD_PROJECT=your-project-id
exec gemini "$@"
```

Point the worker's `command:` at the wrapper's absolute path in `config.yaml`, e.g. `command: C:/Users/you/gemini-wrapper.cmd` or `command: ~/.local/bin/gemini-wrapper.sh`. Since `worker-exec.ts` spawns `command:` verbatim, this works for any worker without any framework changes.

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
3. If all candidates exhausted → return error, `pa notify` an "all workers failed" alert.

`no_fallback: true` on the skill disables steps 3 — once the preferred worker fails, the skill errors immediately.

## Evaluator's role

When a worker stalls (no stdout for `idle_timeout` seconds), the framework can ask another worker (the "evaluator") to decide what to do. The evaluator is fed:

- The stalled worker's prompt
- The stalled worker's stdout so far
- The elapsed idle time

It returns a JSON envelope:

```json
{"action": "extend", "additional_seconds": 60}
{"action": "kill", "reason": "infinite loop"}
{"action": "failover", "reason": "task exceeds context window"}
```

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
| claude, zclaude | `~/.claude/projects/<cwd-slug>/<session>.jsonl` | NDJSON |
| gemini | `~/.gemini/tmp/<project-slug>/chats/session-*.json` | Single JSON |
| codex | `~/.codex/state_5.sqlite` | SQLite (use `sqlite3` to inspect) |

The `<cwd-slug>` for Claude is the cwd with `:`, `\`, `/`, spaces replaced with `-`. E.g., `D:\My Project` → `D--My-Project`.

The `<project-slug>` for Gemini is the cwd lowercased with spaces → hyphens. E.g., `D:/My Project` → `my-project`.

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

## Cross-worker context

The framework doesn't share context across workers — each spawn is independent. If a skill needs context preserved across runs, store it in a JSON file in `cwd`.

For the Telegram bot, per-topic conversation state is maintained in `~/.pa/telegram-bot-topic-<chatId>_<threadId>.json` and replayed on each new message.

## Codex translation layer

Codex's `/skill-name` slash-command syntax conflicts with pa's natural prompt syntax. The framework rewrites `/skill-name` to `$skill-name` before passing to codex.

The list of recognized skill names lives in `~/.pa/codex-skill-translations.json` (scaffolded by `pa init`). Modify it to add custom skills you want auto-translated.

The same list is also used by the bot's `PASS_THROUGH_PATTERN` in `projects/telegram-bot/src/logic.ts` to recognize commands that should not be routed to LLMs (e.g., `/deep-plan` should reach the deep-plan skill, not be interpreted as bot conversation).

## Related docs

- [`CONFIGURATION.md`](CONFIGURATION.md) — `config.yaml` schema reference
- [`SKILLS_GUIDE.md`](SKILLS_GUIDE.md) — writing skills that use workers
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — `pa health` failure recovery
