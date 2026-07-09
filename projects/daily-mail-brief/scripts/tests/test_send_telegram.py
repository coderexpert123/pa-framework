"""
Tests for send_telegram.py's OWN remaining logic.

send_telegram.py used to be a self-contained Telegram sender; it now
delegates delivery to pa/src/telegram_notify.py's send_text/send_document
(see the module docstring). The routing/thread-id/fallback-retry/failure-
accumulation behaviors those functions implement are tested directly in
pa/src/tests/test_telegram_notify.py's TestSendTextRoutingAndRetry (migrated
there 2026-07-08, deep-recheck Phase 2) — not duplicated here.

_check_assertion is also NOT covered here: it already has comprehensive
coverage in test_send_telegram_assert.py's TestAssertionCheck (5 tests),
unaffected by the delegation rewrite.

What's left, and what this file covers: _build_hallucination_body (no
existing coverage anywhere), and main()'s file-type dispatch (.pdf ->
send_document, else -> send_text), with both mocked at the send_telegram
module boundary.
"""
import sys
import os
import json
import tempfile
import shutil
import unittest
from unittest.mock import patch, MagicMock

# Allow importing from parent scripts dir
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _import_fresh():
    if 'send_telegram' in sys.modules:
        del sys.modules['send_telegram']
    import send_telegram
    return send_telegram


class TestBuildHallucinationBody(unittest.TestCase):
    def test_includes_claimed_actual_and_first_line(self):
        mod = _import_fresh()
        with patch.dict(os.environ, {"PA_WORKER_NAME": "zclaude"}, clear=False):
            body = mod._build_hallucination_body("5", 3, "[pa assert] emails.json listed=5")
        self.assertIn("Expected: 3", body)
        self.assertIn("Claimed: 5", body)
        self.assertIn("[pa assert] emails.json listed=5", body)
        self.assertIn("zclaude", body)
        self.assertIn("NOT sent", body)

    def test_truncates_long_first_line(self):
        mod = _import_fresh()
        long_line = "x" * 500
        body = mod._build_hallucination_body("1", 1, long_line)
        # first_line is sliced to [:200] in the body builder
        self.assertNotIn("x" * 201, body)
        self.assertIn("x" * 200, body)

    def test_unknown_worker_when_env_unset(self):
        mod = _import_fresh()
        with patch.dict(os.environ, {}, clear=True):
            body = mod._build_hallucination_body("1", 1, "line")
        self.assertIn("<unknown>", body)


class TestMainFileTypeDispatch(unittest.TestCase):
    """main()'s .pdf -> send_document vs else -> send_text branch, and the
    assertion-header gate feeding into send_text. Both delegated functions
    are mocked at the send_telegram module boundary — their own routing/
    retry logic is tested directly in test_telegram_notify.py."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.pa_home = tempfile.mkdtemp()
        self.env_patch = patch.dict(os.environ, {"PA_HOME": self.pa_home}, clear=False)
        self.env_patch.start()

    def tearDown(self):
        self.env_patch.stop()
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        shutil.rmtree(self.pa_home, ignore_errors=True)

    def test_pdf_path_dispatches_to_send_document(self):
        mod = _import_fresh()
        pdf_path = os.path.join(self.tmpdir, "report.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF fake")

        with patch.object(mod, "send_document") as mock_send_document, \
             patch.object(mod, "send_text") as mock_send_text, \
             patch("sys.argv", ["send_telegram.py", pdf_path]):
            mod.main()

        mock_send_document.assert_called_once_with(pdf_path)
        mock_send_text.assert_not_called()

    def test_markdown_path_with_valid_assertion_dispatches_to_send_text(self):
        mod = _import_fresh()
        emails_path = os.path.join(mod.PROJECT_ROOT, "emails.json")
        saved = None
        if os.path.exists(emails_path):
            with open(emails_path, encoding="utf-8") as f:
                saved = f.read()
        try:
            with open(emails_path, "w", encoding="utf-8") as f:
                json.dump({"emails": [{"id": "1"}]}, f)

            briefing = os.path.join(self.tmpdir, "briefing_output.md")
            with open(briefing, "w", encoding="utf-8") as f:
                f.write("[pa assert] emails.json listed=1\n\nActual briefing body")

            with patch.object(mod, "send_document") as mock_send_document, \
                 patch.object(mod, "send_text") as mock_send_text, \
                 patch("sys.argv", ["send_telegram.py", briefing]):
                mod.main()

            mock_send_document.assert_not_called()
            mock_send_text.assert_called_once()
            sent_text = mock_send_text.call_args[0][0]
            # The assert header line is stripped before sending.
            self.assertNotIn("[pa assert]", sent_text)
            self.assertIn("Actual briefing body", sent_text)
        finally:
            if saved is not None:
                with open(emails_path, "w", encoding="utf-8") as f:
                    f.write(saved)
            elif os.path.exists(emails_path):
                os.remove(emails_path)

    def test_missing_file_exits_before_dispatching(self):
        mod = _import_fresh()
        with patch.object(mod, "send_document") as mock_send_document, \
             patch.object(mod, "send_text") as mock_send_text, \
             patch("sys.argv", ["send_telegram.py", os.path.join(self.tmpdir, "does-not-exist.md")]):
            with self.assertRaises(SystemExit):
                mod.main()
        mock_send_document.assert_not_called()
        mock_send_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
