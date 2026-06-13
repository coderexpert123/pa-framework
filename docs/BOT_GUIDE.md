# Telegram Bot Guide

> Audience: anyone setting up the Telegram bot for the first time, or operating it.

## Setting up the Telegram bot

### 1. Create the bot via @BotFather

1. Open Telegram, search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Pick a name (display name) and a username (must end in `bot`).
4. BotFather replies with the **bot token** — a string like `1234567890:ABCdef...`. **Save it** — this becomes `TELEGRAM_BOT_TOKEN`.

### 2. Find your chat ID

Two options:

**Private DM** (you message the bot directly):
1. Send `/start` to your new bot.
2. Open https://t.me/userinfobot and start chat. It tells you your numeric user ID.
3. That number = your `TELEGRAM_CHAT_ID`.

**Supergroup with forum topics enabled** (recommended for multi-topic routing):
1. Create a new group → upgrade to supergroup → enable Topics (group settings → Topics).
2. Add your bot as a member.
3. Promote the bot to admin (needed for forum_topic_created events and pinned messages).
4. Send a message in any topic, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
5. Look for `chat.id` in the response — it's a negative number starting with `-100`, e.g., `-1001234567890`.

For multi-chat use (e.g., bot operates in two separate groups), comma-separate:
```
TELEGRAM_CHAT_ID=1000000001,-1001234567890
```

### 3. Set the env vars

In `~/.pa/secrets.env`:

```
TELEGRAM_BOT_TOKEN=1234567890:ABCdef...
TELEGRAM_CHAT_ID=-1001234567890
```

For forum-topic routing, also set:

```
TELEGRAM_BRIEFING_CHAT_ID=-1001234567890
TELEGRAM_DAILY_BRIEFING_THREAD_ID=29
```

Restart the bot (`node pa/dist/bin/pa.js bot restart`).

## Optional: `/auth` for Google OAuth recovery

If you enable the Telegram/mobile Google auth flow, the bot also supports:

```text
/auth <code> <state>
```

The intended user path is:

1. A Google-backed project sends an authorization link to Telegram.
2. The user opens it, signs in, and lands on the deployed
   `projects/google-oauth-redirect/` bridge page.
3. That page renders a full `/auth ...` command and offers a copy button.
4. The user pastes the command into Telegram.
5. The bot exchanges the code and optionally triggers `~/.pa/oauth_resume_hook.py`.

See `examples/oauth/README.md` for the full setup.

## Bot lifecycle

### `pa bot stop` / `pa bot restart` / `pa bot rotate`

These three commands manage the bot:

- **`pa bot stop`** — writes a sentinel file at `~/.pa/telegram-bot.stop` that the bot's poll loop checks on each iteration. Within ~30 seconds, the bot finishes any in-flight work and exits gracefully. Lock file (`~/.pa/telegram-bot.lock`) is removed.
- **`pa bot restart`** — calls stop, then waits up to 90 seconds for the bot to be restarted by an external supervisor (Windows Task Scheduler / launchd / systemd / your own cron). Logs the new PID.
- **`pa bot rotate`** — rotates `~/.pa/logs/telegram-bot.log` if it's > 2 MB.

**There is no `pa bot start`.** The bot must be started by something external. Two common options:

#### Option A: Windows Task Scheduler

Register a task that runs the bot wrapper script every minute. The wrapper checks for the lock file; if absent, it starts the bot.

```powershell
# Register the task (one-time setup)
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-ExecutionPolicy Bypass -File "D:\path\to\projects\telegram-bot\run-bot.ps1"'
$trigger = New-ScheduledTaskTrigger -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName "PA-Telegram-Bot" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew)
```

#### Option B: systemd (Linux)

Create `~/.config/systemd/user/pa-telegram-bot.service`:

```ini
[Unit]
Description=PA Telegram Bot
After=network.target

[Service]
ExecStart=/bin/bash /path/to/projects/telegram-bot/run-bot.sh
Restart=always
RestartSec=30
Environment=PA_HOME=%h/.pa

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now pa-telegram-bot
journalctl --user -u pa-telegram-bot -f   # follow logs
```

#### Option C: launchd (macOS)

Create `~/Library/LaunchAgents/com.pa.telegram-bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pa.telegram-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/projects/telegram-bot/run-bot.sh</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PA_HOME</key><string>/Users/you/.pa</string></dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.pa.telegram-bot.plist
```

#### Option D: Foreground run / testing

```bash
pwsh projects/telegram-bot/run-bot.ps1          # Windows
bash projects/telegram-bot/run-bot.sh &         # POSIX (background)
node projects/telegram-bot/dist/main.js         # direct, foreground
```

## Recommended topic layout (conventional)

The framework doesn't auto-create Telegram topics — you create them in your supergroup. But the substrate code refers to several conventional topic names and roles. Here's the recommended layout for a full deployment:

| Topic name | Purpose | Configured via |
|---|---|---|
| `general` (thread 0) | Default catch-all — quick questions, conversations that don't fit elsewhere | `TELEGRAM_CHAT_ID` (the chat's General topic is thread 0) |
| `pa-alerts` | Automated framework alerts: worker failures, rate-limit events, bg-process leaks, evaluator parse errors | `PA_ALERTS_CHAT_ID` + `PA_ALERTS_THREAD_ID` env vars |
| `pa-support` | Manual debugging — pa CLI issues, scheduler problems, lock investigation, skill failures the user wants to discuss | `topic_defaults` map (route to claude/preferred worker) |
| `daily-briefings` | Scheduled informational output — daily mail brief, weekly reports, calendar alerts | `TELEGRAM_DAILY_BRIEFING_THREAD_ID` env var |
| `claude-support`, `zclaude-support`, `gemini-support`, `codex-support` (one per worker) | Debugging a specific worker — prompt engineering, API issues, worker-specific weirdness | `topic_defaults` map (each routes to that worker by default) |
| `feature-changes` | Discussion about implementing changes to the framework / bot / skills | `topic_defaults` (route to claude or zclaude) |
| `system-dashboard` | The pinned-message status card — bot creates + maintains this automatically | First message sent there triggers dashboard creation (`dashboard.ts`) |

### Option A: auto-create via `pa bot setup-topics` (recommended)

The framework ships a topic template at `examples/topics-template.json` and a setup command that creates the canonical topics for you.

```powershell
# Dry-run first — see what would be created (no API calls)
pa bot setup-topics --chat-id -100<your_supergroup_id> --dry-run

# Actually create them
pa bot setup-topics --chat-id -100<your_supergroup_id>
```

The command:
- Reads `examples/topics-template.json` (override with `--template <path>` for a custom layout)
- Skips topics that already exist in `~/.pa/telegram-topic-names.json` (idempotent — safe to re-run)
- Calls Telegram's `createForumTopic` API for new topics
- Records new thread IDs in the topic-names registry with names + descriptions
- Prints recommended `secrets.env` and `config.yaml` `topic_defaults` additions at the end — copy-paste these into your config

**Prerequisites:**
- Bot must be admin in the target supergroup (admin permission needed for `createForumTopic`)
- Supergroup must have forum topics enabled (group settings → Topics)
- `TELEGRAM_BOT_TOKEN` set in `~/.pa/secrets.env`

After creation, update `~/.pa/secrets.env` + `~/.pa/config.yaml` with the printed values, then `pa bot restart`.

### Option B: manual setup

In your Telegram supergroup (with topics enabled):

1. **Create each topic** via the Telegram client — long-press the chat → Manage Topics → Create Topic.
2. **Find the thread ID** of each — send a message to the topic, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`, find your message, note `message_thread_id` (a number).
3. **Add the IDs to `~/.pa/secrets.env`**:
   ```
   PA_ALERTS_CHAT_ID=-100<your_supergroup_id>
   PA_ALERTS_THREAD_ID=<pa-alerts thread id>
   TELEGRAM_DAILY_BRIEFING_THREAD_ID=<daily-briefings thread id>
   TELEGRAM_BRIEFING_CHAT_ID=-100<your_supergroup_id>
   ```
4. **Add `topic_defaults` entries** to `~/.pa/config.yaml` so each topic defaults to the right worker:
   ```yaml
   topic_defaults:
     "-100<group>_310": claude     # pa-support — use claude for framework debugging
     "-100<group>_298": claude     # claude-support — explicit claude
     "-100<group>_191": zclaude    # zclaude-support
     "-100<group>_29": gemini      # daily-briefings — gemini for summaries
     "-100<group>_2": zclaude      # feature-changes
   ```
5. **Restart the bot**: `pa bot restart`.

You don't need ALL these topics — `general` + `pa-alerts` is the minimum viable setup. The others are recommended for organizational hygiene when you have many skills running.

### Topic-name registry

The bot maintains a human-readable topic name registry at `~/.pa/telegram-topic-names.json`. Format:

```json
{
  "-100<group>": {
    "0":   { "name": "general",      "description": "..." },
    "310": { "name": "pa-support",   "description": "..." },
    "3376":{ "name": "pa-alerts",    "description": "..." }
  }
}
```

The bot writes to this file when topics are renamed (via Telegram `forum_topic_edited` events) and reads from it when assembling cross-topic context for the LLM. You can pre-populate it manually with descriptive names — the bot's prompts will say "Topic 310 (pa-support)" instead of "Topic 310".

### Ref-IDs

Every notable message in the system gets a 4-character ref ID with a single-letter prefix:

- `c-XXXX` — Claude conversation message
- `g-XXXX` — Gemini conversation message
- `l-XXXX` — Log entry (structured log line in `~/.pa/app.log.jsonl`)
- `z-XXXX` — zClaude message
- `s-XXXX` — Skill output (alert body, briefing artifact, etc.)

Ref-IDs appear in alert bodies as `_Ref: l-AB12_` (italicized). To resolve a ref-ID to its source: `pa ref l-AB12` (prints the originating message). Implementation: `pa/src/lib/ref-lookup.ts` (shared) and `projects/telegram-bot/src/ref-lookup.ts` (bot side).

## How the bot routes messages

1. **Long-poll** — calls Telegram's `getUpdates` with a 30-second timeout. Multiple updates can arrive in one batch.
2. **Parallel processing** — `Promise.all` handles the batch concurrently.
3. **Per-topic serialization** — each topic (`chat_id`+`thread_id`) is serialized via the blackboard lock. Two messages in the same topic are processed sequentially; messages in different topics run in parallel.
4. **Acknowledge** — the bot reacts to the user's message with 👍 immediately (`setMessageReaction`).
5. **Build prompt** — `src/context.ts:buildPrompt()` assembles identity + capabilities + conversation history + current message.
6. **Choose worker** — explicit `/model <name>` per-topic preference > `topic_defaults` map > priority order.
7. **Spawn worker** — via `pa/src/workers.ts:executeWorker()`.
8. **Clean output** — `src/logic.ts:parseMetadata()` strips `[PA_META]` envelopes, identifies confirmation patterns, applies sanitization for Telegram markdown.
9. **Send** — `src/telegram.ts:sendToTelegram()` with auto-chunking for >4000-char messages.
10. **Persist** — turn appended to `~/.pa/telegram-bot-topic-<ids>.json` (rolling 20-turn window) and `~/.pa/conversation-history.jsonl` (permanent archive).

## Per-topic state

Each `(chat_id, thread_id)` pair has its own state file at `~/.pa/telegram-bot-topic-<chatId>_<threadId>.json`:

```json
{
  "turns": [/* rolling 20-turn history */],
  "session": {"worker": "claude", "session_id": "..."},
  "cwd_override": "/home/me/code/myproject",
  "preferred_worker": "claude",
  "pending_action": "send email to alice@example.com"
}
```

- `turns`: rolling window of (user message, bot response) pairs
- `session.session_id`: lets the worker resume conversation context
- `cwd_override`: set via `/code <path>` — overrides the default `BOT_CWD`
- `preferred_worker`: set via `/model <name>` — pins this topic to one worker
- `pending_action`: set by `confirm_required` PA_META — user's next "yes"/"no" resolves

## Slash commands

Defined in `projects/telegram-bot/src/commands.ts`. Common ones:

- `/help` — list commands
- `/model <name>` — switch the topic to a specific worker
- `/auth <code> <state>` — complete the Telegram/mobile Google OAuth flow
- `/code <path>` — set the working directory for this topic
- `/code reset` — clear working-directory override
- `/branch <name>` — create a branched conversation (child topic in supergroups)
- `/keepawake` — toggle machine-wide sleep prevention (Windows: `SetThreadExecutionState` via PS; macOS: `caffeinate -s`; Linux: `systemd-inhibit`)
- `/deep-plan`, `/deep-recheck`, `/update-brain`, etc. — pass-through to corresponding pa skills

The pass-through list is defined in `~/.pa/codex-skill-translations.json` (shared with the codex worker's translation layer).

## Conversation archive + DLQ

### Archive (`~/.pa/conversation-history.jsonl`)

Every conversation turn is appended as a JSON line. This is the long-term log for skills like `ecosystem-kb` to read and synthesize.

Rotate when > 5 MB (`pa health` warns; manually archive to `~/.pa/archive/`).

### DLQ (`~/.pa/telegram-dlq.jsonl`)

If `sendToTelegram` fails (network error, Telegram API timeout, etc.), the unsent reply is appended to the DLQ. On the bot's next startup, `dlq.ts:flushDlq()` reads the DLQ sequentially and retries each entry.

This guarantees at-least-once delivery — if the bot crashes after a worker returns but before Telegram acks the send, the user still gets the reply on the next bot start.

## Sentinel-based graceful shutdown

The bot polls every iteration:

```ts
if (existsSync(sentinelPath)) {
  // graceful exit: finish in-flight work, save state, release lock
}
```

This is safer than `Stop-Process -Force` which would orphan workers and corrupt state files.

`pa bot stop` writes the sentinel; the bot deletes it on next startup.

## Lock file

`~/.pa/telegram-bot.lock` contains the running bot's PID. On startup, the bot:

1. Checks the lock file. If a valid PID is alive, refuses to start (prevents duplicate instances).
2. Otherwise, writes its own PID, deletes the stop-sentinel, starts the poll loop.

Manually clearing the lock (if the bot crashed without cleanup): `rm ~/.pa/telegram-bot.lock`.

## bot-instructions.md (static system prompt)

The file at `projects/telegram-bot/bot-instructions.md` (gitignored — each user customizes) is appended to claude/zclaude worker spawns via the `--append-system-prompt-file` CLI flag.

To activate it:

1. Copy from `examples/bot-instructions.example.md` to `projects/telegram-bot/bot-instructions.md`.
2. Customize for your identity, paths, and integrations.
3. Edit `~/.pa/config.yaml`: add `--append-system-prompt-file` + absolute path to your claude/zclaude worker's `args`.
4. Restart the bot.

For gemini and codex workers, the bot's `context.ts` constructs an equivalent prompt at runtime (no static file needed).

## Related docs

- [`CONFIGURATION.md`](CONFIGURATION.md) — `topic_defaults` mapping
- [`SKILLS_GUIDE.md`](SKILLS_GUIDE.md) — skills that deliver to Telegram via `telegram_output`
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — bot won't start, DLQ growing, etc.

## Google OAuth Setup

Some skills (like daily-mail-brief) require Google API access. To enable this via Telegram:

1.  **Deploy a Bridge Page**: Host projects/google-oauth-redirect/index.html on a public URL (e.g., GitHub Pages).
2.  **Configure Google Cloud**:
    *   Create a "Web application" OAuth client in the Google Cloud Console.
    *   Add your Bridge Page URL as a "Authorized redirect URI".
    *   Download the JSON and save it to ~/.pa/google-credentials-telegram.json.
3.  **Set Environment Variables**: In ~/.pa/secrets.env, set GOOGLE_AUTH_REDIRECT_URI to your Bridge Page URL.
4.  **Usage**: When a skill requires authentication, it will send a Google link to Telegram. After authorizing, you will be redirected to the Bridge Page, which provides an /auth command. Copy and paste that command back into the bot.

