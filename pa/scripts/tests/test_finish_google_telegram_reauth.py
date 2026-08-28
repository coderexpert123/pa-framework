"""Unit tests for pa/scripts/finish_google_telegram_reauth.py (AI-046)."""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import finish_google_telegram_reauth as fin


def make_pending(auth_id, state, created_at, expires_at):
    return {"auth_id": auth_id, "state": state, "created_at": created_at, "expires_at": expires_at}


class TestScopeRelax(unittest.TestCase):
    def test_relax_env_set_on_import(self):
        """The 2026-06-15 'Scope has changed' failures — the relax flag must be
        active before any fetch_token call."""
        self.assertEqual(os.environ.get("OAUTHLIB_RELAX_TOKEN_SCOPE"), "1")


class TestPickPending(unittest.TestCase):
    NOW = 1_000_000

    def test_none_when_empty(self):
        self.assertIsNone(fin.pick_pending([], None, self.NOW))

    def test_expired_sessions_ignored(self):
        pending = [make_pending("a", "s1", self.NOW - 100, self.NOW - 1)]
        self.assertIsNone(fin.pick_pending(pending, None, self.NOW))
        self.assertIsNone(fin.pick_pending(pending, "s1", self.NOW))

    def test_state_must_match_exactly(self):
        pending = [make_pending("a", "s1", self.NOW - 100, self.NOW + 100)]
        self.assertEqual(fin.pick_pending(pending, "s1", self.NOW)["auth_id"], "a")
        self.assertIsNone(fin.pick_pending(pending, "wrong", self.NOW))

    def test_no_state_picks_latest_valid(self):
        pending = [
            make_pending("old", "s1", self.NOW - 300, self.NOW + 100),
            make_pending("new", "s2", self.NOW - 10, self.NOW + 100),
            make_pending("expired-newest", "s3", self.NOW - 5, self.NOW - 1),
        ]
        self.assertEqual(fin.pick_pending(pending, None, self.NOW)["auth_id"], "new")


class TestMissingScopes(unittest.TestCase):
    def test_superset_grant_is_clean(self):
        req = ["a", "b"]
        granted = ["a", "b", "extra.granular"]  # the include_granted_scopes union case
        self.assertEqual(fin.missing_scopes(req, granted), [])

    def test_declined_scope_reported(self):
        self.assertEqual(fin.missing_scopes(["a", "b"], ["a"]), ["b"])

    def test_handles_none(self):
        self.assertEqual(fin.missing_scopes(None, None), [])


# ---------------------------------------------------------------------------
# WP-G (AI-147): a successful exchange clears the google-auth-blocked.json
# marker (correction 19 / step 4). Monkeypatches Flow so no real Google
# network call is ever made.
# ---------------------------------------------------------------------------

class FakeCreds:
    # `include_refresh` models the ONE distinction that matters here (2026-08-25):
    # a real exchange with access_type=offline + prompt=consent always returns a
    # refresh_token, and a credential WITHOUT one is unrefreshable. This fixture
    # previously returned {"token": "fake"} unconditionally — i.e. it modelled the
    # broken credential as success, which is why the token-clobbering bug that took
    # Gmail/Drive/Docs down was never caught by this suite.
    def __init__(self, scopes, include_refresh=True):
        self.scopes = scopes
        self.expiry = "2026-08-24T00:00:00Z"
        self.include_refresh = include_refresh

    def to_json(self):
        payload = {"token": "fake"}
        if self.include_refresh:
            payload["refresh_token"] = "fake-refresh"
        return json.dumps(payload)


class FakeFlow:
    # Flipped to False by the tests that exercise the no-refresh-token guard.
    include_refresh = True

    def __init__(self, *_a, **_kw):
        self.code_verifier = None

    def fetch_token(self, code=None):
        pass

    @property
    def credentials(self):
        return FakeCreds(["scope-a"], include_refresh=type(self).include_refresh)

    @classmethod
    def from_client_secrets_file(cls, *_a, **_kw):
        return cls()


class TestMarkerCleanup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.secrets_file = self.d / "secrets.json"
        self.secrets_file.write_text("{}", encoding="utf-8")
        self.state_file = self.d / "google-telegram-auth.json"
        self.token_file = self.d / "google-token.json"
        self.marker_file = self.d / "google-auth-blocked.json"

        self._saved_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = str(self.d)

        self._orig_flow = fin.Flow
        fin.Flow = FakeFlow
        self._orig_argv = sys.argv

    def tearDown(self):
        fin.Flow = self._orig_flow
        sys.argv = self._orig_argv
        if self._saved_pa_home is None:
            os.environ.pop("PA_HOME", None)
        else:
            os.environ["PA_HOME"] = self._saved_pa_home
        self.tmp.cleanup()

    def _seed_pending(self):
        pending = [{
            "auth_id": "a1",
            "state": "s1",
            "code_verifier": "v1",
            "redirect_uri": "https://example.com/bridge",
            "scopes": ["scope-a"],
            "resume_action": None,
            "retry_action": None,
            "chat_id": "-100123",
            "thread_id": None,
            "created_at": int(time.time()),
            "expires_at": int(time.time()) + 3600,
        }]
        self.state_file.write_text(json.dumps(pending), encoding="utf-8")

    def _argv(self):
        return [
            "finish_google_telegram_reauth.py",
            "--code", "fake-code",
            "--state", "s1",
            "--secrets-file", str(self.secrets_file),
            "--state-file", str(self.state_file),
            "--token-file", str(self.token_file),
        ]

    def test_present_marker_is_deleted_on_success(self):
        self._seed_pending()
        self.marker_file.write_text(json.dumps({"first_seen": "x"}), encoding="utf-8")
        sys.argv = self._argv()
        fin.main()
        self.assertFalse(self.marker_file.exists())

    # --- no-refresh-token guard (2026-08-25 incident) ----------------------------
    # Google returns a refresh token only on the FIRST authorization unless consent is
    # forced. finish/ used to write whatever came back, so a later re-auth replaced a
    # working credential with an unrefreshable one and every Google skill failed.

    def _no_refresh(self):
        FakeFlow.include_refresh = False
        self.addCleanup(setattr, FakeFlow, "include_refresh", True)

    def test_refuses_to_write_unrefreshable_credential(self):
        self._seed_pending()
        self._no_refresh()
        self.marker_file.write_text(json.dumps({"first_seen": "x"}), encoding="utf-8")
        sys.argv = self._argv()
        rc = fin.main()
        self.assertEqual(rc, 1)
        # The token file must NOT be created, and the blocked-marker must SURVIVE so the
        # operator is still told auth is broken.
        self.assertFalse(self.token_file.exists())
        self.assertTrue(self.marker_file.exists())

    def test_carries_over_existing_refresh_token(self):
        self._seed_pending()
        self._no_refresh()
        self.token_file.write_text(
            json.dumps({"token": "old", "refresh_token": "keep-me"}), encoding="utf-8"
        )
        sys.argv = self._argv()
        fin.main()
        saved = json.loads(self.token_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["refresh_token"], "keep-me")
        self.assertEqual(saved["token"], "fake")

    def test_success_persists_the_refresh_token(self):
        self._seed_pending()
        sys.argv = self._argv()
        fin.main()
        saved = json.loads(self.token_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["refresh_token"], "fake-refresh")

    def test_missing_marker_does_not_raise(self):
        self._seed_pending()
        # marker deliberately absent
        sys.argv = self._argv()
        fin.main()  # must not raise
        self.assertFalse(self.marker_file.exists())


if __name__ == "__main__":
    unittest.main()
