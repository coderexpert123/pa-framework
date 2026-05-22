# pa-framework — Quickstart

> Goal: get a stranger from `git clone` to a running skill + Telegram delivery in ~30 minutes.

## 1. Prerequisites

- **Node.js 22+** (the framework uses ES modules with Node native test runner).
- **Python 3.11+** (only if you'll use Python-based skills like the sample `daily-mail-brief`).
- **PowerShell 7+** on Windows (or any POSIX shell on Linux/macOS — needed for `&&` chaining, `Remove-Item`/`Join-Path` cmdlets in our scripts).
- **At least one LLM CLI** in your PATH:
  - [Claude Code](https://github.com/anthropics/claude-code) (`claude`)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)
  - [OpenAI Codex](https://github.com/openai/codex) (`codex`)
  - Or a Claude alternative like zClaude.
- **Optional**: a Telegram bot (created via [@BotFather](https://t.me/BotFather)) + the chat ID where you want it to operate. See `docs/BOT_GUIDE.md`.
- **Optional**: a Google OAuth client (for the `daily-mail-brief` sample's Gmail access). See `examples/secrets.env.example` for the env vars expected.

## 2. Build

```powershell
git clone https://github.com/coderexpert123/pa-framework.git
cd pa-framework

# pa orchestrator
cd pa
npm install
npm run build
cd ..

# telegram bot
cd projects/telegram-bot
npm install
npm run build
cd ../..
```

Both should compile with zero errors. If TypeScript errors fire, you likely have a Node version mismatch — verify with `node --version`.

## 3. Initialize `~/.pa/`

```powershell
node pa/dist/bin/pa.js init
```

This scaffolds:

- `~/.pa/config.yaml` — worker definitions (4 default workers; you'll customize paths)
- `~/.pa/secrets.env` — empty env-var file
- `~/.pa/skills/`, `~/.pa/logs/`, `~/.pa/skill-drafts/` — runtime directories
- `~/.pa/codex-skill-translations.json` — codex `/skill` → `$skill` translation patterns
- `~/.pa/brain-files.json` — opt-in config for the `update-brain` sample skill

It prints a "Next steps" block at the end with specific docs to read.

## 4. Configure secrets

Edit `~/.pa/secrets.env`. **At minimum**, set:

```
TELEGRAM_BOT_TOKEN=<your bot token from @BotFather>
TELEGRAM_CHAT_ID=<your chat ID — see docs/BOT_GUIDE.md to find it>
```

For the `daily-mail-brief` sample, additionally:

```
PA_FRAMEWORK_ROOT=/path/to/your/pa-framework/clone   # absolute path; used by ${VAR} interpolation in example skills
OBSIDIAN_BRIEFS_DIR=/path/to/your/obsidian/Mail Briefs  # optional; if unset, archival is skipped
```

For optional personalization of the bot's prompt:

```
PA_USER_NAME=YourName                                 # default: "the user"
PA_LOGS_DIR_HINT=~/.pa/logs/<skill>/                  # logs path shown to the LLM
PA_BRIEFS_DIR=/path/to/notes/Mail Briefs              # only set if you want the briefs hint visible
PA_ALERTS_CHAT_ID=<chat ID for failure alerts>        # defaults to TELEGRAM_CHAT_ID's first entry
PA_ALERTS_THREAD_ID=<forum thread ID, or 0 for general>
```

See `examples/secrets.env.example` for the full annotated list.

## 5. Configure workers

Edit `~/.pa/config.yaml`. The default scaffolded config assumes your worker CLIs are in PATH. If yours are at custom paths (common on Windows), adjust the `command` field:

```yaml
workers:
  - name: claude
    command: C:/Users/you/AppData/Roaming/npm/claude.cmd  # Windows example
    # OR: command: /usr/local/bin/claude                   # POSIX example
    args: ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", ...]
    ...
```

Full schema in `docs/CONFIGURATION.md`. Annotated example in `examples/config.yaml.example`.

## 6. Register your first skill

Copy the minimal sample:

```powershell
# PowerShell
Copy-Item -Recurse examples/skills/reminders ~/.pa/skills/

# Bash
cp -r examples/skills/reminders ~/.pa/skills/
```

Verify it loads:

```
node pa/dist/bin/pa.js list
```

You should see `reminders` listed with cron `* * * * *`.

## 7. Run it

Dry-run:

```
node pa/dist/bin/pa.js run reminders
```

If `~/.pa/skills/reminders/reminders.json` is empty or missing, the script exits cleanly (no due reminders). Add a test reminder:

```json
[
  {
    "due_at": "2026-05-21T00:00:00Z",
    "message": "test reminder from pa-framework",
    "chat_id": "<your TELEGRAM_CHAT_ID>"
  }
]
```

Save as `~/.pa/skills/reminders/reminders.json`. Run again — you should see a Telegram message.

## 8. Health check

```
node pa/dist/bin/pa.js health
```

Should report most checks as `PASS` or `WARN`. Failures come with actionable hints (see `docs/TROUBLESHOOTING.md`).

## 9. Start the Telegram bot

```powershell
# Foreground (logs to ~/.pa/logs/telegram-bot.log via the wrapper)
pwsh projects/telegram-bot/run-bot.ps1

# Bash equivalent
node projects/telegram-bot/dist/main.js >> ~/.pa/logs/telegram-bot.log 2>&1
```

Send your bot a message in Telegram — it responds via your highest-priority available worker. Use `/help` to see the bot's slash commands (defined in `projects/telegram-bot/src/commands.ts`).

To stop gracefully: `node pa/dist/bin/pa.js bot stop` (sets a sentinel file the bot polls).

To restart: `node pa/dist/bin/pa.js bot restart` (stop → Task Scheduler / your supervisor brings it back).

## 10. Schedule recurring runs

On Windows:

```
node pa/dist/bin/pa.js schedules sync
```

Registers `PA-Catchup` and `PA-Catchup-OnLogon` Windows Task Scheduler entries. The catchup task runs `pa catchup` every minute, which iterates overdue skills and fires them.

On Linux/macOS (until cross-platform scheduler ships): add to your crontab manually:

```
*/1 * * * * /usr/bin/env node /path/to/pa-framework/pa/dist/bin/pa.js catchup
```

## 11. Sync framework changes to public repo (maintainer-only)

If you've forked this repo and made improvements you want to publish back to your own public mirror, follow the dual-`.git`-directory pattern documented in the framework's [plan](https://github.com/coderexpert123/pa-framework/blob/main/docs/ARCHITECTURE.md):

```powershell
git-public status
git-public add <files>
git-public commit -m "..."
git-public push
```

This is for the substrate maintainer only — regular users contribute via PRs.

## Next steps

- Read [`docs/SKILLS_GUIDE.md`](SKILLS_GUIDE.md) to write your own skills.
- Read [`docs/WORKERS_GUIDE.md`](WORKERS_GUIDE.md) to add new worker CLIs.
- Read [`docs/BOT_GUIDE.md`](BOT_GUIDE.md) for full Telegram setup.
- Read [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) if `pa health` shows failures.
