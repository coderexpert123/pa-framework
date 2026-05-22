"""
Tests for the send() function in send_telegram.py.
Covers: TELEGRAM_BRIEFING_CHAT_ID override, fallback to TELEGRAM_CHAT_ID,
thread ID routing, fallback retry preservation, and failure accumulation.
"""
import sys
import os
import unittest
from unittest.mock import patch, MagicMock

# Allow importing from parent scripts dir
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from send_telegram import send


def ok_response():
    r = MagicMock()
    r.status_code = 200
    return r


def fail_response(code=400, text="Bad Request"):
    r = MagicMock()
    r.status_code = code
    r.text = text
    return r


# Production env: TELEGRAM_BRIEFING_CHAT_ID set — only supergroup receives
PROD_ENV = {
    "TELEGRAM_BOT_TOKEN": "fake-token",
    "TELEGRAM_CHAT_ID": "1000000001,-1001234567890",
    "TELEGRAM_BRIEFING_CHAT_ID": "-1001234567890",
    "TELEGRAM_DAILY_BRIEFING_THREAD_ID": "29",
}

# Fallback env: no TELEGRAM_BRIEFING_CHAT_ID — uses TELEGRAM_CHAT_ID (both destinations)
FALLBACK_ENV = {
    "TELEGRAM_BOT_TOKEN": "fake-token",
    "TELEGRAM_CHAT_ID": "1000000001,-1001234567890",
    "TELEGRAM_DAILY_BRIEFING_THREAD_ID": "29",
}


class TestBriefingChatIdOverride(unittest.TestCase):
    """TELEGRAM_BRIEFING_CHAT_ID takes precedence over TELEGRAM_CHAT_ID."""

    @patch("send_telegram.requests.post", return_value=ok_response())
    @patch.dict(os.environ, PROD_ENV, clear=True)
    def test_only_supergroup_receives_when_briefing_chat_id_set(self, mock_post):
        send("Hello")
        chat_ids_called = {c[1]["json"]["chat_id"] for c in mock_post.call_args_list}
        self.assertIn("-1001234567890", chat_ids_called)
        self.assertNotIn("1000000001", chat_ids_called)

    @patch("send_telegram.requests.post", return_value=ok_response())
    @patch.dict(os.environ, FALLBACK_ENV, clear=True)
    def test_both_chats_receive_when_fallback_to_chat_id(self, mock_post):
        send("Hello")
        chat_ids_called = {c[1]["json"]["chat_id"] for c in mock_post.call_args_list}
        self.assertIn("1000000001", chat_ids_called)
        self.assertIn("-1001234567890", chat_ids_called)


class TestSendThreadIdRouting(unittest.TestCase):
    """Thread ID is applied to supergroup chats only."""

    @patch("send_telegram.requests.post", return_value=ok_response())
    @patch.dict(os.environ, PROD_ENV, clear=True)
    def test_supergroup_gets_thread_id(self, mock_post):
        send("Hello")
        calls = mock_post.call_args_list
        supergroup_call = next(c for c in calls if c[1]["json"]["chat_id"] == "-1001234567890")
        self.assertEqual(supergroup_call[1]["json"]["message_thread_id"], 29)

    @patch("send_telegram.requests.post", return_value=ok_response())
    @patch.dict(os.environ, {**PROD_ENV, "TELEGRAM_DAILY_BRIEFING_THREAD_ID": ""}, clear=True)
    def test_no_thread_id_env_sends_without_it(self, mock_post):
        """When env var is absent/empty, no message_thread_id."""
        send("Hello")
        for c in mock_post.call_args_list:
            self.assertNotIn("message_thread_id", c[1]["json"])


class TestSendFallbackRetry(unittest.TestCase):
    """Thread ID is preserved in the Markdown-fallback retry."""

    @patch("send_telegram.requests.post")
    @patch.dict(os.environ, PROD_ENV, clear=True)
    def test_fallback_preserves_thread_id(self, mock_post):
        # Supergroup Markdown fails then fallback succeeds.
        mock_post.side_effect = [fail_response(), ok_response()]
        send("Hello")
        fallback = next(
            c for c in mock_post.call_args_list
            if c[1]["json"].get("chat_id") == "-1001234567890"
            and "parse_mode" not in c[1]["json"]
        )
        self.assertEqual(fallback[1]["json"]["message_thread_id"], 29)


class TestSendFailureAccumulation(unittest.TestCase):
    """Both Markdown and fallback failing exits with error."""

    @patch("send_telegram.requests.post")
    @patch.dict(os.environ, PROD_ENV, clear=True)
    def test_exits_on_full_failure(self, mock_post):
        mock_post.side_effect = [fail_response(), fail_response()]
        with self.assertRaises(SystemExit):
            send("Hello")


if __name__ == "__main__":
    unittest.main()
