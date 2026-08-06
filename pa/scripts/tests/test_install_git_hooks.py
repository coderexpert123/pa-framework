"""Real-filesystem tests for pa/scripts/install_git_hooks.py.

No mocks of the filesystem — every case builds a real temp private-repo layout
(the tracked source hook) and a real temp public-repo layout (a `.git/hooks/`
target dir), and exercises the real shutil.copyfile path.

Copy-only since 2026-08-06 (was symlink-preferred with hardlink/copy
fallbacks): the public mirror used to live at `.git-public/` sharing this
repo's working tree, so a relative symlink from the tracked source to the
hook target was a same-working-tree convenience. It now lives at its own
directory (nested at `<repo root>/pa-public` by default, own `.git/`,
gitignored by the private repo; override via `PA_PUBLIC_DIR`) as a genuinely
separate git repository with its own independent clone/pull lifecycle — a
symlink or hard link crossing that boundary would desync silently the moment
either repo is re-cloned, which is now a normal, supported recovery path (see
plans/2026-08-05-concurrent-session-safety.md). Re-running the installer after
every edit to the source is the documented, expected workflow; the drift-check
verdict this file also exercises is what catches "forgot to re-run".
"""
import importlib.util
import io
import os
import contextlib
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


class InstallerTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp_private = tempfile.mkdtemp(prefix="pa-install-hooks-private-")
        self._tmp_public = tempfile.mkdtemp(prefix="pa-install-hooks-public-")
        # .resolve() here matches what the installer does internally (it always
        # resolves public_dir) — on this machine TEMP paths may cross a drive
        # junction (D:\Users -> C:\Users), so an unresolved Path here would
        # compare unequal to the installer's resolved return value despite
        # pointing at the identical file.
        self.repo_root = Path(self._tmp_private).resolve()
        self.public_dir = Path(self._tmp_public).resolve()

        self.source = self.repo_root / "pa" / "scripts" / "git-hooks" / "pre-push-pii-guard"
        self.source.parent.mkdir(parents=True, exist_ok=True)
        self.source.write_text(SOURCE_CONTENT, encoding="utf-8")

        (self.public_dir / ".git" / "hooks").mkdir(parents=True, exist_ok=True)
        self.target = self.public_dir / ".git" / "hooks" / "pre-push"

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp_private, ignore_errors=True)
        shutil.rmtree(self._tmp_public, ignore_errors=True)


class TestFreshCopyInstall(InstallerTestBase):
    def test_fresh_install_copies_the_hook(self):
        res = installer.install(self.repo_root, self.public_dir)
        self.assertEqual(res["method"], "copy")
        self.assertTrue(res["changed"])
        self.assertTrue(res["verified"])
        self.assertFalse(self.target.is_symlink(), "copy-only: never a symlink")
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)

    def test_rerun_with_matching_content_is_a_noop(self):
        installer.install(self.repo_root, self.public_dir)
        mtime_before = self.target.stat().st_mtime_ns
        res = installer.install(self.repo_root, self.public_dir)
        self.assertEqual(res["method"], "copy")
        self.assertFalse(res["changed"], "content already matches — must not rewrite the file")
        self.assertTrue(res["verified"])
        self.assertEqual(self.target.stat().st_mtime_ns, mtime_before)

    def test_stale_content_is_overwritten_and_reported_changed(self):
        self.target.write_text("#!/usr/bin/env python3\nprint('STALE drifted copy')\n",
                               encoding="utf-8")
        res = installer.install(self.repo_root, self.public_dir)
        self.assertEqual(res["method"], "copy")
        self.assertTrue(res["changed"])
        self.assertTrue(res["verified"])
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)

    def test_missing_public_hooks_dir_is_created(self):
        import shutil as _shutil
        _shutil.rmtree(self.public_dir / ".git" / "hooks")
        res = installer.install(self.repo_root, self.public_dir)
        self.assertTrue(self.target.exists())
        self.assertTrue(res["verified"])

    def test_missing_source_raises(self):
        self.source.unlink()
        with self.assertRaises(FileNotFoundError):
            installer.install(self.repo_root, self.public_dir)

    def test_existing_symlink_is_replaced_with_a_real_copy(self):
        """Regression: a stale symlink left over from the pre-2026-08-06
        .git-public shared-tree topology must never be trusted as-is, even if
        it happens to resolve to matching content (e.g. because the public
        repo's own tracked tree coincidentally contains an identical file at
        the same relative offset — exactly what happened when pa-public was
        nested: the old hooks/pre-push symlink kept resolving to the mirror's
        own tracked copy of this same script). shutil.copyfile writes THROUGH
        a live symlink into whatever it points at, silently mutating tracked
        content instead of replacing the hook. install() must detect and
        remove any symlink before copying, unconditionally."""
        elsewhere = self.public_dir.parent / "elsewhere-source.txt"
        elsewhere.write_text(SOURCE_CONTENT, encoding="utf-8")
        try:
            self.target.symlink_to(elsewhere)
        except OSError as e:
            # Windows: creating a symlink needs SeCreateSymbolicLinkPrivilege
            # (admin) or Developer Mode — not guaranteed on every CI runner.
            # This test exercises install()'s handling of an EXISTING symlink,
            # which is orthogonal to whether *this test* can create one; skip
            # rather than false-fail the suite on a environment that can't.
            self.skipTest(f"cannot create symlinks in this environment: {e}")
        self.assertTrue(self.target.is_symlink())

        res = installer.install(self.repo_root, self.public_dir)

        self.assertFalse(self.target.is_symlink(), "stale symlink must be replaced by a real file")
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT)
        self.assertTrue(res["changed"])
        self.assertEqual(elsewhere.read_text(encoding="utf-8"), SOURCE_CONTENT,
                         "the symlink's old target must be untouched, not written through")


class TestNoEditPropagation(InstallerTestBase):
    def test_editing_source_does_NOT_propagate_without_reinstall(self):
        """The property that's now TRUE (opposite of the old symlink behavior):
        a copy is a snapshot, so editing the source alone leaves the installed
        hook stale until install() runs again."""
        installer.install(self.repo_root, self.public_dir)
        self.source.write_text(SOURCE_CONTENT + "print('guard v2')\n", encoding="utf-8")
        self.assertEqual(self.target.read_text(encoding="utf-8"), SOURCE_CONTENT,
                         "a copy must NOT reflect a source edit until reinstalled")

    def test_reinstall_after_source_edit_picks_up_the_change(self):
        installer.install(self.repo_root, self.public_dir)
        edited = SOURCE_CONTENT + "print('guard v2')\n"
        self.source.write_text(edited, encoding="utf-8")
        res = installer.install(self.repo_root, self.public_dir)
        self.assertTrue(res["changed"])
        self.assertEqual(self.target.read_text(encoding="utf-8"), edited)


class TestExecutableBit(InstallerTestBase):
    def test_installed_hook_is_executable_on_posix(self):
        import stat as _stat
        installer.install(self.repo_root, self.public_dir)
        if os.name != "nt":
            mode = self.target.stat().st_mode
            self.assertTrue(mode & _stat.S_IXUSR, "hook must be chmod +x on POSIX")


class TestPublicDirResolution(InstallerTestBase):
    def test_explicit_public_dir_argument_wins_over_env_var(self):
        other_public = Path(tempfile.mkdtemp(prefix="pa-install-hooks-envvar-"))
        (other_public / ".git" / "hooks").mkdir(parents=True, exist_ok=True)
        try:
            old = os.environ.get("PA_PUBLIC_DIR")
            os.environ["PA_PUBLIC_DIR"] = str(other_public)
            try:
                res = installer.install(self.repo_root, self.public_dir)
            finally:
                if old is None:
                    os.environ.pop("PA_PUBLIC_DIR", None)
                else:
                    os.environ["PA_PUBLIC_DIR"] = old
            self.assertEqual(res["target"], self.target)
            self.assertFalse((other_public / ".git" / "hooks" / "pre-push").exists())
        finally:
            import shutil as _shutil
            _shutil.rmtree(other_public, ignore_errors=True)

    def test_default_public_dir_is_nested_under_repo_root(self):
        """Core behavior of the 2026-08-06 nesting migration: with NEITHER an
        explicit --public-dir NOR PA_PUBLIC_DIR set, the installer must land
        the hook at <repo_root>/pa-public/.git/hooks/pre-push — not the old
        sibling D:/pa-public default."""
        old = os.environ.pop("PA_PUBLIC_DIR", None)
        try:
            res = installer.install(self.repo_root)
        finally:
            if old is not None:
                os.environ["PA_PUBLIC_DIR"] = old
        expected_target = self.repo_root / "pa-public" / ".git" / "hooks" / "pre-push"
        self.assertEqual(res["target"], expected_target)
        self.assertTrue(expected_target.exists())
        self.assertTrue(res["verified"])

    def test_env_var_used_when_no_explicit_public_dir(self):
        old = os.environ.get("PA_PUBLIC_DIR")
        os.environ["PA_PUBLIC_DIR"] = str(self.public_dir)
        try:
            res = installer.install(self.repo_root)
        finally:
            if old is None:
                os.environ.pop("PA_PUBLIC_DIR", None)
            else:
                os.environ["PA_PUBLIC_DIR"] = old
        self.assertEqual(res["target"], self.target)
        self.assertTrue(self.target.exists())


class TestMainVerdict(InstallerTestBase):
    def test_main_reports_clean_drift_and_returns_zero(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = installer.main(["--repo-root", str(self.repo_root), "--public-dir", str(self.public_dir)])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("drift check: CLEAN", out)

    def test_main_missing_source_returns_nonzero(self):
        self.source.unlink()
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            rc = installer.main(["--repo-root", str(self.repo_root), "--public-dir", str(self.public_dir)])
        self.assertEqual(rc, 1)
        self.assertIn("not found", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
