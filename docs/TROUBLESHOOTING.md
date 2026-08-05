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

If still no lock file appears within 60 seconds, check `~/.pa/logs/telegram-bot.log` for errors (typically: missing `TELEGRAM_BOT_TOKEN`, worker command path wrong — check the `command:` field in config.yaml points at a real executable or wrapper script, etc.).

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

```bash
# macOS / Linux
mv ~/.pa/conversation-history.jsonl ~/.pa/archive/conv-$(date +%Y-%m-%d).jsonl
touch ~/.pa/conversation-history.jsonl
```

```powershell
# Windows PowerShell
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

### `last-catchup` WARN / FAIL — "stale > 30m / 2h"

Catchup hasn't run recently. Check which tasks are registered (cross-platform):

```
pa schedules list
```

Or check your platform's scheduler directly:

```powershell
# Windows
schtasks /query /tn PA-Catchup
```

```bash
# macOS / Linux
crontab -l | grep pa
```

> **Non-default `PA_HOME`?** The literal name `PA-Catchup` above is only correct when `PA_HOME` resolves to the default `~/.pa` (unset, or explicitly set to that same path). Any other resolved `PA_HOME` (see [`docs/CONFIGURATION.md`](CONFIGURATION.md#pa_home-env-var)) gets a task/cron entry suffixed with a short hash unique to that path instead — run `node pa/dist/bin/pa.js schedules list` to see the exact name your install actually registered, rather than assuming the plain literal.

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

The default `pa init` config lists 5 workers by name (zclaude, gemini, codex, claude, agy). If none are installed, `pa run` fails immediately.

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

## Voice-message transcription

### "No transcription engine is set up yet"

The default fresh-install case, and the one every new user hits first: no cloud API key is configured, and the local `transcription` package isn't installed either. The bot replies with the exact message:

> 🎙 I got your voice note, but no transcription engine is set up yet.
>
> Quickest fix, about a minute: get a free key at https://console.groq.com/keys, add
> `GROQ_API_KEY=<your key>` to `~/.pa/secrets.env`, then run `pa bot restart`. Voice notes
> then transcribe in a few seconds.
>
> Prefer fully offline? See docs/TROUBLESHOOTING.md, "No transcription engine is set up yet".

The 60-second fix:

1. Get a free key at https://console.groq.com/keys.
2. Add `GROQ_API_KEY=<your key>` to `~/.pa/secrets.env`.
3. Restart the bot: `pa bot restart`.

Fully offline instead (nothing leaves your machine, but slower and heavier): install the `transcription` Python package plus `ffmpeg` on PATH, then set `transcription: {engine_preference: local}` in `~/.pa/config.yaml`. Expect roughly a gigabyte of dependencies and minutes per voice note on CPU.

See [`BOT_GUIDE.md`](BOT_GUIDE.md#voice-messages-speech-to-text) for the full picture.

### "Local transcription needs ffmpeg"

Per-platform install:

```powershell
# Windows
choco install ffmpeg
```

```bash
# macOS
brew install ffmpeg

# Linux
apt install ffmpeg
```

The gotcha that matters here: the bot is started by Task Scheduler / systemd / launchd and **does not inherit an interactive shell's PATH**, so "it works in my terminal" is not sufficient — install machine-wide, or restart the supervisor after changing PATH.

The cloud engine needs no ffmpeg at all.

### "The transcription service rejected the API key"

Check the `*_API_KEY` line matching the provider you configured (`GROQ_API_KEY`, `OPENAI_API_KEY`, or `DEEPGRAM_API_KEY`) in `~/.pa/secrets.env`. Usual causes: mistyped, expired, or out of quota/billing. Fix it, then `pa bot restart`.

### "Voice notes suddenly got slow"

The non-obvious one. Under `engine_preference: auto`, a dead or exhausted cloud key falls back to local transcription — minutes instead of seconds — so the symptom is latency, not an error.

Diagnose by grepping `~/.pa/app.log.jsonl` for the `voice` component and a `fallback_from` field:

```powershell
Get-Content ~/.pa/app.log.jsonl | ConvertFrom-Json | Where-Object { $_.component -eq 'voice' -and $_.fallback_from }
```

```bash
grep '"component":"voice"' ~/.pa/app.log.jsonl | grep fallback_from
```

### "Transcribing that voice note took too long and was cancelled"

The 600-second timeout fired. Local transcription is slow because the speech model reloads on every note in `spawn` mode. Fixes, in order of effectiveness:

1. Set a cloud key (`GROQ_API_KEY` etc.) — seconds instead of minutes.
2. Switch to `transcription.worker_mode: persistent` in `~/.pa/config.yaml` — the model stays loaded between notes.
3. Send shorter notes.

Do **not** simply raise `PA_VOICE_TRANSCRIBE_TIMEOUT_MS` past 600000 — the bot's per-topic lock goes stale at exactly ten minutes, so a longer timeout lets a second voice note start transcribing concurrently.

### "The first voice note after a break is slow again"

Working as designed: persistent mode shuts down the local worker after `PA_VOICE_WORKER_IDLE_MS` (default 10 minutes) of idleness, so the next note after a gap pays the model-load cost again. Raise `PA_VOICE_WORKER_IDLE_MS` if you can spare the RAM — the trade-off is ~230 MB resident for longer.

### "The background transcriber won't start"

Inspect `~/.pa/voice-worker.json`. Then run the worker in the foreground to see the real error:

```
python pa/scripts/voice_worker.py
```

Two things you can't guess: a failed start **falls back to a one-off spawned process**, so the symptom is slowness rather than an error message, and `~/.pa/app.log.jsonl` records `fallback: persistent-unavailable` when that happens. A stale state file left by a hard kill is detected and replaced automatically — deleting it by hand is never required.

To stop the worker deliberately:

```bash
python -c "import json,socket,os;s=json.load(open(os.path.expanduser('~/.pa/voice-worker.json')));c=socket.create_connection(('127.0.0.1',s['port']),5);c.sendall((json.dumps({'op':'shutdown','token':s['token']})+'\n').encode());print(c.makefile().readline())"
```

### "Nothing happens at all when I send a voice note"

No 👍, no reply. Causes, in likelihood order:

1. **The bot is running old code** — rebuild, `pa bot restart`, and check the new PID's start time against `dist/`'s mtime (this repo's standing gotcha).
2. **The chat isn't listed in `TELEGRAM_CHAT_ID`.**
3. **The bot isn't running at all** — `pa health`.

Point at `~/.pa/app.log.jsonl` filtered to the `voice` component for whichever of the three it turns out to be.

### "This file is too large to transcribe"

The attachment (voice, audio, or video note) is larger than `PA_VOICE_MAX_FILE_BYTES` (default 20 MiB — Telegram's own bot-download ceiling), and is refused before any download happens. There's no way around this for a single attachment; split it or send a shorter clip.

### "`/retranscribe` doesn't seem to do anything"

`/retranscribe` (and `/retranscribe <engine>`, e.g. `/retranscribe groq`) must be sent as a **reply** to the voice/audio/video note you want redone — it has no effect on its own. If the original note's audio has aged out of the 30-day attachment cache, it's re-downloaded from Telegram automatically; if Telegram itself has since expired the file, the retry fails with the same error the original attempt would have hit.

### Non-English notes come out garbled or transliterated instead of erroring

You're on the local engine (`engine_preference: local`, or `auto` with no cloud key configured) — `small.en` is English-only and doesn't refuse non-English audio, it just does its best, which for another language is often a bad transliteration rather than a real transcript. This is expected, not a bug: set `transcription.language` in `~/.pa/config.yaml` and check `~/.pa/app.log.jsonl` for a config-load warning naming the mismatch, or switch to a cloud engine (`GROQ_API_KEY` etc.), which handles other languages properly.

### A multi-speaker note isn't labelled `Speaker 1: / Speaker 2: `

Speaker labelling only happens when **Deepgram** is the provider that actually transcribed the note (`cloud_order` includes `deepgram` and `DEEPGRAM_API_KEY` is set, and Deepgram was actually reached — not, say, Groq because it's earlier in `cloud_order`). Every other provider, and the local engine, always produce unlabelled single-block text, even for a note with multiple speakers.

## Cross-platform issues

### Platform capabilities

All commands are cross-platform. Per-platform backends:

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `pa schedules sync` | Windows Task Scheduler | crontab | crontab |
| Process tree / bgtasks | PowerShell + CIM | `ps`/`pgrep` | `ps`/`pgrep` |
| `/keepawake` | `SetThreadExecutionState` (PS helper) | `caffeinate -s` | `systemd-inhibit` |

> **Linux keepawake caveat:** requires systemd. On non-systemd distros `/keepawake` will fail to start; see "Unsupported OS" below.

### Unsupported OS (FreeBSD, Alpine, musl, other POSIX)

The framework is designed to tell you exactly what to change when something is missing on your OS. Every OS-specific feature either degrades gracefully or throws/warns with a precise adaptation pointer.

**Works natively on any POSIX-compliant system (no changes needed):**

| Component | How |
|-----------|-----|
| `run-bot.sh` launcher | Plain bash, no OS-specific calls |
| All skills, workers, Telegram bot | Pure Node.js / Python |
| `areProcessesAlive()` / `killProcessTree()` | Uses `process.kill(pid, 0)` / `process.kill(-pid, 'SIGTERM')` — POSIX signals, no subprocess |

**Needs `crontab` — self-describes if absent:**

`pa schedules sync` and `pa schedules list` use `crontab`. If not installed, `sync` throws:

```
pa schedules sync: crontab not found on this system. To add scheduling support,
implement a new branch in pa/src/scheduler.ts:syncSchedules() that registers
"pa catchup" on your platform's scheduler (systemd timers, fcron, launchd, etc.).
See syncSchedulesWindows() and syncSchedulesPosix() as reference implementations.
```

The two existing implementations in that file are complete references. The contract: register `pa catchup` and `pa catchup --topic reminders` to both run every minute, under a name derived from `scheduledTaskName()` (not a fixed literal — see the multi-instance note above and in `docs/CONFIGURATION.md`'s `PA_HOME` section) so a new scheduler backend doesn't reintroduce the collision the existing two implementations already fixed.

**Needs `pgrep` / `ps` — warns once if absent:**

`pa bgtasks` and orphan detection use `pgrep -P` (child PIDs) and `ps -eo pid,ppid` (full tree). On systems where these are missing, the framework emits one warning per process lifetime and returns empty results (non-fatal — bgtasks shows "no active workers" rather than crashing):

```
[pa/process-tree] pgrep not found. Child-process tracking disabled.
To add support for this system, implement the POSIX branch in
pa/src/process-tree.ts:getChildPids() using your platform's process-listing tool.
```

Adaptation point: `pa/src/process-tree.ts` — two functions: `getChildPids()` (immediate children) and `getDescendantPids()` (full subtree via BFS). Both have complete Windows and POSIX implementations in the same file.

**Needs `caffeinate` / `systemd-inhibit` — throws with exact instructions:**

`/keepawake` (bot sleep-prevention toggle) is the only feature with no universal POSIX fallback. On an unknown OS the toggle throws:

```
keepawake not supported on platform "<os>". To add support, implement a new branch
in projects/telegram-bot/src/keepawake.ts inside startKeepAwake(): spawn a background
process that prevents sleep and can be killed by PID (or process group if it forks).
```

The pattern is identical for every OS: spawn a sleep-inhibitor process, store its PID, kill it in `stopKeepAwake()`. If your tool forks children (as `systemd-inhibit` does), kill the process group (`process.kill(-pid, 'SIGTERM')`); if it's a single process (as `caffeinate` is), kill by PID. Both reference implementations are in the same file.

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
- [`BOT_GUIDE.md`](BOT_GUIDE.md#voice-messages-speech-to-text) — Voice messages (speech to text)
