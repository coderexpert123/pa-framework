import os
import sys
import json
from datetime import datetime, timezone, timedelta

# Add PA_HOME to path to import telegram_utils
pa_home = os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")
sys.path.insert(0, pa_home)

try:
    from telegram_utils import TelegramConfig, send_text
except ImportError:
    print("[Reminders] ERROR: telegram_utils.py not found in PA_HOME", file=sys.stderr)
    sys.exit(1)

REMINDERS_FILE = os.path.join(pa_home, "reminders.json")

def now_ist():
    # IST is UTC + 5:30
    return datetime.now(timezone(timedelta(hours=5, minutes=30)))

def process_reminders():
    if not os.path.exists(REMINDERS_FILE):
        return

    try:
        with open(REMINDERS_FILE, "r", encoding="utf-8") as f:
            reminders = json.load(f)
    except Exception as e:
        print(f"[Reminders] ERROR: Failed to read {REMINDERS_FILE}: {e}", file=sys.stderr)
        return

    if not reminders:
        return

    now = now_ist()
    due = []
    remaining = []

    for r in reminders:
        try:
            due_at = datetime.fromisoformat(r["due_at"])
            # Ensure due_at is offset-aware for comparison
            if due_at.tzinfo is None:
                due_at = due_at.replace(tzinfo=timezone(timedelta(hours=5, minutes=30)))
            
            if due_at <= now:
                due.append(r)
            else:
                remaining.append(r)
        except Exception as e:
            print(f"[Reminders] SKIP: Invalid due_at '{r.get('due_at')}': {e}", file=sys.stderr)
            remaining.append(r)

    if not due:
        return

    # Atomic-ish write back of remaining reminders
    try:
        with open(REMINDERS_FILE, "w", encoding="utf-8") as f:
            json.dump(remaining, f, indent=2)
    except Exception as e:
        print(f"[Reminders] ERROR: Failed to save remaining reminders: {e}", file=sys.stderr)
        return

    print(f"[Reminders] Processing {len(due)} due reminder(s)...")

    # Send each due reminder
    # Use the bot token from secrets.env
    secrets_path = os.path.join(pa_home, "secrets.env")
    token = None
    if os.path.exists(secrets_path):
        with open(secrets_path, "r") as f:
            for line in f:
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    token = line.split("=", 1)[1].strip()
                    break
    
    if not token:
        print("[Reminders] ERROR: TELEGRAM_BOT_TOKEN not found in secrets.env", file=sys.stderr)
        return

    for r in due:
        msg = r.get("message", "Reminder!")
        chat_id = r.get("chat_id")
        thread_id = r.get("thread_id")
        
        if not chat_id:
            print(f"[Reminders] WARN: Skipping reminder with no chat_id: {msg}")
            continue

        config = TelegramConfig(token=token, chat_ids=[str(chat_id)], thread_id=thread_id)
        # force=True to bypass dedup if the user set multiple identical reminders
        ok = send_text(config, f"â ° **Reminder:** {msg}", force=True)
        if ok:
            print(f"[Reminders] Sent: {msg}")
        else:
            print(f"[Reminders] FAILED to send: {msg}")

if __name__ == "__main__":
    process_reminders()
