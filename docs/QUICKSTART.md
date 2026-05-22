# pa-framework — Quickstart

> Goal: get a stranger from `git clone` to a running skill + Telegram delivery in ~30 minutes.

> **Before you start**: read [`docs/CONVENTIONS.md`](CONVENTIONS.md) for the file-placement rules so personal data doesn't accidentally land in a tracked location. For deployment patterns (simple fork vs dual-`.git`), see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

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
- **Optional**: a Google OAuth client (for the `daily-mail-brief` sample's Gmail access). See [`examples/oauth/README.md`](../examples/oauth/README.md) for the full setup walkthrough.

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

## 5. OAuth setup (if using Gmail-based skills)

If you'll run the `daily-mail-brief` sample or any other Gmail-using skill, set up Google OAuth now. Skip this section if you're not using Gmail/Drive/Docs.

Install Python deps:

```
pip install -r examples/oauth/requirements.txt
```

Copy the OAuth helpers to PA_HOME (where skills load them from):

```powershell
# PowerShell
Copy-Item examples/oauth/google_auth.py $HOME/.pa/google_auth.py
Copy-Item examples/oauth/reauth_google.py $HOME/.pa/reauth_google.py
```

```bash
# Bash / POSIX
cp examples/oauth/google_auth.py ~/.pa/google_auth.py
cp examples/oauth/reauth_google.py ~/.pa/reauth_google.py
```

Get your OAuth credentials JSON from Google Cloud Console — visit https://console.cloud.google.com → APIs & Services → Credentials → Create Credentials → OAuth Client ID → **Desktop app** → Download JSON → save as `~/.pa/google-credentials.json`. See [`examples/oauth/README.md`](../examples/oauth/README.md) for the full walkthrough (consent screen setup, scopes, troubleshooting).

Run the one-time auth flow:

```powershell
python ~/.pa/reauth_google.py
```

A browser window opens — sign in, approve scopes, and the token is written to `~/.pa/google-token.json`.

## 6. Configure workers

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

## 7. Register your first skill

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

## 8. Run it

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

## 9. Health check

```
node pa/dist/bin/pa.js health
```

Should report most checks as `PASS` or `WARN`. Failures come with actionable hints (see `docs/TROUBLESHOOTING.md`).

## 10. Start the Telegram bot

```powershell
# Foreground (logs to ~/.pa/logs/telegram-bot.log via the wrapper)
pwsh projects/telegram-bot/run-bot.ps1

# Bash equivalent
node projects/telegram-bot/dist/main.js >> ~/.pa/logs/telegram-bot.log 2>&1
```

Send your bot a message in Telegram — it responds via your highest-priority available worker. Use `/help` to see the bot's slash commands (defined in `projects/telegram-bot/src/commands.ts`).

To stop gracefully: `node pa/dist/bin/pa.js bot stop` (sets a sentinel file the bot polls).

To restart: `node pa/dist/bin/pa.js bot restart` (stop → Task Scheduler / your supervisor brings it back).

**Optional: auto-create canonical Telegram topics** — if your `TELEGRAM_CHAT_ID` points at a supergroup with forum topics enabled, the framework can auto-create a recommended set (`pa-alerts`, `pa-support`, `daily-briefings`, `claude-support`, etc.) so each skill has a natural destination:

```
node pa/dist/bin/pa.js bot setup-topics
```

Defaults to the first entry in `TELEGRAM_CHAT_ID`; pass `--chat-id <supergroup-id>` to override if your first entry is a DM (DMs don't have forum topics). Idempotent — safe to re-run; only creates missing topics. See [`docs/BOT_GUIDE.md`](BOT_GUIDE.md) for details and the template at `examples/topics-template.json`.

## 11. Schedule recurring runs

On Windows:

```
node pa/dist/bin/pa.js schedules sync
```

Registers `PA-Catchup` and `PA-Catchup-OnLogon` Windows Task Scheduler entries. The catchup task runs `pa catchup` every minute, which iterates overdue skills and fires them.

On Linux/macOS (until cross-platform scheduler ships): add to your crontab manually:

```
*/1 * * * * /usr/bin/env node /path/to/pa-framework/pa/dist/bin/pa.js catchup
```

## 12. Going further: deploying your own version

To set up your own deployment (your own private repo seeded with the framework, or a dual-`.git` setup if you contribute substrate fixes upstream), see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md). It documents two patterns:

- **Pattern A — Simple fork** (recommended for most users): one private repo containing the framework + your personal additions.
- **Pattern B — Dual-`.git`** (advanced): two `.git` directories in one working tree, for contributors who push substrate fixes back to the public framework.

## Next steps

- Read [`docs/SKILLS_GUIDE.md`](SKILLS_GUIDE.md) to write your own skills.
- Read [`docs/WORKERS_GUIDE.md`](WORKERS_GUIDE.md) to add new worker CLIs.
- Read [`docs/BOT_GUIDE.md`](BOT_GUIDE.md) for full Telegram setup.
- Read [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) to plan your own deployment (simple fork or dual-`.git`).
- Read [`docs/CONVENTIONS.md`](CONVENTIONS.md) for file-placement rules (where personal data goes vs where framework code goes).
- Read [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) if `pa health` shows failures.
