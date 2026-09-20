import os
import re
import sys
import time
from contextlib import contextmanager
import json
from datetime import datetime, timezone, timedelta

pa_home = os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")
REMINDERS_FILE = os.path.join(pa_home, "reminders.json")

# Cross-process claim lock on the reminders store (catchup-lane-wedge wave,
# 2026-09-16). Every read-modify-write of reminders.json runs inside it:
# process_reminders.py holds it while it partitions due reminders and writes
# the rest back (never while sending), so two processors can never claim the
# same due reminder; add_reminder() holds it so an add is never lost to a
# concurrent write-back. The lock is a sibling file created with O_EXCL.
# Reclaim (E-A1, catchup-lane-wedge amendment, 2026-09-16) requires BOTH the
# age check AND a dead recorded PID — an age-only reclaim can fire while the
# first holder is still inside its critical section and clobber a write that
# landed in between. A PID that cannot be read/parsed falls back to the hard
# ceiling STORE_LOCK_HARD_STALE_S, so a lock whose holder we can never verify
# is not held forever.
STORE_LOCK_SUFFIX = ".lock"
STORE_LOCK_STALE_S = 60.0
STORE_LOCK_HARD_STALE_S = 900.0
STORE_LOCK_POLL_S = 0.05
ADD_LOCK_WAIT_S = 10.0


class ReminderStoreBusy(Exception):
    """The store lock was still held when the wait budget ran out."""


def _read_lock_pid(lock_path):
    """Return the PID recorded in lock_path, or None if it cannot be read or
    parsed (missing file, race with the holder's own write, garbage content)."""
    try:
        with open(lock_path, "r", encoding="ascii") as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def _pid_is_alive(pid, kernel32=None):
    """Best-effort liveness check for a recorded lock-holder PID. Returns
    True if the PID is a live process, False if it is confirmed dead, and
    None if liveness could not be determined (caller falls back to the hard
    staleness ceiling rather than treating None as either answer).

    `kernel32` is exposed for tests to inject a fake — production callers
    never pass it and get the real DLL, loaded with `use_last_error=True` so
    `ctypes.get_last_error()` reflects OpenProcess's own GetLastError().

    E-A4 (catchup-lane-wedge amendment, 2026-09-16): a process's real exit
    code can legitimately equal 259 (STILL_ACTIVE), which made the previous
    GetExitCodeProcess-based check misreport a dead process as alive.
    WaitForSingleObject(handle, 0) is not fooled by the exit-code value —
    WAIT_TIMEOUT means the process has not signalled (still running),
    WAIT_OBJECT_0 means it has (exited)."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        SYNCHRONIZE = 0x00100000
        WAIT_OBJECT_0 = 0x0
        WAIT_TIMEOUT = 0x102
        ERROR_ACCESS_DENIED = 5
        ERROR_INVALID_PARAMETER = 87

        if kernel32 is None:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid
        )
        if not handle:
            err = ctypes.get_last_error()
            if err == ERROR_ACCESS_DENIED:
                return None
            if err == ERROR_INVALID_PARAMETER:
                return False
            return None
        try:
            result = kernel32.WaitForSingleObject(handle, 0)
            if result == WAIT_TIMEOUT:
                return True
            if result == WAIT_OBJECT_0:
                return False
            return None
        finally:
            kernel32.CloseHandle(handle)
    else:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # A live process we don't own — still alive.
            return True
        except OSError:
            return None


@contextmanager
def reminders_store_lock(store_path, wait_s=10.0):
    lock_path = store_path + STORE_LOCK_SUFFIX
    os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
    deadline = time.monotonic() + wait_s
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except (FileExistsError, PermissionError):
            try:
                age = time.time() - os.path.getmtime(lock_path)
            except OSError:
                continue

            pid = _read_lock_pid(lock_path)
            alive = _pid_is_alive(pid) if pid is not None else None

            reclaimable = (alive is False and age > STORE_LOCK_STALE_S) or (
                alive is None and age > STORE_LOCK_HARD_STALE_S
            )
            if reclaimable:
                try:
                    os.remove(lock_path)
                except OSError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise ReminderStoreBusy(lock_path)
            time.sleep(STORE_LOCK_POLL_S)
    try:
        try:
            os.write(fd, str(os.getpid()).encode("ascii"))
        finally:
            os.close(fd)
        yield lock_path
    finally:
        try:
            os.remove(lock_path)
        except OSError:
            pass

# AI-185 (executable-reminder-dispatch design, 2026-09-02, internal §3.1): the
# closed topic_resume vocabulary, validated at MINT time. Byte-identical rules
# and error strings to BOTH sibling validators — the deliberate-mirror pattern:
# pa/scripts/start_google_telegram_reauth.py's validate_topic_resume and
# projects/telegram-bot/src/oauth.ts's validateTopicResumeAction (fire time) —
# all three pinned by their own tests.
TOPIC_RESUME_MAX_PROMPT_CHARS = 500

# AI-conversation-context reminder fix (2026-09-12): a second closed resume
# vocabulary, sibling to topic_resume, for a reminder whose pending
# task/decision originated in a voice-inbox UI conversation rather than a
# Telegram chat. Byte-identical mirror in
# projects/telegram-bot/src/oauth.ts's validateVoiceInboxResumeAction (fire
# time) — both pinned by their own tests. Resolved by
# projects/voice-inbox/scripts/create_conversation_task.py at fire time,
# which appends a new task into the SAME conversation_id (never a fixed
# chat/topic captured at mint time, so it survives the conversation's
# routing moving between topics).
VOICE_INBOX_RESUME_MAX_PROMPT_CHARS = 500
VOICE_INBOX_CONVERSATION_ID_RE = re.compile(r"^vi-[0-9a-f]{12}$")


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


def validate_voice_inbox_resume(action: dict) -> "str | None":
    """Return an error string, or None when the action is a valid voice_inbox_resume."""
    if set(action.keys()) != {"type", "conversation_id", "prompt"}:
        return 'voice_inbox_resume must have exactly the keys "type", "conversation_id" and "prompt"'
    conversation_id = action.get("conversation_id")
    if not isinstance(conversation_id, str) or not VOICE_INBOX_CONVERSATION_ID_RE.match(conversation_id):
        return 'voice_inbox_resume.conversation_id must match "vi-<12 hex>"'
    prompt = action.get("prompt")
    if not isinstance(prompt, str):
        return "voice_inbox_resume.prompt must be a string"
    if not prompt.strip():
        return "voice_inbox_resume.prompt must not be empty"
    if "\n" in prompt or "\r" in prompt:
        return "voice_inbox_resume.prompt must be a single line"
    if len(prompt) > VOICE_INBOX_RESUME_MAX_PROMPT_CHARS:
        return f"voice_inbox_resume.prompt exceeds {VOICE_INBOX_RESUME_MAX_PROMPT_CHARS} characters"
    if prompt.lstrip().startswith("/"):
        return 'voice_inbox_resume.prompt must not start with "/"'
    return None


def validate_resume_action(action: dict) -> "str | None":
    """Dispatch to the validator for action['type']. Return an error string, or
    None when the action is valid. Unknown/missing type is rejected rather than
    silently accepted, so a typo'd type never mints an inert reminder."""
    action_type = action.get("type")
    if action_type == "topic_resume":
        return validate_topic_resume(action)
    if action_type == "voice_inbox_resume":
        return validate_voice_inbox_resume(action)
    return 'resume_action.type must be "topic_resume" or "voice_inbox_resume"'


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
    reason = validate_resume_action(resume_action)
    if reason:
        print(f"ERROR: Invalid resume action: {reason}", file=sys.stderr)
        sys.exit(1)
    return resume_action


def local_tz():
    """PA_TZ_OFFSET_MINUTES (minutes east of UTC) or UTC when unset — a loud
    stderr warning replaces the old silent IST default (WB-54)."""
    raw = os.environ.get("PA_TZ_OFFSET_MINUTES")
    if raw is None or raw == "":
        print("[reminders] PA_TZ_OFFSET_MINUTES not set — defaulting to UTC (was IST before 2026-09-17)", file=sys.stderr)
        return timezone.utc
    try:
        return timezone(timedelta(minutes=int(raw)))
    except ValueError:
        print(f"[reminders] PA_TZ_OFFSET_MINUTES={raw!r} is not an integer — defaulting to UTC", file=sys.stderr)
        return timezone.utc


def add_reminder(due_at_iso, message, chat_id, thread_id=None, resume_action=None, requires_user_decision=None):
    # Validate BEFORE any file write, so a rejected resume action leaves
    # reminders.json untouched (same ERROR/exit-1 style as the ISO path below).
    if resume_action is not None:
        if not isinstance(resume_action, dict):
            print("ERROR: Invalid resume action: --resume-action-json must decode to a JSON object", file=sys.stderr)
            sys.exit(1)
        reason = validate_resume_action(resume_action)
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

    # Basic ISO validation/normalization (before taking the store lock)
    try:
        # .replace("Z","+00:00"): Python <3.11 fromisoformat rejects the bare
        # UTC 'Z' suffix (stock macOS python3 is 3.9 — leg-2 fail, 2026-09-21).
        dt = datetime.fromisoformat(due_at_iso.replace("Z", "+00:00"))
        # Ensure it has TZ info
        if dt.tzinfo is None:
            # PA_TZ_OFFSET_MINUTES env, or loud UTC default (was silent IST, WB-54)
            dt = dt.replace(tzinfo=local_tz())
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

    try:
        with reminders_store_lock(REMINDERS_FILE, wait_s=ADD_LOCK_WAIT_S):
            if not os.path.exists(REMINDERS_FILE):
                reminders = []
            else:
                try:
                    with open(REMINDERS_FILE, "r", encoding="utf-8") as f:
                        reminders = json.load(f)
                except:
                    reminders = []

            reminders.append(new_reminder)

            # Atomic write: temp file + os.replace
            tmp_path = REMINDERS_FILE + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(reminders, f, indent=2)
            os.replace(tmp_path, REMINDERS_FILE)
    except ReminderStoreBusy:
        print("ERROR: reminders store is locked by another process; reminder not added", file=sys.stderr)
        sys.exit(1)

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
