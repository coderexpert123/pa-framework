"""Tests for pa/scripts/public_separation_check.py (Wave A, AI-264).

Pure unit tests, no repo mutation: every fixture git repo is built in a temp
dir per test. All commits use relative/now timestamps (never absolute-date
fixtures). The real CLI is exercised via subprocess so exit codes and the
SCAN OK contract are tested, not a re-implementation.
"""
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "public_separation_check.py")


def run_checker(repo: str, *extra: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, SCRIPT, "--repo", repo, *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120, env=env,
    )


class GitFixture:
    """A throwaway git repo in a temp dir; commits dated 'now'."""

    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="sepcheck-fixture-")
        self._git(["init"])
        self._git(["config", "user.email", "fixture@example.com"])
        self._git(["config", "user.name", "Fixture"])
        self._git(["config", "commit.gpgsign", "false"])

    def _git(self, args: list[str]) -> None:
        subprocess.run(
            ["git", "-C", self.dir] + args,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=60,
        )

    def commit(self, message: str, files: dict[str, str | bytes]) -> None:
        for name, content in files.items():
            path = os.path.join(self.dir, name.replace("/", os.sep))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            mode = "wb" if isinstance(content, bytes) else "w"
            with open(path, mode, encoding=None if isinstance(content, bytes) else "utf-8") as f:
                f.write(content)
        self._git("add -A".split())
        self._git(["commit", "-m", message, "--date", "now"])

    def remove(self, name: str, message: str) -> None:
        os.remove(os.path.join(self.dir, name))
        self._git("add -A".split())
        self._git(["commit", "-m", message, "--date", "now"])


def write_patterns(tmpdir: str, text: str) -> str:
    path = os.path.join(tmpdir, "patterns.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


class CleanPassTests(unittest.TestCase):
    def test_contents_clean(self) -> None:
        fx = GitFixture()
        fx.commit("generic commit", {"a.py": "print('hello')\n"})
        pats = write_patterns(fx.dir, "# patterns\nnothingsynthetic\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "contents")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("violations=0", r.stdout)
        self.assertIn("SCAN OK", r.stdout)
        self.assertEqual(r.stdout.count("SCAN OK"), 1)

    def test_paths_clean(self) -> None:
        fx = GitFixture()
        fx.commit("generic commit", {"plain/path.txt": "x\n"})
        pats = write_patterns(fx.dir, "nothingsynthetic\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "paths")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("violations=0", r.stdout)

    def test_history_clean(self) -> None:
        fx = GitFixture()
        fx.commit("generic commit", {"a.txt": "plain text\n"})
        fx.remove("a.txt", "remove a.txt")
        pats = write_patterns(fx.dir, "nothingsynthetic\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "history")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("violations=0", r.stdout)
        self.assertIn("commits=2", r.stdout)


class ViolationTests(unittest.TestCase):
    def test_content_violation_exit2(self) -> None:
        fx = GitFixture()
        fx.commit("add file", {"a.py": "TOKEN = \"synthetic-ident-1\"\n"})
        pats = write_patterns(fx.dir, "synthetic-ident-1\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "contents")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("VIOLATION CONTENT a.py:1", r.stdout)
        self.assertIn("SCAN OK", r.stdout)
        self.assertIn("violations=1", r.stdout)

    def test_path_violation_exit2(self) -> None:
        fx = GitFixture()
        fx.commit("add file", {"reminders/synid_config.py": "x = 1\n"})
        pats = write_patterns(fx.dir, "synid\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "paths")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("VIOLATION PATH reminders/synid_config.py", r.stdout)

    def test_separator_normalized_path_match(self) -> None:
        # separators -> spaces + camelCase split: an anchored pattern that
        # would NOT match the raw path must match after normalization.
        fx = GitFixture()
        fx.commit("add file", {"acme_statement.py": "generic\n"})
        pats = write_patterns(fx.dir, r"\bacme\b" + "\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "paths")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("VIOLATION PATH acme_statement.py", r.stdout)

    def test_history_content_violation(self) -> None:
        fx = GitFixture()
        fx.commit("add secret", {"leak.txt": "synthetic-ident-2\n"})
        fx.remove("leak.txt", "remove leak")
        pats = write_patterns(fx.dir, "synthetic-ident-2\n")
        # HEAD contents clean, history blob dirty
        rc = run_checker(fx.dir, "--patterns", pats, "--mode", "contents")
        self.assertEqual(rc.returncode, 0, rc.stderr)
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "history")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("VIOLATION HISTORY-CONTENT", r.stdout)

    def test_history_path_violation(self) -> None:
        fx = GitFixture()
        fx.commit("add", {"reminders/synid2_config.py": "x\n"})
        fx.remove("reminders/synid2_config.py", "remove")
        pats = write_patterns(fx.dir, "synid2\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "history")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("VIOLATION HISTORY-PATH", r.stdout)

    def test_history_message_violation(self) -> None:
        fx = GitFixture()
        fx.commit("add synthetic-ident-3", {"a.txt": "ok\n"})
        pats = write_patterns(fx.dir, "synthetic-ident-3\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "history")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("VIOLATION HISTORY-MSG", r.stdout)


class BinaryAndBudgetTests(unittest.TestCase):
    def test_binary_blob_skipped_not_crash(self) -> None:
        fx = GitFixture()
        fx.commit("add binary", {"blob.bin": b"\x00\x01\x02\xff\xfe"})
        pats = write_patterns(fx.dir, "synthetic-ident-4\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "contents")
        self.assertIn(r.returncode, (0, 2))
        self.assertIn("SKIPPED", r.stdout)

    def test_oversized_blob_skipped(self) -> None:
        fx = GitFixture()
        fx.commit("big", {"huge.txt": ("a" * 1_200_000) + "\n"})
        pats = write_patterns(fx.dir, "synthetic-ident-5\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "contents")
        self.assertIn(r.returncode, (0, 2))
        self.assertIn("SKIPPED", r.stdout)


class PatternsUnionTests(unittest.TestCase):
    def test_patterns_union(self) -> None:
        fx = GitFixture()
        fx.commit("add", {"a.txt": "alpha-1\nbeta-2\n"})
        p1 = write_patterns(fx.dir, "alpha-1\n")
        p2_path = os.path.join(fx.dir, "p2.txt")
        with open(p2_path, "w", encoding="utf-8") as f:
            f.write("beta-2\n")
        r = run_checker(fx.dir, "--patterns", p1, "--patterns", p2_path,
                        "--mode", "contents")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("alpha-1", r.stdout)
        self.assertIn("beta-2", r.stdout)


class PathsRestrictionTests(unittest.TestCase):
    def test_paths_restriction(self) -> None:
        fx = GitFixture()
        fx.commit("add", {"in_set/synid5_file.py": "x\n",
                          "outside/synid5_file.py": "x\n"})
        pats = write_patterns(fx.dir, "synid5\n")
        pathlist = os.path.join(fx.dir, "paths.txt")
        with open(pathlist, "w", encoding="utf-8") as f:
            f.write("in_set/synid5_file.py\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "paths",
                        "--paths", pathlist)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("in_set/synid5_file.py", r.stdout)
        self.assertNotIn("outside/synid5_file.py", r.stdout)

    def test_paths_stdin_restriction(self) -> None:
        fx = GitFixture()
        fx.commit("add", {"in_set/synid6_file.py": "x\n"})
        pats = write_patterns(fx.dir, "synid6\n")
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        r = subprocess.run(
            [sys.executable, SCRIPT, "--repo", fx.dir, "--patterns", pats,
             "--mode", "paths", "--paths", "-"],
            input="in_set/synid6_file.py\n",
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=120, env=env,
        )
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("in_set/synid6_file.py", r.stdout)


class MalformedPatternsTests(unittest.TestCase):
    def test_empty_line_and_malformed_regex_fail_with_line_number(self) -> None:
        fx = GitFixture()
        fx.commit("add", {"a.txt": "synthetic-ident-7\n"})
        bad = write_patterns(fx.dir, "goodpattern\n\n([unclosed\n")
        r = run_checker(fx.dir, "--patterns", bad, "--mode", "all")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotEqual(r.returncode, 2)
        self.assertIn("line", r.stderr)
        self.assertIn("ERROR", r.stderr)

    def test_empty_line_alone_fails(self) -> None:
        fx = GitFixture()
        fx.commit("add", {"a.txt": "synthetic-ident-8\n"})
        bad = write_patterns(fx.dir, "p1\n\np2\n")
        r = run_checker(fx.dir, "--patterns", bad, "--mode", "all")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("line 2", r.stderr)


class PathsModeGuardTests(unittest.TestCase):
    def test_paths_with_contents_mode_errors_not_silent_ignore(self) -> None:
        fx = GitFixture()
        fx.commit("add", {"a.txt": "x\n"})
        pats = write_patterns(fx.dir, "x\n")
        pathlist = os.path.join(fx.dir, "paths.txt")
        with open(pathlist, "w", encoding="utf-8") as f:
            f.write("a.txt\n")
        r = run_checker(fx.dir, "--patterns", pats, "--mode", "contents",
                        "--paths", pathlist)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("--paths restricts only", r.stderr)
        self.assertNotIn("SCAN OK", r.stdout)


if __name__ == "__main__":
    unittest.main()
