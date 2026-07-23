"""Real-filesystem tests for pa/scripts/install_git_hooks.py.

No mocks of the filesystem itself — every case builds a real temp repo layout
(a source hook file + a `.git-public/hooks/` target dir) and exercises the real
os.symlink/os.link/shutil.copyfile paths, matching this session's "real
verification over mocks" convention for anything touching actual filesystem
behavior. The only thing monkeypatched is the injection of a forced OSError to
drive the fallback tiers deterministically — you cannot revoke symlink
privilege from inside a test process.

The load-bearing property is the edit-propagation one: with a symlink (or hard
link) in place, editing the SOURCE must be reflected at the TARGET with no
reinstall. test_symlink_reflects_source_edits_without_reinstall asserts it.
"""
import importlib.util
import io
import os
import contextlib
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "install_git_hooks.py",
)
spec = importlib.util.spec_from_file_location("install_git_hooks", MODULE_PATH)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


SOURCE_CONTENT = "#!/usr/bin/env python3\nprint('guard v1')\n"


def _make_repo(root: Path) -> Path:
    """Lay down a minimal repo: the tracked source hook + empty .git-public/hooks."""
    source = root / "pa" / "scripts" / "git-hooks" / "pre-push-pii-guard"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(SOURCE_CONTENT, encoding="utf-8")
    (root / ".git-public" / "hooks").mkdir(parents=True, exist_ok=True)
    return source


class InstallerTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="pa-install-hooks-")
        self.root = Path(self._tmp)
        self.source = _make_repo(self.root)
        self.target = self.root / ".git-public" / "hooks" / "pre-push"

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)


class TestFreshSymlinkInstall(InstallerTestBase):
    def test_fresh_install_creates_working_symlink(self):
        res = installer.install(self.root)
        self.assertEqual(res["method"], "symlink",
                         "symlink privilege is available here (proven by the "
                         "repo's own AGENTS.md/GEMINI.md links) so the primary "
                         "tier must be used")
        self.assertTrue(res["changed"])
        self.assertTrue(res["verified"])
        self.assertTrue(self.target.is_symlink())
        # Relative target so it survives being cloned to a different path.
        self.assertFalse(os.path.isabs(os.readlink(self.target)))
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)

    def test_rerun_when_already_correct_is_a_noop(self):
        installer.install(self.root)
        link_before = os.readlink(self.target)
        res = installer.install(self.root)
        self.assertEqual(res["method"], "symlink")
        self.assertFalse(res["changed"], "an already-correct symlink is left untouched")
        self.assertEqual(os.readlink(self.target), link_before)

    def test_stale_copy_is_replaced_with_symlink(self):
        # Simulate the historical `cp` install: a plain regular-file copy that
        # has already drifted from the source.
        self.target.write_text("#!/usr/bin/env python3\nprint('STALE drifted copy')\n",
                               encoding="utf-8")
        self.assertFalse(self.target.is_symlink())
        res = installer.install(self.root)
        self.assertEqual(res["method"], "symlink")
        self.assertTrue(res["changed"])
        self.assertTrue(self.target.is_symlink())
        self.assertTrue(res["verified"])
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)


class TestEditPropagation(InstallerTestBase):
    def test_symlink_reflects_source_edits_without_reinstall(self):
        """THE property being fixed: edit the source, target updates itself."""
        installer.install(self.root)
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)

        edited = SOURCE_CONTENT + "print('guard v2 — edited after install')\n"
        self.source.write_text(edited, encoding="utf-8")

        # No second install() call — reading the target must show the edit.
        self.assertEqual(self.target.read_text(encoding="utf-8"), edited,
                         "editing the tracked source IS the install; the hook "
                         "must not need a manual re-copy")


class TestFallbackTiers(InstallerTestBase):
    def test_symlink_failure_falls_back_to_hard_link(self):
        orig_symlink = os.symlink

        def boom(*a, **k):
            raise OSError("no symlink privilege (simulated)")

        buf = io.StringIO()
        os.symlink = boom
        try:
            with contextlib.redirect_stderr(buf):
                res = installer.install(self.root)
        finally:
            os.symlink = orig_symlink

        self.assertEqual(res["method"], "hardlink")
        self.assertTrue(res["changed"])
        self.assertTrue(res["verified"])
        self.assertFalse(self.target.is_symlink())
        # Same inode == a real hard link, and content matches.
        self.assertEqual(self.target.stat().st_ino, self.source.stat().st_ino)
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)
        self.assertTrue(any(w for w in res["warnings"] if "HARD LINK" in w))

    def test_hardlink_failure_falls_back_to_plain_copy_with_warning(self):
        orig_symlink, orig_link = os.symlink, os.link

        def boom(*a, **k):
            raise OSError("simulated failure")

        buf = io.StringIO()
        os.symlink = boom
        os.link = boom
        try:
            with contextlib.redirect_stderr(buf):
                res = installer.install(self.root)
        finally:
            os.symlink, os.link = orig_symlink, orig_link

        self.assertEqual(res["method"], "copy")
        self.assertTrue(res["changed"])
        self.assertTrue(res["verified"])
        self.assertFalse(self.target.is_symlink())
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)
        self.assertTrue(any(w for w in res["warnings"] if "PLAIN COPY" in w),
                        "the copy tier must warn that manual reinstall "
                        "discipline is required again")


class TestMainVerdict(InstallerTestBase):
    def test_main_reports_clean_drift_and_returns_zero(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = installer.main(["--repo-root", str(self.root)])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("drift check: CLEAN", out)


if __name__ == "__main__":
    unittest.main()
