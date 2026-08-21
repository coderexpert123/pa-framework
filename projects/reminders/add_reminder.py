import os
import sys
import json
from datetime import datetime, timezone, timedelta

pa_home = os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")
REMINDERS_FILE = os.path.join(pa_home, "reminders.json")

def add_reminder(due_at_iso, message, chat_id, thread_id=None):
    if not os.path.exists(REMINDERS_FILE):
        reminders = []
    else:
        try:
            with open(REMINDERS_FILE, "r", encoding="utf-8") as f:
                reminders = json.load(f)
        except:
            reminders = []

    # Basic ISO validation/normalization
    try:
        dt = datetime.fromisoformat(due_at_iso)
        # Ensure it has TZ info
        if dt.tzinfo is None:
            # Default to IST if none provided
            dt = dt.replace(tzinfo=timezone(timedelta(hours=5, minutes=30)))
        due_at_iso = dt.isoformat()
    except Exception as e:
        print(f"ERROR: Invalid ISO timestamp '{due_at_iso}': {e}", file=sys.stderr)
        sys.exit(1)

    new_reminder = {
        "due_at": due_at_iso,
        "message": message,
        "chat_id": chat_id,
        "thread_id": thread_id
    }

    reminders.append(new_reminder)

    # Atomic write: temp file + os.replace
    tmp_path = REMINDERS_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(reminders, f, indent=2)
    os.replace(tmp_path, REMINDERS_FILE)

    print(f"SUCCESS: Added reminder for {due_at_iso}: {message}")

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python add_reminder.py <due_at_iso> <message> <chat_id> [thread_id]", file=sys.stderr)
        sys.exit(1)

    due_at = sys.argv[1]
    msg = sys.argv[2]
    chat = sys.argv[3]
    thread = int(sys.argv[4]) if len(sys.argv) > 4 else None

    add_reminder(due_at, msg, chat, thread)
