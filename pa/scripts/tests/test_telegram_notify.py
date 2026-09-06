"""
Tests for the notify() reply_markup passthrough and the plain-text fallback
keyboard carry in telegram_notify.py (Wave-1 WP-C, 2026-09-02).

Defect pinned here (SPEC §1.2): the plain-text FALLBACK payload rebuilt
{"chat_id", "text", "message_thread_id"} WITHOUT reply_markup, so a keyboard was
silently lost exactly when Markdown parsing failed — the most common failure mode
for LLM output. The TypeScript twin carries reply_markup into its fallback
deliberately (pa/src/telegram.ts, 2026-08-24 buttons program P3); the Python
sender now matches, and notify() passes reply_markup through.

Hermetic unittest tests that patch network dependencies — no real Telegram API
calls. Style matches the sibling test_telegram_notify_429.py (pytest-compatible
unittest; that sibling documents why the suite stays pytest-free).
"""

import sys
import unittest
from unittest.mock import MagicMock, patch

# Import telegram_notify as a module from the source tree (sibling convention)
sys.path.insert(0, "pa/src")
import telegram_notify


KEYBOARD = {"inline_keyboard": [[{"text": "Button", "callback_data": "reauth:google"}]]}


def _ok_resp(message_id=1):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"result": {"message_id": message_id}}
    return resp


def _parse_error_resp():
    resp = MagicMock()
    resp.status_code = 400
    resp.text = "Bad Request: can't parse entities"
    return resp


class _PatchedTestCase(unittest.TestCase):
    """Shared patch bookkeeping (same shape as test_telegram_notify_429.py)."""

    def setUp(self):
        self._patches = []

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def _patch(self, obj, name, value):
        p = patch.object(obj, name, value)
        p.start()
        self._patches.append(p)
        return value

    def _patch_routing_and_log(self):
        self._patch(
            telegram_notify,
            "_resolve_routing",
            MagicMock(return_value=("token", ["-12345"], None)),
        )
        mock_log = MagicMock()
        self._patch(telegram_notify, "_log_skill_message_sent", mock_log)
        return mock_log


class TestNotifyReplyMarkupPassthrough(_PatchedTestCase):
    """notify() must forward reply_markup to send_text (Wave-1 WP-C passthrough)."""

    def test_notify_passes_reply_markup_through(self):
        """notify(message, reply_markup=kb) attaches the keyboard to the payload."""
        self._patch_routing_and_log()

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            return _ok_resp()

        self._patch(telegram_notify, "_post", mock_post)

        ref_id = telegram_notify.notify("Status update", reply_markup=KEYBOARD)

        self.assertEqual(len(captured_payloads), 1)
        self.assertEqual(captured_payloads[0]["reply_markup"], KEYBOARD)
        self.assertTrue(ref_id.startswith("s-"))

    def test_notify_without_reply_markup_omits_key(self):
        """Backward compat: notify() without reply_markup produces a payload with
        no "reply_markup" key at all — byte-shape identical to the pre-Wave-1
        behavior every existing caller depends on."""
        self._patch_routing_and_log()

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            return _ok_resp()

        self._patch(telegram_notify, "_post", mock_post)

        telegram_notify.notify("Status update")

        self.assertEqual(len(captured_payloads), 1)
        self.assertNotIn("reply_markup", captured_payloads[0])


class TestFallbackKeepsReplyMarkup(_PatchedTestCase):
    """The plain-text fallback (Markdown parse failure) must keep the keyboard."""

    def test_send_text_fallback_keeps_reply_markup(self):
        """A 400 Markdown-parse failure on the (single, last) part re-sends the
        fallback WITH reply_markup — the Wave-1 WP-C defect fix. The fallback is
        plain text (no parse_mode) and carries the unescaped Ref trailer."""
        self._patch_routing_and_log()

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            if len(captured_payloads) == 1:
                return _parse_error_resp()
            return _ok_resp(message_id=2)

        self._patch(telegram_notify, "_post", mock_post)

        ref_id = telegram_notify.send_text("Briefing text", reply_markup=KEYBOARD)

        self.assertEqual(len(captured_payloads), 2, "Markdown attempt + plain fallback")
        self.assertEqual(captured_payloads[0]["reply_markup"], KEYBOARD,
                         "the primary attempt carries the keyboard")
        self.assertEqual(captured_payloads[1]["reply_markup"], KEYBOARD,
                         "the plain-text fallback must carry the keyboard too")
        self.assertNotIn("parse_mode", captured_payloads[1], "the fallback is plain text")
        self.assertTrue(captured_payloads[1]["text"].endswith(f"Ref: {ref_id}"))
        self.assertTrue(ref_id.startswith("s-"))

    def test_fallback_omits_reply_markup_when_none_given(self):
        """Backward compat: without reply_markup, the fallback payload carries no
        "reply_markup" key (the pre-Wave-1 fallback shape, unchanged)."""
        self._patch_routing_and_log()

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            if len(captured_payloads) == 1:
                return _parse_error_resp()
            return _ok_resp(message_id=2)

        self._patch(telegram_notify, "_post", mock_post)

        telegram_notify.send_text("Briefing text")

        self.assertEqual(len(captured_payloads), 2)
        self.assertNotIn("reply_markup", captured_payloads[1])

    def test_fallback_of_non_last_part_carries_no_keyboard(self):
        """reply_markup attaches to the LAST part only (one keyboard per message);
        a Markdown failure on a NON-last part must send a keyboard-less fallback —
        the keyboard still rides the (later) last part's own send."""
        self._patch_routing_and_log()
        self._patch(
            telegram_notify,
            "_split_message",
            lambda text, max_len=4000: ["part one", "part two"],
        )

        captured_payloads = []

        def mock_post(url, payload):
            captured_payloads.append(payload)
            if len(captured_payloads) == 1:
                # Part 1 of 2 fails Markdown parsing
                return _parse_error_resp()
            if len(captured_payloads) == 2:
                # Part 1's plain-text fallback
                return _ok_resp(message_id=2)
            # Part 2 (last) succeeds on the Markdown attempt
            return _ok_resp(message_id=3)

        self._patch(telegram_notify, "_post", mock_post)

        telegram_notify.send_text("irrelevant, _split_message is mocked", reply_markup=KEYBOARD)

        self.assertEqual(len(captured_payloads), 3, "part1 md + part1 fallback + part2 md")
        self.assertNotIn("reply_markup", captured_payloads[1],
                         "a non-last part's fallback must not steal the keyboard")
        self.assertEqual(captured_payloads[2]["reply_markup"], KEYBOARD,
                         "the last part still carries the keyboard")


if __name__ == "__main__":
    unittest.main()
