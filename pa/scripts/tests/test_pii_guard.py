"""Unit tests for pa/scripts/git-hooks/pre-push-pii-guard (AI-094, AI-097)."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import time
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

    def test_popen_called_with_explicit_utf8_and_replace(self):
        """The encoding contract moved from subprocess.run to _run_gemini's
        Popen when tree-kill landed — same AI-097 stakes, same assertion."""
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = ("CLEAN", "")
        mock_proc.returncode = 0
        with patch.object(guard.subprocess, "Popen", return_value=mock_proc) as mock_popen:
            guard._run_gemini(["gemini", "--yolo"], "prompt", 120)
        _, kwargs = mock_popen.call_args
        self.assertEqual(kwargs.get("encoding"), "utf-8")
        self.assertEqual(kwargs.get("errors"), "replace")

    def test_retries_once_on_timeout_then_succeeds(self):
        with patch.object(guard, "resolve_gemini_argv", return_value=["gemini"]):
            mock_result = MagicMock(stdout="CLEAN", returncode=0)
            with patch.object(
                guard, "_run_gemini",
                side_effect=[subprocess.TimeoutExpired(cmd="gemini", timeout=120), mock_result],
            ) as mock_run:
                is_clean, _, ok = guard.gemini_check("content", [])
        self.assertTrue(is_clean)
        self.assertTrue(ok, "a successful retry is a REAL verdict, not fail-open")
        self.assertEqual(mock_run.call_count, 2)

    def test_fails_open_with_clear_warning_after_all_retries_exhausted(self):
        with patch.object(guard, "resolve_gemini_argv", return_value=["gemini"]):
            with patch.object(
                guard, "_run_gemini",
                side_effect=subprocess.TimeoutExpired(cmd="gemini", timeout=120),
            ) as mock_run:
                is_clean, reason, ok = guard.gemini_check("content", [])
        self.assertTrue(is_clean, "must fail OPEN (never block a push on infra failure)")
        self.assertEqual(reason, "")
        self.assertFalse(ok, "callers must be able to tell fail-open from a real CLEAN")
        self.assertGreaterEqual(mock_run.call_count, 2, "must have actually retried, not given up on the first failure")

    def test_does_not_retry_on_a_parsed_violation(self):
        """A real VIOLATION verdict is not a transient failure — must not retry."""
        with patch.object(guard, "resolve_gemini_argv", return_value=["gemini"]):
            mock_result = MagicMock(stdout="VIOLATION: real name found", returncode=0)
            with patch.object(guard, "_run_gemini", return_value=mock_result) as mock_run:
                is_clean, reason, ok = guard.gemini_check("content", [])
        self.assertFalse(is_clean)
        self.assertTrue(ok)
        self.assertEqual(mock_run.call_count, 1)


class TestRunGeminiTreeKill(unittest.TestCase):
    """2026-07-20 orphan leak: the resolved argv on Windows is `cmd /c shim.cmd`,
    so subprocess.run(timeout=...) killed only cmd.exe and orphaned the node
    grandchild, which busy-spun at 100% CPU forever (six orphans, six cores).
    _run_gemini must kill the WHOLE tree on timeout."""

    def test_timeout_kills_grandchild_too(self):
        # Real-process test: wrapper (child) spawns a sleeper (grandchild) that
        # writes its own PID to a file first thing. After _run_gemini times out,
        # that PID must be gone.
        with tempfile.TemporaryDirectory() as tmp:
            pid_file = os.path.join(tmp, "grandchild.pid")
            sleeper = (
                "import os,time;"
                f"f=open({pid_file!r},'w');f.write(str(os.getpid()));f.close();"
                "time.sleep(60)"
            )
            # Wrapper spawns the sleeper as a grandchild then blocks — the same
            # child->grandchild shape as `cmd /c shim.cmd` -> node, without
            # cmd.exe's argument-mangling of semicolons in the test script.
            wrapper = (
                "import subprocess,sys,time;"
                f"subprocess.Popen([sys.executable,'-c',{sleeper!r}]);"
                "time.sleep(60)"
            )
            argv = [sys.executable, "-c", wrapper]
            start = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                guard._run_gemini(argv, "", timeout=8)
            self.assertLess(time.monotonic() - start, 30, "tree kill must not hang")
            self.assertTrue(os.path.exists(pid_file), "grandchild never started — test is vacuous")
            grandchild_pid = int(open(pid_file).read())
            time.sleep(1.0)  # let the kill settle
            self.assertFalse(
                _pid_alive(grandchild_pid),
                f"grandchild {grandchild_pid} survived the timeout — orphan leak regressed",
            )

    def test_normal_completion_returns_stdout(self):
        script = "import sys; sys.stdout.write('CLEAN'); sys.stdout.flush()"
        argv = [sys.executable, "-c", script]
        result = guard._run_gemini(argv, "ignored input", timeout=30)
        self.assertEqual(result.stdout.strip(), "CLEAN")


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=15,
        ).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class TestFullAuditLlmGuards(unittest.TestCase):
    """The 34-hour retry storm (2026-07-19/20): worst-case LLM phase was
    30 chunks x 2 attempts x 120s = 7200s, double the skill's 3600s timeout,
    so a degraded Gemini made every run time out -> no success recorded ->
    catchup relaunched hourly forever. full_audit must ALWAYS complete: a
    consecutive-failure breaker and a global time budget both stop the LLM
    phase early (loudly) instead of blowing the skill timeout."""

    def _files(self, n_lines):
        # one fake tracked file with n_lines non-blank lines -> ceil(n/300) chunks
        return [("big.txt", "\n".join(f"line {i}" for i in range(n_lines)))]

    def _run_full_audit(self, files, gemini_side_effect, env=None, monotonic=None):
        patches = [
            patch.object(guard, "collect_tree", return_value=files),
            patch.object(guard, "load_tripwires", return_value=["Secretname"]),
            patch.object(guard, "gemini_check", side_effect=gemini_side_effect),
            patch.dict(os.environ, env or {}, clear=False),
        ]
        if monotonic is not None:
            patches.append(patch.object(guard.time, "monotonic", side_effect=monotonic))
        mocks = []
        for p in patches:
            mocks.append(p.start())
        try:
            rc = guard.full_audit(use_llm=True)
        finally:
            for p in patches:
                p.stop()
        return rc, mocks[2]  # (exit code, gemini_check mock)

    def test_breaker_stops_after_consecutive_failures(self):
        # 6 chunks available; gemini always infra-fails -> exactly 3 calls (breaker), rc 0
        rc, gc = self._run_full_audit(
            self._files(1800), gemini_side_effect=lambda *a: (True, "", False))
        self.assertEqual(rc, 0, "a degraded LLM layer must NOT fail the scan — that is the retry storm")
        self.assertEqual(gc.call_count, guard.LLM_FAILURE_BREAKER)

    def test_success_resets_breaker(self):
        # fail, fail, success, fail, fail, success -> all 6 chunks attempted
        verdicts = [(True, "", False), (True, "", False), (True, "", True)] * 2
        rc, gc = self._run_full_audit(self._files(1800), gemini_side_effect=verdicts)
        self.assertEqual(rc, 0)
        self.assertEqual(gc.call_count, 6)

    def test_budget_exhaustion_stops_llm_phase(self):
        # monotonic: deadline calc at t=0, chunk1 check t=0, chunk2 check t=2401
        rc, gc = self._run_full_audit(
            self._files(1800),
            gemini_side_effect=lambda *a: (True, "", True),
            env={"PA_PII_AUDIT_LLM_BUDGET": "2400"},
            monotonic=[0.0, 0.0, 2401.0],
        )
        self.assertEqual(rc, 0)
        self.assertEqual(gc.call_count, 1, "chunk 2 must not start past the deadline")

    def test_llm_violations_still_reported_when_all_calls_succeed(self):
        verdicts = [(False, "real name found", True)] + [(True, "", True)] * 5
        rc, gc = self._run_full_audit(self._files(1800), gemini_side_effect=verdicts)
        self.assertEqual(rc, 0, "violations are OUTPUT, not an error (exit-code contract)")
        self.assertEqual(gc.call_count, 6)


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


class TestCollectDiffEncoding(unittest.TestCase):
    """The per-push diff scan must read `git diff` output as UTF-8. Same AI-097
    class as the gemini subprocess: without explicit encoding=, Windows
    subprocess.run(text=True) decodes with cp1252 — em-dashes silently mojibake
    and the variation selector in ⚠️ (byte 0x8f, undefined in cp1252) raises
    UnicodeDecodeError, which collect_diff's blanket `except` swallows → ADDED
    empties → the whole scan silently vets nothing and the push proceeds
    unchecked (observed 2026-07-12)."""

    def setUp(self):
        guard.ADDED.clear()

    def _run(self, diff_stdout):
        stdin_line = "refs/heads/main " + "a" * 40 + " refs/heads/main " + "b" * 40 + "\n"
        mock_result = MagicMock(stdout=diff_stdout, returncode=0)
        with patch.object(guard.subprocess, "run", return_value=mock_result) as mock_run:
            with patch.object(guard.sys, "stdin", [stdin_line]):
                guard.collect_diff()
        return mock_run

    def test_git_diff_called_with_explicit_utf8_and_replace(self):
        mock_run = self._run("+added line\n")
        _, kwargs = mock_run.call_args
        self.assertEqual(kwargs.get("encoding"), "utf-8")
        self.assertEqual(kwargs.get("errors"), "replace")

    def test_utf8_added_lines_captured_not_dropped(self):
        # A real diff that would crash cp1252 (⚠️ has byte 0x8f) must still be
        # parsed into ADDED so the regex/tripwire/gemini layers actually see it.
        self._run("+warn ⚠️ here\n+em — dash\n-removed old\n")
        self.assertIn("warn ⚠️ here", guard.ADDED)
        self.assertIn("em — dash", guard.ADDED)
        self.assertNotIn("removed old", " ".join(guard.ADDED))

    def test_utf8_pii_in_added_lines_survives_to_scan(self):
        # End-to-end: a tripwire-matching name buried next to an emoji must NOT
        # be lost to a decode failure — it must reach ADDED where scan_text sees it.
        self._run("+report by Secretname ⚠️\n")
        joined = "\n".join(guard.ADDED)
        self.assertEqual(guard.scan_text("f.md", joined, ["Secretname"]) != [], True)


if __name__ == "__main__":
    unittest.main()
