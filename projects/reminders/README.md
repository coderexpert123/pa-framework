# Natural Language Reminders

Scheduled and natural-language reminder system for `pa-framework`.

## Overview

The reminders system manages due reminders stored in `~/.pa/reminders.json` and automatically delivers alerts via Telegram using the central notification substrate.

## Architecture

1. **`add_reminder.py`**: Adds a new reminder with atomic write (`reminders.json.tmp` -> `os.replace`).
2. **`process_reminders.py`**: Evaluates due items against current timestamp, delivers via `telegram_utils`, and atomically prunes delivered items.
3. **Scheduler Integration**: Polled every minute via `pa catchup` or Task Scheduler (`PA-Catchup-Reminders` / cron `* * * * *`).

## CLI Usage

### Add a reminder
```bash
python projects/reminders/add_reminder.py <due_at_iso> <message> <chat_id> [thread_id]
```
- Example:
  ```bash
  python projects/reminders/add_reminder.py "2026-08-21T18:00:00+05:30" "Call doctor" "-1001234567890" 123
  ```

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
