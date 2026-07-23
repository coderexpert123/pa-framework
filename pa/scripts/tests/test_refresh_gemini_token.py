"""Unit tests for pa/scripts/refresh_gemini_token.py"""
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

# Make the parent directory importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import refresh_gemini_token as rgt


def _make_creds(refresh_token="RT123", expiry_offset_ms=None):
    """Build a minimal creds dict. expiry_offset_ms relative to now (positive = future)."""
    now_ms = int(time.time() * 1000)
    expiry = now_ms + (expiry_offset_ms if expiry_offset_ms is not None else 3_600_000)
    creds = {
        "access_token": "AT_old",
        "expiry_date": expiry,
        "token_type": "Bearer",
        "scope": "https://www.googleapis.com/auth/cloud-platform",
    }
    if refresh_token:
        creds["refresh_token"] = refresh_token
    return creds


class TestSecretResolution(unittest.TestCase):
    """_secret() resolves from os.environ first, then ~/.pa/secrets.env."""

    def setUp(self):
        rgt._SECRETS_CACHE = None

    def tearDown(self):
        rgt._SECRETS_CACHE = None

    def test_env_var_takes_precedence(self):
        with patch.dict(os.environ, {"GEMINI_OAUTH_CLIENT_ID": "from-env"}):
            self.assertEqual(rgt._client_id(), "from-env")

    def test_falls_back_to_secrets_env_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "secrets.env"), "w", encoding="utf-8") as f:
                f.write("GEMINI_OAUTH_CLIENT_ID=from-file\n")
            env = {k: v for k, v in os.environ.items() if k != "GEMINI_OAUTH_CLIENT_ID"}
            env["PA_HOME"] = tmp
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(rgt._client_id(), "from-file")

    def test_missing_raises_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if k != "GEMINI_OAUTH_CLIENT_ID"}
            env["PA_HOME"] = tmp
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(RuntimeError):
                    rgt._client_id()


class TestPreRun(unittest.TestCase):

    def setUp(self):
        # Redirect to temp paths so tests don't touch the real creds
        self._orig_creds = rgt.CREDS_PATH
        self._orig_stash = rgt.STASH_PATH
        # os.environ["TEMP"] is Windows-only (KeyError on Linux/macOS) --
        # tempfile.gettempdir() is the cross-platform equivalent.
        rgt.CREDS_PATH = os.path.join(os.environ.get("PA_HOME", tempfile.gettempdir()),
                                      "test_oauth_creds.json")
        rgt.STASH_PATH = rgt.CREDS_PATH + ".refresh_token_stash"

    def tearDown(self):
        for p in [rgt.CREDS_PATH, rgt.STASH_PATH]:
            try:
                os.remove(p)
            except OSError:
                pass
        rgt.CREDS_PATH = self._orig_creds
        rgt.STASH_PATH = self._orig_stash

    def _write_creds(self, creds):
        with open(rgt.CREDS_PATH, "w") as f:
            json.dump(creds, f)

    def _read_creds(self):
        with open(rgt.CREDS_PATH) as f:
            return json.load(f)

    def _read_stash(self):
        with open(rgt.STASH_PATH) as f:
            return f.read().strip()

    # --- creds file missing ---

    def test_no_creds_file_is_noop(self):
        """pre_run exits cleanly when creds file doesn't exist."""
        rgt.pre_run()  # must not raise

    # --- fresh token, no refresh needed ---

    def test_fresh_token_writes_stash_no_refresh(self):
        """Fresh token: stash is written, no network call made."""
        creds = _make_creds(refresh_token="RT_fresh", expiry_offset_ms=600_000)
        self._write_creds(creds)

        with patch.object(rgt, "_do_refresh") as mock_refresh:
            rgt.pre_run()
            mock_refresh.assert_not_called()

        self.assertEqual(self._read_stash(), "RT_fresh")

    def test_fresh_token_no_refresh_token_no_stash(self):
        """Fresh token with no refresh_token: stash not written."""
        creds = _make_creds(refresh_token=None, expiry_offset_ms=600_000)
        self._write_creds(creds)
        rgt.pre_run()
        self.assertFalse(os.path.exists(rgt.STASH_PATH))

    # --- expired token ---

    def test_expired_token_triggers_refresh(self):
        """Expired token: _do_refresh is called."""
        creds = _make_creds(refresh_token="RT_exp", expiry_offset_ms=-60_000)
        self._write_creds(creds)

        with patch.object(rgt, "_do_refresh") as mock_refresh:
            rgt.pre_run()
            mock_refresh.assert_called_once_with(creds, "RT_exp")

    def test_expired_token_writes_stash_before_refresh(self):
        """Stash is written even when refresh is needed (so post_run can restore on failure)."""
        creds = _make_creds(refresh_token="RT_exp", expiry_offset_ms=-1_000)
        self._write_creds(creds)

        with patch.object(rgt, "_do_refresh"):
            rgt.pre_run()

        self.assertEqual(self._read_stash(), "RT_exp")

    def test_expired_no_refresh_token_exits_1(self):
        """Expired with no refresh_token: exits with code 1."""
        creds = _make_creds(refresh_token=None, expiry_offset_ms=-1_000)
        self._write_creds(creds)

        with self.assertRaises(SystemExit) as cm:
            rgt.pre_run()
        self.assertEqual(cm.exception.code, 1)

    def test_missing_expiry_date_treated_as_expired(self):
        """Missing expiry_date defaults to 0 → treated as expired."""
        creds = {"access_token": "AT", "refresh_token": "RT_no_expiry"}
        self._write_creds(creds)

        with patch.object(rgt, "_do_refresh") as mock_refresh:
            rgt.pre_run()
            mock_refresh.assert_called_once()


class TestPostRun(unittest.TestCase):

    def setUp(self):
        self._orig_creds = rgt.CREDS_PATH
        self._orig_stash = rgt.STASH_PATH
        # os.environ["TEMP"] is Windows-only (KeyError on Linux/macOS) --
        # tempfile.gettempdir() is the cross-platform equivalent.
        rgt.CREDS_PATH = os.path.join(os.environ.get("PA_HOME", tempfile.gettempdir()),
                                      "test_oauth_creds.json")
        rgt.STASH_PATH = rgt.CREDS_PATH + ".refresh_token_stash"

    def tearDown(self):
        for p in [rgt.CREDS_PATH, rgt.STASH_PATH]:
            try:
                os.remove(p)
            except OSError:
                pass
        rgt.CREDS_PATH = self._orig_creds
        rgt.STASH_PATH = self._orig_stash

    def _write_creds(self, creds):
        with open(rgt.CREDS_PATH, "w") as f:
            json.dump(creds, f)

    def _write_stash(self, token):
        with open(rgt.STASH_PATH, "w") as f:
            f.write(token)

    def _read_creds(self):
        with open(rgt.CREDS_PATH) as f:
            return json.load(f)

    # --- stash absent ---

    def test_no_stash_is_noop(self):
        """post_run exits cleanly when stash doesn't exist."""
        rgt.post_run()  # must not raise

    def test_no_creds_file_is_noop(self):
        """post_run exits cleanly when creds file doesn't exist."""
        self._write_stash("RT_stashed")
        rgt.post_run()  # must not raise

    # --- refresh_token still present ---

    def test_refresh_token_present_no_restore(self):
        """If refresh_token still in creds, post_run does not overwrite it."""
        creds = _make_creds(refresh_token="RT_current")
        self._write_creds(creds)
        self._write_stash("RT_stashed")

        rgt.post_run()

        result = self._read_creds()
        self.assertEqual(result["refresh_token"], "RT_current")

    # --- refresh_token stripped by CLI ---

    def test_restore_when_refresh_token_stripped(self):
        """If CLI stripped refresh_token, post_run restores it from stash."""
        creds = _make_creds(refresh_token=None)
        self._write_creds(creds)
        self._write_stash("RT_stashed")

        rgt.post_run()

        result = self._read_creds()
        self.assertEqual(result["refresh_token"], "RT_stashed")

    def test_stash_persists_after_post_run(self):
        """Stash file is NOT deleted after post_run (persistent backup)."""
        creds = _make_creds(refresh_token=None)
        self._write_creds(creds)
        self._write_stash("RT_stashed")

        rgt.post_run()

        self.assertTrue(os.path.exists(rgt.STASH_PATH), "stash should be persistent, not deleted")

    def test_corrupt_creds_does_not_crash(self):
        """Corrupt creds.json is handled gracefully — no exception, stash untouched."""
        with open(rgt.CREDS_PATH, "w") as f:
            f.write("{{not valid json}}")
        self._write_stash("RT_stashed")

        rgt.post_run()  # must not raise

        self.assertTrue(os.path.exists(rgt.STASH_PATH))

    def test_empty_stash_is_noop(self):
        """Empty stash file does not cause a restore."""
        creds = _make_creds(refresh_token=None)
        self._write_creds(creds)
        self._write_stash("")

        rgt.post_run()

        result = self._read_creds()
        self.assertIsNone(result.get("refresh_token"))


class TestDoRefresh(unittest.TestCase):

    def setUp(self):
        self._orig_creds = rgt.CREDS_PATH
        # 2026-07-23: os.environ["TEMP"] is Windows-only (KeyError on Linux/
        # macOS, where this test had never actually run until CI grew a
        # Python step across all 3 platforms) -- tempfile.gettempdir() is
        # the cross-platform equivalent.
        rgt.CREDS_PATH = os.path.join(os.environ.get("PA_HOME", tempfile.gettempdir()),
                                      "test_oauth_creds.json")
        # Isolate from the real ~/.pa/secrets.env — _client_id/_client_secret
        # must not depend on this machine's actual OAuth credentials.
        self._env_patch = patch.dict(os.environ, {
            "GEMINI_OAUTH_CLIENT_ID": "test-client-id",
            "GEMINI_OAUTH_CLIENT_SECRET": "test-client-secret",
        })
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()
        try:
            os.remove(rgt.CREDS_PATH)
        except OSError:
            pass
        rgt.CREDS_PATH = self._orig_creds

    def _read_creds(self):
        with open(rgt.CREDS_PATH) as f:
            return json.load(f)

    def _make_response(self, **kwargs):
        payload = {"access_token": "AT_new", "expires_in": 3599, "token_type": "Bearer"}
        payload.update(kwargs)
        response_bytes = json.dumps(payload).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = response_bytes
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def test_successful_refresh_updates_creds(self):
        """Successful refresh updates access_token and expiry_date, preserves refresh_token."""
        creds = _make_creds(refresh_token="RT_keep", expiry_offset_ms=-1_000)
        mock_resp = self._make_response(access_token="AT_new", expires_in=3599)

        with patch("urllib.request.urlopen", return_value=mock_resp):
            rgt._do_refresh(creds, "RT_keep")

        result = self._read_creds()
        self.assertEqual(result["access_token"], "AT_new")
        self.assertEqual(result["refresh_token"], "RT_keep")
        self.assertGreater(result["expiry_date"], int(time.time() * 1000))

    def test_missing_expires_in_uses_default(self):
        """Response without expires_in uses 3600s default instead of crashing."""
        creds = _make_creds(refresh_token="RT_keep")
        # Build mock with no expires_in in the response body
        response_bytes = json.dumps({"access_token": "AT_new", "token_type": "Bearer"}).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = response_bytes
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        before = int(time.time() * 1000)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            rgt._do_refresh(creds, "RT_keep")

        result = self._read_creds()
        self.assertGreaterEqual(result["expiry_date"], before + 3_600_000 - 1000)

    def test_id_token_updated_when_present(self):
        """id_token field is updated when included in refresh response."""
        creds = _make_creds(refresh_token="RT_keep")
        mock_resp = self._make_response(access_token="AT_new", expires_in=3599, id_token="IDT_new")

        with patch("urllib.request.urlopen", return_value=mock_resp):
            rgt._do_refresh(creds, "RT_keep")

        result = self._read_creds()
        self.assertEqual(result["id_token"], "IDT_new")

    def test_id_token_not_overwritten_when_absent(self):
        """Existing id_token is preserved if refresh response omits it."""
        creds = _make_creds(refresh_token="RT_keep")
        creds["id_token"] = "IDT_old"
        mock_resp = self._make_response(access_token="AT_new", expires_in=3599)

        with patch("urllib.request.urlopen", return_value=mock_resp):
            rgt._do_refresh(creds, "RT_keep")

        result = self._read_creds()
        self.assertEqual(result["id_token"], "IDT_old")

    def test_http_error_exits_1(self):
        """HTTP error from token endpoint causes sys.exit(1)."""
        import urllib.error
        creds = _make_creds()
        err = urllib.error.HTTPError(url="", code=400, msg="Bad Request",
                                     hdrs=None, fp=MagicMock(read=lambda: b'{"error":"invalid_grant"}'))

        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(SystemExit) as cm:
                rgt._do_refresh(creds, "RT_bad")
        self.assertEqual(cm.exception.code, 1)

    def test_network_error_exits_1(self):
        """Generic network error causes sys.exit(1)."""
        creds = _make_creds()
        with patch("urllib.request.urlopen", side_effect=OSError("Network unreachable")):
            with self.assertRaises(SystemExit) as cm:
                rgt._do_refresh(creds, "RT_ok")
        self.assertEqual(cm.exception.code, 1)

    def test_creds_file_not_written_on_failure(self):
        """Existing creds file is not modified when refresh fails."""
        import urllib.error
        # Write a creds file first so we can verify it's untouched after failure
        creds = _make_creds(refresh_token="RT_orig")
        with open(rgt.CREDS_PATH, "w") as f:
            json.dump(creds, f)
        original_mtime = os.path.getmtime(rgt.CREDS_PATH)

        err = urllib.error.HTTPError(url="", code=401, msg="Unauthorized",
                                     hdrs=None, fp=MagicMock(read=lambda: b"{}"))

        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(SystemExit):
                rgt._do_refresh(creds, "RT_orig")

        # File should exist and not be modified (mtime unchanged)
        self.assertTrue(os.path.exists(rgt.CREDS_PATH))
        self.assertEqual(os.path.getmtime(rgt.CREDS_PATH), original_mtime,
                         "creds file must not be written on refresh failure")


class TestCorruptionResilience(unittest.TestCase):
    """Root-cause fixes for the 2026-07-12 oauth_creds.json torn-write corruption:
    atomic writes + self-healing load of a torn 'valid-JSON-then-garbage' file."""

    def setUp(self):
        self._orig = rgt.CREDS_PATH
        self._tmpdir = tempfile.mkdtemp()
        rgt.CREDS_PATH = os.path.join(self._tmpdir, "oauth_creds.json")
        rgt.STASH_PATH = rgt.CREDS_PATH + ".refresh_token_stash"

    def tearDown(self):
        rgt.CREDS_PATH = self._orig
        rgt.STASH_PATH = rgt.CREDS_PATH + ".refresh_token_stash"
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_save_creds_is_atomic_no_tmp_left_behind(self):
        rgt.save_creds({"access_token": "AT", "refresh_token": "RT"})
        # The whole-file replace leaves no stray temp file next to the target.
        siblings = os.listdir(self._tmpdir)
        self.assertEqual(siblings, ["oauth_creds.json"], f"unexpected leftovers: {siblings}")
        self.assertEqual(rgt.load_creds()["refresh_token"], "RT")

    def test_load_creds_self_heals_a_torn_valid_then_garbage_file(self):
        # Exactly the 2026-07-12 corruption shape: a complete object, then junk.
        good = json.dumps({"access_token": "AT", "refresh_token": "RT", "expiry_date": 123})
        with open(rgt.CREDS_PATH, "w", encoding="utf-8") as f:
            f.write(good + "ASU0ePuv-6sHEM35garbage")
        creds = rgt.load_creds()
        self.assertEqual(creds["refresh_token"], "RT")
        self.assertEqual(creds["access_token"], "AT")

    def test_load_creds_still_raises_on_unrecoverable_garbage(self):
        with open(rgt.CREDS_PATH, "w", encoding="utf-8") as f:
            f.write("not json at all {[")
        with self.assertRaises(Exception):
            rgt.load_creds()

    def test_save_then_load_round_trip_after_heal(self):
        # A heal-on-load followed by a save produces a clean, re-parseable file.
        with open(rgt.CREDS_PATH, "w", encoding="utf-8") as f:
            f.write(json.dumps({"access_token": "AT", "refresh_token": "RT"}) + "trailing")
        creds = rgt.load_creds()
        rgt.save_creds(creds)
        with open(rgt.CREDS_PATH, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["refresh_token"], "RT")  # clean, no trailing junk


if __name__ == "__main__":
    unittest.main()
