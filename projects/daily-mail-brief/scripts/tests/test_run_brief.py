"""Unit tests for run_brief.py: call_gemini error formatting and state-advancement logic."""
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from unittest.mock import MagicMock, patch
from types import SimpleNamespace

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPT_DIR)

import run_brief


class RunBriefTestCase(unittest.TestCase):
    def setUp(self):
        self._orig_project_root = run_brief.PROJECT_ROOT
        self._project_tmp = tempfile.TemporaryDirectory()
        self.project_root = self._project_tmp.name
        self.pa_home = os.path.join(self.project_root, "pa-home")
        self.env_patch = patch.dict(os.environ, {"PA_HOME": self.pa_home}, clear=False)
        self.env_patch.start()
        run_brief.PROJECT_ROOT = self.project_root

    def tearDown(self):
        run_brief.PROJECT_ROOT = self._orig_project_root
        self.env_patch.stop()
        self._project_tmp.cleanup()

    def state_path(self):
        return os.path.join(self.pa_home, "daily-mail-brief-state.json")


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


class TestStateAdvancementLogic(RunBriefTestCase):
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

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_state_written_after_gemini_success(self, mock_gemini, mock_run_py, _mock_portfolio_context):
        """When Gemini succeeds, PA_HOME state gets window_end_utc from fetch output."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_gemini.return_value = (
            "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
            "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
        )

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        try:
            run_brief.main()
        except SystemExit:
            pass

        state_path = self.state_path()
        self.assertTrue(os.path.exists(state_path), "State must be written after Gemini success")
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["last_window_end_utc"], "2026-05-17T13:30:00+00:00")

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_state_not_written_when_gemini_fails(self, mock_gemini, mock_run_py, _mock_portfolio_context, _mock_notify):
        """When Gemini fails both attempts, state must NOT be written."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_gemini.side_effect = RuntimeError("Gemini exited 1: auth error")

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        self.assertFalse(os.path.exists(self.state_path()), "State must NOT be written when Gemini fails")

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_fetch_failed_written_on_gemini_failure(self, mock_gemini, mock_run_py, _mock_portfolio_context, _mock_notify):
        """On Gemini failure, the PA_HOME failure marker must be written."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_gemini.side_effect = RuntimeError("Gemini exited 1: auth error")

        fetch_failed_path = os.path.join(self.pa_home, "daily-mail-brief-fetch-failed.json")
        content = None
        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        exists = os.path.exists(fetch_failed_path)
        if exists:
            with open(fetch_failed_path, encoding="utf-8") as f:
                content = json.load(f)
        self.assertTrue(exists, "Failure marker must be written on Gemini failure")
        self.assertIsNotNone(content, "Failure marker must be valid JSON")
        self.assertEqual(content.get("status"), "gemini")

    def test_dedup_key_for_status(self):
        """Dedup keys stay lockstep with fetch_headers.py so an 'auth' failure
        collapses across both callers instead of double-notifying."""
        self.assertEqual(run_brief._dedup_key_for_status("auth"), "daily-mail-brief-auth")
        self.assertEqual(run_brief._dedup_key_for_status("gemini"), "daily-mail-brief-gemini")

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_gemini_failure_notifies_and_skips_briefings_send(
        self, mock_gemini, mock_run_py, _mock_portfolio_context, mock_notify
    ):
        """A Gemini failure must alert via the deduped notify path with status
        'gemini' and must NOT send_telegram.py into the user-facing briefings
        topic — the unthrottled direct send flooded thread 29 with 26 identical
        failure notices during one overnight auth blip (2026-07-12)."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_gemini.side_effect = RuntimeError("Gemini exited 42: auth cancelled")

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.args[0], "gemini")
        send_calls = [c for c in mock_run_py.call_args_list
                      if c.args and "send_telegram" in str(c.args[0])]
        self.assertEqual(send_calls, [], "Gemini-failure path must not send_telegram.py to the briefings topic")

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.detect_portfolio_statement_emails", return_value=[])
    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_retry_succeeds_on_second_attempt(self, mock_gemini, mock_run_py, _mock_detect, _mock_portfolio_context):
        """State is advanced when first Gemini attempt fails but second succeeds."""
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

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        self.assertEqual(call_count["n"], 2, "Gemini must be called exactly twice for brief retry")
        self.assertTrue(os.path.exists(self.state_path()), "State must exist after retry success")

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.detect_portfolio_statement_emails", return_value=[])
    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_retry_uses_stricter_marker_prompt_after_unmarked_response(
        self, mock_gemini, mock_run_py, _mock_detect, _mock_portfolio_context
    ):
        """Retry must explicitly require both marker pairs even when a section is empty."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        prompts = []

        def gemini_requires_retry_instruction(prompt):
            prompts.append(prompt)
            if len(prompts) == 1:
                return "Here is the summary without markers."
            if "even if one or both sections are empty" in prompt:
                return (
                    "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
                    "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
                )
            return "Still no markers."

        mock_gemini.side_effect = gemini_requires_retry_instruction

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        self.assertEqual(len(prompts), 2, "Gemini must be called twice after an unmarked response")
        self.assertIn("even if one or both sections are empty", prompts[1])
        self.assertTrue(os.path.exists(self.state_path()), "State must exist after marker-enforced retry success")

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_state_not_written_when_telegram_send_fails(self, mock_gemini, mock_run_py, _mock_portfolio_context):
        """Primary delivery failure must not advance state."""
        fetch_data = self._make_fetch_data()
        mock_gemini.return_value = (
            "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
            "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
        )

        fetch_result = MagicMock(returncode=0, stdout=json.dumps(fetch_data))
        preflight_result = MagicMock(returncode=0)
        send_fail = MagicMock(returncode=2, stderr="assertion failed")

        def fake_run_py(script, *args, check=True):
            if "preflight" in script:
                return preflight_result
            if "fetch_headers" in script:
                return fetch_result
            if "send_telegram" in script:
                return send_fail
            return MagicMock(returncode=0)

        mock_run_py.side_effect = fake_run_py

        with self.assertRaises(SystemExit):
            run_brief.main()

        self.assertFalse(os.path.exists(self.state_path()), "State must not advance when Telegram delivery fails")

    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_zero_email_window_advances_state_without_gemini(self, mock_gemini, mock_run_py):
        """A zero-email slot should still be marked processed."""
        fetch_data = {
            "status": "ok",
            "window": "17 May 2026 05:00 – 17 May 2026 19:00 IST",
            "window_end_utc": "2026-05-17T13:30:00+00:00",
            "listed_count": 0,
            "total_count": 0,
            "emails": [],
        }
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        run_brief.main()

        mock_gemini.assert_not_called()
        self.assertTrue(os.path.exists(self.state_path()), "Zero-email slots must advance state")

    @patch("run_brief.run_py")
    @patch("run_brief.call_gemini")
    def test_already_processed_window_short_circuits(self, mock_gemini, mock_run_py):
        """Already-processed slots should exit without side effects."""
        fetch_data = {
            "status": "already_processed",
            "window": "17 May 2026 05:00 – 17 May 2026 19:00 IST",
            "window_end_utc": "2026-05-17T13:30:00+00:00",
            "listed_count": 0,
            "total_count": 0,
            "emails": [],
        }
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        run_brief.main()

        mock_gemini.assert_not_called()
        self.assertFalse(os.path.exists(self.state_path()), "Already-processed windows must not rewrite state")


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


class TestDetectPortfolioStatementEmails(unittest.TestCase):
    """detect_portfolio_statement_emails must classify via Gemini and parse robustly."""

    PORTFOLIO_EMAIL = {
        "id": "abc123",
        "from": "statements@example-broker.com",
        "subject": "Your Monthly Portfolio Statement - May 2026",
        "snippet": "Dear Account Holder, please find attached your monthly statement for May 2026.",
    }
    NEWS_EMAIL = {
        "id": "xyz999",
        "from": "alerts@economic-times.com",
        "subject": "Sensex rallies 500 points; Nifty at all-time high",
        "snippet": "Markets surged today as NSE and BSE saw heavy buying in banking stocks.",
    }
    # The tracked provider (BRIEF_STATEMENT_PROVIDER) — the only one that should
    # fire the trigger. Fixtures stay neutral: the real provider set lives in
    # ~/.pa/secrets.env, never in this public-tracked file.
    STATEMENT_EMAIL = {
        "id": "statement001",
        "from": "Sam Advisor <sam.advisor@example-wealth.test>",
        "subject": "MONTHLY REPORT- TESTOWNER CLIENT",
        "snippet": "Please find attached your monthly portfolio report from Example Wealth.",
    }
    BANK_ALERT_EMAIL = {
        "id": "bankalert001",
        "from": "alerts@example-bank.test",
        "subject": "A payment was made using your Credit Card",
        "snippet": "Dear Customer, Rs. 11178.38 has been debited from your Example Bank Credit Card.",
    }
    OTHER_BROKER_CONTRACT_NOTE_EMAIL = {
        "id": "otherbroker001",
        "from": "noreply@example-broker.test",
        "subject": "Contract Note for 03-Jul-2026",
        "snippet": "Please find attached your contract note for trades executed today.",
    }

    @patch("run_brief.call_gemini")
    def test_portfolio_statement_triggers(self, mock_gemini):
        mock_gemini.return_value = '["abc123"]'
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, ["abc123"])

    @patch("run_brief.call_gemini")
    def test_market_news_does_not_trigger(self, mock_gemini):
        mock_gemini.return_value = "[]"
        result = run_brief.detect_portfolio_statement_emails([self.NEWS_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_gemini_failure_returns_empty(self, mock_gemini):
        mock_gemini.side_effect = RuntimeError("auth cancelled")
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_json_embedded_in_text_parsed_correctly(self, mock_gemini):
        # Gemini often wraps JSON in prose
        mock_gemini.return_value = 'The emails that qualify are: ["abc123"]\nThat is the only one.'
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, ["abc123"])

    @patch("run_brief.call_gemini")
    def test_empty_email_list_skips_gemini(self, mock_gemini):
        result = run_brief.detect_portfolio_statement_emails([])
        mock_gemini.assert_not_called()
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_detect_triggers_fires_portfolio_reports_when_statement_found(self, mock_gemini):
        mock_gemini.return_value = '["abc123"]'
        result = run_brief.detect_triggers([self.PORTFOLIO_EMAIL])
        self.assertIn("portfolio-reports", result)

    @patch("run_brief.call_gemini")
    def test_detect_triggers_empty_when_only_news_emails(self, mock_gemini):
        mock_gemini.return_value = "[]"
        result = run_brief.detect_triggers([self.NEWS_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_detect_triggers_empty_on_gemini_failure(self, mock_gemini):
        mock_gemini.side_effect = RuntimeError("timeout")
        result = run_brief.detect_triggers([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_gemini_returns_non_list_json_is_safe(self, mock_gemini):
        # Gemini returns valid JSON that's not a list — must not crash
        mock_gemini.return_value = '{"ids": ["abc123"]}'
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_email_missing_id_field_does_not_crash(self, mock_gemini):
        # If an email dict is missing "id", must return [] gracefully, not raise
        bad_email = {"from": "x@y.com", "subject": "Statement", "snippet": ""}
        result = run_brief.detect_portfolio_statement_emails([bad_email])
        self.assertEqual(result, [])
        mock_gemini.assert_not_called()  # should fail before reaching call_gemini

    @patch("run_brief.call_gemini")
    def test_tracked_provider_statement_triggers(self, mock_gemini):
        mock_gemini.return_value = '["statement001"]'
        result = run_brief.detect_portfolio_statement_emails([self.STATEMENT_EMAIL])
        self.assertEqual(result, ["statement001"])

    @patch("run_brief.call_gemini")
    def test_bank_alert_does_not_trigger(self, mock_gemini):
        # Routine bank transactional alerts must not be flagged as portfolio statements
        # (this was the primary source of near-daily false triggers before the prompt fix)
        mock_gemini.return_value = "[]"
        result = run_brief.detect_portfolio_statement_emails([self.BANK_ALERT_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_other_broker_contract_note_does_not_trigger(self, mock_gemini):
        # Other-broker statements must not fire the ad-hoc trigger — only the
        # configured BRIEF_STATEMENT_PROVIDER should
        mock_gemini.return_value = "[]"
        result = run_brief.detect_portfolio_statement_emails([self.OTHER_BROKER_CONTRACT_NOTE_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_gemini")
    def test_detect_triggers_logs_matched_sender_and_subject(self, mock_gemini):
        mock_gemini.return_value = '["statement001"]'
        stderr = StringIO()
        with redirect_stderr(stderr):
            run_brief.detect_triggers([self.STATEMENT_EMAIL])
        logged = stderr.getvalue()
        self.assertIn("MONTHLY REPORT- TESTOWNER CLIENT", logged)
        self.assertIn("Sam Advisor", logged)

    @patch("run_brief.call_gemini")
    def test_detect_triggers_mixed_batch_only_tracked_provider_triggers(self, mock_gemini):
        # A batch containing both a genuine tracked-provider statement and noise
        # (bank alert, market news) should trigger only on the tracked match.
        mock_gemini.return_value = '["statement001"]'
        result = run_brief.detect_triggers(
            [self.STATEMENT_EMAIL, self.BANK_ALERT_EMAIL, self.NEWS_EMAIL]
        )
        self.assertIn("portfolio-reports", result)


class TestPreflightFailurePath(RunBriefTestCase):
    """Preflight failure must write the failure marker and alert via the deduped
    `pa notify` path (pa-alerts), never a direct send into the briefings topic."""

    @patch("run_brief._notify_failure")
    @patch("run_brief.run_py")
    def test_fetch_failed_written_on_preflight_failure(self, mock_run_py, mock_notify):
        """When preflight fails and no marker exists, one is created and the alert
        goes through _notify_failure (status 'auth'), not send_telegram.py."""
        preflight_fail = MagicMock(returncode=1, stderr="token expired")
        send_result = MagicMock(returncode=0)

        def fake_run_py(script, *args, check=True):
            if "preflight" in script:
                return preflight_fail
            return send_result

        mock_run_py.side_effect = fake_run_py

        try:
            run_brief.main()
        except SystemExit:
            pass

        fetch_failed_path = os.path.join(self.pa_home, "daily-mail-brief-fetch-failed.json")
        self.assertTrue(os.path.exists(fetch_failed_path), "Failure marker must exist after preflight failure")
        with open(fetch_failed_path, encoding="utf-8") as f:
            content = json.load(f)
        self.assertEqual(content.get("status"), "auth")
        # Alert must route through the deduped notify path, not send_telegram.py
        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.args[0], "auth")
        send_calls = [c for c in mock_run_py.call_args_list
                      if c.args and "send_telegram" in str(c.args[0])]
        self.assertEqual(send_calls, [], "Preflight failure must not send_telegram.py to the briefings topic")


class TestLoadPortfolioContext(unittest.TestCase):
    """load_portfolio_context() is pure file-I/O + parsing (no LLM call) — must be
    resilient (fail-soft) and correctly skip the excluded providers."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.json_dir = self._tmp.name
        self._orig_dir = run_brief.PORTFOLIO_JSON_DIR
        run_brief.PORTFOLIO_JSON_DIR = self.json_dir
        # Owner has no default (public-repo hygiene, AI-094) — pin a placeholder.
        self._orig_owner = run_brief.PORTFOLIO_CONTEXT_OWNER
        run_brief.PORTFOLIO_CONTEXT_OWNER = "Testowner"
        # Excluded providers are env-driven with an empty default for the same
        # reason — pin neutral placeholders instead of the real provider set.
        self._orig_excluded = run_brief.PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS
        run_brief.PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS = {"Excludedbroker", "Deferredbroker"}

    def tearDown(self):
        run_brief.PORTFOLIO_JSON_DIR = self._orig_dir
        run_brief.PORTFOLIO_CONTEXT_OWNER = self._orig_owner
        run_brief.PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS = self._orig_excluded
        self._tmp.cleanup()

    def _write_snapshot(self, filename, report_date, total_values):
        data = {
            "report_metadata": {"owner": "Testowner", "report_date": report_date},
            "summary": [{"asset_class": "Equity", "current_value": v} for v in total_values],
        }
        with open(os.path.join(self.json_dir, filename), "w", encoding="utf-8") as f:
            json.dump(data, f)

    def test_unset_owner_disables_grounding(self):
        # AI-094: no personal-name default — empty owner must fail soft, not match everything.
        self._write_snapshot("2026-06-01_Testowner_Brokerone.pdf_FullData.json", "2026-06-01", [100000])
        run_brief.PORTFOLIO_CONTEXT_OWNER = ""
        self.assertEqual(run_brief.load_portfolio_context(), "")

    def test_missing_directory_returns_empty_string(self):
        run_brief.PORTFOLIO_JSON_DIR = os.path.join(self.json_dir, "does-not-exist")
        self.assertEqual(run_brief.load_portfolio_context(), "")

    def test_empty_directory_returns_empty_string(self):
        self.assertEqual(run_brief.load_portfolio_context(), "")

    def test_separately_reported_provider_excluded(self):
        self._write_snapshot("2026-06-01_Testowner_Excludedbroker.pdf_FullData.json", "2026-06-01", [100000])
        result = run_brief.load_portfolio_context()
        self.assertEqual(result, "")

    def test_deferred_provider_excluded(self):
        self._write_snapshot("2026-06-01_Testowner_Deferredbroker.pdf_FullData.json", "2026-06-01", [50000])
        result = run_brief.load_portfolio_context()
        self.assertEqual(result, "")

    def test_exclusion_is_case_insensitive(self):
        # Snapshot filenames carry the provider's own casing; the configured
        # exclusion list must match regardless of how either side is cased.
        self._write_snapshot("2026-06-01_Testowner_EXCLUDEDBROKER.pdf_FullData.json", "2026-06-01", [100000])
        self.assertEqual(run_brief.load_portfolio_context(), "")

    def test_empty_exclusion_list_includes_everything(self):
        # Default (nothing configured) must not silently drop providers.
        run_brief.PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS = set()
        self._write_snapshot("2026-06-01_Testowner_Excludedbroker.pdf_FullData.json", "2026-06-01", [100000])
        result = run_brief.load_portfolio_context()
        self.assertIn("Excludedbroker", result)
        self.assertNotIn("excludes", result, "no scope note when nothing is excluded")

    def test_other_owner_excluded(self):
        self._write_snapshot("2026-06-01_Otherperson_Excludedbroker.pdf_FullData.json", "2026-06-01", [100000])
        self._write_snapshot("2026-06-01_Otherperson_Brokerone.pdf_FullData.json", "2026-06-01", [200000])
        result = run_brief.load_portfolio_context()
        self.assertEqual(result, "", "Only the primary user's own snapshots should be used for grounding")

    def test_picks_most_recent_file_per_provider(self):
        self._write_snapshot("2026-01-01_Testowner_Brokerone.pdf_FullData.json", "2026-01-01", [100000])
        self._write_snapshot("2026-06-01_Testowner_Brokerone.pdf_FullData.json", "2026-06-01", [150000])
        result = run_brief.load_portfolio_context()
        self.assertIn("150,000", result)
        self.assertIn("2026-06-01", result)
        self.assertNotIn("100,000", result)

    def test_multiple_providers_all_included(self):
        self._write_snapshot("2026-06-01_Testowner_Brokerone.pdf_FullData.json", "2026-06-01", [100000])
        self._write_snapshot("2026-06-01_Testowner_Portfolio.pdf_FullData.json", "2026-06-01", [200000])
        result = run_brief.load_portfolio_context()
        self.assertIn("Brokerone", result)
        self.assertIn("Portfolio", result)

    def test_malformed_json_skipped_without_crashing(self):
        with open(os.path.join(self.json_dir, "2026-06-01_Testowner_Brokerone.pdf_FullData.json"), "w") as f:
            f.write("{not valid json")
        result = run_brief.load_portfolio_context()
        self.assertEqual(result, "")

    def test_nonmatching_filename_ignored(self):
        with open(os.path.join(self.json_dir, "random_notes.txt"), "w") as f:
            f.write("irrelevant")
        with open(os.path.join(self.json_dir, "processed_log.json"), "w") as f:
            f.write("{}")
        result = run_brief.load_portfolio_context()
        self.assertEqual(result, "")

    def test_one_malformed_schema_does_not_wipe_out_other_providers(self):
        # Brokerone has a schema that would raise (report_metadata is null, and a
        # non-numeric current_value) — Portfolio is well-formed. The malformed
        # one must be skipped without discarding the valid one.
        bad_data = {
            "report_metadata": None,
            "summary": [{"asset_class": "Equity", "current_value": "not-a-number"}],
        }
        with open(
            os.path.join(self.json_dir, "2026-06-01_Testowner_Brokerone.pdf_FullData.json"),
            "w", encoding="utf-8",
        ) as f:
            json.dump(bad_data, f)
        self._write_snapshot("2026-06-01_Testowner_Portfolio.pdf_FullData.json", "2026-06-01", [200000])

        result = run_brief.load_portfolio_context()
        self.assertIn("Portfolio", result)
        self.assertIn("200,000", result)
        self.assertNotIn("Brokerone", result)


class TestProviderIdentifiersAreEnvDriven(unittest.TestCase):
    """The provider set is personal data and this file ships to the public mirror,
    so every provider name in a prompt must come from the env-driven module
    globals — never a literal in the source."""

    def setUp(self):
        self._orig = {
            name: getattr(run_brief, name)
            for name in (
                "STATEMENT_PROVIDER", "STATEMENT_SENDER_NAMES",
                "STATEMENT_EXAMPLE_SUBJECT", "STATEMENT_EXAMPLE_SENDER",
                "OTHER_PROVIDERS", "BANK_ALERT_SENDERS",
            )
        }
        run_brief.STATEMENT_PROVIDER = "Examplewealth"
        run_brief.STATEMENT_SENDER_NAMES = "Sam Advisor"
        run_brief.STATEMENT_EXAMPLE_SUBJECT = "MONTHLY REPORT- TESTOWNER CLIENT"
        run_brief.STATEMENT_EXAMPLE_SENDER = "Sam Advisor"
        run_brief.OTHER_PROVIDERS = ["Examplebroker", "Exampleplatform"]
        run_brief.BANK_ALERT_SENDERS = ["Examplebank"]

    def tearDown(self):
        for name, value in self._orig.items():
            setattr(run_brief, name, value)

    def _classifier_prompt(self):
        with patch("run_brief.call_gemini", return_value="[]") as mock_gemini:
            run_brief.detect_portfolio_statement_emails(
                [{"id": "x", "from": "a@b.test", "subject": "s", "snippet": "n"}]
            )
        return mock_gemini.call_args.args[0]

    def test_classifier_prompt_uses_configured_provider(self):
        prompt = self._classifier_prompt()
        self.assertIn("EXAMPLEWEALTH", prompt, "tracked provider named in upper case")
        self.assertIn("Sam Advisor", prompt)
        self.assertIn("MONTHLY REPORT- TESTOWNER CLIENT", prompt)
        self.assertIn("Examplebroker, Exampleplatform", prompt)
        self.assertIn("Examplebank", prompt)
        self.assertIn("not Examplewealth", prompt)

    def test_classifier_prompt_degrades_cleanly_when_lists_unset(self):
        run_brief.OTHER_PROVIDERS = []
        run_brief.BANK_ALERT_SENDERS = []
        prompt = self._classifier_prompt()
        # Still a usable instruction, just without the deployment's specifics.
        self.assertIn("any provider that is not Examplewealth", prompt)
        self.assertIn("e-mandate notices\n", prompt)
        self.assertIn("Return ONLY a JSON array", prompt)

    def test_grounding_rule_names_configured_providers(self):
        rule = run_brief.build_grounding_rule()
        self.assertIn("Examplebroker, Exampleplatform", rule)
        self.assertIn("NOT Examplewealth", rule)
        self.assertIn("NOT a routine Examplebank transactional alert", rule)

    def test_grounding_rule_omits_bank_caveat_when_unset(self):
        run_brief.BANK_ALERT_SENDERS = []
        rule = run_brief.build_grounding_rule()
        self.assertIn("NOT Examplewealth", rule)
        self.assertNotIn("transactional alert", rule)

    def test_build_prompt_embeds_the_grounding_rule(self):
        prompt = run_brief.build_prompt("some window", 3, "emails here")
        self.assertIn(run_brief.build_grounding_rule(), prompt)


if __name__ == "__main__":
    unittest.main()
