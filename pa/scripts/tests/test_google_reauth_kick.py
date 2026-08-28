"""Unit tests for pa/scripts/google_reauth_kick.py (WP-G, AI-147, WP-E AI-168).

Monkeypatches subprocess.run; never spawns a real process, touches the
network, or sends a real Telegram message.
"""
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from io import StringIO
from pathlib import Path
from unittest import TestCase, mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import google_reauth_kick as kick  # noqa: E402


_Z_FORMAT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


class BaseTestCase(TestCase):
    """Base class with setUp/tearDown for temp PA_HOME and env isolation."""

    # Every key kick._secret() can be asked for. When this suite runs under a
    # pa worker (e.g. the push gate), the real secrets.env values are already
    # in os.environ and — by design (env-then-secrets, mirrors notify.ts) —
    # override the temp secrets.env these tests write. Scrub them so the temp
    # file is authoritative regardless of the runner's environment; tests that
    # exercise the env tier set the var explicitly (2026-08-28, after the push
    # gate failed on 8f56f60 with 5 ambient-env overrides).
    _SCRUB_ENV_KEYS = (
        "PA_REAUTH_CHAT_ID",
        "PA_REAUTH_THREAD_ID",
        "TELEGRAM_CHAT_ID",
        "GOOGLE_AUTH_REDIRECT_URI",
    )

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.orig_env = os.environ.copy()
        for key in self._SCRUB_ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["PA_HOME"] = self.temp_dir
        kick._SECRETS_CACHE = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.orig_env)
        kick._SECRETS_CACHE = None
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _marker(self):
        """Helper to read the marker file."""
        path = Path(self.temp_dir) / "google-auth-blocked.json"
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _mock_run(self, returncode=0, stdout=None, stderr=""):
        """Helper to mock subprocess.run. Returns list of calls captured."""
        if stdout is None:
            stdout = json.dumps({"status": "ok", "auth_url": "https://accounts.google.com/o/oauth2/auth?x=1",
                                 "auth_id": "a1", "reused": False, "sent": True})
        calls = []

        def fake_run(cmd, capture_output=None, text=None, timeout=None):
            calls.append(cmd)
            result = mock.Mock()
            result.returncode = returncode
            result.stdout = stdout
            result.stderr = stderr
            return result

        return mock.patch("subprocess.run", side_effect=fake_run), calls


class TestRoutePrecedence(BaseTestCase):
    """arg > env > secrets.env > TELEGRAM_CHAT_ID[0] / thread 0."""

    def test_explicit_argument_wins(self):
        os.environ["PA_REAUTH_CHAT_ID"] = "-100999"
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111", thread_id=5)
            cmd = calls[0]
            self.assertIn("-100111", cmd)
            self.assertEqual(cmd[cmd.index("--thread-id") + 1], "5")

    def test_env_wins_over_secrets(self):
        (Path(self.temp_dir) / "secrets.env").write_text("PA_REAUTH_CHAT_ID=-100777\n", encoding="utf-8")
        os.environ["PA_REAUTH_CHAT_ID"] = "-100888"
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired")
            self.assertIn("-100888", calls[0])

    def test_secrets_wins_over_telegram_chat_id_fallback(self):
        (Path(self.temp_dir) / "secrets.env").write_text(
            "PA_REAUTH_CHAT_ID=-100777\nTELEGRAM_CHAT_ID=-100555\n", encoding="utf-8")
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired")
            self.assertIn("-100777", calls[0])

    def test_telegram_chat_id_first_entry_is_last_resort(self):
        (Path(self.temp_dir) / "secrets.env").write_text("TELEGRAM_CHAT_ID=-100555,-100666\n", encoding="utf-8")
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired")
            self.assertIn("-100555", calls[0])

    def test_thread_id_defaults_to_zero(self):
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            cmd = calls[0]
            self.assertEqual(cmd[cmd.index("--thread-id") + 1], "0")

    def test_thread_id_env_precedence(self):
        (Path(self.temp_dir) / "secrets.env").write_text("PA_REAUTH_THREAD_ID=42\n", encoding="utf-8")
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            cmd = calls[0]
            self.assertEqual(cmd[cmd.index("--thread-id") + 1], "42")


class TestMarker(BaseTestCase):
    def test_first_call_creates_marker_with_first_seen(self):
        patcher, _ = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            marker = self._marker()
            self.assertTrue(marker["first_seen"])
            self.assertEqual(marker["skills"], ["daily-mail-brief"])
            self.assertEqual(marker["reason"], "expired")

    def test_second_call_keeps_first_seen_appends_skill_refreshes_last_seen(self):
        patcher, _ = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            marker1 = self._marker()
            first_seen = marker1["first_seen"]

            # Push last_sent back past the 6h rate limit so the second call
            # actually reaches the marker-merge + spawn path again.
            marker1["last_sent"] = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
            (Path(self.temp_dir) / "google-auth-blocked.json").write_text(json.dumps(marker1), encoding="utf-8")

        patcher2, _ = self._mock_run()
        with patcher2:
            kick.kick_google_reauth("test-invoice", "still expired", chat_id="-100111")
            marker2 = self._marker()
            self.assertEqual(marker2["first_seen"], first_seen)
            self.assertEqual(set(marker2["skills"]), {"daily-mail-brief", "test-invoice"})
            self.assertEqual(marker2["reason"], "still expired")


class TestRateLimit(BaseTestCase):
    def test_second_call_within_6h_is_rate_limited_and_does_not_spawn(self):
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            self.assertEqual(len(calls), 1)

            result = kick.kick_google_reauth("daily-mail-brief", "expired again", chat_id="-100111")
            self.assertEqual(result, {"status": "rate-limited", "reused": False})
            self.assertEqual(len(calls), 1)  # no second spawn

    def test_after_6h_it_spawns_again(self):
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            self.assertEqual(len(calls), 1)

            marker = self._marker()
            marker["last_sent"] = (datetime.now(timezone.utc) - timedelta(hours=6, minutes=1)).isoformat()
            (Path(self.temp_dir) / "google-auth-blocked.json").write_text(json.dumps(marker), encoding="utf-8")

            result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            self.assertEqual(result["status"], "sent")
            self.assertEqual(len(calls), 2)


class TestFailure(BaseTestCase):
    def test_failing_start_script_returns_failed_and_leaves_last_sent_unset(self):
        patcher, _ = self._mock_run(returncode=1, stdout=json.dumps({"error": "Missing secrets file"}))
        with patcher:
            result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            self.assertEqual(result["status"], "failed")
            marker = self._marker()
            self.assertIsNone(marker["last_sent"])

    def test_subprocess_raising_never_propagates(self):
        def raising_run(*_a, **_kw):
            raise OSError("no such file")

        with mock.patch("subprocess.run", raising_run):
            result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            self.assertEqual(result["status"], "failed")
            self.assertIn("no such file", result["error"])

    def test_unparseable_stdout_on_exit_0_is_failed_not_a_crash(self):
        patcher, _ = self._mock_run(returncode=0, stdout="not json")
        with patcher:
            result = kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            self.assertEqual(result["status"], "failed")


class TestRedirectUri(BaseTestCase):
    def test_redirect_uri_passed_from_secrets(self):
        (Path(self.temp_dir) / "secrets.env").write_text(
            "GOOGLE_AUTH_REDIRECT_URI=https://example.com/bridge\n", encoding="utf-8")
        patcher, calls = self._mock_run()
        with patcher:
            kick.kick_google_reauth("daily-mail-brief", "expired", chat_id="-100111")
            cmd = calls[0]
            self.assertEqual(cmd[cmd.index("--redirect-uri") + 1], "https://example.com/bridge")


class TestCli(BaseTestCase):
    def test_main_prints_result_json(self):
        patcher, _ = self._mock_run()
        with patcher:
            old_stdout = sys.stdout
            sys.stdout = StringIO()
            try:
                rc = kick.main(["--skill", "daily-mail-brief", "--reason", "expired", "--chat-id", "-100111"])
                self.assertEqual(rc, 0)
                out = sys.stdout.getvalue()
                out_json = json.loads(out.strip())
                self.assertEqual(out_json["status"], "sent")
            finally:
                sys.stdout = old_stdout


class TestKickLog(BaseTestCase):
    """Test the append-only ~/.pa/reauth-kicks.jsonl sidecar (AI-168 WP-E, §2.6)."""

    def _kick_log_lines(self):
        """Return list of JSON objects from ~/.pa/reauth-kicks.jsonl."""
        path = Path(self.temp_dir) / "reauth-kicks.jsonl"
        if not path.exists():
            return []
        lines = path.read_text(encoding="utf-8").strip().splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def test_each_invocation_path_appends_one_line_with_correct_status(self):
        # Rate-limited path
        patcher, _ = self._mock_run()
        with patcher:
            kick.kick_google_reauth("skill1", "reason1", chat_id="-100111")
            result = kick.kick_google_reauth("skill1", "reason2", chat_id="-100111")
            self.assertEqual(result["status"], "rate-limited")
            lines = self._kick_log_lines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(lines[0]["status"], "sent")
            self.assertEqual(lines[1]["status"], "rate-limited")

    def test_spawn_failure_appends_failed_status(self):
        def raising_run(*_a, **_kw):
            raise OSError("no such file")

        with mock.patch("subprocess.run", raising_run):
            result = kick.kick_google_reauth("skill2", "spawn failed", chat_id="-100111")
            self.assertEqual(result["status"], "failed")
            lines = self._kick_log_lines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["status"], "failed")
            self.assertEqual(lines[0]["skill"], "skill2")
            self.assertEqual(lines[0]["reason"], "spawn failed")

    def test_script_failure_appends_failed_status(self):
        patcher, _ = self._mock_run(returncode=1, stdout=json.dumps({"error": "Missing secrets"}))
        with patcher:
            result = kick.kick_google_reauth("skill3", "script error", chat_id="-100111")
            self.assertEqual(result["status"], "failed")
            lines = self._kick_log_lines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["status"], "failed")

    def test_unparseable_output_appends_failed_status(self):
        patcher, _ = self._mock_run(returncode=0, stdout="not json")
        with patcher:
            result = kick.kick_google_reauth("skill4", "unparseable", chat_id="-100111")
            self.assertEqual(result["status"], "failed")
            lines = self._kick_log_lines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["status"], "failed")

    def test_success_path_appends_sent_status(self):
        patcher, _ = self._mock_run()
        with patcher:
            result = kick.kick_google_reauth("skill5", "sent successfully", chat_id="-100111")
            self.assertEqual(result["status"], "sent")
            lines = self._kick_log_lines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["status"], "sent")
            self.assertEqual(lines[0]["skill"], "skill5")
            self.assertEqual(lines[0]["reason"], "sent successfully")

    def test_ts_matches_z_format_regex(self):
        patcher, _ = self._mock_run()
        with patcher:
            kick.kick_google_reauth("skill6", "test ts format", chat_id="-100111")
            lines = self._kick_log_lines()
            self.assertEqual(len(lines), 1)
            ts = lines[0]["ts"]
            self.assertIsNotNone(_Z_FORMAT_RE.match(ts), f"Timestamp {ts} doesn't match Z format")

    def test_kick_log_path_differs_from_marker_path(self):
        """The sidecar survives marker deletion (different files)."""
        self.assertNotEqual(kick._marker_path(), kick._kick_log_path())

    def test_unwritable_path_does_not_affect_returned_dict(self):
        """Even if the kick log can't be written, the returned dict is still correct."""
        # Make PA_HOME read-only by creating a file where the directory should be
        log_path = Path(self.temp_dir) / "reauth-kicks.jsonl"
        log_path.write_text("")  # Create as file, not dir
        log_path.chmod(0o444)  # Read-only

        patcher, _ = self._mock_run()
        with patcher:
            result = kick.kick_google_reauth("skill7", "unwritable test", chat_id="-100111")
            # The result should still be correct even though the log write failed
            self.assertEqual(result["status"], "sent")
