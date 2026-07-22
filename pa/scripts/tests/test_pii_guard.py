"""Unit tests for pa/scripts/git-hooks/pre-push-pii-guard (AI-094, AI-097).

Migrated 2026-07-22 along with the guard itself: the semantic layer moved from
Gemini to agy (Antigravity CLI), and the pre-push (interactive) mode's failure
policy moved from fail-open to fail-CLOSED when that layer cannot render a
verdict. `--full` (the scheduled weekly audit) deliberately KEEPS fail-open —
see TestFullAuditLlmGuards and the guard's own module docstring for why that
asymmetry is intentional, not an oversight.
"""
import ast
import contextlib
import glob
import importlib.util
import io
import json
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


class TestResolveAgyArgv(unittest.TestCase):
    """Was TestResolveGeminiArgv — same cases, AGY_CMD/'agy' instead of
    GEMINI_CMD/'gemini'. Order is unchanged: $AGY_CMD env, then 'agy' on
    PATH, then AGY_CMD in ~/.pa/secrets.env (AI-097: git hooks inherit a
    minimal environment)."""

    def test_env_var_plain_binary(self):
        with patch.dict(os.environ, {"AGY_CMD": "/usr/bin/agy"}):
            self.assertEqual(guard.resolve_agy_argv(), ["/usr/bin/agy"])

    def test_env_var_cmd_shim_gets_cmd_interpreter(self):
        """The AI-094 bug: .cmd shims can't be exec'd directly by subprocess."""
        with patch.dict(os.environ, {"AGY_CMD": r"D:\gemini-shim\agy.cmd"}):
            self.assertEqual(guard.resolve_agy_argv(), ["cmd", "/c", r"D:\gemini-shim\agy.cmd"])

    def test_bat_shim_also_wrapped(self):
        with patch.dict(os.environ, {"AGY_CMD": "agy.BAT"}):
            self.assertEqual(guard.resolve_agy_argv(), ["cmd", "/c", "agy.BAT"])

    def test_falls_back_to_path_lookup(self):
        env = {k: v for k, v in os.environ.items() if k != "AGY_CMD"}
        with patch.dict(os.environ, env, clear=True):
            with patch.object(guard.shutil, "which", return_value=None):
                with patch.object(guard, "_load_secrets", return_value={}):
                    self.assertIsNone(guard.resolve_agy_argv())
            with patch.object(guard.shutil, "which", return_value="/opt/agy"):
                with patch.object(guard, "_load_secrets", return_value={}):
                    self.assertEqual(guard.resolve_agy_argv(), ["/opt/agy"])

    def test_falls_back_to_secrets_env_when_path_lookup_fails(self):
        """AI-097: git hooks run with a minimal env — AGY_CMD is set in
        ~/.pa/secrets.env but not exported into the hook's process env. The
        hook must consult secrets.env before giving up, same as
        projects/coding-dirs-updater/update_coding_dirs.py's reference pattern."""
        env = {k: v for k, v in os.environ.items() if k != "AGY_CMD"}
        with patch.dict(os.environ, env, clear=True):
            with patch.object(guard.shutil, "which", return_value=None):
                with patch.object(guard, "_load_secrets", return_value={"AGY_CMD": r"D:\gemini-shim\agy.cmd"}):
                    self.assertEqual(guard.resolve_agy_argv(), ["cmd", "/c", r"D:\gemini-shim\agy.cmd"])

    def test_env_var_still_wins_over_secrets_env(self):
        with patch.dict(os.environ, {"AGY_CMD": "/from/env"}):
            with patch.object(guard, "_load_secrets", return_value={"AGY_CMD": "/from/secrets/file"}):
                self.assertEqual(guard.resolve_agy_argv(), ["/from/env"])


class TestLoadSecrets(unittest.TestCase):
    def test_parses_key_value_pairs_and_ignores_comments(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "secrets.env"), "w", encoding="utf-8") as f:
                f.write("# comment\nAGY_CMD=D:/gemini-shim/agy.cmd\nEMPTY=\n\nQUOTED=\"value\"\n")
            with patch.object(guard, "PA_HOME", tmp):
                secrets = guard._load_secrets()
        self.assertEqual(secrets.get("AGY_CMD"), "D:/gemini-shim/agy.cmd")
        self.assertEqual(secrets.get("QUOTED"), "value")

    def test_missing_file_returns_empty_dict(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(guard, "PA_HOME", os.path.join(tmp, "does-not-exist")):
                self.assertEqual(guard._load_secrets(), {})


def _leaked_prompt_files():
    """Any pa-pii-guard-prompt-*.txt files currently sitting in the temp dir.
    Used to prove agy_check's temp prompt file is cleaned up on EVERY code
    path (success, timeout, unparseable-retry-exhausted) — not just the
    happy path."""
    return set(glob.glob(os.path.join(tempfile.gettempdir(), "pa-pii-guard-prompt-*.txt")))


class TestAgyCheckSturdiness(unittest.TestCase):
    """Was TestGeminiCheckSturdiness. AI-097: Windows subprocess.run() without
    an explicit encoding= defaults to the system codepage (cp1252), and a
    CLI's UTF-8 output (emoji, smart quotes) crashes a background reader
    thread with an exception that escapes agy_check()'s own try/except
    entirely (the reader thread isn't the calling thread) — a push would
    proceed, but by accident, not by the intended design. Also covers: no
    retry on a single transient failure would silently disable the layer for
    a whole push despite the module's stated 'sturdy, relied on' goal; and
    the prompt-file lifecycle introduced by the 2026-07-22 migration to
    argv-based (`-p @<file>`) prompting instead of stdin piping."""

    def test_popen_called_with_explicit_utf8_and_replace(self):
        """The encoding contract lives on _run_agy's Popen kwargs."""
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = ("CLEAN", "")
        mock_proc.returncode = 0
        with patch.object(guard.subprocess, "Popen", return_value=mock_proc) as mock_popen:
            guard._run_agy(["agy", "--yolo"], 120)
        _, kwargs = mock_popen.call_args
        self.assertEqual(kwargs.get("encoding"), "utf-8")
        self.assertEqual(kwargs.get("errors"), "replace")

    def test_no_agy_binary_resolvable_fails_open_with_reason_naming_agy_cmd(self):
        with patch.object(guard, "resolve_agy_argv", return_value=None):
            is_clean, reason, ok = guard.agy_check("content", [])
        self.assertTrue(is_clean, "no binary resolvable is a layer failure, not a real CLEAN verdict")
        self.assertEqual(reason, "")
        self.assertFalse(ok, "callers must be able to tell 'no binary' from a real verdict")
        self.assertIn("AGY_CMD", guard.LLM_SKIP_REASON)

    def test_retries_once_on_timeout_then_succeeds(self):
        with patch.object(guard, "resolve_agy_argv", return_value=["agy"]):
            mock_result = MagicMock(stdout="CLEAN", returncode=0)
            with patch.object(
                guard, "_run_agy",
                side_effect=[subprocess.TimeoutExpired(cmd="agy", timeout=150), mock_result],
            ) as mock_run:
                is_clean, _, ok = guard.agy_check("content", [])
        self.assertTrue(is_clean)
        self.assertTrue(ok, "a successful retry is a REAL verdict, not fail-open")
        self.assertEqual(mock_run.call_count, 2)

    def test_fails_open_with_clear_warning_after_all_retries_exhausted(self):
        with patch.object(guard, "resolve_agy_argv", return_value=["agy"]):
            with patch.object(
                guard, "_run_agy",
                side_effect=subprocess.TimeoutExpired(cmd="agy", timeout=150),
            ) as mock_run:
                is_clean, reason, ok = guard.agy_check("content", [])
        self.assertTrue(is_clean, "the LAYER still fails open (a real verdict couldn't be produced)")
        self.assertEqual(reason, "")
        self.assertFalse(ok, "callers must be able to tell layer-failure from a real CLEAN — "
                             "main() is what turns this ok=False into a BLOCK on a push now")
        self.assertGreaterEqual(mock_run.call_count, 2, "must have actually retried, not given up on the first failure")

    def test_does_not_retry_on_a_parsed_violation(self):
        """A real VIOLATION verdict is not a transient failure — must not retry."""
        with patch.object(guard, "resolve_agy_argv", return_value=["agy"]):
            mock_result = MagicMock(stdout="VIOLATION: real name found", returncode=0)
            with patch.object(guard, "_run_agy", return_value=mock_result) as mock_run:
                is_clean, reason, ok = guard.agy_check("content", [])
        self.assertFalse(is_clean)
        self.assertTrue(ok)
        self.assertEqual(mock_run.call_count, 1)

    def test_unparseable_response_retries_once_then_gives_up(self):
        with patch.object(guard, "resolve_agy_argv", return_value=["agy"]):
            mock_result = MagicMock(stdout="uh, I'm not sure what you mean", returncode=0)
            with patch.object(guard, "_run_agy", return_value=mock_result) as mock_run:
                is_clean, reason, ok = guard.agy_check("content", [])
        self.assertTrue(is_clean, "unparseable must fail OPEN, not silently claim a clean verdict forever")
        self.assertFalse(ok)
        self.assertEqual(mock_run.call_count, 2, "an unparseable response gets exactly one retry before giving up")

    def test_prompt_file_written_and_cleaned_up_on_success(self):
        before = _leaked_prompt_files()
        with patch.object(guard, "resolve_agy_argv", return_value=["agy"]):
            mock_result = MagicMock(stdout="CLEAN", returncode=0)
            with patch.object(guard, "_run_agy", return_value=mock_result):
                guard.agy_check("content", [])
        self.assertEqual(_leaked_prompt_files() - before, set(),
                         "the temp prompt file must not survive a successful call")

    def test_prompt_file_cleaned_up_after_timeout_exhausted(self):
        before = _leaked_prompt_files()
        with patch.object(guard, "resolve_agy_argv", return_value=["agy"]):
            with patch.object(guard, "_run_agy",
                              side_effect=subprocess.TimeoutExpired(cmd="agy", timeout=150)):
                guard.agy_check("content", [])
        self.assertEqual(_leaked_prompt_files() - before, set(),
                         "the temp prompt file must not leak when every attempt times out")

    def test_prompt_file_cleaned_up_after_unparseable_retry_exhausted(self):
        before = _leaked_prompt_files()
        with patch.object(guard, "resolve_agy_argv", return_value=["agy"]):
            mock_result = MagicMock(stdout="garbage", returncode=0)
            with patch.object(guard, "_run_agy", return_value=mock_result):
                guard.agy_check("content", [])
        self.assertEqual(_leaked_prompt_files() - before, set(),
                         "the temp prompt file must not leak on the unparseable-exhausted path")

    def test_prompt_file_cleaned_up_when_no_binary_resolvable(self):
        """No _run_agy call happens at all on this path — _write_agy_prompt is
        never even reached — but assert the invariant holds regardless (no
        file should appear from this call)."""
        before = _leaked_prompt_files()
        with patch.object(guard, "resolve_agy_argv", return_value=None):
            guard.agy_check("content", [])
        self.assertEqual(_leaked_prompt_files() - before, set())


class TestWriteAgyPrompt(unittest.TestCase):
    """_write_agy_prompt is new in the 2026-07-22 migration: the prompt now
    rides in on argv (`-p @<file>`) instead of stdin, matching how
    ~/.pa/config.yaml's agy worker and worker-exec.ts already invoke agy."""

    def test_writes_prompt_content_and_returns_a_readable_path(self):
        path = guard._write_agy_prompt("scan this content for PII")
        try:
            self.assertTrue(os.path.exists(path))
            self.assertIn("pa-pii-guard-prompt-", os.path.basename(path))
            with open(path, encoding="utf-8") as f:
                self.assertEqual(f.read(), "scan this content for PII")
        finally:
            os.unlink(path)

    def test_each_call_gets_its_own_file(self):
        p1 = guard._write_agy_prompt("a")
        p2 = guard._write_agy_prompt("b")
        try:
            self.assertNotEqual(p1, p2)
        finally:
            os.unlink(p1)
            os.unlink(p2)


class TestRunAgyTreeKill(unittest.TestCase):
    """Was TestRunGeminiTreeKill. 2026-07-20 orphan leak: the resolved argv on
    Windows is `cmd /c shim.cmd`, so subprocess.run(timeout=...) killed only
    cmd.exe and orphaned the node grandchild, which busy-spun at 100% CPU
    forever (six orphans, six cores). _run_agy must kill the WHOLE tree on
    timeout — this is the single most important test in the file: a real
    spawned process tree, not a mock, must actually die."""

    def test_timeout_kills_grandchild_too(self):
        # Real-process test: wrapper (child) spawns a sleeper (grandchild) that
        # writes its own PID to a file first thing. After _run_agy times out,
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
                guard._run_agy(argv, timeout=8)
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
        result = guard._run_agy(argv, timeout=30)
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
    phase early (loudly) instead of blowing the skill timeout.

    2026-07-22: the underlying CLI changed to agy (agy_check instead of
    gemini_check) but this policy is UNCHANGED ON PURPOSE — full_audit is a
    scheduled REPORT that must always complete, unlike the push gate below,
    which now fails closed. Both must still hold with agy_check mocked in."""

    def _files(self, n_lines):
        # one fake tracked file with n_lines non-blank lines -> ceil(n/300) chunks
        return [("big.txt", "\n".join(f"line {i}" for i in range(n_lines)))]

    def _run_full_audit(self, files, agy_side_effect, env=None, monotonic=None):
        patches = [
            patch.object(guard, "collect_tree", return_value=files),
            patch.object(guard, "load_tripwires", return_value=["Secretname"]),
            patch.object(guard, "agy_check", side_effect=agy_side_effect),
            patch.dict(os.environ, env or {}, clear=False),
            # Path scanning added 2026-07-21: full_audit now enumerates every
            # tracked path (binaries included) separately from readable
            # contents. Stub it so these tests never touch a real repo.
            patch.object(guard, "list_tracked_paths",
                         return_value=[p for p, _ in files]),
            # Commit-message scanning added 2026-07-21 — stub it too.
            patch.object(guard, "list_commit_messages", return_value=[]),
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
        return rc, mocks[2]  # (exit code, agy_check mock)

    def test_breaker_stops_after_consecutive_failures(self):
        # 6 chunks available; agy always infra-fails -> exactly 3 calls (breaker), rc 0
        rc, gc = self._run_full_audit(
            self._files(1800), agy_side_effect=lambda *a: (True, "", False))
        self.assertEqual(rc, 0, "a degraded LLM layer must NOT fail the scan — that is the retry storm; "
                               "full_audit keeps fail-open policy after the agy migration, deliberately")
        self.assertEqual(gc.call_count, guard.LLM_FAILURE_BREAKER)

    def test_success_resets_breaker(self):
        # fail, fail, success, fail, fail, success -> all 6 chunks attempted
        verdicts = [(True, "", False), (True, "", False), (True, "", True)] * 2
        rc, gc = self._run_full_audit(self._files(1800), agy_side_effect=verdicts)
        self.assertEqual(rc, 0)
        self.assertEqual(gc.call_count, 6)

    def test_budget_exhaustion_stops_llm_phase(self):
        # monotonic: deadline calc at t=0, chunk1 check t=0, chunk2 check t=2401
        rc, gc = self._run_full_audit(
            self._files(1800),
            agy_side_effect=lambda *a: (True, "", True),
            env={"PA_PII_AUDIT_LLM_BUDGET": "2400"},
            monotonic=[0.0, 0.0, 2401.0],
        )
        self.assertEqual(rc, 0)
        self.assertEqual(gc.call_count, 1, "chunk 2 must not start past the deadline")

    def test_llm_violations_still_reported_when_all_calls_succeed(self):
        verdicts = [(False, "real name found", True)] + [(True, "", True)] * 5
        rc, gc = self._run_full_audit(self._files(1800), agy_side_effect=verdicts)
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
    class as the LLM subprocess: without explicit encoding=, Windows
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
        # parsed into ADDED so the regex/tripwire/agy layers actually see it.
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


class TestScanPath(unittest.TestCase):
    """2026-07-21 leak 3: projects/daily-mail-brief/scripts/download_exbank_statement.py
    shipped to the public mirror for months. The file's CONTENTS were entirely
    generic — the user's bank was named by the PATH, and every layer of this
    guard (and the manual audit scans) read contents only. A filename is data."""

    def test_tripwire_in_filename_is_caught(self):
        violations = guard.scan_path(
            "projects/daily-mail-brief/scripts/download_exbank_statement.py", [r"\bEXBANK\b"])
        self.assertEqual(len(violations), 1, "the leak-3 regression test")
        self.assertIn("download_exbank_statement.py", violations[0])

    def test_path_hit_is_marked_distinctly_from_a_content_hit(self):
        path_hit = guard.scan_path("docs/secretname_notes.md", ["Secretname"])[0]
        content_hit = guard.scan_text("docs/notes.md", "Secretname\n", ["Secretname"])[0]
        self.assertIn("[PATH]", path_hit)
        self.assertNotIn("[PATH]", content_hit,
                         "content hits must stay distinguishable from path hits")

    def test_binary_extension_paths_are_still_checked(self):
        """collect_tree skips .pdf CONTENT — which is exactly why the NAME of a
        pdf is the one thing that must never be skipped."""
        self.assertEqual(len(guard.scan_path("exports/2026_exbank_statement.pdf", [r"\bEXBANK\b"])), 1)

    def test_clean_path_no_violations(self):
        self.assertEqual(guard.scan_path("pa/src/workers.ts", [r"\bEXBANK\b", "Secretname"]), [])

    def test_malformed_tripwire_skipped(self):
        self.assertEqual(guard.scan_path("a/b.py", ["([bad"]), [])

    def test_case_insensitive(self):
        self.assertEqual(len(guard.scan_path("scripts/EXBANK_dl.py", [r"\bexbank\b"])), 1)

    def test_word_anchored_tripwire_matches_inside_snake_kebab_and_camel_paths(self):
        """A filename is not prose: `_` is a \\w char, so `\\bEXBANK\\b` has NO
        boundary in `download_exbank_statement.py`. Anchored tripwires are the
        RIGHT style for content (they keep the pattern off ordinary English) —
        so the path layer normalises separators instead of asking the human to
        write a second, looser copy of every pattern."""
        for path in ("a/download_exbank_statement.py",
                     "a/download-exbank-statement.py",
                     "a/downloadExbankStatement.py",
                     "a/exbank.statement.py",
                     "exbank/statement.py"):
            with self.subTest(path=path):
                self.assertEqual(len(guard.scan_path(path, [r"\bEXBANK\b"])), 1, path)

    def test_normalisation_does_not_invent_matches(self):
        # 'EXBANK' must not be conjured out of adjacent unrelated fragments.
        self.assertEqual(guard.scan_path("src/hd/fc_helper.py", [r"\bEXBANK\b"]), [])
        self.assertEqual(guard.scan_path("src/sexbankx.py", [r"\bEXBANK\b"]), [])

    def test_one_violation_per_pattern_not_per_variant(self):
        hits = guard.scan_path("a/exbank_thing.py", [r"\bEXBANK\b"])
        self.assertEqual(len(hits), 1, "raw + normalised variants must not double-report")


class TestCollectTouched(unittest.TestCase):
    """The push diff shows ADDED LINES only. A rename into a PII-bearing path
    adds zero lines, so the entire scan saw an empty string. _collect_touched
    is what makes the push's file set visible at all."""

    def setUp(self):
        for lst in (guard.ADDED, guard.TOUCHED_PATHS, guard.TOUCHED_FILES,
                    guard.UNREADABLE_PATHS, guard.MESSAGES):
            lst.clear()

    def _run(self, name_status_stdout, blobs=None):
        mock_result = MagicMock(stdout=name_status_stdout, returncode=0)
        with patch.object(guard.subprocess, "run", return_value=mock_result) as mock_run:
            with patch.object(guard, "_read_blobs", return_value=blobs or []):
                guard._collect_touched("base", "tip")
        return mock_run

    def test_rename_records_the_new_path_not_the_old(self):
        self._run("R100\tscripts/generic_name.py\tscripts/download_exbank_statement.py\n")
        self.assertIn("scripts/download_exbank_statement.py", guard.TOUCHED_PATHS)
        self.assertNotIn("scripts/generic_name.py", guard.TOUCHED_PATHS)

    def test_modified_and_added_paths_recorded(self):
        self._run("M\ta.py\nA\tb/c.md\n")
        self.assertEqual(guard.TOUCHED_PATHS, ["a.py", "b/c.md"])

    def test_deletions_excluded_by_git_and_renames_detected(self):
        mock_run = self._run("M\ta.py\n")
        argv = mock_run.call_args[0][0]
        self.assertIn("--find-renames", argv)
        self.assertIn("--diff-filter=ACMRT", argv, "a deleted path is not shipped")
        self.assertIn("--name-status", argv)

    def test_name_status_call_uses_explicit_utf8(self):
        mock_run = self._run("M\ta.py\n")
        _, kwargs = mock_run.call_args
        self.assertEqual(kwargs.get("encoding"), "utf-8")
        self.assertEqual(kwargs.get("errors"), "replace")

    def test_unreadable_blob_recorded_not_silently_dropped(self):
        self._run("M\ta.bin\n", blobs=[("a.bin", None)])
        self.assertIn("a.bin", guard.UNREADABLE_PATHS)
        self.assertEqual(guard.TOUCHED_FILES, [])

    def test_full_content_stored_for_readable_blob(self):
        self._run("M\ta.py\n", blobs=[("a.py", "line1\nline2\n")])
        self.assertEqual(guard.TOUCHED_FILES, [("a.py", "line1\nline2\n")])

    def test_name_status_failure_warns_loudly(self):
        buf = io.StringIO()
        with patch.object(guard.subprocess, "run", side_effect=OSError("boom")):
            with contextlib.redirect_stderr(buf):
                guard._collect_touched("base", "tip")
        self.assertIn("FAIL-OPEN", buf.getvalue())
        self.assertEqual(guard.TOUCHED_PATHS, [])


class TestPushScanCoverage(unittest.TestCase):
    """End-to-end main() in pre-push mode. Every case here is a leak that
    actually reached github.com/coderexpert123/pa-framework."""

    def setUp(self):
        for lst in (guard.ADDED, guard.TOUCHED_PATHS, guard.TOUCHED_FILES,
                    guard.UNREADABLE_PATHS, guard.MESSAGES):
            lst.clear()

    def _main(self, added=(), touched_paths=(), touched_files=(), tripwires=(),
              messages=(), agy=(True, "", True)):
        def fake_collect():
            guard.ADDED.extend(added)
            guard.TOUCHED_PATHS.extend(touched_paths)
            guard.TOUCHED_FILES.extend(touched_files)
            guard.MESSAGES.extend(messages)

        env = {k: v for k, v in os.environ.items() if k != "PA_SKIP_PII_GUARD"}
        buf = io.StringIO()
        with patch.dict(os.environ, env, clear=True), \
             patch.object(guard.sys, "argv", ["pre-push-pii-guard", "origin", "git@x:y.git"]), \
             patch.object(guard, "collect_diff", side_effect=fake_collect), \
             patch.object(guard, "load_tripwires", return_value=list(tripwires)), \
             patch.object(guard, "agy_check", return_value=agy) as gc, \
             contextlib.redirect_stderr(buf):
            rc = guard.main()
        return rc, buf.getvalue(), gc

    def test_tripwire_in_a_shipped_filename_blocks_the_push(self):
        """Leak 3 regression: contents generic, PATH names the bank, zero added lines."""
        rc, err, _ = self._main(
            touched_paths=["projects/daily-mail-brief/scripts/download_exbank_statement.py"],
            tripwires=[r"\bEXBANK\b"])
        self.assertEqual(rc, 1)
        self.assertIn("[PATH]", err)

    def test_rename_into_a_bad_path_blocks_even_with_no_added_lines(self):
        rc, err, _ = self._main(added=[], touched_paths=["scripts/acmebank_statement_dl.py"],
                                tripwires=[r"\bAcmeBank\b"])
        self.assertEqual(rc, 1)
        self.assertIn("acmebank_statement_dl.py", err)

    def test_preexisting_unchanged_content_in_a_touched_file_blocks(self):
        """Leak 2 regression: the provider names were committed long before this
        push; the diff's '+' lines are clean, the file is not."""
        rc, err, _ = self._main(
            added=["# unrelated new comment"],
            touched_paths=["scripts/run_brief.py"],
            touched_files=[("scripts/run_brief.py",
                            "import os\nPROVIDER = 'Secretname Wealth'\n")],
            tripwires=["Secretname"])
        self.assertEqual(rc, 1)
        self.assertIn("scripts/run_brief.py:2", err,
                      "must point at the pre-existing line, not just say 'somewhere'")

    def test_added_line_scan_still_runs(self):
        rc, err, _ = self._main(added=["contact Secretname today"],
                                touched_paths=["a.py"], tripwires=["Secretname"])
        self.assertEqual(rc, 1)
        self.assertIn("(added lines)", err)

    def test_commit_message_alone_blocks_the_push(self):
        """Tree, diff and paths all clean; only the message names the provider."""
        rc, err, _ = self._main(
            added=["# generic"], touched_paths=["scripts/generic.py"],
            touched_files=[("scripts/generic.py", "# generic\n")],
            messages=[("f" * 40, "rename download_exbank_statement.py -> generic.py")],
            tripwires=[r"\bEXBANK\b"])
        self.assertEqual(rc, 1)
        self.assertIn("[COMMIT MSG]", err)

    def test_clean_push_passes_and_discloses_layer_scope(self):
        rc, err, gc = self._main(added=["x = 1"], touched_paths=["a.py"],
                                 touched_files=[("a.py", "x = 1\n")],
                                 tripwires=["Secretname"])
        self.assertEqual(rc, 0)
        self.assertIn("ADDED LINES ONLY", err,
                      "the LLM layer's true (narrower) scope must be stated, not implied")
        self.assertEqual(gc.call_count, 1)

    def test_agy_infra_failure_now_blocks_the_push(self):
        """CORRECTED 2026-07-22 (was `test_gemini_infra_failure_warns_loudly_and_
        still_exits_zero`, asserting rc == 0): that assertion encoded the OLD
        fail-open push policy. The policy changed today — a push is an
        interactive gate, and a layer-3 verdict failure (unreachable, timed
        out twice, unparseable) now BLOCKS instead of waving the push through.
        Kept in place rather than deleted, per this repo's own convention for
        a test whose ASSERTION encoded now-superseded behavior. The layer
        itself still prints its own FAIL-OPEN banner (it genuinely could not
        render a verdict) — what changed is main()'s RESPONSE to that, not
        whether the banner fires."""
        rc, err, _ = self._main(added=["x = 1"], touched_paths=["a.py"],
                                agy=(True, "", False))
        self.assertEqual(rc, 1, "fail-CLOSED since 2026-07-22 — an infra failure must not wave a push through")
        self.assertIn("FAIL-OPEN", err, "the layer-skip banner still fires; main()'s reaction to it is what changed")
        self.assertIn("agy semantic scan", err)
        self.assertIn("PA_SKIP_PII_GUARD", err, "the only sanctioned escape hatch must be named in the block message")

    def test_agy_violation_still_blocks(self):
        rc, err, _ = self._main(added=["x = 1"], touched_paths=["a.py"],
                                agy=(False, "real name found", True))
        self.assertEqual(rc, 1)
        self.assertIn("real name found", err)

    def test_missing_tripwire_file_warns_loudly(self):
        rc, err, _ = self._main(added=["x = 1"], touched_paths=["a.py"], tripwires=[])
        self.assertEqual(rc, 0)
        self.assertIn("FAIL-OPEN", err)
        self.assertIn("pii-tripwires.txt", err)

    def test_credential_pattern_in_touched_file_content_blocks(self):
        rc, err, _ = self._main(
            touched_paths=["bot.py"],
            touched_files=[("bot.py", "TOKEN = '1234567890:" + "A" * 35 + "'\n")])
        self.assertEqual(rc, 1)
        self.assertIn("credential", err)

    def test_empty_push_is_a_no_op(self):
        rc, _, gc = self._main()
        self.assertEqual(rc, 0)
        self.assertEqual(gc.call_count, 0)


class TestPushModeFailClosed(unittest.TestCase):
    """NEW 2026-07-22: proves the actual policy change end-to-end via main().
    agy_check's (is_clean, reason, ok) contract is unchanged; what changed is
    what the PUSH-mode caller does with ok=False. `--full` (full_audit,
    covered separately in TestFullAuditLlmGuards) keeps the OLD fail-open
    behavior on purpose — a scheduled report must always complete, a push
    gate must not wave through content nobody actually verified. Complements
    (does not replace) the in-place-corrected regression test in
    TestPushScanCoverage."""

    def setUp(self):
        for lst in (guard.ADDED, guard.TOUCHED_PATHS, guard.TOUCHED_FILES,
                    guard.UNREADABLE_PATHS, guard.MESSAGES):
            lst.clear()

    def _main(self, agy):
        def fake_collect():
            guard.ADDED.extend(["x = 1"])
            guard.TOUCHED_PATHS.extend(["a.py"])

        env = {k: v for k, v in os.environ.items() if k != "PA_SKIP_PII_GUARD"}
        buf = io.StringIO()
        with patch.dict(os.environ, env, clear=True), \
             patch.object(guard.sys, "argv", ["pre-push-pii-guard", "origin", "git@x:y.git"]), \
             patch.object(guard, "collect_diff", side_effect=fake_collect), \
             patch.object(guard, "load_tripwires", return_value=["Secretname"]), \
             patch.object(guard, "agy_check", return_value=agy), \
             contextlib.redirect_stderr(buf):
            rc = guard.main()
        return rc, buf.getvalue()

    def test_layer_could_not_render_a_verdict_blocks_the_push(self):
        rc, err = self._main(agy=(True, "", False))
        self.assertEqual(rc, 1, "ok=False must block a push, not pass it")
        self.assertIn("PA_SKIP_PII_GUARD", err, "the sanctioned escape hatch must be named")
        self.assertIn("pii-guard-bypass.jsonl", err, "the bypass-is-never-silent property must be advertised here too")

    def test_genuinely_clean_verdict_passes(self):
        rc, _ = self._main(agy=(True, "", True))
        self.assertEqual(rc, 0)

    def test_genuine_violation_blocks_with_reason(self):
        rc, err = self._main(agy=(False, "some reason", True))
        self.assertEqual(rc, 1)
        self.assertIn("some reason", err)


class TestBypassRecord(unittest.TestCase):
    """PA_SKIP_PII_GUARD stays a working escape hatch (it is how a verified-clean
    history rewrite gets pushed, and — as of 2026-07-22 — the ONLY sanctioned
    way past a layer-3 verdict failure on a push), but it used to vanish
    without trace, so 'was anything ever pushed unscanned?' was unanswerable
    after the fact."""

    def _bypass(self, pa_home, stdin_lines):
        buf = io.StringIO()
        with patch.dict(os.environ, {"PA_SKIP_PII_GUARD": "1"}), \
             patch.object(guard, "PA_HOME", pa_home), \
             patch.object(guard.sys, "argv", ["pre-push-pii-guard", "origin", "git@github.com:x/y.git"]), \
             patch.object(guard.sys, "stdin", list(stdin_lines)), \
             contextlib.redirect_stderr(buf):
            rc = guard.main()
        return rc, buf.getvalue()

    def test_bypass_writes_a_durable_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            stdin = ["refs/heads/main " + "a" * 40 + " refs/heads/main " + "b" * 40 + "\n"]
            rc, err = self._bypass(tmp, stdin)
            self.assertEqual(rc, 0, "the bypass must still bypass")
            log = os.path.join(tmp, "pii-guard-bypass.jsonl")
            self.assertTrue(os.path.exists(log), "no durable record written")
            with open(log, encoding="utf-8") as f:
                entry = json.loads(f.read().strip())
        self.assertEqual(entry["event"], "pii-guard-bypass")
        self.assertTrue(entry["ts"], "a record with no timestamp is not an audit trail")
        self.assertEqual(entry["remote"], "origin")
        self.assertEqual(len(entry["refs"]), 1)
        self.assertIn("refs/heads/main", entry["refs"][0])

    def test_bypass_prints_an_unmissable_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, err = self._bypass(tmp, [])
        self.assertIn("BYPASSED", err)
        self.assertIn("PA_SKIP_PII_GUARD", err)

    def test_bypass_appends_rather_than_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._bypass(tmp, [])
            self._bypass(tmp, [])
            with open(os.path.join(tmp, "pii-guard-bypass.jsonl"), encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 2)

    def test_unwritable_log_does_not_break_the_bypass(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(guard.os, "makedirs", side_effect=OSError("read-only")):
                rc, err = self._bypass(tmp, [])
        self.assertEqual(rc, 0, "bookkeeping failure must never wedge the push")


class TestFullAuditPathScan(unittest.TestCase):
    def _audit(self, paths, files, tripwires, messages=()):
        buf = io.StringIO()
        with patch.object(guard, "list_tracked_paths", return_value=list(paths)), \
             patch.object(guard, "collect_tree", return_value=list(files)), \
             patch.object(guard, "load_tripwires", return_value=list(tripwires)), \
             patch.object(guard, "list_commit_messages", return_value=list(messages)), \
             contextlib.redirect_stdout(buf):
            rc = guard.full_audit(use_llm=False)
        return rc, buf.getvalue()

    def test_full_audit_scans_paths_including_unreadable_binaries(self):
        rc, out = self._audit(
            paths=["docs/notes.md", "exports/2026_exbank_statement.pdf"],
            files=[("docs/notes.md", "clean\n")],
            tripwires=[r"\bEXBANK\b"])
        self.assertEqual(rc, 0, "violations are OUTPUT, not an error (exit-code contract)")
        self.assertIn("[PATH]", out)
        self.assertIn("2026_exbank_statement.pdf", out)
        self.assertIn("in file NAMES", out)

    def test_full_audit_scans_commit_messages(self):
        rc, out = self._audit(
            paths=["a.md"], files=[("a.md", "clean\n")], tripwires=[r"\bEXBANK\b"],
            messages=[("a" * 40, "rename download_exbank_statement.py -> generic.py\n")])
        self.assertIn("[COMMIT MSG]", out)
        self.assertIn("in COMMIT MESSAGES", out)

    def test_no_llm_flag_announces_the_skipped_layer(self):
        rc, out = self._audit(paths=["a.md"], files=[("a.md", "clean\n")],
                              tripwires=["Secretname"])
        self.assertIn("FAIL-OPEN", out)
        self.assertIn("--no-llm", out)


class TestCommitMessageScan(unittest.TestCase):
    """2026-07-21, found while hardening this guard: the commit that renamed
    download_<bank>_statement.py away put that exact filename in its own SUBJECT
    line, and that commit is public on origin/main. Diff clean, tree clean, path
    clean — and `git log` publishes the term anyway. Nothing had ever scanned a
    commit message."""

    def setUp(self):
        guard.MESSAGES.clear()

    def test_message_tripwire_is_marked_as_a_commit_hit(self):
        hits = guard.scan_messages(
            [("deadbeefcafe0000", "rename download_exbank_statement.py -> generic.py")],
            [r"\bEXBANK\b"])
        self.assertEqual(len(hits), 1)
        self.assertIn("[COMMIT MSG]", hits[0])
        self.assertIn("deadbeefcafe", hits[0], "must name the commit to rewrite")

    def test_clean_message_no_hits(self):
        self.assertEqual(guard.scan_messages([("a" * 40, "fix a typo")], [r"\bEXBANK\b"]), [])

    def test_credential_in_a_commit_message_is_caught(self):
        hits = guard.scan_messages([("a" * 40, "oops token 1234567890:" + "A" * 35)], [])
        self.assertEqual(len(hits), 1)
        self.assertIn("credential", hits[0])

    def test_new_branch_push_uses_the_bare_sha_range(self):
        mock_result = MagicMock(stdout="", returncode=0)
        with patch.object(guard.subprocess, "run", return_value=mock_result) as mock_run:
            guard._collect_messages("0" * 40, "b" * 40)
        self.assertIn("b" * 40, mock_run.call_args[0][0])
        self.assertNotIn("0" * 40 + ".." + "b" * 40, mock_run.call_args[0][0])

    def test_incremental_push_uses_a_two_dot_range(self):
        mock_result = MagicMock(stdout="", returncode=0)
        with patch.object(guard.subprocess, "run", return_value=mock_result) as mock_run:
            guard._collect_messages("a" * 40, "b" * 40)
        self.assertIn("a" * 40 + ".." + "b" * 40, mock_run.call_args[0][0])

    def test_log_call_uses_explicit_utf8(self):
        mock_result = MagicMock(stdout="", returncode=0)
        with patch.object(guard.subprocess, "run", return_value=mock_result) as mock_run:
            guard._collect_messages("a" * 40, "b" * 40)
        _, kwargs = mock_run.call_args
        self.assertEqual(kwargs.get("encoding"), "utf-8")
        self.assertEqual(kwargs.get("errors"), "replace")

    def test_multiline_messages_parse_into_separate_records(self):
        stdout = (f"sha1{guard._FLD}subject one\n\nbody line\n{guard._REC}"
                  f"sha2{guard._FLD}subject two\n{guard._REC}")
        mock_result = MagicMock(stdout=stdout, returncode=0)
        with patch.object(guard.subprocess, "run", return_value=mock_result):
            guard._collect_messages("a" * 40, "b" * 40)
        self.assertEqual([s for s, _ in guard.MESSAGES], ["sha1", "sha2"])
        self.assertIn("body line", guard.MESSAGES[0][1])

    def test_git_log_failure_warns_loudly(self):
        buf = io.StringIO()
        mock_result = MagicMock(stdout="", stderr="fatal: bad revision", returncode=128)
        with patch.object(guard.subprocess, "run", return_value=mock_result):
            with contextlib.redirect_stderr(buf):
                guard._collect_messages("a" * 40, "b" * 40)
        self.assertIn("FAIL-OPEN", buf.getvalue())
        self.assertEqual(guard.MESSAGES, [])


class TestSubprocessEncodingInvariant(unittest.TestCase):
    """Do-not-regress (2026-07-08, re-broken and re-fixed 2026-07-12): ANY
    subprocess call in the guard that decodes output (text=True) must pass
    encoding='utf-8', errors='replace'. Without it Windows decodes with cp1252,
    where byte 0x8f (in the ⚠️ variation selector) is undefined — the call
    raises, a blanket `except` swallows it, and the scan silently vets nothing.
    A source-level assertion is what makes this hold for call sites that do not
    exist yet. Calls WITHOUT text=True (e.g. taskkill) return bytes and are
    exempt — there is no decode to get wrong. Unchanged by the 2026-07-22 agy
    migration — run it and confirm rather than assume, since a failure here
    would be a real defect in the core file worth escalating immediately."""

    def test_every_decoding_subprocess_call_pins_utf8(self):
        with open(GUARD_PATH, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            if not (isinstance(fn, ast.Attribute) and fn.attr in ("run", "Popen")):
                continue
            if not (isinstance(fn.value, ast.Name) and fn.value.id == "subprocess"):
                continue
            kw = {k.arg: k.value for k in node.keywords if k.arg}
            decodes = "text" in kw or "encoding" in kw or "universal_newlines" in kw
            if not decodes:
                continue  # bytes mode — nothing to decode wrongly
            enc = kw.get("encoding")
            errs = kw.get("errors")
            ok = (isinstance(enc, ast.Constant) and enc.value == "utf-8"
                  and isinstance(errs, ast.Constant) and errs.value == "replace")
            if not ok:
                offenders.append(f"line {node.lineno}: subprocess.{fn.attr}")
        self.assertEqual(offenders, [], f"missing encoding='utf-8', errors='replace': {offenders}")

    def test_kwargs_dict_call_sites_are_covered_by_the_popen_test(self):
        """_run_agy builds its kwargs in a dict and unpacks with **kwargs, so
        the AST check above cannot see them (the keyword node's .arg is None
        for a ** unpack) — the live assertion in
        TestAgyCheckSturdiness.test_popen_called_with_explicit_utf8_and_replace
        is what covers it. This test exists so that pairing is not accidental."""
        with open(GUARD_PATH, encoding="utf-8") as f:
            src = f.read()
        self.assertIn('encoding="utf-8", errors="replace"', src)


if __name__ == "__main__":
    unittest.main()
