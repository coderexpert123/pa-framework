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
        shim = Path(os.environ["PA_GEMINI_SHIM_DIR"])
        (shim / "gemini.cmd").write_text("@echo off", encoding="utf-8")

        arcs = [a for _, a in bs.build_manifest()]
        self.assertIn("pa/secrets.env", arcs)
        self.assertIn("pa/google-token.json", arcs)
        self.assertIn("gemini-shim/gemini.cmd", arcs)

    def test_manifest_skips_missing_files(self):
        home = Path(os.environ["PA_HOME"])
        (home / "secrets.env").write_text("X=1", encoding="utf-8")
        arcs = [a for _, a in bs.build_manifest()]
        self.assertIn("pa/secrets.env", arcs)
        self.assertNotIn("pa/google-token.json", arcs)  # never created

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


if __name__ == "__main__":
    unittest.main()
