---
cron: "* * * * *"
on_missed: latest
cwd: "~/.pa/skills/reminders"
secrets:
  - TELEGRAM_BOT_TOKEN
cmd: "python process_reminders.py"
---

Process due one-off reminders from `reminders.json` (in this skill's directory) and send them to Telegram.

Minimal example: every minute, run a Python script. The script reads
`reminders.json` from `cwd`, finds reminders whose trigger time has passed,
sends them via the Telegram bot HTTP API (using `TELEGRAM_BOT_TOKEN` from
secrets.env), and rewrites `reminders.json` without the sent ones.

`reminders.json` format (create this file in `cwd` before first run, or have
another skill/script write to it):

```json
[
  {
    "due_at": "2026-05-21T15:30:00+05:30",
    "message": "drink water",
    "chat_id": "-1001234567890",
    "thread_id": 0
  }
]
```

See `examples/skills/daily-mail-brief/skill.md` for a more advanced example
with telegram_output routing and LLM worker delegation. See
`examples/skills/update-brain/skill.md` for the full feature set
(worker override + no_fallback + atomic writes + git integration).
