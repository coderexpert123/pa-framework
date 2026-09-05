"""
Tests for 429 retry_after handling in telegram_notify.py (AI-149).

Hermetic unittest tests that patch network/time dependencies to verify
rate-limit handling without real Telegram API calls.

pytest-free by necessity: the CI Python gate has no pytest installed
(ModuleNotFoundError, private CI run 33461374803, fixed 2026-09-01).
"""

import sys
import json
import time
import io
import tempfile
import contextlib
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Import telegram_notify as a module from the worktree source tree
sys.path.insert(0, "pa/src")
import telegram_notify


class Test429RetryHandling(unittest.TestCase):
    """Test that 429 responses with retry_after are handled correctly."""

    def setUp(self):
        """Set up patches for each test."""
        self._patches = []

    def tearDown(self):
        """Clean up patches after each test."""
        for p in self._patches:
            p.stop()

    def _patch(self, obj, name, value):
        """Helper to patch an attribute and track it for cleanup."""
        p = patch.object(obj, name, value)
        p.start()
        self._patches.append(p)
        return value

    def test_429_with_retry_after_succeeds_on_second_attempt(self):
        """A 429 with retry_after: 2 followed by a 200 results in success
        and exactly one sleep(3) call (2+1 margin)."""
        # Mock dependencies
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        sleep_calls = []
        mock_sleep = lambda n: sleep_calls.append(n)
        self._patch(time, "sleep", mock_sleep)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        # Track _post calls
        post_call_count = 0

        def mock_post(url, payload):
            nonlocal post_call_count
            post_call_count += 1
            resp = MagicMock()
            if post_call_count == 1:
                # First call: 429 with retry_after: 2
                resp.status_code = 429
                resp.json.return_value = {"parameters": {"retry_after": 2}}
            else:
                # Second call: success
                resp.status_code = 200
                resp.json.return_value = {"result": {"message_id": 123}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        # Send a simple message
        ref_id = telegram_notify.send_text("Test message")

        # Assertions
        self.assertEqual(post_call_count, 2, "Should retry once after 429")
        self.assertEqual(len(sleep_calls), 1, "Should sleep exactly once")
        self.assertEqual(sleep_calls[0], 3, "Should sleep for retry_after+1 (2+1=3)")
        mock_log.assert_called()
        self.assertTrue(ref_id.startswith("s-"))

    def test_four_consecutive_429s_triggers_failure_path(self):
        """Four consecutive 429s end with the failure path (SystemExit)."""
        # Mock dependencies
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        sleep_calls = []
        mock_sleep = lambda n: sleep_calls.append(n)
        self._patch(time, "sleep", mock_sleep)

        # Track _post calls
        post_call_count = 0

        def mock_post(url, payload):
            nonlocal post_call_count
            post_call_count += 1
            resp = MagicMock()
            # Always return 429
            resp.status_code = 429
            resp.json.return_value = {"parameters": {"retry_after": 1}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        # Capture stderr
        stderr_capture = io.StringIO()

        # Send a simple message - should raise SystemExit after 4 attempts
        with contextlib.redirect_stderr(stderr_capture):
            with self.assertRaises(SystemExit) as cm:
                telegram_notify.send_text("Test message")

        # Assertions
        self.assertEqual(cm.exception.code, 1, "Should exit with code 1")
        self.assertEqual(post_call_count, 4, "Should attempt 4 times total")
        # Should have slept 4 times (before each retry: after attempts 1, 2, 3, and the final 4th)
        self.assertEqual(len(sleep_calls), 4, "Should sleep 4 times (once after each of the 4 attempts)")

        # Check error output
        captured = stderr_capture.getvalue()
        self.assertTrue("ERROR" in captured or "failed" in captured)

    def test_non_429_non_200_uses_plain_fallback_without_429_sleep(self):
        """A non-429 non-200 still takes the plain-fallback path exactly once
        (no rate-limit sleep)."""
        # Mock dependencies
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        sleep_calls = []
        mock_sleep = lambda n: sleep_calls.append(n)
        self._patch(time, "sleep", mock_sleep)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        # Track _post calls
        post_call_count = 0

        def mock_post(url, payload):
            nonlocal post_call_count
            post_call_count += 1
            resp = MagicMock()
            if post_call_count == 1:
                # First call with Markdown: parse error (400)
                resp.status_code = 400
                resp.text = "Bad Request: can't parse entities"
                resp.json.return_value = {"error": "parse error"}
            else:
                # Second call with plain text: success
                resp.status_code = 200
                resp.json.return_value = {"result": {"message_id": 456}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        # Send a simple message
        ref_id = telegram_notify.send_text("Test *message*")

        # Assertions
        self.assertEqual(post_call_count, 2, "Should call _post twice (Markdown + plain fallback)")
        self.assertEqual(len(sleep_calls), 0, "Should NOT sleep for non-429 errors")
        mock_log.assert_called()
        self.assertTrue(ref_id.startswith("s-"))

    def test_429_without_parseable_retry_after_sleeps_default_2s(self):
        """A 429 without parseable retry_after sleeps 2s before retry."""
        # Mock dependencies
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        sleep_calls = []
        mock_sleep = lambda n: sleep_calls.append(n)
        self._patch(time, "sleep", mock_sleep)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        # Track _post calls
        post_call_count = 0

        def mock_post(url, payload):
            nonlocal post_call_count
            post_call_count += 1
            resp = MagicMock()
            if post_call_count == 1:
                # First call: 429 without retry_after field
                resp.status_code = 429
                resp.json.return_value = {"parameters": {}}  # No retry_after
            else:
                # Second call: success
                resp.status_code = 200
                resp.json.return_value = {"result": {"message_id": 789}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        # Send a simple message
        ref_id = telegram_notify.send_text("Test message")

        # Assertions
        self.assertEqual(post_call_count, 2, "Should retry once after 429")
        self.assertEqual(len(sleep_calls), 1, "Should sleep exactly once")
        self.assertEqual(sleep_calls[0], 2, "Should sleep for default 2s when retry_after missing")
        mock_log.assert_called()
        self.assertTrue(ref_id.startswith("s-"))

    def test_429_retry_after_capped_at_60s(self):
        """A 429 with retry_after > 60 is capped at 60s sleep."""
        # Mock dependencies
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        sleep_calls = []
        mock_sleep = lambda n: sleep_calls.append(n)
        self._patch(time, "sleep", mock_sleep)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        # Track _post calls
        post_call_count = 0

        def mock_post(url, payload):
            nonlocal post_call_count
            post_call_count += 1
            resp = MagicMock()
            if post_call_count == 1:
                # First call: 429 with excessive retry_after
                resp.status_code = 429
                resp.json.return_value = {"parameters": {"retry_after": 300}}
            else:
                # Second call: success
                resp.status_code = 200
                resp.json.return_value = {"result": {"message_id": 999}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        # Send a simple message
        ref_id = telegram_notify.send_text("Test message")

        # Assertions
        self.assertEqual(post_call_count, 2, "Should retry once after 429")
        self.assertEqual(len(sleep_calls), 1, "Should sleep exactly once")
        self.assertEqual(sleep_calls[0], 61, "Should cap retry_after at 60s, sleep 61s (60+1)")
        mock_log.assert_called()
        self.assertTrue(ref_id.startswith("s-"))


class TestParseModeOption(unittest.TestCase):
    """Test the optional parse_mode kwarg on send_text (WP-G, correction 13).

    An OAuth consent URL must never go through Telegram's legacy Markdown
    parser (underscores/parentheses get mangled — memory 2026-08-15), so
    send_text(..., parse_mode=None) must omit the "parse_mode" payload key
    entirely and use the unescaped "Ref: <id>" trailer instead of "_Ref: <id>_".
    """

    def setUp(self):
        """Set up patches for each test."""
        self._patches = []

    def tearDown(self):
        """Clean up patches after each test."""
        for p in self._patches:
            p.stop()

    def _patch(self, obj, name, value):
        """Helper to patch an attribute and track it for cleanup."""
        p = patch.object(obj, name, value)
        p.start()
        self._patches.append(p)
        return value

    def test_default_parse_mode_still_sends_markdown(self):
        """Unchanged behavior: no parse_mode kwarg -> payload carries
        "parse_mode": "Markdown" and the italic "_Ref: ..._" trailer."""
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"result": {"message_id": 1}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        ref_id = telegram_notify.send_text("Test message")

        self.assertEqual(len(captured_payloads), 1)
        self.assertEqual(captured_payloads[0]["parse_mode"], "Markdown")
        self.assertTrue(captured_payloads[0]["text"].endswith(f"_Ref: {ref_id}_"))

    def test_parse_mode_none_omits_key_and_rewrites_ref_trailer(self):
        """parse_mode=None -> no "parse_mode" key in the payload at all, and
        the ref trailer is the unescaped "Ref: <id>" form."""
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"result": {"message_id": 2}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        ref_id = telegram_notify.send_text(
            "https://accounts.google.com/o/oauth2/auth?foo=bar",
            parse_mode=None,
        )

        self.assertEqual(len(captured_payloads), 1)
        self.assertNotIn("parse_mode", captured_payloads[0])
        self.assertTrue(captured_payloads[0]["text"].endswith(f"Ref: {ref_id}"))
        self.assertNotIn(f"_Ref: {ref_id}_", captured_payloads[0]["text"])


class TestReplyMarkupOption(unittest.TestCase):
    """Test the optional reply_markup kwarg on send_text (WP-2, reauth button).

    Telegram allows one keyboard per message, so a multi-part send must
    attach reply_markup to the LAST part's payload only, and it must be
    entirely absent (not even a null key) when not given.
    """

    def setUp(self):
        """Set up patches for each test."""
        self._patches = []

    def tearDown(self):
        """Clean up patches after each test."""
        for p in self._patches:
            p.stop()

    def _patch(self, obj, name, value):
        """Helper to patch an attribute and track it for cleanup."""
        p = patch.object(obj, name, value)
        p.start()
        self._patches.append(p)
        return value

    def test_default_omits_reply_markup_key(self):
        """No reply_markup kwarg -> payload carries no "reply_markup" key at all."""
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"result": {"message_id": 1}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        telegram_notify.send_text("Test message")

        self.assertEqual(len(captured_payloads), 1)
        self.assertNotIn("reply_markup", captured_payloads[0])

    def test_reply_markup_attached_to_single_part_payload(self):
        """A single-part message (last part == only part) carries the given
        reply_markup dict verbatim in the payload."""
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"result": {"message_id": 1}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        keyboard = {"inline_keyboard": [[{"text": "Button", "callback_data": "reauth:google"}]]}
        telegram_notify.send_text("Test message", reply_markup=keyboard)

        self.assertEqual(len(captured_payloads), 1)
        self.assertEqual(captured_payloads[0]["reply_markup"], keyboard)

    def test_reply_markup_attached_only_to_last_part_of_multi_part_send(self):
        """A message long enough to split into multiple parts must carry
        reply_markup on the LAST part's payload only — Telegram allows one
        keyboard per message."""
        mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
        self._patch(telegram_notify, "_resolve_routing", mock_resolve)

        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"result": {"message_id": len(captured_payloads)}}
            return resp

        self._patch(telegram_notify, "_post", mock_post)

        # Force a split: two paragraphs, each padded past a tiny max_len via
        # patching _split_message directly (keeps the test independent
        # of the real 4000-char threshold).
        self._patch(
            telegram_notify, "_split_message",
            lambda text, max_len=4000: ["part one", "part two"],
        )

        keyboard = {"inline_keyboard": [[{"text": "Button", "callback_data": "reauth:google"}]]}
        telegram_notify.send_text("irrelevant, _split_message is mocked", reply_markup=keyboard)

        self.assertEqual(len(captured_payloads), 2)
        self.assertNotIn("reply_markup", captured_payloads[0])
        self.assertEqual(captured_payloads[1]["reply_markup"], keyboard)


class TestDocument429Retry(unittest.TestCase):
    """Test 429 handling for send_document (AI-149)."""

    def setUp(self):
        """Set up patches for each test."""
        self._patches = []

    def tearDown(self):
        """Clean up patches after each test."""
        for p in self._patches:
            p.stop()

    def _patch(self, obj, name, value):
        """Helper to patch an attribute and track it for cleanup."""
        p = patch.object(obj, name, value)
        p.start()
        self._patches.append(p)
        return value

    def test_document_429_with_retry_after(self):
        """send_document also honors 429 retry_after for file uploads."""
        # Create a temporary test file
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "test.txt"
            test_file.write_text("Test content")

            # Mock dependencies
            mock_resolve = MagicMock(return_value=("token", ["-12345"], None))
            self._patch(telegram_notify, "_resolve_routing", mock_resolve)

            sleep_calls = []
            mock_sleep = lambda n: sleep_calls.append(n)
            self._patch(time, "sleep", mock_sleep)

            mock_log = MagicMock()
            self._patch(telegram_notify, "_log_skill_message_sent", mock_log)

            # Track _post_multipart calls
            post_call_count = 0

            def mock_post_multipart(url, data, files):
                nonlocal post_call_count
                post_call_count += 1
                resp = MagicMock()
                if post_call_count == 1:
                    # First call: 429 with retry_after: 3
                    resp.status_code = 429
                    resp.json.return_value = {"parameters": {"retry_after": 3}}
                else:
                    # Second call: success
                    resp.status_code = 200
                    resp.json.return_value = {"result": {"message_id": 111}}
                return resp

            self._patch(telegram_notify, "_post_multipart", mock_post_multipart)

            # Send a document
            ref_id = telegram_notify.send_document(str(test_file))

            # Assertions
            self.assertEqual(post_call_count, 2, "Should retry once after 429")
            self.assertEqual(len(sleep_calls), 1, "Should sleep exactly once")
            self.assertEqual(sleep_calls[0], 4, "Should sleep for retry_after+1 (3+1=4)")
            mock_log.assert_called()
            self.assertTrue(ref_id.startswith("s-"))


if __name__ == "__main__":
    unittest.main()
