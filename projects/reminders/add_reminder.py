import os
import sys
import json
from datetime import datetime, timezone, timedelta

pa_home = os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")
REMINDERS_FILE = os.path.join(pa_home, "reminders.json")

# AI-185 (executable-reminder-dispatch design, 2026-09-02, internal §3.1): the
# closed topic_resume vocabulary, validated at MINT time. Byte-identical rules
# and error strings to BOTH sibling validators — the deliberate-mirror pattern:
# pa/scripts/start_google_telegram_reauth.py's validate_topic_resume and
# projects/telegram-bot/src/oauth.ts's validateTopicResumeAction (fire time) —
# all three pinned by their own tests.
TOPIC_RESUME_MAX_PROMPT_CHARS = 500


def validate_topic_resume(action: dict) -> "str | None":
    """Return an error string, or None when the action is a valid topic_resume."""
    if set(action.keys()) != {"type", "prompt"}:
        return 'topic_resume must have exactly the keys "type" and "prompt"'
    prompt = action.get("prompt")
    if not isinstance(prompt, str):
        return "topic_resume.prompt must be a string"
    if not prompt.strip():
        return "topic_resume.prompt must not be empty"
    if "\n" in prompt or "\r" in prompt:
        return "topic_resume.prompt must be a single line"
    if len(prompt) > TOPIC_RESUME_MAX_PROMPT_CHARS:
        return f"topic_resume.prompt exceeds {TOPIC_RESUME_MAX_PROMPT_CHARS} characters"
    if prompt.lstrip().startswith("/"):
        return 'topic_resume.prompt must not start with "/"'
    return None


def parse_resume_action_json(resume_action_json):
    """Decode + validate an --resume-action-json value. Returns the action dict,
    or exits with `ERROR: Invalid resume action: <reason>` on stderr."""
    try:
        resume_action = json.loads(resume_action_json)
    except Exception as e:
        print(f"ERROR: Invalid resume action: not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(resume_action, dict):
        print("ERROR: Invalid resume action: --resume-action-json must decode to a JSON object", file=sys.stderr)
        sys.exit(1)
    reason = validate_topic_resume(resume_action)
    if reason:
        print(f"ERROR: Invalid resume action: {reason}", file=sys.stderr)
        sys.exit(1)
    return resume_action


def add_reminder(due_at_iso, message, chat_id, thread_id=None, resume_action=None, requires_user_decision=None):
    # Validate BEFORE any file write, so a rejected resume action leaves
    # reminders.json untouched (same ERROR/exit-1 style as the ISO path below).
    if resume_action is not None:
        if not isinstance(resume_action, dict):
            print("ERROR: Invalid resume action: --resume-action-json must decode to a JSON object", file=sys.stderr)
            sys.exit(1)
        reason = validate_topic_resume(resume_action)
        if reason:
            print(f"ERROR: Invalid resume action: {reason}", file=sys.stderr)
            sys.exit(1)
    # AI-207 reminder-delivery wave (2026-09-05): a mint whose message merely
    # duplicates the executable prompt would deliver the raw instruction as the
    # operator-facing label. Rejected before any file write.
    if resume_action is not None and message.strip() == str(resume_action.get("prompt", "")).strip():
        print("ERROR: message must be a plain-language operator label, not the executable "
              "instruction — put the instruction in --resume-action-json and a person-readable "
              "summary in message", file=sys.stderr)
        sys.exit(1)

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
    # `message` stays the human label; `prompt` inside resume_action is the
    # executable instruction (AI-185 §3.1).
    if resume_action is not None:
        new_reminder["resume_action"] = resume_action
    # AI-207: stored ONLY when the minter passed --no-keyboard (or an explicit
    # value) — a flagless mint leaves the key absent, the backward-compat pin.
    if requires_user_decision is not None:
        new_reminder["requires_user_decision"] = requires_user_decision

    reminders.append(new_reminder)

    # Atomic write: temp file + os.replace
    tmp_path = REMINDERS_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(reminders, f, indent=2)
    os.replace(tmp_path, REMINDERS_FILE)

    print(f"SUCCESS: Added reminder for {due_at_iso}: {message}")

if __name__ == "__main__":
    argv = sys.argv[1:]
    resume_action_json = None
    if "--resume-action-json" in argv:
        idx = argv.index("--resume-action-json")
        if idx + 1 >= len(argv):
            print("ERROR: --resume-action-json requires a JSON value", file=sys.stderr)
            sys.exit(1)
        resume_action_json = argv[idx + 1]
        argv = argv[:idx] + argv[idx + 2:]
    # AI-207: presence flag — strip it, then translate to the explicit-false
    # record key. No "force true" flag exists (text-only defaults to keyboard).
    no_keyboard = "--no-keyboard" in argv
    argv = [a for a in argv if a != "--no-keyboard"]

    if len(argv) < 3:
        print("Usage: python add_reminder.py <due_at_iso> <message> <chat_id> [thread_id] [--resume-action-json <json>] [--no-keyboard]", file=sys.stderr)
        sys.exit(1)

    due_at = argv[0]
    msg = argv[1]
    chat = argv[2]
    thread = int(argv[3]) if len(argv) > 3 else None

    resume_action = parse_resume_action_json(resume_action_json) if resume_action_json is not None else None

    add_reminder(due_at, msg, chat, thread, resume_action, requires_user_decision=False if no_keyboard else None)
