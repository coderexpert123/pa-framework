"""Unit tests for human_gated_blocker_watch — the escalating blocker watchdog.

Run: python -m unittest discover -s projects/pa-maintenance/tests

The escalation ladder (day 0-2 silent, 3-6 warn, 7+ error naming config
priority) and the two invariants (never writes config.yaml; the ledger is the
only place age is tracked) are asserted here so a regression fails in the suite
rather than as a missed page — or, worse, a config.yaml the cron job quietly
rewrote.
"""
import io
import contextlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import human_gated_blocker_watch as hgb  # noqa: E402

NOW = datetime(2026, 7, 23, 12, 0, tzinfo=timezone.utc)


def cooldown(classification="account-exhausted", reason="[account-exhausted] ..."):
    return {
        "cooldown_until": NOW.isoformat(),
        "last_event": NOW.isoformat(),
        "reason": reason,
        "classification": classification,
    }


def ledger_entry(days_old, worker="zclaude", classification="account-exhausted",
                 last_alerted_on=None, ever_escalated=False):
    first = (NOW - timedelta(days=days_old)).isoformat()
    entry = {"first_detected_at": first, "last_confirmed_at": first,
             "worker": worker, "classification": classification}
    if last_alerted_on is not None:
        entry["last_alerted_on"] = last_alerted_on
    if ever_escalated:
        entry["ever_escalated"] = True
    return {f"{worker}:{classification}": entry}


# ---------------------------------------------------------------------------
# filtering — only account-exhausted / auth-error are human-gated
# ---------------------------------------------------------------------------

class TestHumanGatedFilter(unittest.TestCase):
    def test_account_exhausted_and_auth_error_are_gated(self):
        state = {"zclaude": cooldown("account-exhausted"),
                 "gemini": cooldown("auth-error")}
        got = hgb.human_gated_blockers(state)
        self.assertEqual(set(got), {"zclaude:account-exhausted", "gemini:auth-error"})

    def test_self_healing_classifications_are_ignored(self):
        state = {
            "codex": cooldown("usage-limit-session"),
            "a": cooldown("quota-daily"),
            "b": cooldown("quota-per-minute"),
            "c": cooldown("server-overload"),
            "d": cooldown("quota-exhausted"),
        }
        self.assertEqual(hgb.human_gated_blockers(state), {})

    def test_missing_or_unknown_classification_is_ignored(self):
        state = {"x": {"reason": "no classification field"},
                 "y": cooldown("unknown"),
                 "z": "not-a-dict"}
        self.assertEqual(hgb.human_gated_blockers(state), {})


# ---------------------------------------------------------------------------
# age
# ---------------------------------------------------------------------------

class TestAgeDays(unittest.TestCase):
    def test_whole_days_since_first_detected(self):
        self.assertEqual(hgb.age_days((NOW - timedelta(days=5)).isoformat(), NOW), 5)

    def test_same_instant_is_zero(self):
        self.assertEqual(hgb.age_days(NOW.isoformat(), NOW), 0)

    def test_naive_timestamp_is_treated_as_utc(self):
        naive = (NOW - timedelta(days=4)).replace(tzinfo=None).isoformat()
        self.assertEqual(hgb.age_days(naive, NOW), 4)

    def test_garbage_timestamp_never_escalates(self):
        self.assertEqual(hgb.age_days("not-a-date", NOW), 0)


# ---------------------------------------------------------------------------
# escalation ladder
# ---------------------------------------------------------------------------

class TestEscalationLadder(unittest.TestCase):
    def test_new_entry_is_tracked_with_no_alert_at_day_0(self):
        """A brand-new human-gated blocker records first_detected_at and fires
        NO alert — days 0-2 are the existing one-shot's window."""
        alerts, new_ledger, resolved = hgb.evaluate(
            {"zclaude": cooldown()}, {}, {"zclaude": 1}, NOW)
        self.assertEqual(alerts, [])
        self.assertEqual(resolved, [])
        entry = new_ledger["zclaude:account-exhausted"]
        self.assertEqual(entry["first_detected_at"], NOW.isoformat())
        self.assertNotIn("ever_escalated", entry)

    def test_day_2_is_still_silent(self):
        alerts, _, _ = hgb.evaluate(
            {"zclaude": cooldown()}, ledger_entry(2), {"zclaude": 1}, NOW)
        self.assertEqual(alerts, [])

    def test_day_3_fires_exactly_one_warn(self):
        alerts, new_ledger, _ = hgb.evaluate(
            {"zclaude": cooldown()}, ledger_entry(3), {"zclaude": 1}, NOW)
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["severity"], hgb.WARN)
        self.assertEqual(alerts[0]["worker"], "zclaude")
        self.assertEqual(alerts[0]["age_days"], 3)
        # dedup stamp recorded so a second run the same day stays silent
        self.assertEqual(
            new_ledger["zclaude:account-exhausted"]["last_alerted_on"],
            NOW.date().isoformat())

    def test_day_7_fires_exactly_one_error_naming_config_priority(self):
        alerts, _, _ = hgb.evaluate(
            {"zclaude": cooldown()}, ledger_entry(7), {"zclaude": 1}, NOW)
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["severity"], hgb.ERROR)
        self.assertEqual(alerts[0]["priority"], 1)
        report = hgb.render_report(alerts, [])
        self.assertIn("priority 1", report)
        self.assertIn("7 days", report)

    def test_preserves_original_first_detected_at_on_re_confirmation(self):
        original = ledger_entry(4)
        original_ts = original["zclaude:account-exhausted"]["first_detected_at"]
        _alerts, new_ledger, _ = hgb.evaluate(
            {"zclaude": cooldown()}, original, {"zclaude": 1}, NOW)
        self.assertEqual(
            new_ledger["zclaude:account-exhausted"]["first_detected_at"], original_ts)
        self.assertEqual(
            new_ledger["zclaude:account-exhausted"]["last_confirmed_at"], NOW.isoformat())


class TestDailyDedup(unittest.TestCase):
    def test_already_alerted_today_stays_silent(self):
        led = ledger_entry(5, last_alerted_on=NOW.date().isoformat(),
                           ever_escalated=True)
        alerts, _, _ = hgb.evaluate({"zclaude": cooldown()}, led, {"zclaude": 1}, NOW)
        self.assertEqual(alerts, [])

    def test_a_new_calendar_day_re_fires(self):
        yesterday = (NOW - timedelta(days=1)).date().isoformat()
        led = ledger_entry(5, last_alerted_on=yesterday, ever_escalated=True)
        alerts, _, _ = hgb.evaluate({"zclaude": cooldown()}, led, {"zclaude": 1}, NOW)
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["severity"], hgb.WARN)


class TestResolution(unittest.TestCase):
    def test_disappeared_blocker_is_cleared_from_ledger(self):
        led = ledger_entry(4)
        alerts, new_ledger, resolved = hgb.evaluate({}, led, {}, NOW)
        self.assertNotIn("zclaude:account-exhausted", new_ledger)
        self.assertEqual(alerts, [])
        # never escalated -> no resolved note
        self.assertEqual(resolved, [])

    def test_recovered_after_escalation_emits_a_resolved_note(self):
        led = ledger_entry(9, last_alerted_on=(NOW - timedelta(days=1)).date().isoformat(),
                           ever_escalated=True)
        _alerts, new_ledger, resolved = hgb.evaluate({}, led, {}, NOW)
        self.assertNotIn("zclaude:account-exhausted", new_ledger)
        self.assertEqual(len(resolved), 1)
        self.assertIn("zclaude", resolved[0])

    def test_classification_flip_to_self_healing_clears_the_gated_key(self):
        """zclaude moving from account-exhausted to a self-healing quota fault
        clears the old gated key (its blocker is no longer human-gated)."""
        led = ledger_entry(5)
        alerts, new_ledger, _ = hgb.evaluate(
            {"zclaude": cooldown("quota-daily")}, led, {"zclaude": 1}, NOW)
        self.assertEqual(new_ledger, {})
        self.assertEqual(alerts, [])


# ---------------------------------------------------------------------------
# end-to-end main()
# ---------------------------------------------------------------------------

CONFIG_YAML = (
    "workers:\n"
    "  - name: zclaude\n"
    "    command: zclaude.bat\n"
    "    priority: 1\n"
    "  - name: agy\n"
    "    command: agy.cmd\n"
    "    priority: 2\n"
)


class TestMainEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.state = self.d / "rate-limit-state.json"
        self.ledger = self.d / "human-gated-blockers.json"
        self.config = self.d / "config.yaml"
        self.config.write_text(CONFIG_YAML, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, now=NOW, extra=()):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = hgb.main(["--state", str(self.state), "--ledger", str(self.ledger),
                           "--config", str(self.config), "--now", now.isoformat(),
                           "--no-send", *extra])
        return rc, buf.getvalue().strip()

    def test_nothing_tracked_prints_no_output(self):
        self.state.write_text("{}", encoding="utf-8")
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertEqual(out, "NO_OUTPUT")

    def test_missing_state_file_prints_no_output(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertEqual(out, "NO_OUTPUT")

    def test_day_0_tracks_but_prints_no_output(self):
        self.state.write_text(json.dumps({"zclaude": cooldown()}), encoding="utf-8")
        rc, out = self._run()
        self.assertEqual(out, "NO_OUTPUT")
        blockers = json.loads(self.ledger.read_text())["blockers"]
        self.assertIn("zclaude:account-exhausted", blockers)

    def test_day_7_run_pages_with_priority_and_persists_dedup(self):
        # seed a 7-day-old ledger, then a present blocker
        old = (NOW - timedelta(days=7)).isoformat()
        self.ledger.write_text(json.dumps({"blockers": {
            "zclaude:account-exhausted": {"first_detected_at": old,
                                          "last_confirmed_at": old}}}),
            encoding="utf-8")
        self.state.write_text(json.dumps({"zclaude": cooldown()}), encoding="utf-8")
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("ESCALATED", out)
        self.assertIn("priority 1", out)
        # second run same day: dedup keeps it silent
        _rc2, out2 = self._run()
        self.assertEqual(out2, "NO_OUTPUT")

    def test_config_yaml_is_byte_identical_before_and_after(self):
        """The invariant that must never regress: this watchdog only ever READS
        config.yaml. A cron job that rewrites hand-maintained intent is how
        priorities and their evidence comments get lost."""
        self.state.write_text(json.dumps({"zclaude": cooldown()}), encoding="utf-8")
        before = self.config.read_bytes()
        # exercise every age band so no path can sneak a write in
        for days in (0, 4, 8):
            self.ledger.write_text(json.dumps({"blockers": {
                "zclaude:account-exhausted": {
                    "first_detected_at": (NOW - timedelta(days=days)).isoformat()}}}),
                encoding="utf-8")
            self._run()
        after = self.config.read_bytes()
        self.assertEqual(before, after)


# ---------------------------------------------------------------------------
# config reading (read-only)
# ---------------------------------------------------------------------------

class TestLoadPriorities(unittest.TestCase):
    def test_priorities_are_read_by_worker_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "config.yaml"
            p.write_text(CONFIG_YAML, encoding="utf-8")
            got = hgb.load_priorities(p)
            self.assertEqual(got, {"zclaude": 1, "agy": 2})

    def test_missing_config_is_empty_not_a_crash(self):
        self.assertEqual(hgb.load_priorities(Path("nope-xyz.yaml")), {})


class TestLedgerIO(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "human-gated-blockers.json"
            hgb.save_ledger(p, {"a:b": {"first_detected_at": "t"}}, NOW)
            self.assertEqual(hgb.load_ledger(p)["a:b"]["first_detected_at"], "t")

    def test_corrupt_ledger_is_treated_as_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "human-gated-blockers.json"
            p.write_text("{not json", encoding="utf-8")
            self.assertEqual(hgb.load_ledger(p), {})

    def test_corrupt_state_is_treated_as_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "rate-limit-state.json"
            p.write_text("{not json", encoding="utf-8")
            self.assertEqual(hgb.load_state(p), {})


class TestSecrets(unittest.TestCase):
    def test_chat_id_is_parsed_by_sign_not_by_position(self):
        import os
        saved = {k: os.environ.get(k) for k in ("PA_ALERTS_CHAT_ID", "TELEGRAM_CHAT_ID")}
        try:
            os.environ.pop("PA_ALERTS_CHAT_ID", None)
            os.environ["TELEGRAM_CHAT_ID"] = "7000000001,-1001234567890"
            hgb._SECRETS_CACHE = {}
            self.assertEqual(hgb.alert_chat_id(), "-1001234567890")
        finally:
            hgb._SECRETS_CACHE = None
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


# WPD6: Postmortem scanning tests
class TestPostmortemScanning(unittest.TestCase):
    """Test unclosed action item detection in postmortems."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.temp_dir.name)
        (self.repo_root / "plans").mkdir()
        (self.repo_root / "plans" / "postmortems").mkdir()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_unclosed_items_over_30_days_are_flagged(self):
        # Create a postmortem with unclosed items older than 30 days
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-07-01-test.md"
        created = (NOW - timedelta(days=35)).isoformat()
        pm_file.write_text(
            f"# Test Postmortem\n\n"
            f"**Created:** {created}\n\n"
            "## Action Items\n\n"
            "- [ ] Investigate root cause\n"
            "- [ ] Fix the bug\n"
            "- [ ] Update documentation\n",
            encoding="utf-8",
        )

        alerts = hgb.scan_postmortems(self.repo_root, NOW)
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["postmortem_file"], "2026-07-01-test.md")
        self.assertEqual(alerts[0]["age_days"], 35)
        self.assertEqual(alerts[0]["unclosed_count"], 3)

    def test_closed_items_are_not_flagged(self):
        # Create a postmortem with only closed items
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-07-01-test.md"
        created = (NOW - timedelta(days=35)).isoformat()
        pm_file.write_text(
            f"# Test Postmortem\n\n"
            f"**Created:** {created}\n\n"
            "## Action Items\n\n"
            "- [x] Investigate root cause\n"
            "- [x] Fix the bug\n",
            encoding="utf-8",
        )

        alerts = hgb.scan_postmortems(self.repo_root, NOW)
        self.assertEqual(len(alerts), 0)

    def test_recent_postmortems_under_30_days_are_not_flagged(self):
        # Create a postmortem with unclosed items but only 10 days old
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-07-13-test.md"
        created = (NOW - timedelta(days=10)).isoformat()
        pm_file.write_text(
            f"# Test Postmortem\n\n"
            f"**Created:** {created}\n\n"
            "## Action Items\n\n"
            "- [ ] Investigate root cause\n",
            encoding="utf-8",
        )

        alerts = hgb.scan_postmortems(self.repo_root, NOW)
        self.assertEqual(len(alerts), 0)

    def test_postmortem_without_created_date_is_skipped(self):
        # Create a postmortem without a created date
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-07-01-test.md"
        pm_file.write_text(
            "# Test Postmortem\n\n"
            "## Action Items\n\n"
            "- [ ] Investigate root cause\n",
            encoding="utf-8",
        )

        alerts = hgb.scan_postmortems(self.repo_root, NOW)
        self.assertEqual(len(alerts), 0)

    def test_items_are_limited_in_output(self):
        # Create a postmortem with many unclosed items
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-07-01-test.md"
        created = (NOW - timedelta(days=35)).isoformat()
        items = "\n".join(f"- [ ] Item {i}" for i in range(10))
        pm_file.write_text(
            f"# Test Postmortem\n\n"
            f"**Created:** {created}\n\n"
            "## Action Items\n\n"
            f"{items}\n",
            encoding="utf-8",
        )

        alerts = hgb.scan_postmortems(self.repo_root, NOW)
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["unclosed_count"], 10)
        # Should only include first 3 items
        self.assertEqual(len(alerts[0]["items"]), 3)
        self.assertEqual(alerts[0]["items"][0], "Item 0")


# ---------------------------------------------------------------------------
# WP-G (AI-147): third human-gated-blocker family — Google reauth
# ---------------------------------------------------------------------------

class TestGoogleAuthScan(unittest.TestCase):
    """scan_google_auth() — pure-ish (filesystem-scoped) scan of the marker
    written by pa/scripts/google_reauth_kick.py."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.marker = self.d / "google-auth-blocked.json"
        self.token = self.d / "google-token.json"

    def tearDown(self):
        self.tmp.cleanup()

    def _write_marker(self, first_seen_days_old, skills=("daily-mail-brief",), reason="expired"):
        first_seen = (NOW - timedelta(days=first_seen_days_old)).isoformat()
        self.marker.write_text(json.dumps({
            "first_seen": first_seen,
            "last_seen": first_seen,
            "last_sent": None,
            "reason": reason,
            "skills": list(skills),
        }), encoding="utf-8")

    def test_no_marker_is_silent(self):
        self.assertEqual(hgb.scan_google_auth(self.marker, self.token, NOW), [])

    def test_day_0_to_2_is_tracked_with_none_severity(self):
        self._write_marker(1)
        got = hgb.scan_google_auth(self.marker, self.token, NOW)
        self.assertEqual(len(got), 1)
        self.assertIsNone(got[0]["severity"])
        self.assertEqual(got[0]["age_days"], 1)

    def test_day_3_is_warn(self):
        self._write_marker(3)
        got = hgb.scan_google_auth(self.marker, self.token, NOW)
        self.assertEqual(got[0]["severity"], hgb.WARN)

    def test_day_7_is_error(self):
        self._write_marker(7)
        got = hgb.scan_google_auth(self.marker, self.token, NOW)
        self.assertEqual(got[0]["severity"], hgb.ERROR)

    def test_skills_and_reason_are_carried(self):
        self._write_marker(3, skills=("daily-mail-brief", "test-invoice"), reason="token expired")
        got = hgb.scan_google_auth(self.marker, self.token, NOW)
        self.assertEqual(got[0]["skills"], ["daily-mail-brief", "test-invoice"])
        self.assertEqual(got[0]["reason"], "token expired")

    def test_token_refreshed_after_first_seen_resolves_and_deletes_marker(self):
        self._write_marker(5)
        self.token.write_text("{}", encoding="utf-8")
        newer = (NOW + timedelta(minutes=1)).timestamp()
        os.utime(self.token, (newer, newer))
        got = hgb.scan_google_auth(self.marker, self.token, NOW)
        self.assertEqual(got, [])
        self.assertFalse(self.marker.exists())

    def test_token_older_than_first_seen_does_not_resolve(self):
        self._write_marker(5)
        self.token.write_text("{}", encoding="utf-8")
        older = (NOW - timedelta(days=10)).timestamp()
        os.utime(self.token, (older, older))
        got = hgb.scan_google_auth(self.marker, self.token, NOW)
        self.assertEqual(len(got), 1)
        self.assertTrue(self.marker.exists())

    def test_missing_first_seen_is_silent(self):
        self.marker.write_text(json.dumps({"skills": ["x"]}), encoding="utf-8")
        self.assertEqual(hgb.scan_google_auth(self.marker, self.token, NOW), [])

    def test_corrupt_marker_is_silent(self):
        self.marker.write_text("{not json", encoding="utf-8")
        self.assertEqual(hgb.scan_google_auth(self.marker, self.token, NOW), [])


class TestGoogleAuthStampLedger(unittest.TestCase):
    """The dedup stamp lives as a top-level sibling of "blockers" so
    evaluate()'s vanished-key cleanup (which only knows about
    "<worker>:<classification>" keys) can never delete it."""

    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "human-gated-blockers.json"
            hgb.save_google_auth_stamp(p, "2026-07-23")
            self.assertEqual(hgb.load_google_auth_stamp(p), "2026-07-23")

    def test_missing_file_is_none(self):
        self.assertIsNone(hgb.load_google_auth_stamp(Path("nope-xyz.json")))

    def test_survives_a_save_ledger_call_that_runs_first(self):
        """save_ledger() rewrites the whole file with only
        {updatedAt, note, blockers}; save_google_auth_stamp() called
        afterwards must re-attach "google_auth" as a sibling, not lose it."""
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "human-gated-blockers.json"
            hgb.save_google_auth_stamp(p, "2026-07-22")
            hgb.save_ledger(p, {"zclaude:account-exhausted": {"first_detected_at": "t"}}, NOW)
            hgb.save_google_auth_stamp(p, "2026-07-23")
            self.assertEqual(hgb.load_google_auth_stamp(p), "2026-07-23")
            self.assertIn("zclaude:account-exhausted", hgb.load_ledger(p))

    def test_evaluate_never_sees_or_drops_the_google_auth_key(self):
        """Regression pin for the design that keeps "google_auth" OUT of the
        "blockers" dict: if it were ever moved inside "blockers", evaluate()'s
        vanished-key cleanup would silently pop it every run (it is not a
        "<worker>:<classification>" pair present in rate-limit-state.json)."""
        alerts, new_ledger, resolved = hgb.evaluate({}, {"google-auth": {"last_alerted_on": "2026-07-22"}}, {}, NOW)
        self.assertNotIn("google-auth", new_ledger)
        self.assertEqual(resolved, [])  # not "ever_escalated" -> silent drop, not a resolved note


class TestGoogleAuthEndToEnd(unittest.TestCase):
    """main() wiring: the nothing-to-report gate, render_report, and the
    paging condition alongside postmortem_alerts (correction 19 / step 6)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self._saved_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = str(self.home)

    def tearDown(self):
        if self._saved_pa_home is None:
            os.environ.pop("PA_HOME", None)
        else:
            os.environ["PA_HOME"] = self._saved_pa_home
        self.tmp.cleanup()

    def _write_marker(self, first_seen_days_old, skills=("daily-mail-brief",), reason="expired"):
        first_seen = (NOW - timedelta(days=first_seen_days_old)).isoformat()
        (self.home / "google-auth-blocked.json").write_text(json.dumps({
            "first_seen": first_seen, "last_seen": first_seen, "last_sent": None,
            "reason": reason, "skills": list(skills),
        }), encoding="utf-8")

    def _run(self, now=NOW, extra=()):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = hgb.main(["--now", now.isoformat(), "--no-send", *extra])
        return rc, buf.getvalue().strip()

    def test_no_marker_prints_no_output(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertEqual(out, "NO_OUTPUT")

    def test_day_0_prints_no_output(self):
        self._write_marker(1)
        rc, out = self._run()
        self.assertEqual(out, "NO_OUTPUT")

    def test_day_3_fires_exactly_one_warn_naming_the_skill(self):
        self._write_marker(3, skills=("daily-mail-brief",))
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("Google auth", out)
        self.assertIn("daily-mail-brief", out)
        self.assertNotIn("ESCALATED", out)

    def test_day_7_fires_exactly_one_error(self):
        self._write_marker(7)
        rc, out = self._run()
        self.assertIn("Google auth", out)
        self.assertIn("ESCALATED", out)

    def test_dedup_prevents_a_second_alert_the_same_day(self):
        self._write_marker(3)
        _rc1, out1 = self._run()
        self.assertIn("Google auth", out1)
        _rc2, out2 = self._run()
        self.assertEqual(out2, "NO_OUTPUT")

    def test_resolved_marker_produces_no_alert_and_is_deleted(self):
        self._write_marker(5)
        token = self.home / "google-token.json"
        token.write_text("{}", encoding="utf-8")
        newer = (NOW + timedelta(minutes=1)).timestamp()
        os.utime(token, (newer, newer))
        rc, out = self._run()
        self.assertEqual(out, "NO_OUTPUT")
        self.assertFalse((self.home / "google-auth-blocked.json").exists())


class TestReauthKeyboardMarkup(unittest.TestCase):
    """WP-D2 B.1 (2026-09-02): the google-auth page carries the one-tap
    reauth:google button; pages with no google-auth alerts carry none."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.d = self.home / "cfg"
        self.d.mkdir()
        self.state = self.d / "rate-limit-state.json"
        self.ledger = self.d / "human-gated-blockers.json"
        self.config = self.d / "config.yaml"
        self.config.write_text(CONFIG_YAML, encoding="utf-8")
        self._saved_pa_home = os.environ.get("PA_HOME")
        # PA_HOME pinned to the temp dir too: scan_google_auth() reads the
        # marker from pa_home(), and the machine's real marker must not leak in.
        os.environ["PA_HOME"] = str(self.home)

    def tearDown(self):
        if self._saved_pa_home is None:
            os.environ.pop("PA_HOME", None)
        else:
            os.environ["PA_HOME"] = self._saved_pa_home
        self.tmp.cleanup()

    def _write_marker(self, first_seen_days_old, skills=("daily-mail-brief",)):
        first_seen = (NOW - timedelta(days=first_seen_days_old)).isoformat()
        (self.home / "google-auth-blocked.json").write_text(json.dumps({
            "first_seen": first_seen, "last_seen": first_seen, "last_sent": None,
            "reason": "invalid_grant", "skills": list(skills),
        }), encoding="utf-8")

    def _run_capture_page(self):
        pages = []
        real_page = hgb.page_alerts

        def capturing_page(report, reply_markup=None):
            pages.append((report, reply_markup))

        hgb.page_alerts = capturing_page
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
                # NO --no-send: the paging branch (and only that branch) attaches
                # the keyboard, so it must run — against the stub above.
                rc = hgb.main(["--state", str(self.state), "--ledger", str(self.ledger),
                               "--config", str(self.config), "--now", NOW.isoformat()])
        finally:
            hgb.page_alerts = real_page
        return rc, buf.getvalue().strip(), pages

    def test_blocker_watch_reauth_report_carries_reauth_google_markup(self):
        self._write_marker(3)
        rc, out, pages = self._run_capture_page()
        self.assertEqual(rc, 0)
        self.assertIn("Google auth", out)
        self.assertEqual(len(pages), 1)
        report, markup = pages[0]
        self.assertIn("Google auth", report)
        self.assertEqual(markup, {"inline_keyboard": [[
            {"text": "🔐 Reauth Google", "callback_data": "reauth:google"},
        ]]})

    def test_non_google_page_carries_no_markup(self):
        # A 7-day-old worker blocker with no google marker pages — with no keyboard.
        old = (NOW - timedelta(days=7)).isoformat()
        self.ledger.write_text(json.dumps({"blockers": {
            "zclaude:account-exhausted": {"first_detected_at": old,
                                          "last_confirmed_at": old}}}),
            encoding="utf-8")
        self.state.write_text(json.dumps({"zclaude": cooldown()}), encoding="utf-8")
        rc, out, pages = self._run_capture_page()
        self.assertEqual(rc, 0)
        self.assertIn("ESCALATED", out)
        self.assertEqual(len(pages), 1)
        _report, markup = pages[0]
        self.assertIsNone(markup)


if __name__ == "__main__":
    unittest.main()
