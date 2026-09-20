"""Unit tests for backup_secrets.py crypto + manifest + pack/restore round-trip.

Pure-logic only — no Drive, no network. Run:
    python -m pytest pa/scripts/tests/test_backup_secrets.py -q
"""
import io
import os
import gzip
import sys
import tarfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import backup_secrets as bs  # noqa: E402

PASSPHRASE = "correct-horse-battery-staple-1234"


class TestEncryptDecrypt(unittest.TestCase):
    def test_round_trip(self):
        pt = b"the quick brown fox" * 100
        blob = bs.encrypt(pt, PASSPHRASE)
        self.assertTrue(blob.startswith(bs.MAGIC))
        self.assertEqual(bs.decrypt(blob, PASSPHRASE), pt)

    def test_wrong_passphrase_fails(self):
        blob = bs.encrypt(b"secret", PASSPHRASE)
        with self.assertRaises(Exception):
            bs.decrypt(blob, "wrong-passphrase-000000000")

    def test_tampered_ciphertext_fails(self):
        blob = bytearray(bs.encrypt(b"secret data here", PASSPHRASE))
        blob[-1] ^= 0x01  # flip a bit in the GCM tag
        with self.assertRaises(Exception):
            bs.decrypt(bytes(blob), PASSPHRASE)

    def test_bad_magic_rejected(self):
        with self.assertRaises(ValueError):
            bs.decrypt(b"NOTAPABKUP" + b"\x00" * 40, PASSPHRASE)

    def test_distinct_salts_and_nonces(self):
        # Same plaintext + passphrase must not produce identical blobs.
        a = bs.encrypt(b"x", PASSPHRASE)
        b = bs.encrypt(b"x", PASSPHRASE)
        self.assertNotEqual(a, b)


class TestManifestAndPack(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        self._orig_home = os.environ.get("PA_HOME")
        self._orig_shim = os.environ.get("PA_GEMINI_SHIM_DIR")
        os.environ["PA_HOME"] = str(Path(self.tmp) / "pa-home")
        os.environ["PA_GEMINI_SHIM_DIR"] = str(Path(self.tmp) / "shim")
        (Path(self.tmp) / "pa-home").mkdir()
        (Path(self.tmp) / "shim").mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        for var, val in [("PA_HOME", self._orig_home), ("PA_GEMINI_SHIM_DIR", self._orig_shim)]:
            if val is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = val

    def _write(self, rel, content):
        p = Path(os.environ["PA_HOME"]).parent / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")

    def test_manifest_collects_existing_pa_files_and_shim(self):
        home = Path(os.environ["PA_HOME"])
        (home / "secrets.env").write_text("TELEGRAM_BOT_TOKEN=x", encoding="utf-8")
        (home / "google-token.json").write_text("{}", encoding="utf-8")
        (home / "data").mkdir()
        (home / "data" / "profile.json").write_text("{}", encoding="utf-8")
        (home / "data" / "profile-history-archive.jsonl").write_text("", encoding="utf-8")
        shim = Path(os.environ["PA_GEMINI_SHIM_DIR"])
        (shim / "gemini.cmd").write_text("@echo off", encoding="utf-8")

        arcs = [a for _, a in bs.build_manifest()]
        self.assertIn("pa/secrets.env", arcs)
        self.assertIn("pa/google-token.json", arcs)
        self.assertIn("gemini-shim/gemini.cmd", arcs)
        # AI-089: the repo-external profile pair rides this bundle for durability
        self.assertIn("pa/data/profile.json", arcs)
        self.assertIn("pa/data/profile-history-archive.jsonl", arcs)

    def test_manifest_skips_missing_files(self):
        home = Path(os.environ["PA_HOME"])
        (home / "secrets.env").write_text("X=1", encoding="utf-8")
        arcs = [a for _, a in bs.build_manifest()]
        self.assertIn("pa/secrets.env", arcs)
        self.assertNotIn("pa/google-token.json", arcs)  # never created

    def test_shim_env_set_but_missing_dir_is_loud(self):
        # WB-51: a configured shim dir that does not exist must be a LOUD
        # error naming the env override, never a silently-empty hash set.
        os.environ["PA_GEMINI_SHIM_DIR"] = str(Path(self.tmp) / "no-such-shim")
        with self.assertRaises(RuntimeError) as ctx:
            bs.build_manifest()
        self.assertIn("PA_GEMINI_SHIM_DIR", str(ctx.exception))

    def test_shim_env_unset_skips_section(self):
        # WB-51: no shim configured → the section skips (no hardcoded
        # operator default). No error, no shim entries.
        del os.environ["PA_GEMINI_SHIM_DIR"]
        arcs = [a for _, a in bs.build_manifest()]
        self.assertFalse([a for a in arcs if a.startswith("gemini-shim/")])

    def test_build_blob_refuses_without_secrets_env(self):
        # Only a stray non-core file present → no secrets.env → must refuse.
        (Path(os.environ["PA_HOME"]) / "pii-tripwires.txt").write_text("x", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            bs.build_blob(PASSPHRASE)

    def test_full_backup_restore_round_trip(self):
        home = Path(os.environ["PA_HOME"])
        (home / "secrets.env").write_text("TELEGRAM_BOT_TOKEN=abc\nPA_BACKUP_PASSPHRASE=y", encoding="utf-8")
        (home / "google-token.json").write_text('{"refresh_token":"rt"}', encoding="utf-8")

        blob, arcs = bs.build_blob(PASSPHRASE)
        # Decrypt → gunzip → untar → verify byte-exact recovery.
        raw = gzip.decompress(bs.decrypt(blob, PASSPHRASE))
        recovered = {}
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r") as tar:
            for m in tar.getmembers():
                recovered[m.name] = tar.extractfile(m).read()
        self.assertEqual(recovered["pa/secrets.env"], (home / "secrets.env").read_bytes())
        self.assertEqual(recovered["pa/google-token.json"], (home / "google-token.json").read_bytes())


class TestReauthKickOnDriveFailure(unittest.TestCase):
    """backup_secrets.py had NO existing handler around _drive() before this
    (correction 14 of the 2026-08-23 alerts-wave spec) — main() must wrap
    it, kick a reauth link via the WP-G helper, and still exit 1 without
    masking the real error. The helper module doesn't exist at collection time
    in every environment (WP-G's own file) so it's stubbed via sys.modules,
    matching the try/except-Exception import at the call site."""

    def setUp(self):
        import tempfile
        self._orig_kick_module = sys.modules.get("google_reauth_kick")
        self.stub_module = type(sys)("google_reauth_kick")
        self.stub_module.kick_google_reauth = MagicMock()
        sys.modules["google_reauth_kick"] = self.stub_module

        self.tmp = tempfile.mkdtemp()
        self._orig_home = os.environ.get("PA_HOME")
        self._orig_pass = os.environ.get("PA_BACKUP_PASSPHRASE")
        os.environ["PA_HOME"] = str(Path(self.tmp) / "pa-home")
        Path(os.environ["PA_HOME"]).mkdir()
        # build_manifest() must find a real secrets.env or build_blob() raises
        # BEFORE reaching _drive() — content is irrelevant, only existence.
        (Path(os.environ["PA_HOME"]) / "secrets.env").write_text(
            "PA_BACKUP_PASSPHRASE=correct-horse-battery-staple-1234", encoding="utf-8"
        )
        # Set directly (bypasses _secret()'s module-level _SECRETS_CACHE, which
        # is populated lazily and would otherwise leak across test run order).
        os.environ["PA_BACKUP_PASSPHRASE"] = "correct-horse-battery-staple-1234"

    def tearDown(self):
        import shutil
        if self._orig_kick_module is not None:
            sys.modules["google_reauth_kick"] = self._orig_kick_module
        else:
            sys.modules.pop("google_reauth_kick", None)
        shutil.rmtree(self.tmp, ignore_errors=True)
        for var, val in [("PA_HOME", self._orig_home), ("PA_BACKUP_PASSPHRASE", self._orig_pass)]:
            if val is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = val

    def test_drive_failure_kicks_reauth_and_exits_1(self):
        with patch.object(
            bs, "_drive", side_effect=RuntimeError("Google token is missing or invalid.")
        ):
            with self.assertRaises(SystemExit) as ctx:
                bs.main()

        self.assertEqual(ctx.exception.code, 1)
        self.stub_module.kick_google_reauth.assert_called_once()
        _, kwargs = self.stub_module.kick_google_reauth.call_args
        self.assertEqual(kwargs.get("resume_skill"), "secrets-backup")


if __name__ == "__main__":
    unittest.main()
