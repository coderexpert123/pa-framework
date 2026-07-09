"""Unit tests for pa/scripts/git-hooks/pre-push-pii-guard (AI-094, AI-097)."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

GUARD_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "git-hooks", "pre-push-pii-guard",
)
spec = importlib.util.spec_from_loader("pii_guard", loader=None)
guard = importlib.util.module_from_spec(spec)
with open(GUARD_PATH, encoding="utf-8") as f:
    code = f.read()
exec(compile(code.replace('if __name__ == "__main__":', 'if False:'), GUARD_PATH, "exec"), guard.__dict__)


class TestResolveGeminiArgv(unittest.TestCase):
    def test_env_var_plain_binary(self):
        with patch.dict(os.environ, {"GEMINI_CMD": "/usr/bin/gemini"}):
            self.assertEqual(guard.resolve_gemini_argv(), ["/usr/bin/gemini"])

    def test_env_var_cmd_shim_gets_cmd_interpreter(self):
        """The AI-094 bug: .cmd shims can't be exec'd directly by subprocess."""
        with patch.dict(os.environ, {"GEMINI_CMD": r"D:\gemini-shim\gemini.cmd"}):
            self.assertEqual(guard.resolve_gemini_argv(), ["cmd", "/c", r"D:\gemini-shim\gemini.cmd"])

    def test_bat_shim_also_wrapped(self):
        with patch.dict(os.environ, {"GEMINI_CMD": "gemini.BAT"}):
            self.assertEqual(guard.resolve_gemini_argv(), ["cmd", "/c", "gemini.BAT"])

    def test_falls_back_to_path_lookup(self):
        env = {k: v for k, v in os.environ.items() if k != "GEMINI_CMD"}
        with patch.dict(os.environ, env, clear=True):
            with patch.object(guard.shutil, "which", return_value=None):
                with patch.object(guard, "_load_secrets", return_value={}):
                    self.assertIsNone(guard.resolve_gemini_argv())
            with patch.object(guard.shutil, "which", return_value="/opt/gemini"):
                with patch.object(guard, "_load_secrets", return_value={}):
                    self.assertEqual(guard.resolve_gemini_argv(), ["/opt/gemini"])

    def test_falls_back_to_secrets_env_when_path_lookup_fails(self):
        """AI-097: git hooks run with a minimal env — GEMINI_CMD is set in
        ~/.pa/secrets.env but not exported into the hook's process env. The
        hook must consult secrets.env before giving up, same as
        projects/coding-dirs-updater/update_coding_dirs.py's reference pattern."""
        env = {k: v for k, v in os.environ.items() if k != "GEMINI_CMD"}
        with patch.dict(os.environ, env, clear=True):
            with patch.object(guard.shutil, "which", return_value=None):
                with patch.object(guard, "_load_secrets", return_value={"GEMINI_CMD": r"D:\gemini-shim\gemini.cmd"}):
                    self.assertEqual(guard.resolve_gemini_argv(), ["cmd", "/c", r"D:\gemini-shim\gemini.cmd"])

    def test_env_var_still_wins_over_secrets_env(self):
        with patch.dict(os.environ, {"GEMINI_CMD": "/from/env"}):
            with patch.object(guard, "_load_secrets", return_value={"GEMINI_CMD": "/from/secrets/file"}):
                self.assertEqual(guard.resolve_gemini_argv(), ["/from/env"])


class TestLoadSecrets(unittest.TestCase):
    def test_parses_key_value_pairs_and_ignores_comments(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "secrets.env"), "w", encoding="utf-8") as f:
                f.write("# comment\nGEMINI_CMD=D:/gemini-shim/gemini.cmd\nEMPTY=\n\nQUOTED=\"value\"\n")
            with patch.object(guard, "PA_HOME", tmp):
                secrets = guard._load_secrets()
        self.assertEqual(secrets.get("GEMINI_CMD"), "D:/gemini-shim/gemini.cmd")
        self.assertEqual(secrets.get("QUOTED"), "value")

    def test_missing_file_returns_empty_dict(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(guard, "PA_HOME", os.path.join(tmp, "does-not-exist")):
                self.assertEqual(guard._load_secrets(), {})


class TestGeminiCheckSturdiness(unittest.TestCase):
    """AI-097: the 2026-07-08 crash — Windows subprocess.run() without an
    explicit encoding= defaults to the system codepage (cp1252), and Gemini's
    UTF-8 output (emoji, smart quotes) crashes a background reader thread with
    an exception that escapes gemini_check()'s own try/except entirely (the
    reader thread isn't the calling thread) — the push proceeded, but by
    accident, not by the intended fail-open design. Also: no retry on a
    single transient failure, despite the module's stated 'sturdy, relied on'
    goal — a one-shot timeout/connection blip silently disables the layer
    for the whole push."""

    def test_subprocess_called_with_explicit_utf8_and_replace(self):
        with patch.object(guard, "resolve_gemini_argv", return_value=["gemini"]):
            mock_result = MagicMock(stdout="CLEAN", returncode=0)
            with patch.object(guard.subprocess, "run", return_value=mock_result) as mock_run:
                guard.gemini_check("some content", [])
        _, kwargs = mock_run.call_args
        self.assertEqual(kwargs.get("encoding"), "utf-8")
        self.assertEqual(kwargs.get("errors"), "replace")

    def test_retries_once_on_timeout_then_succeeds(self):
        with patch.object(guard, "resolve_gemini_argv", return_value=["gemini"]):
            mock_result = MagicMock(stdout="CLEAN", returncode=0)
            with patch.object(
                guard.subprocess, "run",
                side_effect=[subprocess.TimeoutExpired(cmd="gemini", timeout=120), mock_result],
            ) as mock_run:
                is_clean, _ = guard.gemini_check("content", [])
        self.assertTrue(is_clean)
        self.assertEqual(mock_run.call_count, 2)

    def test_fails_open_with_clear_warning_after_all_retries_exhausted(self):
        with patch.object(guard, "resolve_gemini_argv", return_value=["gemini"]):
            with patch.object(
                guard.subprocess, "run",
                side_effect=subprocess.TimeoutExpired(cmd="gemini", timeout=120),
            ) as mock_run:
                is_clean, reason = guard.gemini_check("content", [])
        self.assertTrue(is_clean, "must fail OPEN (never block a push on infra failure)")
        self.assertEqual(reason, "")
        self.assertGreaterEqual(mock_run.call_count, 2, "must have actually retried, not given up on the first failure")

    def test_does_not_retry_on_a_parsed_violation(self):
        """A real VIOLATION verdict is not a transient failure — must not retry."""
        with patch.object(guard, "resolve_gemini_argv", return_value=["gemini"]):
            mock_result = MagicMock(stdout="VIOLATION: real name found", returncode=0)
            with patch.object(guard.subprocess, "run", return_value=mock_result) as mock_run:
                is_clean, reason = guard.gemini_check("content", [])
        self.assertFalse(is_clean)
        self.assertEqual(mock_run.call_count, 1)


class TestScanText(unittest.TestCase):
    def test_clean_content_no_violations(self):
        self.assertEqual(guard.scan_text("a.py", "print('hello')\n", ["Secretname"]), [])

    def test_credential_pattern_with_line_number(self):
        content = "x = 1\ntoken = '1234567890:" + "A" * 35 + "'\n"
        violations = guard.scan_text("bot.py", content, [])
        self.assertEqual(len(violations), 1)
        self.assertTrue(violations[0].startswith("bot.py:2 credential"), violations[0])

    def test_tripwire_case_insensitive(self):
        violations = guard.scan_text("doc.md", "written by SECRETNAME yesterday", [r"Secretname"])
        self.assertEqual(len(violations), 1)
        self.assertIn("tripwire", violations[0])

    def test_malformed_tripwire_skipped(self):
        self.assertEqual(guard.scan_text("a.py", "text", ["([bad"]), [])

    def test_multiple_hits_all_reported(self):
        content = "Secretname line one\nnothing\nSecretname again\n"
        violations = guard.scan_text("f.txt", content, ["Secretname"])
        self.assertEqual(len(violations), 2)
        self.assertIn("f.txt:1", violations[0])
        self.assertIn("f.txt:3", violations[1])


if __name__ == "__main__":
    unittest.main()
