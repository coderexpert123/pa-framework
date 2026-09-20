"""
Process due reminders from reminders.json in this script's directory.

Each reminder: {"due_at": "<ISO8601>", "message": "...", "chat_id": "...", "thread_id": <int|null>}

Reads TELEGRAM_BOT_TOKEN from env (injected by the skill's `secrets:` declaration).
Uses urllib (Python stdlib) so no `pip install` is required.
Delivery floor (D4): when the token is absent the script does not fail — it
prints a loud WARN and delivers each due reminder to the local outbox
(`$PA_HOME/outbox/`) instead, so an install with no Telegram still completes.
The framework's full reminder engine (projects/reminders in the pa-framework repo) adds conditional keyboards, executable resume dispatch, and ref-ID minting on top of this minimal sample.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
import urllib.request
import urllib.parse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REMINDERS_FILE = os.path.join(SCRIPT_DIR, "reminders.json")
OUTBOX_DIR = os.path.join(os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa"), "outbox")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")


def send(chat_id: str, thread_id, text: str) -> bool:
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    payload = {"chat_id": str(chat_id), "text": text}
    if thread_id is not None and thread_id != 0:
        payload["message_thread_id"] = thread_id
    data = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception as e:
        print(f"[reminders] send failed: {e}", file=sys.stderr)
        return False


def deliver(chat_id: str, thread_id, text: str) -> None:
    if TOKEN:
        ok = send(chat_id, thread_id, text)
        print(f"[reminders] {'sent' if ok else 'FAILED'}: {text}")
        return
    # D4 delivery floor: no Telegram configured — loud WARN, then the local
    # outbox file is the delivery surface. Never a silent drop, never a crash.
    print("[reminders] WARN: TELEGRAM_BOT_TOKEN not set — delivering to the local outbox instead", file=sys.stderr)
    os.makedirs(OUTBOX_DIR, exist_ok=True)
    path = os.path.join(OUTBOX_DIR, f"reminder-{int(time.time() * 1000)}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"[reminders] delivered to outbox: {path}")


def main() -> None:
    if not os.path.exists(REMINDERS_FILE):
        return  # nothing scheduled
    with open(REMINDERS_FILE, encoding="utf-8") as f:
        reminders = json.load(f)
    if not isinstance(reminders, list) or not reminders:
        return

    now = datetime.now(timezone.utc)
    due, remaining = [], []
    for r in reminders:
        try:
            due_at = datetime.fromisoformat(r["due_at"])
            if due_at.tzinfo is None:
                due_at = due_at.replace(tzinfo=timezone.utc)
            (due if due_at <= now else remaining).append(r)
        except Exception as e:
            print(f"[reminders] skipping malformed entry: {e}", file=sys.stderr)
            remaining.append(r)

    if not due:
        return

    # Persist the remaining reminders BEFORE sending — atomic-ish via .tmp + rename.
    tmp = REMINDERS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(remaining, f, indent=2)
    os.replace(tmp, REMINDERS_FILE)

    for r in due:
        deliver(r["chat_id"], r.get("thread_id"), f"⏰ Reminder: {r.get('message', '(no message)')}")


if __name__ == "__main__":
    main()
