# Natural Language Reminders

Scheduled and natural-language reminder system for `pa-framework`.

## Overview

The reminders system manages due reminders stored in `~/.pa/reminders.json` and automatically delivers alerts via Telegram using the central notification substrate.

## Architecture

1. **`add_reminder.py`**: Adds a new reminder with atomic write (`reminders.json.tmp` -> `os.replace`).
2. **`process_reminders.py`**: Evaluates due items against current timestamp, deletes them from `reminders.json` first, then delivers each one through the shared `pa/src/telegram_notify.py` sender (`send_text`). Every reminder now carries a ref-ID and a **Done / 1 h / Tomorrow** keyboard, and one failed send no longer blocks the rest of the batch.
3. **Scheduler Integration**: Polled every minute via `pa catchup` or Task Scheduler (`PA-Catchup-Reminders` / cron `* * * * *`).

## Buttons

Each delivered reminder carries three inline buttons:

- **Done** — acknowledges the reminder; nothing is re-created, since the due entry is already gone.
- **1 h** — re-adds the same message one hour from now.
- **Tomorrow** — re-adds the same message at 9 AM the next day.

A tap re-creates the reminder through the unchanged `add_reminder.py` atomic writer above, so a snoozed reminder is just a new entry in `reminders.json`.

## CLI Usage

### Add a reminder
```bash
python projects/reminders/add_reminder.py <due_at_iso> <message> <chat_id> [thread_id] [--resume-action-json <json>]
```
- Example:
  ```bash
  python projects/reminders/add_reminder.py "2026-08-21T18:00:00+05:30" "Call doctor" "-1001234567890" 123
  ```

### Add an executable reminder (AI-185)
```bash
python projects/reminders/add_reminder.py <due_at_iso> <message> <chat_id> [thread_id] \
  --resume-action-json '{"type": "topic_resume", "prompt": "<single-line instruction>"}'
```
The prompt is validated at mint time (closed `topic_resume` shape: exactly the keys `type` + `prompt`; single line, <=500 chars, must not start with `/`) and stored on the record as `resume_action`; `message` remains the human label. At fire time the payload is appended to `~/.pa/pending-reminder-resume.json` for the bot's `reminder-resume-drain` job to inject as a system turn, and the operator receives a `⏰ *Reminder (dispatched to worker):*` notice with **no** inline keyboard (snoozing after the prompt is queued would be misleading). If the queue append fails, delivery is never lost: the reminder falls back to the plain text send with the Done / 1 h / Tomorrow keyboard.

### Process due reminders
```bash
python projects/reminders/process_reminders.py
```

## Storage Schema (`~/.pa/reminders.json`)
```json
[
  {
    "due_at": "2026-08-21T18:00:00+05:30",
    "message": "Call doctor",
    "chat_id": "-1001234567890",
    "thread_id": 123
  }
]
```
