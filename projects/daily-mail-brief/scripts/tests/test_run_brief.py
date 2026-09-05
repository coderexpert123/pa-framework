"""Unit tests for run_brief.py: call_llm error formatting and state-advancement logic."""
import json
import os
import subprocess
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

class TestBuildAgyCommand(unittest.TestCase):
    """build_agy_command is a PURE command builder — unit-testable without a
    subprocess (2026-08-23, WP-F step 2b)."""

    def setUp(self):
        self._orig_cmd = run_brief.AGY_CMD
        self._orig_model = run_brief.AGY_MODEL
        self._orig_timeout = run_brief.AGY_PRINT_TIMEOUT

    def tearDown(self):
        run_brief.AGY_CMD = self._orig_cmd
        run_brief.AGY_MODEL = self._orig_model
        run_brief.AGY_PRINT_TIMEOUT = self._orig_timeout

    def test_flag_pairs_in_order_and_prompt_is_at_file_reference(self):
        run_brief.AGY_CMD = "D:/gemini-shim/agy.cmd"
        run_brief.AGY_MODEL = "gemini-3.7-flash-high"
        run_brief.AGY_PRINT_TIMEOUT = "10m"
        cmd = run_brief.build_agy_command("C:/wt/tmp/pa-prompt-abc123.txt")
        self.assertEqual(cmd, [
            "cmd", "/c", "D:/gemini-shim/agy.cmd",
            "--dangerously-skip-permissions",
            "--model", "gemini-3.7-flash-high",
            "--print-timeout", "10m",
            "--output-format", "text",
            "-p", "@C:/wt/tmp/pa-prompt-abc123.txt",
        ])

    def test_prompt_is_never_inlined(self):
        """The prompt text itself must never appear as its own argv element —
        only the @-file reference (worker-exec.ts:231 precedent, correction 28
        of the 2026-08-23 alerts-wave design, internal)."""
        cmd = run_brief.build_agy_command("some/prompt/path.txt")
        self.assertEqual(cmd[-1], "@some/prompt/path.txt")
        self.assertTrue(cmd[-1].startswith("@"))

    def test_model_and_timeout_come_from_module_globals(self):
        """AGY_MODEL/AGY_PRINT_TIMEOUT are populated from DAILY_MAIL_BRIEF_MODEL/
        DAILY_MAIL_BRIEF_PRINT_TIMEOUT at import time (see TestProviderIdentifiers
        AreEnvDriven for the same pattern used elsewhere in this file) — verified
        here via the module globals build_agy_command actually reads."""
        run_brief.AGY_MODEL = "custom-model"
        run_brief.AGY_PRINT_TIMEOUT = "5m"
        cmd = run_brief.build_agy_command("p.txt")
        self.assertIn("custom-model", cmd)
        self.assertIn("5m", cmd)


class TestBuildFallbackLlmCommand(unittest.TestCase):
    """build_fallback_llm_command is a PURE command builder (mirrors
    TestBuildAgyCommand). The prompt must travel on stdin — never argv — for
    the same ~32 KB Windows command-line cap reason build_agy_command's
    @-file reference exists."""

    def setUp(self):
        self._orig = run_brief.FALLBACK_LLM_CMD

    def tearDown(self):
        run_brief.FALLBACK_LLM_CMD = self._orig

    def test_flag_pairs_in_order_and_no_prompt_argument(self):
        run_brief.FALLBACK_LLM_CMD = "C:/Users/you/.local/bin/zclaude.bat"
        cmd = run_brief.build_fallback_llm_command()
        self.assertEqual(cmd, [
            "cmd", "/c", "C:/Users/you/.local/bin/zclaude.bat",
            "--dangerously-skip-permissions",
            "--output-format", "text",
            "-p",
        ])

    def test_prompt_text_never_appears_in_argv(self):
        cmd = run_brief.build_fallback_llm_command()
        # Print mode with no argument: the prompt arrives on stdin (call_llm
        # passes it via input=), so no argv slot can carry briefing content.
        self.assertEqual(cmd[-1], "-p")

    def test_command_comes_from_module_global(self):
        run_brief.FALLBACK_LLM_CMD = "C:/somewhere/other-cli.exe"
        self.assertIn("C:/somewhere/other-cli.exe", run_brief.build_fallback_llm_command())


class TestDurationToSeconds(unittest.TestCase):
    """_duration_to_seconds parses the --print-timeout duration syntax ('10m')
    so the Python-level subprocess bound can be sized from it."""

    def test_parses_s_m_h_and_bare_numbers(self):
        self.assertEqual(run_brief._duration_to_seconds("45s", 1), 45)
        self.assertEqual(run_brief._duration_to_seconds("10m", 1), 600)
        self.assertEqual(run_brief._duration_to_seconds("1h", 1), 3600)
        self.assertEqual(run_brief._duration_to_seconds("90", 1), 90)
        self.assertEqual(run_brief._duration_to_seconds("2.5m", 1), 150)

    def test_whitespace_and_case_tolerated(self):
        self.assertEqual(run_brief._duration_to_seconds(" 10M ", 1), 600)

    def test_unparseable_or_empty_falls_back(self):
        for bad in ("", "abc", "10x", "-5m", None):
            self.assertEqual(run_brief._duration_to_seconds(bad, 600), 600)


class TestCallLlmBoundedTimeout(unittest.TestCase):
    """The agy subprocess inside call_llm must be bounded at the Python level.

    --print-timeout is only advisory to the CLI: a call that hangs at
    auth/network before the print wait, or a CLI that overruns its own bound,
    would otherwise block run_brief forever — the run goes dark with no
    failure marker, no alert, and no retry. The bound is the 'bounded
    timeouts' half of the agy-routing fix for the recurring auth-failure /
    timeout evidence (2026-08-21..24)."""

    @patch("run_brief.subprocess.run")
    def test_subprocess_call_receives_bounded_timeout(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="ok")
        run_brief.call_llm("ping")
        kwargs = mock_run.call_args.kwargs
        self.assertIn("timeout", kwargs, "subprocess.run must be given a timeout")
        self.assertGreater(kwargs["timeout"], 0)

    @patch("run_brief.subprocess.run")
    def test_bound_is_looser_than_cli_own_print_timeout(self, mock_run):
        """The Python bound must exceed the CLI's own --print-timeout by a
        comfortable margin so agy's internal timeout normally fires first and
        its diagnostic stderr (auth text, quota text) reaches the retry loop
        instead of being cut off mid-flight by the outer bound."""
        mock_run.return_value = MagicMock(returncode=0, stdout="ok")
        run_brief.call_llm("ping")
        timeout = mock_run.call_args.kwargs["timeout"]
        print_timeout_s = run_brief._duration_to_seconds(run_brief.AGY_PRINT_TIMEOUT, 600.0)
        self.assertGreaterEqual(timeout, print_timeout_s + 60)

    @patch(
        "run_brief.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd=["cmd", "/c", "agy"], timeout=720),
    )
    def test_timeout_surfaces_as_transient_runtime_error(self, mock_run):
        """TimeoutExpired must become a RuntimeError the retry loop already
        knows how to handle — transient (retried once), never auth-classified
        (an auth fail-fast on a timeout would strand a healthy credential)."""
        with self.assertRaises(RuntimeError) as ctx:
            run_brief.call_llm("ping")
        msg = str(ctx.exception)
        self.assertIn("timed out", msg)
        self.assertFalse(
            run_brief.is_llm_auth_failure(msg),
            "a timeout must stay transient, not fail fast as llm-auth",
        )

    @patch(
        "run_brief.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd=["cmd", "/c", "agy"], timeout=720),
    )
    def test_temp_prompt_file_removed_on_timeout(self, mock_run):
        """The @-file temp prompt must still be cleaned up when the subprocess
        times out (the finally block covers the raise path)."""
        created = {}
        real_ntf = run_brief.tempfile.NamedTemporaryFile

        def tracking_ntf(*args, **kwargs):
            f = real_ntf(*args, **kwargs)
            created["path"] = f.name
            return f

        with patch("run_brief.tempfile.NamedTemporaryFile", side_effect=tracking_ntf):
            with self.assertRaises(RuntimeError):
                run_brief.call_llm("ping")

        self.assertIn("path", created, "prompt temp file was created")
        self.assertFalse(
            os.path.exists(created["path"]),
            "prompt temp file must be removed when the agy call times out",
        )


# The exact stderr agy emitted on a license-invalidation run 2026-08-19..21:
# non-transient, yet the retry loop burned both attempts on every run and alerted
# as if a catchup retry could fix it.
RECORDED_GEMINI_AUTH_ERROR = (
    "Gemini exited 1: Warning: 256-color support not detected. Using a terminal "
    "with at least 256-color support is recommended for a better visual experience.\n"
    "YOLO mode is enabled. All tool calls will be automatically approved.\n"
    "Error authenticating: _GaxiosError: You do not have a valid license of this "
    "product. Please contact your administrator."
)

# The exact stderr agy emitted on the recorded quota-exhaustion runs of
# 2026-09-02: capacity, not credentials. Misclassified as fatal llm-auth
# ("LLM auth/license failure — not retrying" → status llm-auth, no retry,
# unactionable re-auth guidance) while agy's own quota message said it would
# not reset for 16-26h and the failover chain had other workers available.
RECORDED_AGY_QUOTA_ERROR = (
    "agy exited 1: Error: Individual quota reached. Please upgrade your "
    "subscription to increase your limits. Resets in 26h16m20s."
)


class TestIsLlmAuthFailure(unittest.TestCase):
    """Auth/license failures must be recognizable so the retry loop can fail
    fast for the LLM CLI (agy). Quota exhaustion is NOT auth (2026-09-02
    revision) — it is classified separately in TestIsLlmQuotaFailure."""

    def test_recorded_license_error_detected(self):
        self.assertTrue(run_brief.is_llm_auth_failure(RECORDED_GEMINI_AUTH_ERROR))

    def test_oauth_rejections_detected(self):
        for text in (
            "Gemini exited 1: Error authenticating: _GaxiosError: invalid_grant",
            "Gemini exited 1: UNAUTHENTICATED: Request had invalid credentials",
        ):
            self.assertTrue(run_brief.is_llm_auth_failure(text), text)

    def test_transient_errors_not_classified_auth(self):
        for text in (
            "Gemini exited 1: Connection reset by peer",
            "Gemini exited 1: quota exceeded, retry later",
            "Gemini exited 1: internal server error",
        ):
            self.assertFalse(run_brief.is_llm_auth_failure(text), text)

    def test_dedup_key_for_llm_auth_status(self):
        self.assertEqual(
            run_brief._dedup_key_for_status("gemini-auth"), "daily-mail-brief-gemini-auth"
        )

    # 2026-08-23 (WP-F step 5): the cases the spec pinned for the renamed
    # is_llm_auth_failure. agy's own quota signature lived here until the
    # 2026-09-02 revision moved it to the separate quota classifier (recorded
    # quota-exhaustion runs were failing the brief as fatal llm-auth) — see
    # test_agy_quota_signature_is_quota_not_auth below and TestIsLlmQuotaFailure.
    def test_valid_license_phrase_detected(self):
        self.assertTrue(
            run_brief.is_llm_auth_failure("You do not have a valid license of this product.")
        )

    def test_invalid_grant_detected(self):
        self.assertTrue(run_brief.is_llm_auth_failure("OAuth error: invalid_grant"))

    def test_agy_quota_signature_is_quota_not_auth(self):
        """2026-09-02 revision: quota exhaustion is capacity, not credentials.
        'Individual quota reached' must classify as quota (failover path) and
        must NOT classify as auth — the auth classification aborted the brief
        with a fatal no-retry exit and unactionable re-auth guidance while
        agy's own message said the quota resets in 16-26h."""
        for text in (
            "Individual quota reached",
            "individual quota reached — try again later",
            "INDIVIDUAL QUOTA REACHED",
        ):
            self.assertTrue(run_brief.is_llm_quota_failure(text), text)
            self.assertFalse(run_brief.is_llm_auth_failure(text), text)

    def test_recorded_quota_error_not_classified_auth(self):
        self.assertFalse(run_brief.is_llm_auth_failure(RECORDED_AGY_QUOTA_ERROR))

    def test_generic_rate_limit_not_classified_auth(self):
        self.assertFalse(run_brief.is_llm_auth_failure("429 Too Many Requests"))


class TestIsLlmQuotaFailure(unittest.TestCase):
    """Quota exhaustion must be recognizable SEPARATELY from auth so call_llm
    can fail the inner LLM over to the next worker instead of aborting the
    brief (the worker chain agy → codex → zclaude → claude draws each worker
    from its own quota pool)."""

    def test_recorded_quota_error_detected(self):
        self.assertTrue(run_brief.is_llm_quota_failure(RECORDED_AGY_QUOTA_ERROR))

    def test_quota_signature_detected_case_insensitively(self):
        for text in (
            "Individual quota reached",
            "individual quota reached — try again later",
            "INDIVIDUAL QUOTA REACHED",
        ):
            self.assertTrue(run_brief.is_llm_quota_failure(text), text)

    def test_google_resource_exhausted_marker_detected(self):
        # Google's API-level marker for the same quota pool — paired with the
        # quota string in ~/.pa/config.yaml's agy rate_limit_patterns.
        self.assertTrue(
            run_brief.is_llm_quota_failure("RESOURCE_EXHAUSTED: quota limit exceeded")
        )

    def test_auth_failures_not_classified_quota(self):
        for text in (RECORDED_GEMINI_AUTH_ERROR, "OAuth error: invalid_grant"):
            self.assertFalse(run_brief.is_llm_quota_failure(text), text)

    def test_transient_errors_not_classified_quota(self):
        for text in (
            "agy exited 1: Connection reset by peer",
            "429 Too Many Requests",
            "agy exited 1: internal server error",
        ):
            self.assertFalse(run_brief.is_llm_quota_failure(text), text)


class TestQuotaFailoverInCallLlm(unittest.TestCase):
    """Quota exhaustion on the primary (agy) must fail the inner LLM over to
    the fallback CLI — the next worker, which draws from its own quota pool —
    instead of raising. The recorded 2026-09-02 failures aborted the brief with
    a fatal llm-auth classification while agy's quota wouldn't reset for
    16-26h. Auth and transient failures must NOT trigger the fallback."""

    QUOTA_STDERR = (
        "Error: Individual quota reached. Please upgrade your subscription "
        "to increase your limits. Resets in 16h19m8s."
    )

    @patch("run_brief.subprocess.run")
    def test_quota_failure_fails_over_and_returns_fallback_output(self, mock_run):
        """The exact recorded evidence: agy exits 1 with the quota stderr →
        the fallback CLI is invoked with the prompt on stdin and its output
        becomes the LLM response, so the brief still delivers."""
        fallback_out = "===BRIEFING_START===\nbrief\n===BRIEFING_END==="
        mock_run.side_effect = [
            MagicMock(returncode=1, stdout="", stderr=self.QUOTA_STDERR),
            MagicMock(returncode=0, stdout=fallback_out, stderr=""),
        ]

        result = run_brief.call_llm("the prompt")

        self.assertEqual(mock_run.call_count, 2, "quota failure must fail over to the fallback CLI")
        second = mock_run.call_args_list[1]
        self.assertIn(run_brief.FALLBACK_LLM_CMD, second.args[0])
        self.assertEqual(
            second.kwargs.get("input"), "the prompt",
            "fallback prompt must travel on stdin, never argv",
        )
        self.assertIn("timeout", second.kwargs, "fallback call must stay time-bounded")
        self.assertEqual(result, fallback_out)

    @patch("run_brief.subprocess.run")
    def test_auth_failure_does_not_fail_over(self, mock_run):
        """Dead credentials/license are non-transient for the whole run —
        surfacing the agy error directly is still the right call; the fallback
        would only mask it (and the recorded license incident must keep its
        actionable llm-auth alert)."""
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr=RECORDED_GEMINI_AUTH_ERROR)

        with self.assertRaises(RuntimeError) as ctx:
            run_brief.call_llm("the prompt")

        self.assertEqual(mock_run.call_count, 1, "auth failure must not invoke the fallback")
        self.assertIn("valid license", str(ctx.exception))

    @patch("run_brief.subprocess.run")
    def test_transient_failure_does_not_fail_over(self, mock_run):
        """Generic errors keep the existing story: raise → main() retries once
        → status 'llm'. The fallback is quota-only (minimal revision)."""
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="Connection reset by peer")

        with self.assertRaises(RuntimeError):
            run_brief.call_llm("the prompt")

        self.assertEqual(mock_run.call_count, 1, "transient failure must not invoke the fallback")

    @patch("run_brief.subprocess.run")
    def test_fallback_failure_raises_transient_not_auth(self, mock_run):
        """Both pools dry (agy quota, fallback exit 1): the raised error must
        stay transient-classified so catchup keeps retrying until a pool
        resets — never the fatal llm-auth path of the recorded failure."""
        mock_run.side_effect = [
            MagicMock(returncode=1, stdout="", stderr=self.QUOTA_STDERR),
            MagicMock(returncode=1, stdout="", stderr="billing hard limit reached"),
        ]

        with self.assertRaises(RuntimeError) as ctx:
            run_brief.call_llm("the prompt")

        self.assertEqual(mock_run.call_count, 2)
        self.assertIn("fallback LLM exited 1", str(ctx.exception))
        self.assertFalse(
            run_brief.is_llm_auth_failure(str(ctx.exception)),
            "a failed fallback must not reclassify the run as llm-auth",
        )

    @patch("run_brief.subprocess.run")
    def test_fallback_timeout_raises_transient_not_auth(self, mock_run):
        mock_run.side_effect = [
            MagicMock(returncode=1, stdout="", stderr=self.QUOTA_STDERR),
            subprocess.TimeoutExpired(cmd=["cmd", "/c", "zclaude.bat"], timeout=720),
        ]

        with self.assertRaises(RuntimeError) as ctx:
            run_brief.call_llm("the prompt")

        self.assertIn("timed out", str(ctx.exception))
        self.assertFalse(run_brief.is_llm_auth_failure(str(ctx.exception)))

    @patch("run_brief.subprocess.run")
    def test_fallback_output_gets_same_noise_stripping_as_primary(self, mock_run):
        noisy = "real reply\nCreated execution plan for SessionEnd: stuff"
        mock_run.side_effect = [
            MagicMock(returncode=1, stdout="", stderr=self.QUOTA_STDERR),
            MagicMock(returncode=0, stdout=noisy, stderr=""),
        ]

        self.assertEqual(run_brief.call_llm("p"), "real reply")


class TestLlmAuthFailureFailsFast(RunBriefTestCase):
    """A non-transient auth/license failure must skip the pointless second
    attempt, write a distinct 'llm-auth' marker, and alert with actionable
    guidance instead of 'next catchup will retry'."""

    def _make_fetch_data(self, listed=2):
        return {
            "window": "21 Aug 2026 05:00 – 21 Aug 2026 19:00 IST",
            "window_end_utc": "2026-08-21T13:30:00+00:00",
            "listed_count": listed,
            "total_count": listed,
            "emails": [
                {"id": f"e{i}", "from": "a@b.com", "subject": "subj",
                 "gmail_category": "unknown", "in_inbox": True, "is_unread": True, "snippet": ""}
                for i in range(listed)
            ],
        }

    def _patch_run_py(self, fetch_data):
        fetch_result = MagicMock(returncode=0, stdout=json.dumps(fetch_data))

        def fake_run_py(script, *args, check=True):
            if "fetch_headers" in script:
                return fetch_result
            return MagicMock(returncode=0)

        return fake_run_py

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_no_second_attempt_and_no_sleep(self, mock_llm, mock_run_py, _portfolio, _notify):
        mock_run_py.side_effect = self._patch_run_py(self._make_fetch_data())
        mock_llm.side_effect = RuntimeError(RECORDED_GEMINI_AUTH_ERROR)

        with patch("run_brief.time.sleep") as mock_sleep:
            with self.assertRaises(SystemExit):
                run_brief.main()

        self.assertEqual(
            mock_llm.call_count, 1,
            "Auth/license failure is non-transient — must not be retried",
        )
        mock_sleep.assert_not_called()

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_llm_auth_marker_written(self, mock_llm, mock_run_py, _portfolio, _notify):
        mock_run_py.side_effect = self._patch_run_py(self._make_fetch_data())
        mock_llm.side_effect = RuntimeError(RECORDED_GEMINI_AUTH_ERROR)

        with patch("run_brief.time.sleep"):
            with self.assertRaises(SystemExit):
                run_brief.main()

        marker_path = os.path.join(self.pa_home, "daily-mail-brief-fetch-failed.json")
        self.assertTrue(os.path.exists(marker_path), "Failure marker must be written")
        with open(marker_path, encoding="utf-8") as f:
            content = json.load(f)
        self.assertEqual(content.get("status"), "llm-auth")
        self.assertIn("valid license", content.get("reason", ""))

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_notify_body_is_actionable_not_retry_promise(
        self, mock_llm, mock_run_py, _portfolio, mock_notify
    ):
        mock_run_py.side_effect = self._patch_run_py(self._make_fetch_data())
        mock_llm.side_effect = RuntimeError(RECORDED_GEMINI_AUTH_ERROR)

        with patch("run_brief.time.sleep"):
            with self.assertRaises(SystemExit):
                run_brief.main()

        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.args[0], "llm-auth")
        body = mock_notify.call_args.args[1]
        self.assertIn("not transient", body)
        self.assertIn("AGY_CMD", body)
        self.assertNotIn(
            "next catchup will retry", body,
            "Auth failure alert must not promise a retry that cannot succeed",
        )

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_transient_failure_still_retries_twice(
        self, mock_llm, mock_run_py, _portfolio, mock_notify
    ):
        """The fail-fast path must not eat the existing transient retry: generic
        errors still get both attempts and the plain 'llm' status."""
        mock_run_py.side_effect = self._patch_run_py(self._make_fetch_data())
        mock_llm.side_effect = RuntimeError("Gemini exited 1: Connection reset by peer")

        with patch("run_brief.time.sleep"):
            with self.assertRaises(SystemExit):
                run_brief.main()

        self.assertEqual(mock_llm.call_count, 2, "Transient failures keep the retry")
        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.args[0], "llm")

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_recorded_quota_failure_is_transient_not_llm_auth(
        self, mock_llm, mock_run_py, _portfolio, mock_notify
    ):
        """Reproduces the recorded 2026-09-02 evidence at main() level: an agy
        quota error surfacing from call_llm (i.e. the fallback pool was also
        dry) must NOT take the fatal llm-auth path — no re-auth can fix
        capacity, and agy's own message said the quota resets in 16-26h. It
        keeps the transient retry and the plain 'llm' status so catchup
        redelivers once any pool has capacity."""
        mock_run_py.side_effect = self._patch_run_py(self._make_fetch_data())
        mock_llm.side_effect = RuntimeError(RECORDED_AGY_QUOTA_ERROR)

        with patch("run_brief.time.sleep"):
            with self.assertRaises(SystemExit):
                run_brief.main()

        self.assertEqual(mock_llm.call_count, 2, "quota exhaustion keeps the transient retry")
        mock_notify.assert_called_once()
        self.assertEqual(
            mock_notify.call_args.args[0], "llm",
            "quota exhaustion must never be classified llm-auth",
        )


class TestStateAdvancementLogic(RunBriefTestCase):
    """State must be written only after the LLM call succeeds, not at fetch time."""

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

    def _patch_run_py(self, fetch_data, llm_side_effect=None, llm_return="ok"):
        """Helper: patch run_py to return fake fetch output; patch call_llm."""
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
    @patch("run_brief.call_llm")
    def test_state_written_after_llm_success(self, mock_llm, mock_run_py, _mock_portfolio_context):
        """When the LLM call succeeds, PA_HOME state gets window_end_utc from fetch output."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_llm.return_value = (
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
        self.assertTrue(os.path.exists(state_path), "State must be written after LLM success")
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["last_window_end_utc"], "2026-05-17T13:30:00+00:00")

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_state_not_written_when_llm_fails(self, mock_llm, mock_run_py, _mock_portfolio_context, _mock_notify):
        """When the LLM call fails both attempts, state must NOT be written."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_llm.side_effect = RuntimeError("agy exited 1: auth error")

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        self.assertFalse(os.path.exists(self.state_path()), "State must NOT be written when LLM fails")

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_fetch_failed_written_on_llm_failure(self, mock_llm, mock_run_py, _mock_portfolio_context, _mock_notify):
        """On LLM failure, the PA_HOME failure marker must be written."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_llm.side_effect = RuntimeError("agy exited 1: auth error")

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
        self.assertTrue(exists, "Failure marker must be written on LLM failure")
        self.assertIsNotNone(content, "Failure marker must be valid JSON")
        self.assertEqual(content.get("status"), "llm")

    def test_dedup_key_for_status(self):
        """Dedup keys stay lockstep with fetch_headers.py so an 'auth' failure
        collapses across both callers instead of double-notifying."""
        self.assertEqual(run_brief._dedup_key_for_status("auth"), "daily-mail-brief-auth")

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_llm_failure_notifies_and_skips_briefings_send(
        self, mock_llm, mock_run_py, _mock_portfolio_context, mock_notify
    ):
        """An LLM failure must alert via the deduped notify path with status
        'llm' and must NOT send_telegram.py into the user-facing briefings
        topic — the unthrottled direct send flooded thread 29 with 26 identical
        failure notices during one overnight auth blip (2026-07-12)."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)
        mock_llm.side_effect = RuntimeError("agy exited 42: auth cancelled")

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.args[0], "llm")
        send_calls = [c for c in mock_run_py.call_args_list
                      if c.args and "send_telegram" in str(c.args[0])]
        self.assertEqual(send_calls, [], "LLM-failure path must not send_telegram.py to the briefings topic")

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.detect_portfolio_statement_emails", return_value=[])
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_retry_succeeds_on_second_attempt(self, mock_llm, mock_run_py, _mock_detect, _mock_portfolio_context):
        """State is advanced when first LLM attempt fails but second succeeds."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        call_count = {"n": 0}

        def llm_fail_then_succeed(prompt):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("transient error")
            return (
                "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
                "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
            )

        mock_llm.side_effect = llm_fail_then_succeed

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        self.assertEqual(call_count["n"], 2, "LLM must be called exactly twice for brief retry")
        self.assertTrue(os.path.exists(self.state_path()), "State must exist after retry success")

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.detect_portfolio_statement_emails", return_value=[])
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_retry_uses_stricter_marker_prompt_after_unmarked_response(
        self, mock_llm, mock_run_py, _mock_detect, _mock_portfolio_context
    ):
        """Retry must explicitly require both marker pairs even when a section is empty."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        prompts = []

        def llm_requires_retry_instruction(prompt):
            prompts.append(prompt)
            if len(prompts) == 1:
                return "Here is the summary without markers."
            if "even if one or both sections are empty" in prompt:
                return (
                    "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
                    "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
                )
            return "Still no markers."

        mock_llm.side_effect = llm_requires_retry_instruction

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        with patch("run_brief.time.sleep"):
            try:
                run_brief.main()
            except SystemExit:
                pass

        self.assertEqual(len(prompts), 2, "LLM must be called twice after an unmarked response")
        self.assertIn("even if one or both sections are empty", prompts[1])
        self.assertTrue(os.path.exists(self.state_path()), "State must exist after marker-enforced retry success")

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_state_not_written_when_telegram_send_fails(self, mock_llm, mock_run_py, _mock_portfolio_context):
        """Primary delivery failure must not advance state."""
        fetch_data = self._make_fetch_data()
        mock_llm.return_value = (
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
    @patch("run_brief.call_llm")
    def test_zero_email_window_advances_state_without_llm(self, mock_llm, mock_run_py):
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

        mock_llm.assert_not_called()
        self.assertTrue(os.path.exists(self.state_path()), "Zero-email slots must advance state")

    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_already_processed_window_short_circuits(self, mock_llm, mock_run_py):
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

        mock_llm.assert_not_called()
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
    """detect_portfolio_statement_emails must classify via LLM and parse robustly."""

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

    @patch("run_brief.call_llm")
    def test_portfolio_statement_triggers(self, mock_llm):
        mock_llm.return_value = '["abc123"]'
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, ["abc123"])

    @patch("run_brief.call_llm")
    def test_market_news_does_not_trigger(self, mock_llm):
        mock_llm.return_value = "[]"
        result = run_brief.detect_portfolio_statement_emails([self.NEWS_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_llm_failure_returns_empty(self, mock_llm):
        mock_llm.side_effect = RuntimeError("auth cancelled")
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_json_embedded_in_text_parsed_correctly(self, mock_llm):
        # LLM often wraps JSON in prose
        mock_llm.return_value = 'The emails that qualify are: ["abc123"]\nThat is the only one.'
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, ["abc123"])

    @patch("run_brief.call_llm")
    def test_empty_email_list_skips_llm(self, mock_llm):
        result = run_brief.detect_portfolio_statement_emails([])
        mock_llm.assert_not_called()
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_detect_triggers_fires_portfolio_reports_when_statement_found(self, mock_llm):
        mock_llm.return_value = '["abc123"]'
        result = run_brief.detect_triggers([self.PORTFOLIO_EMAIL])
        self.assertIn("portfolio-reports", result)

    @patch("run_brief.call_llm")
    def test_detect_triggers_empty_when_only_news_emails(self, mock_llm):
        mock_llm.return_value = "[]"
        result = run_brief.detect_triggers([self.NEWS_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_detect_triggers_empty_on_llm_failure(self, mock_llm):
        mock_llm.side_effect = RuntimeError("timeout")
        result = run_brief.detect_triggers([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_llm_returns_non_list_json_is_safe(self, mock_llm):
        # LLM returns valid JSON that's not a list — must not crash
        mock_llm.return_value = '{"ids": ["abc123"]}'
        result = run_brief.detect_portfolio_statement_emails([self.PORTFOLIO_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_email_missing_id_field_does_not_crash(self, mock_llm):
        # If an email dict is missing "id", must return [] gracefully, not raise
        bad_email = {"from": "x@y.com", "subject": "Statement", "snippet": ""}
        result = run_brief.detect_portfolio_statement_emails([bad_email])
        self.assertEqual(result, [])
        mock_llm.assert_not_called()  # should fail before reaching call_llm

    @patch("run_brief.call_llm")
    def test_tracked_provider_statement_triggers(self, mock_llm):
        mock_llm.return_value = '["statement001"]'
        result = run_brief.detect_portfolio_statement_emails([self.STATEMENT_EMAIL])
        self.assertEqual(result, ["statement001"])

    @patch("run_brief.call_llm")
    def test_bank_alert_does_not_trigger(self, mock_llm):
        # Routine bank transactional alerts must not be flagged as portfolio statements
        # (this was the primary source of near-daily false triggers before the prompt fix)
        mock_llm.return_value = "[]"
        result = run_brief.detect_portfolio_statement_emails([self.BANK_ALERT_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_other_broker_contract_note_does_not_trigger(self, mock_llm):
        # Other-broker statements must not fire the ad-hoc trigger — only the
        # configured BRIEF_STATEMENT_PROVIDER should
        mock_llm.return_value = "[]"
        result = run_brief.detect_portfolio_statement_emails([self.OTHER_BROKER_CONTRACT_NOTE_EMAIL])
        self.assertEqual(result, [])

    @patch("run_brief.call_llm")
    def test_detect_triggers_logs_matched_sender_and_subject(self, mock_llm):
        mock_llm.return_value = '["statement001"]'
        stderr = StringIO()
        with redirect_stderr(stderr):
            run_brief.detect_triggers([self.STATEMENT_EMAIL])
        logged = stderr.getvalue()
        self.assertIn("MONTHLY REPORT- TESTOWNER CLIENT", logged)
        self.assertIn("Sam Advisor", logged)

    @patch("run_brief.call_llm")
    def test_detect_triggers_mixed_batch_only_tracked_provider_triggers(self, mock_llm):
        # A batch containing both a genuine tracked-provider statement and noise
        # (bank alert, market news) should trigger only on the tracked match.
        mock_llm.return_value = '["statement001"]'
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

    @patch("run_brief._notify_failure")
    @patch("run_brief.write_failure_marker")
    @patch("run_brief.read_failure_marker")
    @patch("run_brief.run_py")
    def test_main_exits_2_on_preflight_failure(
        self, mock_run_py, mock_read_marker, mock_write_marker, mock_notify
    ):
        """A bare `return` here previously made a preflight failure look like
        `status: success` to the scheduler — latestSuccess kept advancing and
        the 2026-08-19..21 four-day outage went undetected (review §2.2). exit
        code 2 matches preflight.py's own sys.exit(2) (2026-08-23, WP-F step 3)."""
        preflight_fail = MagicMock(returncode=1, stderr="token expired")

        def fake_run_py(script, *args, check=True):
            if "preflight" in script:
                return preflight_fail
            return MagicMock(returncode=0)

        mock_run_py.side_effect = fake_run_py
        mock_read_marker.return_value = {"status": "auth", "reason": "token expired"}

        with self.assertRaises(SystemExit) as ctx:
            run_brief.main()

        self.assertEqual(ctx.exception.code, 2)


class TestFailureExitsAreSelfDescribing(RunBriefTestCase):
    """Every failure exit must leave a stderr diagnostic.

    The skill runner records only this script's stderr as the run's error
    (pa/src/commands/run.ts: `error: error.trim() || undefined`) and the
    failure analyzer falls back to 'unknown error' when that field is empty.
    Six recorded runs (2026-08-23..24) exited 2 with empty stderr — the
    preflight-failure branch prints nothing, so when `pa notify` succeeds
    silently each run became an unclassifiable 'unknown error' row in the
    failure evidence. Same defect class one branch over: the
    malformed-briefing fail_llm() call has no print of its own either. A
    failure exit that says nothing is unactionable and unanalyzable."""

    def _make_fetch_data(self, listed=2):
        return {
            "window": "23 Aug 2026 05:00 – 23 Aug 2026 19:00 IST",
            "window_end_utc": "2026-08-23T13:30:00+00:00",
            "listed_count": listed,
            "total_count": listed,
            "emails": [
                {"id": f"e{i}", "from": "a@b.com", "subject": "subj",
                 "gmail_category": "unknown", "in_inbox": True, "is_unread": True, "snippet": ""}
                for i in range(listed)
            ],
        }

    def _patch_run_py(self, fetch_data=None):
        """fetch_data=None makes preflight fail (the recorded exit-2 runs);
        otherwise preflight/fetch/send all succeed."""
        fetch_result = MagicMock(returncode=0, stdout=json.dumps(fetch_data) if fetch_data else "")

        def fake_run_py(script, *args, check=True):
            if "preflight" in script:
                if fetch_data is None:
                    return MagicMock(returncode=1, stderr="token expired")
                return MagicMock(returncode=0)
            if "fetch_headers" in script:
                return fetch_result
            return MagicMock(returncode=0)

        return fake_run_py

    @patch("run_brief._notify_failure")
    @patch("run_brief.run_py")
    def test_preflight_failure_exit_writes_stderr_diagnostic(self, mock_run_py, mock_notify):
        """Reproduces the recorded 'unknown error' rows: exit 2 with empty
        stderr (notify succeeded silently) leaves meta.error empty, so the
        failure is recorded as unclassifiable."""
        mock_run_py.side_effect = self._patch_run_py(fetch_data=None)

        stderr = StringIO()
        with redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as ctx:
                run_brief.main()

        self.assertEqual(ctx.exception.code, 2)
        logged = stderr.getvalue()
        self.assertTrue(logged.strip(), "exit-2 must leave a stderr diagnostic, not exit silently")
        self.assertIn("auth", logged)
        self.assertIn("token expired", logged)

    @patch("run_brief._notify_failure")
    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_malformed_briefing_failure_writes_stderr_diagnostic(
        self, mock_llm, mock_run_py, _portfolio, mock_notify
    ):
        """fail_llm reached from the malformed-briefing branch (whose caller
        prints nothing): the funnel itself must say why on stderr."""
        mock_run_py.side_effect = self._patch_run_py(fetch_data=self._make_fetch_data())
        mock_llm.return_value = (
            "===BRIEFING_START===\nbriefing without the assert header\n===BRIEFING_END==="
        )

        stderr = StringIO()
        with redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as ctx:
                run_brief.main()

        self.assertEqual(ctx.exception.code, 1)
        logged = stderr.getvalue()
        self.assertTrue(logged.strip(), "fail_llm must leave a stderr diagnostic")
        self.assertIn("Malformed briefing content", logged)


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
        with patch("run_brief.call_llm", return_value="[]") as mock_llm:
            run_brief.detect_portfolio_statement_emails(
                [{"id": "x", "from": "a@b.test", "subject": "s", "snippet": "n"}]
            )
        return mock_llm.call_args.args[0]

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


class TestParseDecisionRows(unittest.TestCase):
    """parse_decision_rows must extract decision JSON from the DECISIONS marker block."""

    def test_wellformed_two_row_block_returns_two_dicts(self):
        response = (
            "===BRIEFING_START===\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            '{"request_excerpt":"Sender1 - Subj1","decision":"included","rationale":"Borderline case","alternatives":["excluded: too old"]}\n'
            '{"request_excerpt":"Sender2 - Subj2","decision":"excluded","rationale":"Clearly promotional","alternatives":[]}\n'
            "===DECISIONS_END==="
        )
        rows = run_brief.parse_decision_rows(response)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["decision"], "included")
        self.assertEqual(rows[1]["decision"], "excluded")

    def test_malformed_middle_line_skipped_with_warn(self):
        response = (
            "===BRIEFING_START===\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            '{"request_excerpt":"Sender1 - Subj1","decision":"included","rationale":"OK","alternatives":[]}\n'
            "not valid json here\n"
            '{"request_excerpt":"Sender2 - Subj2","decision":"excluded","rationale":"OK","alternatives":[]}\n'
            "===DECISIONS_END==="
        )
        stderr = StringIO()
        with redirect_stderr(stderr):
            rows = run_brief.parse_decision_rows(response)
        self.assertEqual(len(rows), 2)
        logged = stderr.getvalue()
        self.assertIn("Malformed decision line", logged)

    def test_more_than_ten_lines_capped_at_ten(self):
        lines = [
            f'{{"request_excerpt":"S{i}","decision":"included","rationale":"OK","alternatives":[]}}'
            for i in range(15)
        ]
        response = (
            "===BRIEFING_START===\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            + "\n".join(lines) +
            "\n===DECISIONS_END==="
        )
        stderr = StringIO()
        with redirect_stderr(stderr):
            rows = run_brief.parse_decision_rows(response)
        self.assertEqual(len(rows), 10)
        logged = stderr.getvalue()
        self.assertIn("capping at 10", logged)

    def test_missing_markers_returns_empty_list(self):
        response = "===BRIEFING_START===\nbrief\n===BRIEFING_END==="
        rows = run_brief.parse_decision_rows(response)
        self.assertEqual(rows, [])

    def test_empty_block_returns_empty_list(self):
        response = (
            "===BRIEFING_START===\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            "===DECISIONS_END==="
        )
        rows = run_brief.parse_decision_rows(response)
        self.assertEqual(rows, [])

    def test_fenced_block_not_required_markers_suffice(self):
        """Markers alone are enough; code fences are NOT required."""
        response = (
            "===BRIEFING_START===\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            '{"request_excerpt":"S1","decision":"included","rationale":"OK","alternatives":[]}\n'
            "===DECISIONS_END==="
        )
        rows = run_brief.parse_decision_rows(response)
        self.assertEqual(len(rows), 1)


class TestDecisionRecordingInMain(RunBriefTestCase):
    """Decision recording must enrich rows deterministically and never fail the brief."""

    def _make_fetch_data(self, listed=2):
        return {
            "window": "21 Aug 2026 05:00 – 21 Aug 2026 19:00 IST",
            "window_end_utc": "2026-08-21T13:30:00+00:00",
            "listed_count": listed,
            "total_count": listed,
            "emails": [
                {"id": f"e{i}", "from": "a@b.com", "subject": "subj",
                 "gmail_category": "unknown", "in_inbox": True, "is_unread": True, "snippet": ""}
                for i in range(listed)
            ],
        }

    def _patch_run_py(self, fetch_data):
        fetch_result = MagicMock(returncode=0, stdout=json.dumps(fetch_data))

        def fake_run_py(script, *args, check=True):
            if "fetch_headers" in script:
                return fetch_result
            return MagicMock(returncode=0)

        return fake_run_py

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    @patch("run_brief.decisions_lib.record_decision")
    def test_decision_rows_enriched_and_recorded(
        self, mock_record, mock_llm, mock_run_py, _mock_portfolio
    ):
        """Decision rows from the LLM are enriched with deterministic fields and recorded."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        llm_response = (
            "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            '{"request_excerpt":"Sender - Subject","decision":"included","rationale":"Borderline","alternatives":["excluded"]}\n'
            "===DECISIONS_END==="
        )
        mock_llm.return_value = llm_response

        env_patch = patch.dict(
            os.environ,
            {"TELEGRAM_DAILY_BRIEFING_THREAD_ID": "4242", "TELEGRAM_BRIEFING_CHAT_ID": "-1009999999999"},
            clear=False,
        )

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        with env_patch:
            try:
                run_brief.main()
            except SystemExit:
                pass

        self.assertEqual(mock_record.call_count, 1)
        call_args = mock_record.call_args.args[0]
        self.assertEqual(call_args["source"], "skill")
        self.assertEqual(call_args["skill"], "daily-mail-brief")
        self.assertEqual(call_args["thread_id"], 4242)
        self.assertEqual(call_args["chat_id"], -1009999999999)
        self.assertEqual(call_args["request_excerpt"], "Sender - Subject")
        self.assertEqual(call_args["decision"], "included")

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    @patch("run_brief.decisions_lib.record_decision")
    def test_recording_failure_does_not_fail_brief(
        self, mock_record, mock_llm, mock_run_py, _mock_portfolio
    ):
        """A recording failure must print a warning and never fail the brief (try/except)."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        llm_response = (
            "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            '{"request_excerpt":"S","decision":"included","rationale":"R","alternatives":[]}\n'
            "===DECISIONS_END==="
        )
        mock_llm.return_value = llm_response
        mock_record.return_value = {"ok": False, "error": "DB write failed"}

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        stderr = StringIO()
        with redirect_stderr(stderr):
            try:
                run_brief.main()
            except SystemExit as e:
                # Should exit successfully (or with unrelated code), NOT crash
                pass

        logged = stderr.getvalue()
        self.assertIn("decision trace write failed", logged)

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    @patch("run_brief.decisions_lib.record_decision")
    def test_record_decision_exception_caught_and_warned(
        self, mock_record, mock_llm, mock_run_py, _mock_portfolio
    ):
        """An exception during recording must be caught, warned, and never fail the brief."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        llm_response = (
            "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
            "===DECISIONS_START===\n"
            '{"request_excerpt":"S","decision":"included","rationale":"R","alternatives":[]}\n'
            "===DECISIONS_END==="
        )
        mock_llm.return_value = llm_response
        mock_record.side_effect = RuntimeError("Unexpected DB error")

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        stderr = StringIO()
        with redirect_stderr(stderr):
            try:
                run_brief.main()
            except SystemExit:
                pass

        logged = stderr.getvalue()
        self.assertIn("decision trace recording failed", logged)

    @patch("run_brief.load_portfolio_context", return_value="")
    @patch("run_brief.run_py")
    @patch("run_brief.call_llm")
    def test_brief_succeeds_without_decision_block(self, mock_llm, mock_run_py, _mock_portfolio):
        """A brief without a DECISIONS block must still succeed (the block is optional)."""
        fetch_data = self._make_fetch_data()
        mock_run_py.side_effect = self._patch_run_py(fetch_data)

        llm_response = (
            "===BRIEFING_START===\n[pa assert] emails.json listed=2\n\nbrief\n===BRIEFING_END===\n"
            "===ANALYSIS_START===\nanalysis\n===ANALYSIS_END==="
        )
        mock_llm.return_value = llm_response

        emails_path = os.path.join(self.project_root, "emails.json")
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump({"emails": [{}, {}], "listed_count": 2}, f)

        try:
            run_brief.main()
        except SystemExit as e:
            # Should exit successfully
            pass

        # The brief should complete without trying to record any decisions
        briefing_path = os.path.join(self.project_root, "briefing_output.md")
        self.assertTrue(os.path.exists(briefing_path), "Briefing must be written even without decisions")


class TestDecisionBlockInPrompt(RunBriefTestCase):
    """build_prompt must include the DECISIONS section in the prompt."""

    def test_build_prompt_contains_decision_markers(self):
        prompt = run_brief.build_prompt("some window", 3, "emails here")
        self.assertIn("===DECISIONS_START===", prompt)
        self.assertIn("===DECISIONS_END===", prompt)

    def test_build_prompt_contains_max_ten_lines_instruction(self):
        prompt = run_brief.build_prompt("some window", 3, "emails here")
        self.assertIn("max 10 lines", prompt)

    def test_build_prompt_explains_optional_block(self):
        prompt = run_brief.build_prompt("some window", 3, "emails here")
        self.assertIn("optional section", prompt.lower())
        self.assertIn("only when there were non-obvious choices", prompt.lower())


if __name__ == "__main__":
    unittest.main()
