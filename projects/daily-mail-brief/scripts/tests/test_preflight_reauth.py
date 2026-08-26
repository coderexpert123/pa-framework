"""Unit tests for the WP-G (AI-147) reauth wiring in preflight.py.

preflight.py now delegates the reauth-link send entirely to
pa/scripts/start_google_telegram_reauth.py --reuse-pending (rather than
hand-rolling its own --resume-action-json call), resolving chat/thread via
google_reauth_kick's resolver. This monkeypatches auth.get_gmail_service (to
force an auth-classified failure), subprocess.run (so the real start script
is never spawned), and notify_send (so no real `pa notify` process is
spawned and no real Telegram send happens).
"""
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPT_DIR)

import preflight  # noqa: E402
import auth  # noqa: E402


class RefreshError(Exception):
    """Stand-in for google.auth.exceptions.RefreshError — preflight classifies
    purely by exception TYPE NAME (type(e).__name__), so a same-named local
    class is enough to hit the "auth" branch without importing the real
    google-auth exception hierarchy."""


class TestPreflightReauthWiring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pa_home = os.path.join(self.tmp.name, "pa-home")
        os.makedirs(self.pa_home, exist_ok=True)

        self._env_saved = {
            k: os.environ.get(k) for k in (
                "PA_HOME", "TELEGRAM_CHAT_ID", "GOOGLE_AUTH_REDIRECT_URI",
                "PA_REAUTH_CHAT_ID", "PA_REAUTH_THREAD_ID",
                "TELEGRAM_BRIEFING_CHAT_ID", "TELEGRAM_DAILY_BRIEFING_THREAD_ID",
            )
        }
        os.environ["PA_HOME"] = self.pa_home
        os.environ["TELEGRAM_CHAT_ID"] = "-100111"
        os.environ["GOOGLE_AUTH_REDIRECT_URI"] = "https://example.com/bridge"
        os.environ.pop("PA_REAUTH_CHAT_ID", None)
        os.environ.pop("PA_REAUTH_THREAD_ID", None)
        os.environ.pop("TELEGRAM_BRIEFING_CHAT_ID", None)
        os.environ.pop("TELEGRAM_DAILY_BRIEFING_THREAD_ID", None)

        self._orig_get_gmail_service = auth.get_gmail_service
        auth.get_gmail_service = MagicMock(side_effect=RefreshError("token expired"))

        self._orig_subprocess_run = preflight.subprocess.run
        self.run_calls = []

        def fake_run(cmd, capture_output=None, text=None):
            self.run_calls.append(cmd)
            result = MagicMock()
            result.returncode = 0
            result.stdout = json.dumps({"status": "ok", "auth_url": "https://accounts.google.com/x",
                                        "auth_id": "a1", "reused": True, "sent": True})
            result.stderr = ""
            return result

        preflight.subprocess.run = fake_run

        self._orig_notify_send = preflight.notify_send
        self.notify_calls = []
        preflight.notify_send = lambda **kw: self.notify_calls.append(kw)

    def tearDown(self):
        auth.get_gmail_service = self._orig_get_gmail_service
        preflight.subprocess.run = self._orig_subprocess_run
        preflight.notify_send = self._orig_notify_send
        for k, v in self._env_saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_auth_failure_invokes_start_script_with_reuse_pending_and_resume_skill(self):
        with self.assertRaises(SystemExit) as ctx:
            preflight.main()
        self.assertEqual(ctx.exception.code, 2)

        self.assertEqual(len(self.run_calls), 1)
        cmd = self.run_calls[0]
        self.assertIn("--reuse-pending", cmd)
        idx = cmd.index("--resume-skill")
        self.assertEqual(cmd[idx + 1], "daily-mail-brief")
        idx_chat = cmd.index("--chat-id")
        self.assertTrue(cmd[idx_chat + 1])  # non-empty

    def test_fetch_failed_marker_is_still_written(self):
        fetch_failed = os.path.join(self.pa_home, "daily-mail-brief-fetch-failed.json")
        self.assertFalse(os.path.exists(fetch_failed))
        with self.assertRaises(SystemExit):
            preflight.main()
        self.assertTrue(os.path.exists(fetch_failed))
        data = json.loads(open(fetch_failed, encoding="utf-8").read())
        self.assertEqual(data["status"], "auth")

    def test_exit_code_is_2(self):
        with self.assertRaises(SystemExit) as ctx:
            preflight.main()
        self.assertEqual(ctx.exception.code, 2)

    def test_notify_send_still_fires_with_dedup_key(self):
        with self.assertRaises(SystemExit):
            preflight.main()
        self.assertEqual(len(self.notify_calls), 1)
        self.assertEqual(self.notify_calls[0]["dedup_key"], "daily-mail-brief-auth")

    def test_reason_has_no_markdown_link_when_start_script_succeeds(self):
        """WP-G step 5: the link already went out via Telegram plain text —
        preflight's own reason text must not re-embed a markdown link."""
        with self.assertRaises(SystemExit):
            preflight.main()
        fetch_failed = os.path.join(self.pa_home, "daily-mail-brief-fetch-failed.json")
        data = json.loads(open(fetch_failed, encoding="utf-8").read())
        self.assertNotIn("[Tap here", data["reason"])
        self.assertIn("reauth link was sent", data["reason"])


if __name__ == "__main__":
    unittest.main()
