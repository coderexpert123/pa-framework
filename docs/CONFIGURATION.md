# Configuration Reference

> Audience: anyone configuring `~/.pa/config.yaml`, `~/.pa/secrets.env`, or PA_HOME overrides.

## Files & locations

The framework reads configuration from `~/.pa/` (or wherever `PA_HOME` env var points):

| Path | Purpose | Scaffolded by `pa init`? |
|---|---|---|
| `~/.pa/config.yaml` | Worker definitions, evaluator, topic routing, bg-task thresholds | Yes — see below |
| `~/.pa/secrets.env` | KEY=VALUE pairs injected as env vars at worker spawn time | Yes — empty |
| `~/.pa/skills/<name>/skill.md` | Skill definitions (YAML frontmatter + body) | No — user creates |
| `~/.pa/logs/<skill>/<timestamp>.json` | Per-run logs | Yes (dir created) |
| `~/.pa/skill-drafts/` | `pa learn` proposes new skills here | Yes (dir created) |
| `~/.pa/codex-skill-translations.json` | Skill-name patterns for codex `/skill` → `$skill` rewrite | Yes — defaults |
| `~/.pa/brain-files.json` | List of files for the `update-brain` sample skill | Yes — empty |
| `~/.pa/google-credentials.json` | Google OAuth client (user-provided) | No |
| `~/.pa/google-token.json` | Google OAuth refresh token (user-generated via reauth) | No |
| `~/.pa/google_auth.py` | Shared Python module for Google API access | No — user provides |
| `~/.pa/blackboard.json` | Runtime: resource lock state | Auto-managed |
| `~/.pa/app.log.jsonl` | Runtime: structured logs | Auto-managed |
| `~/.pa/conversation-history.jsonl` | Runtime: bot conversation archive | Auto-managed |
| `~/.pa/rate-limit-state.json` | Runtime: per-worker cooldown state | Auto-managed |
| `~/.pa/telegram-bot-state.json` | Runtime: bot global state (last update ID) | Auto-managed |
| `~/.pa/telegram-bot.lock` | Runtime: PID file for bot | Auto-managed |

## `config.yaml` schema

### Top-level

| Field | Type | Required | Default | Effect |
|---|---|---|---|---|
| `workers` | `WorkerConfig[]` | Yes | — | List of available worker CLIs. Empty = no workers (fatal). |
| `evaluator` | `EvaluatorConfig` | No | None | LLM consulted when a worker stalls. Without one, stalled workers are killed at idle_timeout. |
| `topic_defaults` | `Record<string, string>` | No | `{}` | Maps `<chatId>_<threadId>` strings to a preferred worker name. Used by the bot. |
| `bg_tasks` | `BgTasksConfig` | No | See below | Thresholds for background-leak detection. |

### `WorkerConfig`

| Field | Type | Required | Default | Effect |
|---|---|---|---|---|
| `name` | string | Yes | — | Unique identifier. Used in `--worker` flag, in `skill.frontmatter.worker`, and in `topic_defaults`. |
| `command` | string | Yes | — | Binary path. PATH-resolved or absolute. On Windows, `.cmd`/`.bat` works. |
| `args` | string[] | Yes | — | CLI arguments. For `input_mode: arg`, `{prompt}` and `{prompt_file}` are substituted. |
| `check` | string | Yes | — | Availability probe. Run via shell; exit 0 = available. |
| `check_timeout` | number (sec) | No | 30 | Max time for `check` to complete. |
| `rate_limit_patterns` | string[] | No | `[]` | Case-insensitive substrings searched in stdout+stderr. Match → cooldown. |
| `priority` | number | No | (array index + 1) | Lower wins on failover. |
| `state_dir` | string | No | undefined | Session-mode rate-limit dir. Tilde-expanded. |
| `state_pattern` | string | No | `*.jsonl` | Glob for tailing `state_dir`. |
| `input_mode` | `'arg' \| 'stdin-text' \| 'stdin-json'` | No | `'arg'` | How the prompt reaches the worker. |
| `output_format` | string | No | undefined | Informational (`'stream-json'` enables NDJSON parsing for session-id extraction). |

### `EvaluatorConfig`

| Field | Type | Required | Default | Effect |
|---|---|---|---|---|
| `worker` | string | Yes | — | Must match one of the `workers` `name` values. |
| `timeout` | number (sec) | No | 60 | Max time for the evaluator to decide. |

### `BgTasksConfig`

| Field | Type | Required | Default | Constraint | Effect |
|---|---|---|---|---|---|
| `alert_seconds` | number | No | 300 | >= 60 | Alert if a worker's descendant outlives parent by N seconds. |
| `alert_repeat_seconds` | number | No | 1800 | >= alert_seconds | Repeat the alert every N seconds. |

### Validation

- Missing `workers` array → `pa run` errors fatally.
- A worker missing `name`/`command`/`args`/`check` → load error with the missing field named.
- Non-integer or out-of-range `bg_tasks` values → warning, fall back to defaults (not fatal).
- Invalid `input_mode` → silently defaults to `'arg'` (be careful — typos here cause behavior breakage without errors).

## `secrets.env` consumed by framework

The framework itself reads these (independent of any specific skill):

| Variable | Required | Effect |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | For bot/notify | Used by the Telegram bot and `pa notify` |
| `TELEGRAM_CHAT_ID` | For notify default | Default destination for `pa notify` if `PA_ALERTS_CHAT_ID` unset |
| `PA_ALERTS_CHAT_ID` | No | Override notify destination |
| `PA_ALERTS_THREAD_ID` | No | Forum thread for notify destination (default 0) |
| `PA_USER_NAME` | No | Identity name in bot's system prompt (default "the user") |
| `PA_LOGS_DIR_HINT` | No | Logs path hint in bot's capabilities prompt |
| `PA_BRIEFS_DIR` | No | When set, adds briefs-path hint to bot's capabilities prompt |
| `BOT_CWD` | No | Bot's default working dir (default process.cwd()) |
| `CLAUDE_CMD` | No | Path to Claude CLI for LLM-based bot topic description generation |
| `PA_REPOS_BASE` | No | Base for `/code <short-name>` resolution in the bot |
| `PA_TZ_OFFSET_MINUTES` | No | IST offset override (default 330 = UTC+5:30) |
| `PA_GEMINI_RESET_TZ` | No | Gemini's daily quota reset timezone (default America/Los_Angeles) |
| `CLAUDE_CODE_GIT_BASH_PATH` | Win only | Claude Code CLI needs this on Windows |

All others are skill-specific — see individual skill files.

## `PA_HOME` env var

`PA_HOME` overrides the default `~/.pa` location. Useful for:

- **Testing**: set `PA_HOME=$tmpdir` for isolated test runs
- **Multi-instance**: run two pa installs side-by-side (e.g., personal + work)
- **Containers**: pin to `/var/lib/pa-state` or similar

When set, the framework derives all paths from `${PA_HOME}/` instead of `~/.pa/`. Subdirectory names (skills/, logs/, etc.) remain hardcoded.

## `pa init` defaults

Running `node pa/dist/bin/pa.js init` scaffolds:

- A minimal `config.yaml` with 4 default workers (zclaude, gemini, codex, claude) at standard PATH-resolved commands
- An empty `secrets.env` (you fill it in)
- The codex-skill-translations.json + brain-files.json (defaults)
- The `skills/`, `logs/`, `skill-drafts/` directories
- A "Next steps" message pointing at this doc and others

Re-running `pa init` is idempotent: it skips files that exist. Use it to add the new JSON files after upgrading.
