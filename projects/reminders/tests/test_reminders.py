"""
Unit tests for projects/reminders (add_reminder.py & process_reminders.py)
"""
import os
import sys
import json
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
