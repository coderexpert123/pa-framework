"""
Unit tests for projects/reminders (add_reminder.py & process_reminders.py)
"""
import os
import sys
import json
import subprocess
import tempfile
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

# Ensure projects/reminders is on path
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

import add_reminder
import process_reminders


@pytest.fixture
def temp_pa_home(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        monkeypatch.setenv("PA_HOME", tmpdir)
        monkeypatch.setattr(add_reminder, "pa_home", tmpdir)
        monkeypatch.setattr(add_reminder, "REMINDERS_FILE", os.path.join(tmpdir, "reminders.json"))
        monkeypatch.setattr(process_reminders, "pa_home", tmpdir)
        monkeypatch.setattr(process_reminders, "REMINDERS_FILE", os.path.join(tmpdir, "reminders.json"))
        monkeypatch.setattr(process_reminders, "PENDING_RESUME_FILE", os.path.join(tmpdir, "pending-reminder-resume.json"))

        # Write dummy secrets.env for process_reminders
        secrets_path = os.path.join(tmpdir, "secrets.env")
        with open(secrets_path, "w", encoding="utf-8") as f:
            f.write("TELEGRAM_BOT_TOKEN=123456789:TEST_BOT_TOKEN_MOCK\n")

        yield tmpdir


def test_add_reminder_creates_file_and_appends(temp_pa_home):
    due_iso = "2026-08-21T15:00:00+05:30"
    add_reminder.add_reminder(due_iso, "Test reminder 1", "-1001234567890", 42)

    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    assert os.path.exists(reminders_file)

    with open(reminders_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert len(data) == 1
    assert data[0]["message"] == "Test reminder 1"
    assert data[0]["chat_id"] == "-1001234567890"
    assert data[0]["thread_id"] == 42

    # Add second reminder
    add_reminder.add_reminder(due_iso, "Test reminder 2", "-1001234567890", None)
    with open(reminders_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert len(data) == 2
    assert data[1]["message"] == "Test reminder 2"
    assert data[1]["thread_id"] is None


def test_add_reminder_attaches_timezone_if_naive(temp_pa_home):
    naive_iso = "2026-08-21T15:00:00"
    add_reminder.add_reminder(naive_iso, "Naive TZ test", "-1001234567890")

    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    with open(reminders_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert "+05:30" in data[0]["due_at"]


def test_process_reminders_sends_due_and_retains_future(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    past_due = (now - timedelta(minutes=10)).isoformat()
    future_due = (now + timedelta(hours=2)).isoformat()

    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    with open(reminders_file, "w", encoding="utf-8") as f:
        json.dump([
            {"due_at": past_due, "message": "Past task", "chat_id": "-1001234567890", "thread_id": 10},
            {"due_at": future_due, "message": "Future task", "chat_id": "-1001234567890", "thread_id": 20},
        ], f)

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    # Verify send_text was called for past task with a keyboard attached
    assert mock_send_text.called
    call_args, call_kwargs = mock_send_text.call_args
    assert "Past task" in call_args[0]
    assert isinstance(call_args[0], str)
    assert call_kwargs["chat_id"] == "-1001234567890"
    assert call_kwargs["thread_id"] == 10
    assert call_kwargs["reply_markup"] == process_reminders.build_reminder_keyboard()

    # Verify remaining items in reminders.json
    with open(reminders_file, "r", encoding="utf-8") as f:
        remaining = json.load(f)
    assert len(remaining) == 1
    assert remaining[0]["message"] == "Future task"


def test_process_reminders_handles_empty_gracefully(temp_pa_home, monkeypatch):
    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    with open(reminders_file, "w", encoding="utf-8") as f:
        json.dump([], f)

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()
    assert not mock_send_text.called


def test_process_reminders_sets_token_env_from_secrets(temp_pa_home, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)

    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    past_due = (now - timedelta(minutes=10)).isoformat()

    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    with open(reminders_file, "w", encoding="utf-8") as f:
        json.dump([
            {"due_at": past_due, "message": "Token task", "chat_id": "-1001234567890", "thread_id": 10},
        ], f)

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    assert os.environ.get("TELEGRAM_BOT_TOKEN") == "123456789:TEST_BOT_TOKEN_MOCK"


def test_process_reminders_one_failure_does_not_block_the_next(temp_pa_home, monkeypatch, capsys):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    past_due_1 = (now - timedelta(minutes=10)).isoformat()
    past_due_2 = (now - timedelta(minutes=5)).isoformat()

    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    with open(reminders_file, "w", encoding="utf-8") as f:
        json.dump([
            {"due_at": past_due_1, "message": "First task", "chat_id": "-1001234567890", "thread_id": 10},
            {"due_at": past_due_2, "message": "Second task", "chat_id": "-1001234567890", "thread_id": 20},
        ], f)

    mock_send_text = MagicMock(side_effect=[SystemExit(1), "s-abc123"])
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    # Both sends were attempted despite the first raising SystemExit.
    assert mock_send_text.call_count == 2
    out = capsys.readouterr().out
    assert "FAILED to send: First task" in out
    assert "Sent: Second task" in out

    # Both due reminders were consumed (deleted before sending, per the
    # existing due/remaining partition behaviour).
    with open(reminders_file, "r", encoding="utf-8") as f:
        remaining = json.load(f)
    assert remaining == []


def test_process_reminders_generic_exception_does_not_block_the_next(temp_pa_home, monkeypatch, capsys):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    past_due_1 = (now - timedelta(minutes=10)).isoformat()
    past_due_2 = (now - timedelta(minutes=5)).isoformat()

    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    with open(reminders_file, "w", encoding="utf-8") as f:
        json.dump([
            {"due_at": past_due_1, "message": "First task", "chat_id": "-1001234567890", "thread_id": 10},
            {"due_at": past_due_2, "message": "Second task", "chat_id": "-1001234567890", "thread_id": 20},
        ], f)

    mock_send_text = MagicMock(side_effect=[RuntimeError("boom"), "s-abc123"])
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    assert mock_send_text.call_count == 2
    out = capsys.readouterr().out
    assert "FAILED to send: First task" in out
    assert "Sent: Second task" in out


def test_build_reminder_keyboard_callback_data():
    keyboard = process_reminders.build_reminder_keyboard()
    row = keyboard["inline_keyboard"][0]
    callback_values = [button["callback_data"] for button in row]
    assert callback_values == ["rm:done", "rm:1h", "rm:tmrw"]
    for value in callback_values:
        assert len(value.encode("utf-8")) <= 64


def test_reminder_message_text_starts_with_bold_prefix():
    text = process_reminders.reminder_message_text("x")
    assert text.startswith("⏰ *Reminder:*")
    assert text == "⏰ *Reminder:* x"


# --- AI-185: executable reminder dispatch (mint time) ---

VALID_RESUME_JSON = '{"type": "topic_resume", "prompt": "Run Gate F verification"}'


def _resume_json_with_prompt(prompt: str) -> str:
    return json.dumps({"type": "topic_resume", "prompt": prompt})


def test_add_reminder_accepts_resume_action(temp_pa_home):
    due_iso = "2026-09-02T21:15:00+05:30"
    add_reminder.add_reminder(due_iso, "Gate F check", "-1001234567890", 310,
                              resume_action=json.loads(VALID_RESUME_JSON))

    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    with open(reminders_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert len(data) == 1
    # message stays the human label; the prompt is the executable instruction.
    assert data[0]["message"] == "Gate F check"
    assert data[0]["resume_action"] == {"type": "topic_resume", "prompt": "Run Gate F verification"}


def _assert_rejected(temp_pa_home, resume_json, expected_reason):
    with pytest.raises(SystemExit) as exc:
        add_reminder.add_reminder("2026-09-02T21:15:00+05:30", "msg", "-1001234567890",
                                  None, resume_action=json.loads(resume_json))
    assert exc.value.code == 1

    # A rejected resume action must not leave a reminder behind.
    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    assert not os.path.exists(reminders_file)


def test_add_reminder_rejects_oversized_prompt(temp_pa_home, capsys):
    _assert_rejected(temp_pa_home, _resume_json_with_prompt("x" * 501),
                     "topic_resume.prompt exceeds 500 characters")
    assert "ERROR: Invalid resume action:" in capsys.readouterr().err


def test_add_reminder_rejects_multiline_prompt(temp_pa_home, capsys):
    _assert_rejected(temp_pa_home, _resume_json_with_prompt("line one\nline two"),
                     "topic_resume.prompt must be a single line")
    assert "ERROR: Invalid resume action:" in capsys.readouterr().err


def test_add_reminder_rejects_extra_keys(temp_pa_home, capsys):
    extra = json.dumps({"type": "topic_resume", "prompt": "do it", "extra": 1})
    _assert_rejected(temp_pa_home, extra,
                     'topic_resume must have exactly the keys "type" and "prompt"')
    assert "ERROR: Invalid resume action:" in capsys.readouterr().err


def test_add_reminder_rejects_slash_prompt(temp_pa_home, capsys):
    _assert_rejected(temp_pa_home, _resume_json_with_prompt("/status now"),
                     'topic_resume.prompt must not start with "/"')
    assert "ERROR: Invalid resume action:" in capsys.readouterr().err


# --- AI-185: executable reminder dispatch (fire time) ---

def _write_reminder(temp_pa_home, reminder):
    reminders_file = os.path.join(temp_pa_home, "reminders.json")
    try:
        with open(reminders_file, "r", encoding="utf-8") as f:
            existing = json.load(f)
    except Exception:
        existing = []
    with open(reminders_file, "w", encoding="utf-8") as f:
        json.dump(existing + [reminder], f)


def _executable_reminder(now, **overrides):
    reminder = {
        "due_at": (now - timedelta(minutes=10)).isoformat(),
        "message": "Gate F check",
        "chat_id": "-1001234567890",
        "thread_id": 310,
        "resume_action": {"type": "topic_resume", "prompt": "Run Gate F verification"},
    }
    reminder.update(overrides)
    return reminder


def test_process_queues_executable_reminder(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    reminder = _executable_reminder(now)
    _write_reminder(temp_pa_home, reminder)

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    queue_file = os.path.join(temp_pa_home, "pending-reminder-resume.json")
    assert os.path.exists(queue_file)
    with open(queue_file, "r", encoding="utf-8") as f:
        records = json.load(f)
    assert len(records) == 1
    record = records[0]
    # id = "<due_at>-<8 hex>", queued_at present, chat/thread/action as stored.
    assert record["id"] == f"{reminder['due_at']}-{record['id'].rsplit('-', 1)[1]}"
    assert len(record["id"].rsplit("-", 1)[1]) == 8
    assert record["queued_at"]
    assert record["chat_id"] == "-1001234567890"
    assert record["thread_id"] == 310
    assert record["resume_action"] == {"type": "topic_resume", "prompt": "Run Gate F verification"}

    # The notice is the dispatched-to-worker form, with no keyboard attached.
    call_args, call_kwargs = mock_send_text.call_args
    assert call_args[0] == "⏰ *Reminder (dispatched to worker):* Gate F check"
    assert call_kwargs["chat_id"] == "-1001234567890"
    assert call_kwargs["thread_id"] == 310

    # The due reminder was still consumed (pop-before-act, unchanged).
    with open(os.path.join(temp_pa_home, "reminders.json"), "r", encoding="utf-8") as f:
        assert json.load(f) == []


def test_process_notice_has_no_keyboard(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    _write_reminder(temp_pa_home, _executable_reminder(now))

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    assert mock_send_text.call_count == 1
    call_args, call_kwargs = mock_send_text.call_args
    assert "dispatched to worker" in call_args[0]
    assert "reply_markup" not in call_kwargs or call_kwargs["reply_markup"] is None


def test_process_falls_back_to_text_on_queue_failure(temp_pa_home, monkeypatch, capsys):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    _write_reminder(temp_pa_home, _executable_reminder(now))

    def boom(reminder):
        raise RuntimeError("queue file unwritable")

    monkeypatch.setattr(process_reminders, "append_resume_record", boom)
    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    # AI-207: the legacy executable fallback is the plain text send WITHOUT a
    # keyboard (buttons on system-executed work were the defect); no queue file.
    call_args, call_kwargs = mock_send_text.call_args
    assert call_args[0] == "⏰ *Reminder:* Gate F check"
    assert "reply_markup" not in call_kwargs or call_kwargs["reply_markup"] is None
    assert not os.path.exists(os.path.join(temp_pa_home, "pending-reminder-resume.json"))

    out = capsys.readouterr().out
    assert "[Reminders] WARN: queue append failed, fell back to text send: Gate F check" in out
    assert "Sent: Gate F check" in out


def test_process_text_only_unchanged(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    _write_reminder(temp_pa_home, {
        "due_at": (now - timedelta(minutes=10)).isoformat(),
        "message": "Plain task",
        "chat_id": "-1001234567890",
        "thread_id": 10,
    })

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    # Today's path, byte-identical: full text + keyboard, no queue side effects.
    assert mock_send_text.call_count == 1
    call_args, call_kwargs = mock_send_text.call_args
    assert call_args[0] == "⏰ *Reminder:* Plain task"
    assert call_kwargs["reply_markup"] == process_reminders.build_reminder_keyboard()
    assert not os.path.exists(os.path.join(temp_pa_home, "pending-reminder-resume.json"))


# --- AI-207: reminder delivery — conditional keyboard + mint guard ---

def test_requires_user_decision_helper_defaults():
    # Legacy default is pinned: absent flag -> keyboard for a text-only
    # reminder, none for an executable one; an explicit value always wins.
    assert process_reminders.requires_user_decision({"message": "x"}) is True
    assert process_reminders.requires_user_decision(
        {"message": "x", "resume_action": {"type": "topic_resume", "prompt": "p"}}) is False
    assert process_reminders.requires_user_decision({"requires_user_decision": True}) is True
    assert process_reminders.requires_user_decision({"requires_user_decision": False}) is False


def test_process_text_only_no_keyboard_when_suppressed(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    _write_reminder(temp_pa_home, {
        "due_at": (now - timedelta(minutes=10)).isoformat(),
        "message": "Suppressed task",
        "chat_id": "-1001234567890",
        "thread_id": 10,
        "requires_user_decision": False,
    })

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    assert mock_send_text.call_count == 1
    call_args, call_kwargs = mock_send_text.call_args
    assert call_args[0] == "⏰ *Reminder:* Suppressed task"
    assert "reply_markup" not in call_kwargs or call_kwargs["reply_markup"] is None


def test_process_text_only_keyboard_when_explicitly_required(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    _write_reminder(temp_pa_home, {
        "due_at": (now - timedelta(minutes=10)).isoformat(),
        "message": "Explicit task",
        "chat_id": "-1001234567890",
        "thread_id": 10,
        "requires_user_decision": True,
    })

    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    assert mock_send_text.call_count == 1
    call_args, call_kwargs = mock_send_text.call_args
    assert call_args[0] == "⏰ *Reminder:* Explicit task"
    assert call_kwargs["reply_markup"] == process_reminders.build_reminder_keyboard()


def test_process_executable_fallback_legacy_has_no_keyboard(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    _write_reminder(temp_pa_home, _executable_reminder(now))  # no flag: legacy default

    def boom(reminder):
        raise RuntimeError("queue file unwritable")

    monkeypatch.setattr(process_reminders, "append_resume_record", boom)
    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    call_args, call_kwargs = mock_send_text.call_args
    assert call_args[0] == "⏰ *Reminder:* Gate F check"
    assert "reply_markup" not in call_kwargs or call_kwargs["reply_markup"] is None


def test_process_executable_fallback_keyboard_when_required(temp_pa_home, monkeypatch):
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    _write_reminder(temp_pa_home, _executable_reminder(now, requires_user_decision=True))

    def boom(reminder):
        raise RuntimeError("queue file unwritable")

    monkeypatch.setattr(process_reminders, "append_resume_record", boom)
    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)

    process_reminders.process_reminders()

    call_args, call_kwargs = mock_send_text.call_args
    assert call_args[0] == "⏰ *Reminder:* Gate F check"
    assert call_kwargs["reply_markup"] == process_reminders.build_reminder_keyboard()


def test_add_reminder_no_keyboard_flag_stores_false(temp_pa_home):
    add_reminder.add_reminder("2026-09-05T18:00:00+05:30", "Silent task", "-1001234567890", 10,
                              requires_user_decision=False)

    with open(os.path.join(temp_pa_home, "reminders.json"), "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data[0]["requires_user_decision"] is False


def test_add_reminder_without_flags_omits_requires_user_decision_key(temp_pa_home):
    add_reminder.add_reminder("2026-09-05T18:00:00+05:30", "Plain task", "-1001234567890", 10)

    with open(os.path.join(temp_pa_home, "reminders.json"), "r", encoding="utf-8") as f:
        data = json.load(f)
    assert "requires_user_decision" not in data[0]


def test_add_reminder_rejects_prompt_as_message(temp_pa_home, capsys):
    prompt = "Run Gate F verification"
    with pytest.raises(SystemExit) as exc:
        add_reminder.add_reminder("2026-09-05T18:00:00+05:30", prompt, "-1001234567890", 310,
                                  resume_action={"type": "topic_resume", "prompt": prompt})
    assert exc.value.code == 1
    assert "plain-language operator label" in capsys.readouterr().err

    # A rejected mint must not leave a reminder behind.
    assert not os.path.exists(os.path.join(temp_pa_home, "reminders.json"))


def test_cli_no_keyboard_flag_stores_false(temp_pa_home):
    # The CLI seam is what agents actually call: run the real script with the
    # fixture's temp PA_HOME inherited.
    script = os.path.join(PROJECT_DIR, "add_reminder.py")
    result = subprocess.run(
        [sys.executable, script, "2026-09-05T18:00:00+05:30", "CLI task", "-1001234567890", "10",
         "--no-keyboard"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr

    with open(os.path.join(temp_pa_home, "reminders.json"), "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data[0]["requires_user_decision"] is False
