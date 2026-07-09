"""Unit tests for pa/scripts/finish_google_telegram_reauth.py (AI-046)."""
import os
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
