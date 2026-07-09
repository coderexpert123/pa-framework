"""Tests for send_telegram.py assertion check and failure mode."""
import json
import os
import sys
import tempfile
import shutil
import unittest
from unittest.mock import patch

# The test needs to work with the real PROJECT_ROOT since send_telegram.py
# uses it as a module-level constant. We'll create test fixtures in the
# actual project root and clean up after.

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
EMAILS_JSON = os.path.join(PROJECT_ROOT, "emails.json")


class TestAssertionCheck(unittest.TestCase):
    """Test _check_assertion in send_telegram.py."""

    def setUp(self):
        self.pa_home = tempfile.mkdtemp()
        self.fetch_failed = os.path.join(self.pa_home, "daily-mail-brief-fetch-failed.json")
        self.env_patch = patch.dict(os.environ, {"PA_HOME": self.pa_home}, clear=False)
        self.env_patch.start()
        self._saved_emails = None
        if os.path.exists(EMAILS_JSON):
            with open(EMAILS_JSON, 'r', encoding='utf-8') as f:
                self._saved_emails = f.read()
        self._saved_failed = None
        if os.path.exists(self.fetch_failed):
            with open(self.fetch_failed, 'r', encoding='utf-8') as f:
                self._saved_failed = f.read()

    def tearDown(self):
        self.env_patch.stop()
        if self._saved_emails is not None:
            with open(EMAILS_JSON, 'w', encoding='utf-8') as f:
                f.write(self._saved_emails)
        elif os.path.exists(EMAILS_JSON):
            os.remove(EMAILS_JSON)
        if self._saved_failed is not None:
            with open(self.fetch_failed, 'w', encoding='utf-8') as f:
                f.write(self._saved_failed)
        elif os.path.exists(self.fetch_failed):
            os.remove(self.fetch_failed)
        shutil.rmtree(self.pa_home, ignore_errors=True)

    def _import(self):
        if 'send_telegram' in sys.modules:
            del sys.modules['send_telegram']
        sys.path.insert(0, os.path.join(SCRIPT_DIR, '..'))
        import send_telegram
        return send_telegram

    def test_valid_assertion_passes(self):
        """Valid [pa assert] header with matching count â†’ ok=True."""
        mod = self._import()
        with open(EMAILS_JSON, 'w', encoding='utf-8') as f:
            json.dump({"emails": [{"id": "1"}, {"id": "2"}, {"id": "3"}]}, f)   


        text = "[pa assert] emails.json listed=3\n\nBriefing content here"
        ok, claimed, actual = mod._check_assertion(text)
        self.assertTrue(ok)
        self.assertEqual(claimed, "3")
        self.assertEqual(actual, 3)

    def test_mismatched_count_fails(self):
        """Mismatched count → ok=False."""
        mod = self._import()
        with open(EMAILS_JSON, 'w', encoding='utf-8') as f:
            json.dump({"emails": [{"id": "1"}, {"id": "2"}, {"id": "3"}]}, f)   

        text = "[pa assert] emails.json listed=99\n\nBriefing"
        ok, claimed, actual = mod._check_assertion(text)
        self.assertFalse(ok)
        self.assertEqual(claimed, "99")
        self.assertEqual(actual, 3)

    def test_missing_header_fails(self):
        """No [pa assert] header → ok=False."""
        mod = self._import()
        text = "Just a normal briefing without assert header"
        ok, claimed, actual = mod._check_assertion(text)
        self.assertFalse(ok)
        self.assertEqual(claimed, "<missing>")

    def test_zero_email_assertion(self):
        """Zero-email path with listed=0 → ok=True."""
        mod = self._import()
        with open(EMAILS_JSON, 'w', encoding='utf-8') as f:
            json.dump({"emails": []}, f)

        text = "[pa assert] emails.json listed=0\n\nNo emails."
        ok, claimed, actual = mod._check_assertion(text)
        self.assertTrue(ok)
        self.assertEqual(actual, 0)

    def test_missing_emails_json(self):
        """emails.json absent → ok=False."""
        if os.path.exists(EMAILS_JSON):
            os.remove(EMAILS_JSON)
        mod = self._import()
        text = "[pa assert] emails.json listed=3\n\nBriefing"
        ok, claimed, actual = mod._check_assertion(text)
        self.assertFalse(ok)


class TestFailureMode(unittest.TestCase):
    """Test that the PA_HOME failure marker bypasses assertion check."""

    def setUp(self):
        self.pa_home = tempfile.mkdtemp()
        self.fetch_failed = os.path.join(self.pa_home, "daily-mail-brief-fetch-failed.json")
        self.env_patch = patch.dict(os.environ, {"PA_HOME": self.pa_home}, clear=False)
        self.env_patch.start()
        self._saved_failed = None
        if os.path.exists(self.fetch_failed):
            with open(self.fetch_failed, 'r', encoding='utf-8') as f:
                self._saved_failed = f.read()

    def tearDown(self):
        self.env_patch.stop()
        if self._saved_failed is not None:
            with open(self.fetch_failed, 'w', encoding='utf-8') as f:
                f.write(self._saved_failed)
        elif os.path.exists(self.fetch_failed):
            os.remove(self.fetch_failed)
        shutil.rmtree(self.pa_home, ignore_errors=True)

    def test_failure_mode_sends_without_assert(self):
        """When the PA_HOME failure marker exists, send_telegram bypasses assertion and sends."""
        # Create failure marker
        with open(self.fetch_failed, 'w', encoding='utf-8') as f:
            json.dump({"status": "auth", "reason": "token expired"}, f)

        # Create briefing without assert header
        tmpdir = tempfile.mkdtemp()
        briefing = os.path.join(tmpdir, 'briefing_output.md')
        with open(briefing, 'w', encoding='utf-8') as f:
            f.write("Failure notice - no assert header")

        mod = None
        if 'send_telegram' in sys.modules:
            del sys.modules['send_telegram']
        sys.path.insert(0, os.path.join(SCRIPT_DIR, '..'))
        import send_telegram
        mod = send_telegram

        # send_telegram.py delegates to pa/src/telegram_notify.py's send_text
        # (not the old self-contained send() this test used to patch — removed
        # in the delegation rewrite). mod.send_text is the module-level binding
        # created by `from telegram_notify import send_document, send_text`,
        # so patching it here correctly intercepts main()'s call.
        with patch.object(mod, 'send_text') as mock_send_text:
            with patch('sys.argv', ['send_telegram.py', briefing]):
                mod.main()
            mock_send_text.assert_called_once()
            sent_text = mock_send_text.call_args[0][0]
            self.assertIn("Failure notice", sent_text)

        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
