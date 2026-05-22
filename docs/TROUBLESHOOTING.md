# Troubleshooting

> Audience: anyone debugging a `pa health` failure or a stuck install.

## Quick diagnosis: run `pa health`

```
node pa/dist/bin/pa.js health
```

It runs 10 checks. Each one prints `PASS`, `WARN`, or `FAIL` with a short message. The improved messages (Phase 6 of the publication plan) include actionable remediation hints — read them carefully.

## Common failure modes

### `bot-process` FAIL — "no lock file"

The Telegram bot isn't running. Start it:

```powershell
node pa/dist/bin/pa.js bot restart   # if you have Task Scheduler / cron set up
# OR
pwsh projects/telegram-bot/run-bot.ps1   # to start manually
```

If still no lock file appears within 60 seconds, check `~/.pa/logs/telegram-bot.log` for errors (typically: missing `TELEGRAM_BOT_TOKEN`, gemini-shim path wrong, etc.).

### `bot-process` FAIL — "PID not alive"

The lock file references a PID, but that process is gone (crashed without cleanup).

```
node pa/dist/bin/pa.js bot restart
```

This writes a fresh lock and spawns a new bot via your supervisor.

### `blackboard` WARN/FAIL — "stale locks > 4h"

Workers died without releasing their locks. Reasons: SIGKILL by OS, system reboot, crash mid-execution.

```
node pa/dist/bin/pa.js purge-locks
```

If stale locks keep reappearing, grep `~/.pa/app.log.jsonl` for repeated crashes:

```powershell
Get-Content ~/.pa/app.log.jsonl | ConvertFrom-Json | Where-Object { $_.level -eq 'error' } | Select-Object -Last 20
```

### `conversation-log` FAIL — "> 5MB"

The bot's permanent archive at `~/.pa/conversation-history.jsonl` has grown. Archive it:

```powershell
Move-Item ~/.pa/conversation-history.jsonl ~/.pa/archive/conv-$(Get-Date -Format yyyy-MM-dd).jsonl
New-Item -ItemType File ~/.pa/conversation-history.jsonl
```

### `bot-log` FAIL — "> 5MB"

```
node pa/dist/bin/pa.js bot rotate
```

Or manually move `~/.pa/logs/telegram-bot.log` to `~/.pa/archive/`.

### `workers` FAIL — "all unavailable"

None of your configured workers passed their `check`. Causes:

1. **Worker CLI not installed** — install at least one (Claude Code, gemini-cli, openai-codex).
2. **`command` path wrong** in `~/.pa/config.yaml` — see [`WORKERS_GUIDE.md`](WORKERS_GUIDE.md).
3. **All workers cooling** (rate-limited) — wait, or `rm ~/.pa/rate-limit-state.json` to clear cooldowns (only if you're certain they're stale).
4. **PATH issue** — if commands work in a fresh shell but `pa workers` reports unavailable, the bot's environment may not include the right PATH. Set `command` to an absolute path.

### `workers` WARN — "X cooling"

A worker is in rate-limit cooldown. Other workers should pick up. If you specifically need that worker (e.g., it's the only one with grounded search), wait or use `--worker <other>` on individual `pa run` calls.

### `skills` FAIL — "parse error: <name>"

A skill's YAML frontmatter is malformed. Read the parse error message — it usually pinpoints the line.

Common YAML mistakes:
- Indentation (YAML is whitespace-sensitive; use 2 spaces, no tabs)
- Unquoted strings containing `:` or `#` (must be quoted: `chat_id: '-1001234567890'`)
- Boolean strings (`true`/`false` vs `'true'`/`'false'`)
- Comments after `---` markers (allowed inside the YAML block, not on the marker line)

Verify with a YAML linter (e.g., `yamllint`).

### `secrets` FAIL — "missing: <key>"

Required env vars are not in `~/.pa/secrets.env`. The framework currently considers `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` required.

Add the missing keys. See [`CONFIGURATION.md`](CONFIGURATION.md) for the full list.

### `last-catchup` FAIL — "no run logs found"

No skill has ever run. Either:

1. You just installed (normal) — try `pa run reminders` to confirm execution works.
2. The catchup task isn't firing automatically — register Windows Task Scheduler / crontab. See [`QUICKSTART.md`](QUICKSTART.md) §11 "Schedule recurring runs".

### `last-catchup` WARN — "stale > 2h"

Catchup hasn't run in over 2 hours. Check the supervisor (Task Scheduler / cron):

```powershell
# Windows
schtasks /query /tn PA-Catchup
```

If the task disappeared, re-register: `node pa/dist/bin/pa.js schedules sync`.

### `disk-logs` FAIL — "> 500MB"

`~/.pa/logs/` has accumulated. Bulk-archive old skill logs:

```powershell
Get-ChildItem ~/.pa/logs -Recurse -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Move-Item -Destination ~/.pa/archive/
```

## Fresh-install gotchas

A new user running `pa init` then trying to use the framework typically hits:

### "What API keys?"

The init message points at this doc and `examples/secrets.env.example`. Read those — they list every supported env var with descriptions.

### "No skills found"

`pa init` doesn't pre-install any skills. Copy from `examples/skills/`:

```powershell
# PowerShell
Copy-Item -Recurse examples/skills/reminders ~/.pa/skills/

# Bash
cp -r examples/skills/reminders ~/.pa/skills/
```

Then `pa list` will show it.

### "Worker 'zclaude' check failed or script missing"

The default `pa init` config lists 4 workers by name (zclaude, claude, gemini, codex). If none are installed, `pa run` fails immediately.

Fix: install at least one of:
- Claude Code: [installation guide](https://github.com/anthropics/claude-code)
- Gemini CLI: [installation guide](https://github.com/google-gemini/gemini-cli)
- OpenAI Codex: [installation guide](https://github.com/openai/codex)

Then verify with `pa workers`. Adjust `command` paths in `~/.pa/config.yaml` if needed.

### "Bot won't start" (no log appears, no lock file)

Most common cause: the bot's foreground process crashed immediately due to a missing env var or build artifact.

Diagnose:
```powershell
node projects/telegram-bot/dist/main.js
```

Run in foreground. If it crashes, the stderr tells you what's missing. Typical: `TELEGRAM_BOT_TOKEN not set` or `Cannot find module './workers.js'` (the latter means `pa/dist/` doesn't exist — rebuild pa first).

### "Bot sends messages to wrong chat"

`TELEGRAM_CHAT_ID` is the default destination. Verify it matches the chat where you want the bot to operate:

```powershell
# Re-fetch chat_id from a recent message:
curl "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getUpdates" | jq '.result[-1].message.chat'
```

### "Telegram messages are stripped/malformed"

The bot strips `[PA_META]` envelopes before sending. If your skill's intended Telegram-bound output contains `[PA_META]` as literal text (not as a meta action), the framework will eat it.

Workaround: emit the literal text outside the `[PA_META]` envelope position (anywhere except the LAST line of output).

## Cross-platform issues

### Windows-only features

These don't work on Linux/macOS:

- `pa schedules sync` — uses Windows Task Scheduler
- `pa/src/process-tree.ts` — uses PowerShell + WMI for descendant PID discovery
- `pa/src/commands/bgtasks.ts` — depends on process-tree
- `bg-leak alerts` — needs descendant-PID introspection

POSIX workarounds:
- Schedule `pa catchup` via crontab manually
- BG-leak detection is silently disabled
- Other commands (`pa run`, `pa list`, `pa health` partial) work fine

Full cross-platform support is on the roadmap.

### Path separators

The framework normalizes `/` and `\` internally. User-facing config (`config.yaml`, `secrets.env`) accepts both. But:

- Cron expressions: always use Unix `* * * * *` syntax (no Windows variants)
- File paths in `cmd:` and `cwd:`: prefer `/` (forward slash) — works on both Windows and POSIX

### Line endings

Tracked files use LF line endings. Git may warn `LF will be replaced by CRLF` on Windows checkout — this is fine, just `core.autocrlf` behavior.

`.git-public/` has `core.autocrlf false` to prevent line-ending churn in the public mirror.

## Related docs

- [`QUICKSTART.md`](QUICKSTART.md) — initial setup
- [`CONFIGURATION.md`](CONFIGURATION.md) — config reference
- [`SKILLS_GUIDE.md`](SKILLS_GUIDE.md) — skill authoring
- [`WORKERS_GUIDE.md`](WORKERS_GUIDE.md) — worker setup
- [`BOT_GUIDE.md`](BOT_GUIDE.md) — Telegram bot operation
