"""Unit tests for rate_limit_digest — the exactly-once rate-limit parser digest.

Run: python -m unittest discover -s projects/pa-maintenance/tests

Covers the two verified defects it replaces: LLM "last 65 minutes" arithmetic
that triple-reported one event, and 106 gemini spawns for a single input line.
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import rate_limit_digest as rld  # noqa: E402

NOW = datetime(2026, 7, 21, 12, 0, tzinfo=timezone.utc)

ZAI_429 = ("API Error: Request rejected (429) · [1113][Insufficient balance or no "
           "resource package. Please recha")


def entry(ts, worker="zclaude", raw=ZAI_429, reason="no-session-evidence"):
    return json.dumps({"timestamp": ts, "worker": worker, "raw": raw,
                       "session_id": "s", "reason": reason})


class TestHypothesis(unittest.TestCase):
    def test_insufficient_balance_is_credit_exhaustion(self):
        self.assertIn("credit exhausted", rld.hypothesis_for(ZAI_429))

    def test_credit_wins_over_generic_429(self):
        # The string contains "429" too; the specific cause must win.
        self.assertNotIn("429 with wording", rld.hypothesis_for(ZAI_429))

    def test_plain_exit_code_is_not_a_rate_limit(self):
        self.assertIn("not a real rate limit",
                      rld.hypothesis_for("Exited with code 4294967295"))

    def test_generic_429_is_parser_gap(self):
        self.assertIn("rate-limits.ts",
                      rld.hypothesis_for("HTTP 429 Too Many Requests"))

    def test_5xx_is_upstream_error(self):
        self.assertIn("misclassified", rld.hypothesis_for("503 Service Unavailable"))

    def test_unknown_text_is_novel(self):
        self.assertEqual(rld.hypothesis_for("something entirely new"),
                         rld.NOVEL_HYPOTHESIS)


class TestSelectNewLines(unittest.TestCase):
    def test_only_unreported_lines_are_returned(self):
        lines = ["a", "b", "c"]
        new, eff, rotated = rld.select_new_lines(lines, 2)
        self.assertEqual(new, ["c"])
        self.assertEqual(eff, 2)
        self.assertFalse(rotated)

    def test_nothing_new_when_cursor_is_current(self):
        new, _eff, rotated = rld.select_new_lines(["a", "b"], 2)
        self.assertEqual(new, [])
        self.assertFalse(rotated)

    def test_truncation_replays_everything(self):
        new, eff, rotated = rld.select_new_lines(["a"], 5)
        self.assertEqual(new, ["a"])
        self.assertEqual(eff, 0)
        self.assertTrue(rotated)


class TestParseAndGroup(unittest.TestCase):
    def test_malformed_lines_are_counted_not_fatal(self):
        entries, malformed = rld.parse_entries(["{bad", entry(NOW.isoformat()), "[]"])
        self.assertEqual(len(entries), 1)
        self.assertEqual(malformed, 2)

    def test_grouping_by_worker_and_reason(self):
        entries, _ = rld.parse_entries([
            entry("2026-07-21T10:00:00Z"),
            entry("2026-07-21T10:05:00Z"),
            entry("2026-07-21T10:06:00Z", worker="claude",
                  raw="Exited with code 4294967295"),
        ])
        groups = rld.group_entries(entries)
        self.assertEqual(len(groups), 2)
        self.assertEqual(groups[0]["worker"], "zclaude")
        self.assertEqual(groups[0]["count"], 2)
        self.assertEqual(groups[1]["worker"], "claude")

    def test_missing_worker_becomes_unknown(self):
        groups = rld.group_entries([{"raw": "x"}])
        self.assertEqual(groups[0]["worker"], "unknown")
        self.assertEqual(groups[0]["reason"], "unknown")


class TestWithinWindow(unittest.TestCase):
    def test_recent_entry_kept(self):
        e, _ = rld.parse_entries([entry((NOW - timedelta(hours=2)).isoformat())])
        self.assertEqual(len(rld.within_window(e, NOW, 24)), 1)

    def test_old_entry_dropped(self):
        e, _ = rld.parse_entries([entry((NOW - timedelta(days=40)).isoformat())])
        self.assertEqual(rld.within_window(e, NOW, 24), [])

    def test_unparseable_timestamp_counts_as_historical(self):
        e, _ = rld.parse_entries([entry("not-a-date")])
        self.assertEqual(rld.within_window(e, NOW, 24), [])


class TestRenderReport(unittest.TestCase):
    def test_report_is_bounded_and_actionable(self):
        entries, _ = rld.parse_entries([entry("2026-07-21T10:00:00Z")])
        out = rld.render_report(rld.group_entries(entries), 0, False)
        self.assertIn("1 new entry", out)
        self.assertIn("zclaude", out)
        self.assertIn("Action:", out)
        self.assertLessEqual(len(out), rld.MAX_REPORT_CHARS)

    def test_long_report_is_truncated(self):
        entries, _ = rld.parse_entries(
            [entry(f"2026-07-21T10:{i:02d}:00Z", worker=f"w{i}", raw="x" * 300)
             for i in range(40)])
        out = rld.render_report(rld.group_entries(entries), 0, False)
        self.assertLessEqual(len(out), rld.MAX_REPORT_CHARS)

    def test_rotation_is_announced(self):
        entries, _ = rld.parse_entries([entry("2026-07-21T10:00:00Z")])
        self.assertIn("rotated", rld.render_report(rld.group_entries(entries), 0, True))


class TestEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = Path(self.tmp.name) / "rate-limit-unparseable.jsonl"
        self.cursor = Path(self.tmp.name) / "cursor.json"

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, now=NOW, extra=()):
        from io import StringIO
        buf, real = StringIO(), sys.stdout
        sys.stdout = buf
        try:
            code = rld.main(["--file", str(self.log), "--cursor", str(self.cursor),
                             "--now", now.isoformat(), *extra])
        finally:
            sys.stdout = real
        return code, buf.getvalue().strip()

    def test_missing_file_is_no_output(self):
        code, out = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(out, "NO_OUTPUT")

    def test_first_run_ignores_history_but_advances_cursor(self):
        self.log.write_text("\n".join([
            entry("2026-05-12T10:49:16Z"),
            entry("2026-06-15T17:26:07Z"),
        ]) + "\n", encoding="utf-8")
        code, out = self._run()
        self.assertEqual(out, "NO_OUTPUT")
        self.assertEqual(json.loads(self.cursor.read_text())["processedLines"], 2)

    def test_same_event_is_reported_exactly_once(self):
        """The regression: an hourly skill must not re-report a standing entry."""
        self.log.write_text(entry("2026-05-12T10:49:16Z") + "\n", encoding="utf-8")
        self._run()  # first run: adopt, report nothing
        with self.log.open("a", encoding="utf-8") as fh:
            fh.write(entry("2026-07-21T11:30:00Z") + "\n")
        _code, first = self._run()
        self.assertIn("1 new entry", first)
        for _ in range(3):  # three more hourly runs, no new input
            _code, later = self._run()
            self.assertEqual(later, "NO_OUTPUT")

    def test_no_advance_leaves_cursor_untouched(self):
        self.log.write_text(entry("2026-07-21T11:30:00Z") + "\n", encoding="utf-8")
        self._run()  # establish cursor
        before = self.cursor.read_text()
        with self.log.open("a", encoding="utf-8") as fh:
            fh.write(entry("2026-07-21T11:45:00Z") + "\n")
        _code, out = self._run(extra=("--no-advance",))
        self.assertIn("1 new entry", out)
        self.assertEqual(self.cursor.read_text(), before)

    def test_corrupt_cursor_is_adopted_not_crashed_on(self):
        """A hand-edited / half-written state file must not kill the hourly skill.

        `int(cursor["processedLines"])` raised ValueError on a string and
        TypeError on null, and a negative value replayed the tail of the log.
        All three now degrade to first-run semantics: window-guarded (so months
        of history are not dumped into Telegram either), silent, cursor
        re-established.
        """
        self.log.write_text("\n".join([
            entry("2026-05-12T10:49:16Z"),   # both historical — outside the
            entry("2026-06-15T17:26:07Z"),   # 24h adoption window
        ]) + "\n", encoding="utf-8")
        for corrupt in ('{"processedLines": "abc"}', '{"processedLines": null}',
                        '{"processedLines": -5}', '{"processedLines": 1.5}',
                        '{}', '[]', 'not json at all'):
            self.cursor.write_text(corrupt, encoding="utf-8")
            code, out = self._run()
            self.assertEqual(code, 0, corrupt)
            self.assertEqual(out, "NO_OUTPUT", corrupt)
            self.assertEqual(json.loads(self.cursor.read_text())["processedLines"], 2,
                             corrupt)

    def test_load_cursor_rejects_unusable_shapes(self):
        for corrupt in ('{"processedLines": "3"}', '{"processedLines": null}',
                        '{"processedLines": -1}', '{"processedLines": true}',
                        '{"updatedAt": "x"}', '[]', '{'):
            self.cursor.write_text(corrupt, encoding="utf-8")
            self.assertIsNone(rld.load_cursor(self.cursor), corrupt)

    def test_load_cursor_accepts_a_well_formed_file(self):
        self.cursor.write_text('{"processedLines": 7, "updatedAt": "x"}', encoding="utf-8")
        self.assertEqual(rld.load_cursor(self.cursor)["processedLines"], 7)

    def test_truncated_log_replays_rather_than_going_silent(self):
        self.log.write_text("\n".join([entry("2026-07-21T11:00:00Z"),
                                       entry("2026-07-21T11:10:00Z")]) + "\n",
                            encoding="utf-8")
        self._run()
        self.log.write_text(entry("2026-07-21T11:50:00Z") + "\n", encoding="utf-8")
        _code, out = self._run()
        self.assertIn("rotated", out)
        self.assertIn("1 new entry", out)


if __name__ == "__main__":
    unittest.main()
