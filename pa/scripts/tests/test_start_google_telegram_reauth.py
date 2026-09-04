"""Unit tests for pa/scripts/start_google_telegram_reauth.py (WP-G, AI-147).

Monkeypatches Flow.from_client_secrets_file and the Telegram notifier;
never touches the network or a real Telegram chat.

Run: python -m pytest pa/scripts/tests/test_start_google_telegram_reauth.py -q
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import start_google_telegram_reauth as start  # noqa: E402

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src"))
import telegram_notify  # noqa: E402

# Deliberately carries characters (underscore, parentheses) that Telegram's
# legacy Markdown parser would mangle if this ever went out with
# parse_mode="Markdown" — the whole point of correction 13 / step 1.
FAKE_AUTH_URL = ("https://accounts.google.com/o/oauth2/auth?state=abc_123"
                 "&client_id=fake(app)&scope=x")


class FakeFlow:
    def __init__(self, *_a, **_kw):
        self.code_verifier = "fake-verifier"

    def authorization_url(self, **_kw):
        return FAKE_AUTH_URL, "fake-state"

    @classmethod
    def from_client_secrets_file(cls, *_a, **_kw):
        return cls()


class BaseCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.secrets_file = self.d / "secrets.json"
        self.secrets_file.write_text("{}", encoding="utf-8")
        self.state_file = self.d / "google-telegram-auth.json"

        self._orig_flow = start.Flow
        start.Flow = FakeFlow
        self._orig_argv = sys.argv
        self._orig_send_text = telegram_notify.send_text

    def tearDown(self):
        start.Flow = self._orig_flow
        sys.argv = self._orig_argv
        telegram_notify.send_text = self._orig_send_text
        self.tmp.cleanup()

    def _argv(self, *extra):
        return [
            "start_google_telegram_reauth.py",
            "--secrets-file", str(self.secrets_file),
            "--state-file", str(self.state_file),
            "--redirect-uri", "https://example.com/bridge",
            "--chat-id", "-100123",
            *extra,
        ]


class TestExpiry(BaseCliTest):
    def test_expires_at_is_created_at_plus_43200(self):
        sys.argv = self._argv("--no-send")
        start.main()
        pending = json.loads(self.state_file.read_text())
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["expires_at"] - pending[0]["created_at"], 43200)


class TestNoSend(BaseCliTest):
    def test_no_send_writes_session_and_sends_nothing(self):
        called = []
        telegram_notify.send_text = lambda *a, **kw: called.append((a, kw))

        sys.argv = self._argv("--no-send")
        start.main()

        self.assertEqual(called, [])
        pending = json.loads(self.state_file.read_text())
        self.assertEqual(len(pending), 1)


class TestDefaultSend(BaseCliTest):
    def test_default_path_calls_notifier_once_plain_text_with_raw_url(self):
        captured = {}

        def fake_send_text(text, chat_id=None, thread_id=None, parse_mode="Markdown", reply_markup=None):
            captured["calls"] = captured.get("calls", 0) + 1
            captured["text"] = text
            captured["chat_id"] = chat_id
            captured["thread_id"] = thread_id
            captured["parse_mode"] = parse_mode
            captured["reply_markup"] = reply_markup
            return "s-abc123"

        telegram_notify.send_text = fake_send_text

        sys.argv = self._argv()
        start.main()

        self.assertEqual(captured["calls"], 1)
        self.assertIsNone(captured["parse_mode"])
        self.assertIn(FAKE_AUTH_URL, captured["text"])
        self.assertNotIn("\\", captured["text"])
        self.assertIsNotNone(captured["reply_markup"])


class TestNotifierFailure(BaseCliTest):
    def test_raising_notifier_removes_session_and_exits_nonzero(self):
        def raising_send_text(*_a, **_kw):
            raise RuntimeError("boom")

        telegram_notify.send_text = raising_send_text

        sys.argv = self._argv()
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)

        pending = json.loads(self.state_file.read_text())
        self.assertEqual(pending, [])


class TestReusePending(BaseCliTest):
    def test_reuse_pending_resends_stored_url_and_does_not_append(self):
        existing = {
            "auth_id": "existing123",
            "state": "s1",
            "code_verifier": "v1",
            "redirect_uri": "https://example.com/bridge",
            "scopes": start.DEFAULT_SCOPES,
            "chat_id": "-100123",
            "thread_id": None,
            "resume_action": None,
            "retry_action": None,
            "created_at": int(time.time()),
            "expires_at": int(time.time()) + 43200,
            "auth_url": "https://accounts.google.com/o/oauth2/auth?stored=1",
        }
        self.state_file.write_text(json.dumps([existing]), encoding="utf-8")

        captured = {}
        telegram_notify.send_text = lambda text, **kw: captured.setdefault("text", text) or "s-abc"

        sys.argv = self._argv("--reuse-pending")
        start.main()

        pending = json.loads(self.state_file.read_text())
        self.assertEqual(len(pending), 1)  # no second entry appended
        self.assertEqual(pending[0]["auth_id"], "existing123")
        self.assertIn("stored=1", captured["text"])

    def test_reuse_pending_without_a_match_falls_through_to_mint(self):
        """A pruned-but-empty pending list (or scope mismatch) must still
        mint a fresh session rather than error out."""
        telegram_notify.send_text = lambda *a, **kw: "s-abc"

        sys.argv = self._argv("--reuse-pending")
        start.main()

        pending = json.loads(self.state_file.read_text())
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["auth_url"], FAKE_AUTH_URL)


class TestResumeSkill(BaseCliTest):
    def test_resume_skill_stores_run_pa_skill_shape(self):
        sys.argv = self._argv("--no-send", "--resume-skill", "daily-mail-brief")
        start.main()
        pending = json.loads(self.state_file.read_text())
        self.assertEqual(pending[0]["resume_action"], {
            "type": "run_pa_skill",
            "skill": "daily-mail-brief",
            "description": "Retry daily-mail-brief",
        })

    def test_resume_action_json_wins_over_resume_skill(self):
        sys.argv = self._argv(
            "--no-send", "--resume-skill", "daily-mail-brief",
            "--resume-action-json", json.dumps({"type": "custom", "skill": "other"}),
        )
        start.main()
        pending = json.loads(self.state_file.read_text())
        self.assertEqual(pending[0]["resume_action"], {"type": "custom", "skill": "other"})


class TestReauthKeyboard(BaseCliTest):
    """Direct unit tests for _send_reauth_message's reply_markup construction
    (WP-2, plans/2026-08-23-reauth-button-SPEC.md): callback data contract
    "reauth:google" / "reauth:google:<skill>", button label
    "🔐 Re-authorize Google (fresh link)"."""

    def test_keyboard_without_skill_suffix(self):
        captured = {}

        def fake_send_text(text, chat_id=None, thread_id=None, parse_mode=None, reply_markup=None):
            captured["text"] = text
            captured["reply_markup"] = reply_markup
            return "s-abc"

        telegram_notify.send_text = fake_send_text

        result = start._send_reauth_message("https://example.com/consent", None, "-100123", None)

        self.assertTrue(result)
        self.assertEqual(captured["reply_markup"], {
            "inline_keyboard": [[
                {"text": "\U0001F510 Re-authorize Google (fresh link)", "callback_data": "reauth:google"}
            ]]
        })
        self.assertIn("Or tap the button below later for a fresh link.", captured["text"])

    def test_keyboard_with_valid_skill_suffix(self):
        captured = {}

        def fake_send_text(text, chat_id=None, thread_id=None, parse_mode=None, reply_markup=None):
            captured["reply_markup"] = reply_markup
            return "s-abc"

        telegram_notify.send_text = fake_send_text

        start._send_reauth_message("https://example.com/consent", "daily-mail-brief", "-100123", None)

        self.assertEqual(
            captured["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            "reauth:google:daily-mail-brief",
        )

    def test_invalid_skill_name_is_stripped_from_callback_data(self):
        captured = {}

        def fake_send_text(text, chat_id=None, thread_id=None, parse_mode=None, reply_markup=None):
            captured["reply_markup"] = reply_markup
            return "s-abc"

        telegram_notify.send_text = fake_send_text

        # Uppercase + underscore fails the [a-z0-9-]{1,64} skill charset —
        # the callback must fall back to the bare "reauth:google" form
        # rather than carry an invalid skill token the bot would reject.
        start._send_reauth_message("https://example.com/consent", "Daily_Mail_Brief", "-100123", None)

        self.assertEqual(
            captured["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            "reauth:google",
        )

    def test_50_char_skill_name_is_kept_within_64_byte_budget(self):
        """§3.2 of plans/2026-08-24-buttons-program-SPEC.md: the skill charset
        cap moved from 64 to 50 chars, since "reauth:google:" alone is 14
        bytes of the fixed 64-byte callback_data budget."""
        captured = {}

        def fake_send_text(text, chat_id=None, thread_id=None, parse_mode=None, reply_markup=None):
            captured["reply_markup"] = reply_markup
            return "s-abc"

        telegram_notify.send_text = fake_send_text

        skill_50 = "a" * 50
        start._send_reauth_message("https://example.com/consent", skill_50, "-100123", None)

        callback_data = captured["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
        self.assertEqual(callback_data, f"reauth:google:{skill_50}")
        self.assertLessEqual(len(callback_data.encode("utf-8")), 64)

    def test_51_char_skill_name_is_stripped_from_callback(self):
        captured = {}

        def fake_send_text(text, chat_id=None, thread_id=None, parse_mode=None, reply_markup=None):
            captured["reply_markup"] = reply_markup
            return "s-abc"

        telegram_notify.send_text = fake_send_text

        skill_51 = "a" * 51
        start._send_reauth_message("https://example.com/consent", skill_51, "-100123", None)

        self.assertEqual(
            captured["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            "reauth:google",
        )

    def test_send_text_called_with_reply_markup_kwarg(self):
        """_send_reauth_message must pass reply_markup through to send_text
        (not just build it and drop it) — asserted via call signature."""
        calls = []

        def fake_send_text(text, chat_id=None, thread_id=None, parse_mode=None, reply_markup=None):
            calls.append({"chat_id": chat_id, "thread_id": thread_id, "parse_mode": parse_mode,
                          "reply_markup": reply_markup})
            return "s-abc"

        telegram_notify.send_text = fake_send_text

        start._send_reauth_message("https://example.com/consent", None, "-100999", 42)

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["chat_id"], "-100999")
        self.assertEqual(calls[0]["thread_id"], 42)
        self.assertIsNone(calls[0]["parse_mode"])
        self.assertIsNotNone(calls[0]["reply_markup"])


class TestTopicResumeValidation(BaseCliTest):
    def test_valid_topic_resume_persists_verbatim(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "continue the contact add",
            })
        )
        start.main()
        pending = json.loads(self.state_file.read_text())
        self.assertEqual(pending[0]["resume_action"], {
            "type": "topic_resume",
            "prompt": "continue the contact add",
        })

    def test_extra_key_description_is_rejected(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "continue",
                "description": "extra key",
            })
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        # When validation fails, no session file is written
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_prompt_missing_is_rejected(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({"type": "topic_resume"})
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_prompt_non_string_is_rejected(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": 123,
            })
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_blank_prompt_is_rejected(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "   ",
            })
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_multiline_prompt_via_newline_is_rejected(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "continue\nnow",
            })
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_501_char_prompt_is_rejected(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "x" * 501,
            })
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_500_char_prompt_is_accepted(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "x" * 500,
            })
        )
        start.main()
        pending = json.loads(self.state_file.read_text())
        self.assertEqual(len(pending), 1)

    def test_prompt_starting_with_slash_is_rejected(self):
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "/continue",
            })
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_prompt_with_leading_spaces_starting_with_slash_is_rejected(self):
        """After trimming leading spaces, if the prompt starts with / it is rejected."""
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "  /continue",
            })
        )
        with self.assertRaises(SystemExit) as ctx:
            start.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertFalse(self.state_file.exists(), "Session file should not exist after validation failure")

    def test_non_topic_resume_payload_stays_opaque(self):
        """A run_pa_skill payload that would FAIL the topic_resume rules
        still mints fine and persists verbatim."""
        sys.argv = self._argv(
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "run_pa_skill",
                "skill": "x",
                "args": ["a"],
                "worker": "z",
            })
        )
        start.main()
        pending = json.loads(self.state_file.read_text())
        self.assertEqual(pending[0]["resume_action"], {
            "type": "run_pa_skill",
            "skill": "x",
            "args": ["a"],
            "worker": "z",
        })


class TestReusePendingLatestMintWins(BaseCliTest):
    def test_reuse_pending_updates_resume_payload_when_re_minting(self):
        """Mint session A with --resume-skill, then re-run with --reuse-pending
        carrying a NEW topic_resume payload. The stored session should be
        updated with the new payload, thread_id, and chat_id."""
        # Mint initial session with --resume-skill
        sys.argv = self._argv(
            "--no-send",
            "--resume-skill", "old-skill",
            "--thread-id", "11111",
        )
        start.main()

        # Re-mint with --reuse-pending carrying topic_resume
        sys.argv = self._argv(
            "--reuse-pending",
            "--no-send",
            "--resume-action-json", json.dumps({
                "type": "topic_resume",
                "prompt": "continue X",
            }),
            "--thread-id", "12253",
        )
        start.main()

        pending = json.loads(self.state_file.read_text())
        self.assertEqual(len(pending), 1)
        # resume_action updated to topic_resume
        self.assertEqual(pending[0]["resume_action"], {
            "type": "topic_resume",
            "prompt": "continue X",
        })
        # thread_id updated
        self.assertEqual(pending[0]["thread_id"], 12253)
        # auth_url unchanged (still the FAKE_AUTH_URL from first mint)
        self.assertIn("client_id=fake(app)", pending[0]["auth_url"])


if __name__ == "__main__":
    unittest.main()
