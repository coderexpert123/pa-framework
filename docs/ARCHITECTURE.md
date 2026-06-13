# pa-framework — Architecture

> Audience: developers extending the framework or building skills on top of it.

## Five intelligence layers

The framework is structured so that each layer depends only on the ones below it:

| # | Layer | Where it lives | What it does |
|---|---|---|---|
| 5 | Communication | `projects/telegram-bot/` | Long-poll Telegram bot, forum-topic routing, conversation archive |
| 4 | Skill substrate | `~/.pa/skills/<name>/skill.md` | Markdown skills with YAML frontmatter; runtime dispatch |
| 3 | Orchestrator | `pa/src/{scheduler,blackboard,analyzer,drafts,lib/*}.ts` | Cron eval, locking, structured logs, alert dedup, learn pipeline |
| 2 | Worker pool | `pa/src/{workers,worker-exec,worker-evaluator,state-monitor,rate-limits-*}.ts` | CLI spawn, failover, rate-limit parsing, stuck-state evaluation |
| 1 | Auth substrate | `~/.pa/google_auth.py` + Telegram/mobile bridge helpers (see `examples/oauth/README.md`) | Shared Google OAuth for Gmail/Drive/Docs plus optional Telegram/mobile recovery |

Domain projects (e.g., `projects/daily-mail-brief/`) sit *above* layer 5; they use the bot for delivery, register skills in `~/.pa/skills/`, and call into the orchestrator via the `pa` CLI or `pa notify`.

## Telegram/mobile OAuth recovery

The framework also supports a mobile-friendly Google OAuth recovery loop:

1. A project detects expired Google credentials and launches
   `pa/scripts/start_google_telegram_reauth.py`.
2. That script generates a consent URL, stores pending state in
   `~/.pa/google-telegram-auth.json`, and sends the URL to Telegram.
3. Google redirects the user to `projects/google-oauth-redirect/`, a static
   page that renders `/auth <code> <state>`.
4. The user pastes that command into Telegram.
5. The bot's `/auth` handler runs `finish_google_telegram_reauth.py`, writes the
   refreshed token, and optionally invokes a private resume hook.

Public/private boundary:

- **Public substrate**: the bot `/auth` surface, pending auth-session format,
  start/finish scripts, static bridge page, and docs.
- **Private deployment**: OAuth client JSONs, token/state storage paths, and the
  action registry in `~/.pa/oauth_resume_hook.py`.

## Worker pool contract

Workers are external CLI processes spawned via `child_process.spawn`. Each is configured in `~/.pa/config.yaml`:

```yaml
workers:
  - name: zclaude          # unique identifier
    command: zclaude       # path or PATH-resolved binary
    args: ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", ...]
    check: zclaude --version  # availability probe
    check_timeout: 30         # seconds; default 30
    input_mode: stdin-json    # 'arg' | 'stdin-text' | 'stdin-json'
    output_format: stream-json # informational; "stream-json" = NDJSON
    rate_limit_patterns:       # substrings searched in stdout+stderr
      - "rate limit"
      - "429"
    priority: 1               # lower wins
    state_dir: "~/.claude/projects"  # for session-mode rate-limit detection
    state_pattern: "*.jsonl"  # glob for tailing state files
```

### Input modes

- **`arg`** (default): prompt is written to `${tmpdir()}/pa-prompt-<id>.txt`. `{prompt}` in `args` is substituted to `@<path>` (with `@` prefix); `{prompt_file}` to the bare path.
- **`stdin-text`**: prompt sent to worker's stdin as plain text.
- **`stdin-json`**: prompt sent to worker's stdin as a stream of JSON envelopes (one per line). Codex resume uses subcommand syntax — see `pa/src/worker-exec.ts`.

### Output expectations

- Exit code `0` = success.
- Stdout is captured; if `output_format: stream-json`, the framework parses NDJSON events for session-id capture and rate-limit signals.
- Stderr is scanned for `rate_limit_patterns`.

### Rate-limit signaling

Two modes:

1. **Text-pattern** (codex, gemini): substrings from `rate_limit_patterns` in stdout/stderr trigger cooldown.
2. **Session-mode** (claude, zclaude): the framework tails `state_dir/state_pattern` for `api_error` events with code 429 and parses cooldown duration.

Per-worker cooldowns are tracked in `~/.pa/rate-limit-state.json`. While a worker is in cooldown, the orchestrator skips it and tries the next-priority available worker.

### Process tree

The framework tracks descendant PIDs of spawned workers (`pa/src/process-tree.ts`) and kills the entire tree on idle-timeout or absolute-timeout. On Windows it uses PowerShell + CIM; on POSIX it uses `ps`/`pgrep`. Background-leak alerts fire when descendants outlive the parent.

### Adding a new worker

1. Add a new entry to `~/.pa/config.yaml` `workers:` array.
2. Choose `input_mode` and `output_format` that match the CLI's I/O contract.
3. Populate `rate_limit_patterns` with regex/substring matches from the CLI's actual error output.
4. Restart the bot so the config reloads.

For a hypothetical local Ollama integration:

```yaml
  - name: ollama
    command: ollama
    args: ["run", "llama3", "{prompt}"]
    check: ollama --version
    input_mode: arg
    rate_limit_patterns: []   # local model — no rate limits
    priority: 5
```

See `docs/WORKERS_GUIDE.md` for a more complete walkthrough.

## Skill YAML frontmatter schema

Skills live at `~/.pa/skills/<name>/skill.md`. The YAML frontmatter (between `---` markers) declares scheduling and execution behavior; the body is the prompt sent to the worker (or, with `cmd:`, ignored).

| Field | Type | Default | Effect |
|---|---|---|---|
| `cron` | string | — | Standard 5-field cron expression. Optional — if absent, skill is manual-trigger only. |
| `on_missed` | `'latest' \| 'all' \| 'skip'` | `'latest'` | Catchup behavior. `'all'` is capped at 10 missed runs. |
| `cwd` | string | — | Working directory for the worker process. `~` expands to homedir. `${VAR}` env-interpolated. |
| `secrets` | string[] | — | Env vars to inject into the worker process from `~/.pa/secrets.env`. |
| `timeout` | number (sec) | 3600 | Max total execution time. |
| `idle_timeout` | number (sec) | 300 | Max silence (no stdout) before kill. |
| `trigger_description` | string | — | LLM-readable description for skill chaining (`run_skill` PA_META action). |
| `inject_triggers` | boolean | false | If true, inject all other skills' `trigger_description`s into this skill's prompt. |
| `worker` | string | — | Force a specific worker (e.g., `gemini`) instead of priority-ordered failover. |
| `no_fallback` | boolean | false | When true with `worker:`, don't failover on failure. |
| `cmd` | string | — | Direct shell command (bypasses LLM). `${VAR}` env-interpolated. |
| `telegram_output` | object | — | Deliver LLM output to Telegram. See below. |

### `telegram_output`

```yaml
telegram_output:
  chat_id: '-1001234567890'             # destination chat; supports ${VAR} interpolation
  thread_id: 0                          # optional forum thread; supports ${VAR}
  token_secret: TELEGRAM_BOT_TOKEN      # env var name (NOT the token value)
```

When set, the framework posts the worker's final output to the specified Telegram destination. Env interpolation (`${VAR}`) is applied to `chat_id`, `thread_id`, and `token_secret`. Numeric strings are coerced back to Number for `thread_id`.

## PA_META envelope

A skill's worker (or the bot's LLM response) can emit a metadata envelope as the LAST line of its output:

```
[PA_META]: {"actions":[{"type":"...", ...}]}
```

Action types:

- **`retry_with_worker{reason}`** — worker declares it can't complete; orchestrator routes to the next-priority worker.
- **`run_skill{skill}`** — trigger another skill automatically after this one finishes.
- **`confirm_required`** — used by the bot in place of "Reply *yes* to confirm" text; the bot tracks pending confirmations per-topic.

The bot strips the envelope before delivering text to the user. In execution mode (`Pending Confirmation` set), the bot suppresses any `[PA_META]` the model emits.

## Blackboard & locking

`pa/src/blackboard.ts` manages a JSON file at `~/.pa/blackboard.json` containing PID + heartbeat-timestamp pairs per shared resource. Concurrent skill executions acquire/release locks via `proper-lockfile` on the JSON file itself.

Stale locks (heartbeat > 10 minutes old) are flagged by `pa health` and can be cleared via `pa purge-locks`. Each worker process refreshes its heartbeat periodically while running.

## Conversation archive + DLQ

- **Archive**: `~/.pa/conversation-history.jsonl` — append-only log of every bot turn (one JSON object per line). Read by the `ecosystem-kb`-style skills for KB synthesis.
- **Per-topic state**: `~/.pa/telegram-bot-topic-{chatId}_{threadId}.json` — rolling 20-turn window for the bot's context window.
- **DLQ**: `~/.pa/telegram-dlq.jsonl` — bot replies that failed to send are appended here. On bot startup, the DLQ is sequentially retried via `dlq.ts`.

## Ref-IDs

Every notable message in the system gets a 4-character ref ID with a single-letter prefix:

- `c-XXXX` — Claude conversation message
- `g-XXXX` — Gemini conversation message
- `l-XXXX` — Log entry
- `z-XXXX` — zClaude message
- `s-XXXX` — Skill output

The `pa ref <id>` command resolves any ref to its source. Used in alert bodies (`_Ref: l-AB12_`) so the user can `pa ref l-AB12` to drill into the originating message.

## Logging

Structured JSON logs at `~/.pa/app.log.jsonl`. Format:

```json
{"timestamp":"2026-05-21T18:30:00+05:30","level":"info","module":"workers","message":"failover","ctx":{"from":"zclaude","to":"gemini","reason":"rate-limit"}}
```

Use `pa logs <skill>` to read recent runs.

## Conventions

- **Timestamps**: IST by default (UTC+5:30). Override via `PA_TZ_OFFSET_MINUTES` env var. All log messages use ISO-8601 with the configured offset.
- **Atomic file writes**: Skills that update files should write to `<path>.tmp` then rename to ensure no partial writes if interrupted.
- **Git snapshots before destructive updates**: Skills modifying tracked files in a git repo should `git commit -am "pre-update snapshot"` before editing, then `git commit -am "<skill> auto-refresh"` after.
- **Gemini CLI cwd → project slug**: The Gemini CLI derives an on-disk slug at `~/.gemini/tmp/<slug>/chats/` from the cwd (lowercase + spaces → hyphens). `projects/telegram-bot/src/main.ts:GEMINI_PROJECT_DIR` must match. Changing cwd requires updating this constant in lockstep.
- **Marker-based content insertion**: Skills like `update-brain` use `<!-- AUTO:* -->` markers to identify auto-managed sections within manually-edited files. The skill validates markers exist post-update and refuses to write if any disappeared.
- **Line-count floor**: Stateful skills that rewrite files should refuse to write the new content if it's < 80% of the old size — a guard against accidental wipes.

See also: `docs/SKILLS_GUIDE.md`, `docs/WORKERS_GUIDE.md`, `docs/BOT_GUIDE.md`, `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md`.
