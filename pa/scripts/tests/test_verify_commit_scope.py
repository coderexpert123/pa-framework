"""Tests for pa/scripts/verify_commit_scope.py (scoped-commit enforcement, 2026-08-28).

Runs the script as a subprocess against a real throwaway git repo — real-process
verification per the house rule for git-adjacent tooling (no mocks of git)."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "verify_commit_scope.py"


def sh(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )


class VerifyCommitScopeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.repo.mkdir(parents=True, exist_ok=True)
        # Windows-native path for the WindowsApps python (never MSYS paths).
        self.repo = Path(os.path.realpath(self.repo))
        sh("git", "init", "-q", cwd=self.repo)
        sh("git", "config", "user.email", "t@example.com", cwd=self.repo)
        sh("git", "config", "user.name", "t", cwd=self.repo)
        (self.repo / "base.txt").write_text("base\n", encoding="utf-8")
        sh("git", "add", "base.txt", cwd=self.repo)
        sh("git", "commit", "-q", "-m", "base", cwd=self.repo)
        self.base = sh("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, name: str, *files: str):
        for f in files:
            target = self.repo / f
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"{name}\n", encoding="utf-8")
        sh("git", "add", *files, cwd=self.repo)
        sh("git", "commit", "-q", "-m", name, cwd=self.repo)

    def run_verifier(self, *paths: str, allowlist_file: str | None = None):
        cmd = [sys.executable, str(SCRIPT), "--base", self.base]
        if allowlist_file:
            cmd += ["--allowlist-file", allowlist_file]
        if paths:
            cmd += ["--", *paths]
        return subprocess.run(
            cmd, cwd=self.repo, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )

    def test_scope_held_exit_0(self):
        self.commit("mine", "a.txt", "b.txt")
        res = self.run_verifier("a.txt", "b.txt")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("scope held", res.stdout)

    def test_violation_exit_1_names_path_and_commit(self):
        self.commit("mine", "a.txt")
        self.commit("sweep", "stranger.txt")
        res = self.run_verifier("a.txt")
        self.assertEqual(res.returncode, 1, res.stdout + res.stderr)
        self.assertIn("stranger.txt", res.stdout)
        self.assertIn("sweep", res.stdout)

    def test_no_commits_in_range_is_trivially_held(self):
        res = self.run_verifier("a.txt")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

    def test_backslash_paths_normalized(self):
        self.commit("mine", "sub/inner.txt")
        res = self.run_verifier("sub\\inner.txt")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

    def test_allowlist_file_with_comments_and_blanks(self):
        self.commit("mine", "a.txt")
        al = self.repo / "allow.txt"
        al.write_text("# comment\n\na.txt\n", encoding="utf-8")
        res = self.run_verifier(allowlist_file=str(al))
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

    def test_empty_allowlist_is_usage_error(self):
        res = self.run_verifier()
        self.assertEqual(res.returncode, 2, res.stdout + res.stderr)

    def test_bad_base_is_git_error(self):
        res = self.run_verifier("a.txt")
        # sanity: valid base works; now an invalid one exits 2
        cmd = [sys.executable, str(SCRIPT), "--base", "deadbeef", "--", "a.txt"]
        bad = subprocess.run(
            cmd, cwd=self.repo, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        self.assertEqual(bad.returncode, 2, bad.stdout + bad.stderr)
        self.assertEqual(res.returncode, 0)


if __name__ == "__main__":
    unittest.main()
