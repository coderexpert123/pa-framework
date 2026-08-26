"""Unit tests for pa/scripts/google_reauth_kick.py (WP-G, AI-147).

Monkeypatches subprocess.run; never spawns a real process, touches the
network, or sends a real Telegram message.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import google_reauth_kick as kick  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_pa_home(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    kick._SECRETS_CACHE = None
    yield
    kick._SECRETS_CACHE = None


def _mock_run(monkeypatch, returncode=0, stdout=None, stderr=""):
    if stdout is None:
        stdout = json.dumps({"status": "ok", "auth_url": "https://accounts.google.com/o/oauth2/auth?x=1",
                             "auth_id": "a1", "reused": False, "sent": True})
    calls = []

    def fake_run(cmd, capture_output=None, text=None, timeout=None):
        calls.append(cmd)
        result = MagicMock()
        result.returncode = returncode
        result.stdout = stdout
        result.stderr = stderr
        return result

    monkeypatch.setattr(kick.subprocess, "run", fake_run)
    return calls


def _marker(tmp_path):
    return json.loads((tmp_path / "google-auth-blocked.json").read_text(encoding="utf-8"))


class TestRoutePrecedence:
    """arg > env > secrets.env > TELEGRAM_CHAT_ID[0] / thread 0."""

    def test_explicit_argument_wins(self, monkeypatch, tmp_path):
        monkeypatch.setenv("PA_REAUTH_CHAT_ID", "-100999")
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111", thread_id=5)
        cmd = calls[0]
        assert "-100111" in cmd
        assert cmd[cmd.index("--thread-id") + 1] == "5"

    def test_env_wins_over_secrets(self, monkeypatch, tmp_path):
        (tmp_path / "secrets.env").write_text("PA_REAUTH_CHAT_ID=-100777\n", encoding="utf-8")
        monkeypatch.setenv("PA_REAUTH_CHAT_ID", "-100888")
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired")
        assert "-100888" in calls[0]

    def test_secrets_wins_over_telegram_chat_id_fallback(self, monkeypatch, tmp_path):
        (tmp_path / "secrets.env").write_text(
            "PA_REAUTH_CHAT_ID=-100777\nTELEGRAM_CHAT_ID=-100555\n", encoding="utf-8")
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired")
        assert "-100777" in calls[0]

    def test_telegram_chat_id_first_entry_is_last_resort(self, monkeypatch, tmp_path):
        (tmp_path / "secrets.env").write_text("TELEGRAM_CHAT_ID=-100555,-100666\n", encoding="utf-8")
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired")
        assert "-100555" in calls[0]

    def test_thread_id_defaults_to_zero(self, monkeypatch, tmp_path):
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        cmd = calls[0]
        assert cmd[cmd.index("--thread-id") + 1] == "0"

    def test_thread_id_env_precedence(self, monkeypatch, tmp_path):
        (tmp_path / "secrets.env").write_text("PA_REAUTH_THREAD_ID=42\n", encoding="utf-8")
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        cmd = calls[0]
        assert cmd[cmd.index("--thread-id") + 1] == "42"


class TestMarker:
    def test_first_call_creates_marker_with_first_seen(self, monkeypatch, tmp_path):
        _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        marker = _marker(tmp_path)
        assert marker["first_seen"]
        assert marker["skills"] == ["daily-mail-brief"]
        assert marker["reason"] == "expired"

    def test_second_call_keeps_first_seen_appends_skill_refreshes_last_seen(self, monkeypatch, tmp_path):
        _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        marker1 = _marker(tmp_path)
        first_seen = marker1["first_seen"]

        # Push last_sent back past the 6h rate limit so the second call
        # actually reaches the marker-merge + spawn path again.
        marker1["last_sent"] = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
        (tmp_path / "google-auth-blocked.json").write_text(json.dumps(marker1), encoding="utf-8")

        _mock_run(monkeypatch)
        kick.kick_google_reauth("hemir-invoice", "still expired", chat_id="-100111")
        marker2 = _marker(tmp_path)
        assert marker2["first_seen"] == first_seen
        assert set(marker2["skills"]) == {"daily-mail-brief", "hemir-invoice"}
        assert marker2["reason"] == "still expired"


class TestRateLimit:
    def test_second_call_within_6h_is_rate_limited_and_does_not_spawn(self, monkeypatch, tmp_path):
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        assert len(calls) == 1

        result = kick.kick_google_reauth("daily-mail-brief", "expired again", chat_id="-100111")
        assert result == {"status": "rate-limited", "reused": False}
        assert len(calls) == 1  # no second spawn

    def test_after_6h_it_spawns_again(self, monkeypatch, tmp_path):
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        assert len(calls) == 1

        marker = _marker(tmp_path)
        marker["last_sent"] = (datetime.now(timezone.utc) - timedelta(hours=6, minutes=1)).isoformat()
        (tmp_path / "google-auth-blocked.json").write_text(json.dumps(marker), encoding="utf-8")

        result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        assert result["status"] == "sent"
        assert len(calls) == 2


class TestFailure:
    def test_failing_start_script_returns_failed_and_leaves_last_sent_unset(self, monkeypatch, tmp_path):
        _mock_run(monkeypatch, returncode=1, stdout=json.dumps({"error": "Missing secrets file"}))
        result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        assert result["status"] == "failed"
        marker = _marker(tmp_path)
        assert marker["last_sent"] is None

    def test_subprocess_raising_never_propagates(self, monkeypatch, tmp_path):
        def raising_run(*_a, **_kw):
            raise OSError("no such file")

        monkeypatch.setattr(kick.subprocess, "run", raising_run)
        result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        assert result["status"] == "failed"
        assert "no such file" in result["error"]

    def test_unparseable_stdout_on_exit_0_is_failed_not_a_crash(self, monkeypatch, tmp_path):
        _mock_run(monkeypatch, returncode=0, stdout="not json")
        result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        assert result["status"] == "failed"


class TestRedirectUri:
    def test_redirect_uri_passed_from_secrets(self, monkeypatch, tmp_path):
        (tmp_path / "secrets.env").write_text(
            "GOOGLE_AUTH_REDIRECT_URI=https://example.com/bridge\n", encoding="utf-8")
        calls = _mock_run(monkeypatch)
        kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
        cmd = calls[0]
        assert cmd[cmd.index("--redirect-uri") + 1] == "https://example.com/bridge"


class TestCli:
    def test_main_prints_result_json(self, monkeypatch, tmp_path, capsys):
        _mock_run(monkeypatch)
        rc = kick.main(["--skill", "daily-mail-brief", "--reason", "expired", "--chat-id", "-100111"])
        assert rc == 0
        out = json.loads(capsys.readouterr().out.strip())
        assert out["status"] == "sent"
