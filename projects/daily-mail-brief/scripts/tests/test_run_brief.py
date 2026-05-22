"""Unit tests for run_brief.py: call_gemini error formatting and state-advancement logic."""
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch
from types import SimpleNamespace

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPT_DIR)

import run_brief


class TestCallGeminiErrorFormat(unittest.TestCase):
    """call_gemini must surface both stderr and stdout on non-zero exit."""

    def _make_result(self, returncode, stderr, stdout):
        return SimpleNamespace(returncode=returncode, stderr=stderr, stdout=stdout)

    @patch("run_brief.subprocess.run")
    def test_stderr_only_when_stdout_empty(self, mock_run):
        mock_run.return_value = self._make_result(1, "some error", "")
        with self.assertRaises(RuntimeError) as ctx:
            run_brief.call_gemini("prompt")
        msg = str(ctx.exception)
        self.assertIn("some error", msg)
        self.assertNotIn("stdout:", msg)

    @patch("run_brief.subprocess.run")
    def test_stderr_and_stdout_when_stdout_nonempty(self, mock_run):
        mock_run.return_value = self._make_result(1, "startup noise", "actual api error")
        with self.assertRaises(RuntimeError) as ctx:
            run_brief.call_gemini("prompt")
        msg = str(ctx.exception)
        self.assertIn("startup noise", msg)
        self.assertIn("stdout:", msg)
        self.assertIn("actual api error", msg)

    @patch("run_brief.subprocess.run")
    def test_whitespace_only_stdout_not_included(self, mock_run):
        mock_run.return_value = self._make_result(1, "err", "   \n  ")
        with self.assertRaises(RuntimeError) as ctx:
            run_brief.call_gemini("prompt")
        self.assertNotIn("stdout:", str(ctx.exception))

    @patch("run_brief.subprocess.run")
    def test_success_returns_stripped_output(self, mock_run):
        mock_run.return_value = self._make_result(0, "", "  hello world  ")
        result = run_brief.call_gemini("prompt")
        self.assertEqual(result, "hello world")

    @patch("run_brief.subprocess.run")
    def test_noise_marker_stripped(self, mock_run):
        mock_run.return_value = self._make_result(
            0, "", "real output\nCreated execution plan for SessionEnd: foo"
        )
        result = run_brief.call_gemini("prompt")
        self.assertEqual(result, "real output")


class TestStateAdvancementLogic(unittest.TestCase):
    """State must be written only after Gemini succeeds, not at fetch time."""

    def _make_fetch_data(self, window_end_utc="2026-05-17T13:30:00+00:00", listed=2):
        return {
            "window": "17 May 2026 05:00 – 17 May 2026 19:00 IST",
            "window_end_utc": window_end_utc,
            "listed_count": listed,
            "total_count": listed,
            "emails": [
                {"id": f"e{i}", "from": "a@b.com", "subject": "subj",
                 "gmail_category": "unknown", "in_inbox": True, "is_unread": True, "snippet": ""}
                for i in range(listed)
            ],
        }

    def _patch_run_py(self, fetch_data, gemini_side_effect=None, gemini_return="ok"):
        """Helper: patch run_py to return fake fetch output; patch call_gemini."""
        fetch_result = MagicMock()
        fetch_result.returncode = 0
        fetch_result.stdout = json.dumps(fetch_data)

        send_result = MagicMock()
        send_result.returncode = 0

        def fake_run_py(script, *args, check=True):
            if "fetch_headers" in script:
                return fetch_result
            if "preflight" in script:
                return MagicMock(returncode=0)
            return send_result

        return fake_run_py

    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_state_written_after_gemini_success(self, mock_gemini, mock_run_py, tmp_path=None):
        """When Gemini succeeds, state.json gets window_end_utc from fetch output."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            # Redirect PROJECT_ROOT to tmpdir
            orig_root = run_brief.PROJECT_ROOT
            run_brief.PROJECT_ROOT = tmpdir
            run_brief.FETCH_FAILED_FILE = os.path.join(tmpdir, ".fetch-failed.json")

            fetch_data = self._make_fetch_data()
            mock_run_py.side_effect = self._patch_run_py(fetch_data)
            # Gemini returns minimal valid output with markers
            mock_gemini.return_value = (
                "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
                "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
            )

            # Create a fake emails.json (needed by send_telegram assertion path, mocked here)
            emails_path = os.path.join(tmpdir, "emails.json")
            with open(emails_path, "w") as f:
                json.dump({"emails": [{}, {}], "listed_count": 2}, f)

            try:
                run_brief.main()
            except SystemExit:
                pass
            finally:
                run_brief.PROJECT_ROOT = orig_root
                run_brief.FETCH_FAILED_FILE = os.path.join(orig_root, ".fetch-failed.json")

            state_path = os.path.join(tmpdir, "state.json")
            self.assertTrue(os.path.exists(state_path), "state.json must be written after Gemini success")
            with open(state_path) as f:
                state = json.load(f)
            self.assertEqual(state["last_window_end_utc"], "2026-05-17T13:30:00+00:00")

    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_state_not_written_when_gemini_fails(self, mock_gemini, mock_run_py):
        """When Gemini fails both attempts, state.json must NOT be written."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            orig_root = run_brief.PROJECT_ROOT
            run_brief.PROJECT_ROOT = tmpdir
            run_brief.FETCH_FAILED_FILE = os.path.join(tmpdir, ".fetch-failed.json")

            fetch_data = self._make_fetch_data()
            mock_run_py.side_effect = self._patch_run_py(fetch_data)
            mock_gemini.side_effect = RuntimeError("Gemini exited 1: auth error")

            with patch("run_brief.time.sleep"):  # skip sleep delay
                try:
                    run_brief.main()
                except SystemExit:
                    pass
                finally:
                    run_brief.PROJECT_ROOT = orig_root
                    run_brief.FETCH_FAILED_FILE = os.path.join(orig_root, ".fetch-failed.json")

            state_path = os.path.join(tmpdir, "state.json")
            self.assertFalse(os.path.exists(state_path), "state.json must NOT be written when Gemini fails")

    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_fetch_failed_written_on_gemini_failure(self, mock_gemini, mock_run_py):
        """On Gemini failure, .fetch-failed.json must be written (send_telegram bypass)."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            orig_root = run_brief.PROJECT_ROOT
            run_brief.PROJECT_ROOT = tmpdir
            run_brief.FETCH_FAILED_FILE = os.path.join(tmpdir, ".fetch-failed.json")

            fetch_data = self._make_fetch_data()
            mock_run_py.side_effect = self._patch_run_py(fetch_data)
            mock_gemini.side_effect = RuntimeError("Gemini exited 1: auth error")

            fetch_failed_path = os.path.join(tmpdir, ".fetch-failed.json")
            content = None
            with patch("run_brief.time.sleep"):
                try:
                    run_brief.main()
                except SystemExit:
                    pass
                finally:
                    run_brief.PROJECT_ROOT = orig_root
                    run_brief.FETCH_FAILED_FILE = os.path.join(orig_root, ".fetch-failed.json")

            exists = os.path.exists(fetch_failed_path)
            if exists:
                with open(fetch_failed_path) as f:
                    content = json.load(f)
            self.assertTrue(exists, ".fetch-failed.json must be written on Gemini failure")
            self.assertIsNotNone(content, ".fetch-failed.json must be valid JSON")
            self.assertEqual(content.get("status"), "gemini")

    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_retry_succeeds_on_second_attempt(self, mock_gemini, mock_run_py):
        """State IS advanced when first Gemini attempt fails but second succeeds."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            orig_root = run_brief.PROJECT_ROOT
            run_brief.PROJECT_ROOT = tmpdir
            run_brief.FETCH_FAILED_FILE = os.path.join(tmpdir, ".fetch-failed.json")

            fetch_data = self._make_fetch_data()
            mock_run_py.side_effect = self._patch_run_py(fetch_data)

            call_count = {"n": 0}
            def gemini_fail_then_succeed(prompt):
                call_count["n"] += 1
                if call_count["n"] == 1:
                    raise RuntimeError("transient error")
                return (
                    "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
                    "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
                )
            mock_gemini.side_effect = gemini_fail_then_succeed

            emails_path = os.path.join(tmpdir, "emails.json")
            with open(emails_path, "w") as f:
                json.dump({"emails": [{}, {}], "listed_count": 2}, f)

            with patch("run_brief.time.sleep"):
                try:
                    run_brief.main()
                except SystemExit:
                    pass
                finally:
                    run_brief.PROJECT_ROOT = orig_root
                    run_brief.FETCH_FAILED_FILE = os.path.join(orig_root, ".fetch-failed.json")

            self.assertEqual(call_count["n"], 2, "Gemini must be called twice")
            state_path = os.path.join(tmpdir, "state.json")
            self.assertTrue(os.path.exists(state_path), "state.json must exist after retry success")


class TestMarkerParsing(unittest.TestCase):
    """Marker extraction must use index(), not split(), to handle duplicate markers."""

    def _parse_briefing(self, response):
        """Replicate run_brief marker parsing logic."""
        if "===BRIEFING_START===" in response and "===BRIEFING_END===" in response:
            b_start = response.index("===BRIEFING_START===") + len("===BRIEFING_START===")
            b_end = response.index("===BRIEFING_END===")
            return response[b_start:b_end].strip()
        return None

    def test_single_markers_extracted(self):
        response = "===BRIEFING_START===\ncontent\n===BRIEFING_END==="
        self.assertEqual(self._parse_briefing(response), "content")

    def test_duplicate_start_marker_uses_first_occurrence(self):
        response = "===BRIEFING_START===\n===BRIEFING_START===\nreal content\n===BRIEFING_END==="
        result = self._parse_briefing(response)
        self.assertIn("real content", result)

    def test_preamble_before_marker_ignored(self):
        response = "some preamble\n===BRIEFING_START===\nactual content\n===BRIEFING_END==="
        self.assertEqual(self._parse_briefing(response), "actual content")


class TestPreflightFailurePath(unittest.TestCase):
    """Preflight failure must write .fetch-failed.json before send_telegram so assertion is bypassed."""

    @patch("run_brief.run_py")
    def test_fetch_failed_written_on_preflight_failure(self, mock_run_py):
        """When preflight fails and no .fetch-failed.json exists, one is created before send_telegram."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            orig_root = run_brief.PROJECT_ROOT
            run_brief.PROJECT_ROOT = tmpdir
            run_brief.FETCH_FAILED_FILE = os.path.join(tmpdir, ".fetch-failed.json")

            preflight_fail = MagicMock()
            preflight_fail.returncode = 1
            preflight_fail.stderr = "token expired"

            send_result = MagicMock()
            send_result.returncode = 0

            def fake_run_py(script, *args, check=True):
                if "preflight" in script:
                    return preflight_fail
                return send_result

            mock_run_py.side_effect = fake_run_py

            try:
                run_brief.main()
            except SystemExit:
                pass
            finally:
                run_brief.PROJECT_ROOT = orig_root
                run_brief.FETCH_FAILED_FILE = os.path.join(orig_root, ".fetch-failed.json")

            fetch_failed_path = os.path.join(tmpdir, ".fetch-failed.json")
            self.assertTrue(os.path.exists(fetch_failed_path), ".fetch-failed.json must exist after preflight failure")
            with open(fetch_failed_path) as f:
                content = json.load(f)
            self.assertEqual(content.get("status"), "auth")


if __name__ == "__main__":
    unittest.main()
