"""
End-to-end pins for the context-aware auto-resume fix (2026-09-12 incident):
the 08:00 Swiggy re-run reminder — a pending DECISION originating in a
voice-inbox UI conversation — fired as plain text ("⏰ *Reminder:* ...") and
nothing resumed. The fix's contract, at this project's two seams:

- MINT (CLI, the seam agents actually invoke): a reminder about a pending
  task/decision carries --resume-action-json scoped to the origin —
  {"type": "voice_inbox_resume", "conversation_id": "vi-<12 hex>", "prompt":
  ...} for a voice-inbox conversation, {"type": "topic_resume", ...} for a
  Telegram topic — and the payload lands on the stored record.
- FIRE: such a record must NOT deliver as plain text. It queues a
  pending-reminder-resume record whose resume_action the bot's drain
  (drainDueReminderResumes) type-branches on BEFORE the chat_id gate, so the
  work resumes in the originating conversation.

Function-level mint validation is pinned in test_reminders.py; these tests
pin the full CLI mint -> stored record -> fire -> queued-resume-record path
for BOTH resume vocabularies, mirroring the recorded incident.
"""
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

import pytest

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

        secrets_path = os.path.join(tmpdir, "secrets.env")
        with open(secrets_path, "w", encoding="utf-8") as f:
            f.write("TELEGRAM_BOT_TOKEN=123456789:TEST_BOT_TOKEN_MOCK\n")

        yield tmpdir


SWIGGY_INCIDENT_PROMPT = (
    "Ask the operator to approve the fresh-OTP Swiggy re-run capturing delivery "
    "orders from Sep 2024-May 2026, then carry out the re-run if approved"
)


def _mint_via_cli(tmpdir, resume_action_json, extra_args=()):
    """Mint through the real CLI seam (subprocess), inheriting PA_HOME."""
    script = os.path.join(PROJECT_DIR, "add_reminder.py")
    result = subprocess.run(
        [sys.executable, script,
         "2026-09-12T08:00:00+05:30",
         "Swiggy re-run: approve fresh-OTP capture of delivery orders",
         "-1001234567890",
         "--resume-action-json", resume_action_json,
         *extra_args],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return result


def _stored_reminders(tmpdir):
    with open(os.path.join(tmpdir, "reminders.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def _fire_and_capture(tmpdir, monkeypatch):
    """Run the real fire path; return (send_calls, queued_records)."""
    mock_send_text = MagicMock(return_value="s-abc123")
    monkeypatch.setattr(process_reminders, "send_text", mock_send_text)
    process_reminders.process_reminders()

    queue_path = os.path.join(tmpdir, "pending-reminder-resume.json")
    records = []
    if os.path.exists(queue_path):
        with open(queue_path, "r", encoding="utf-8") as f:
            records = json.load(f)
    return mock_send_text, records


def test_voice_inbox_pending_decision_cli_mint_carries_resume_payload(temp_pa_home):
    # The recorded incident's shape: a pending decision that originated in a
    # voice-inbox UI conversation, minted through the CLI with the resume
    # payload scoped to that conversation.
    resume_json = json.dumps({
        "type": "voice_inbox_resume",
        "conversation_id": "vi-02a3c74901d4",
        "prompt": SWIGGY_INCIDENT_PROMPT,
    })
    _mint_via_cli(temp_pa_home, resume_json, extra_args=("--no-keyboard",))

    data = _stored_reminders(temp_pa_home)
    assert len(data) == 1
    assert data[0]["resume_action"] == {
        "type": "voice_inbox_resume",
        "conversation_id": "vi-02a3c74901d4",
        "prompt": SWIGGY_INCIDENT_PROMPT,
    }
    # System-executed resume work mints with --no-keyboard.
    assert data[0]["requires_user_decision"] is False


def test_voice_inbox_pending_decision_fires_as_resume_not_plain_text(temp_pa_home, monkeypatch):
    # The recorded failure, restated as the post-fix contract: at fire time
    # the record must NOT deliver as plain text — it queues a resume record
    # the drain branches on for voice_inbox_resume (before the chat gate),
    # and the operator gets the dispatched-to-worker notice with no keyboard.
    past = (datetime.now(timezone(timedelta(hours=5, minutes=30))) - timedelta(minutes=10)).isoformat()
    with open(os.path.join(temp_pa_home, "reminders.json"), "w", encoding="utf-8") as f:
        json.dump([{
            "due_at": past,
            "message": "Swiggy re-run: approve fresh-OTP capture of delivery orders",
            "chat_id": "-1001234567890",
            "thread_id": 310,
            "requires_user_decision": False,
            "resume_action": {
                "type": "voice_inbox_resume",
                "conversation_id": "vi-02a3c74901d4",
                "prompt": SWIGGY_INCIDENT_PROMPT,
            },
        }], f)

    mock_send_text, records = _fire_and_capture(temp_pa_home, monkeypatch)

    # Plain-text delivery is the recorded failure: must not happen.
    assert mock_send_text.call_count == 1
    sent_text = mock_send_text.call_args[0][0]
    assert sent_text.startswith("⏰ *Reminder (dispatched to worker):*")
    assert "reply_markup" not in mock_send_text.call_args.kwargs or \
        mock_send_text.call_args.kwargs["reply_markup"] is None

    # The queued record is what the bot's drainDueReminderResumes pops and
    # branches on via resume_action.type == "voice_inbox_resume".
    assert len(records) == 1
    assert records[0]["resume_action"]["type"] == "voice_inbox_resume"
    assert records[0]["resume_action"]["conversation_id"] == "vi-02a3c74901d4"
    assert records[0]["resume_action"]["prompt"] == SWIGGY_INCIDENT_PROMPT

    # The reminder was consumed.
    assert _stored_reminders(temp_pa_home) == []


def test_topic_resume_pending_decision_cli_mint_carries_resume_payload(temp_pa_home):
    # The 2026-08-31 leg of the correction: work pending in a Telegram topic
    # resumes INTO that topic, not as static canned text.
    resume_json = json.dumps({
        "type": "topic_resume",
        "prompt": "Resume the Swiggy re-run thread: check the extraction result and report",
    })
    _mint_via_cli(temp_pa_home, resume_json)

    data = _stored_reminders(temp_pa_home)
    assert len(data) == 1
    assert data[0]["resume_action"] == {
        "type": "topic_resume",
        "prompt": "Resume the Swiggy re-run thread: check the extraction result and report",
    }


def test_topic_resume_pending_decision_fires_as_resume_not_plain_text(temp_pa_home, monkeypatch):
    past = (datetime.now(timezone(timedelta(hours=5, minutes=30))) - timedelta(minutes=10)).isoformat()
    with open(os.path.join(temp_pa_home, "reminders.json"), "w", encoding="utf-8") as f:
        json.dump([{
            "due_at": past,
            "message": "Swiggy re-run thread: finish and report",
            "chat_id": "-1001234567890",
            "thread_id": 310,
            "resume_action": {
                "type": "topic_resume",
                "prompt": "Resume the Swiggy re-run thread: check the extraction result and report",
            },
        }], f)

    mock_send_text, records = _fire_and_capture(temp_pa_home, monkeypatch)

    assert mock_send_text.call_count == 1
    assert mock_send_text.call_args[0][0].startswith("⏰ *Reminder (dispatched to worker):*")
    assert len(records) == 1
    assert records[0]["resume_action"]["type"] == "topic_resume"
    assert records[0]["chat_id"] == "-1001234567890"
    assert records[0]["thread_id"] == 310
    assert _stored_reminders(temp_pa_home) == []
