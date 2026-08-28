"""Tests for the current-slot-only window resolution in fetch_headers.py."""

import os
import sys
import unittest
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPT_DIR)

import fetch_headers


class TestResolveWindow(unittest.TestCase):
    def test_uses_latest_completed_slot_even_with_stale_state(self):
        now = datetime(2026, 6, 11, 8, 35, tzinfo=timezone.utc)
        stale_state = datetime(2026, 4, 29, 13, 30, tzinfo=timezone.utc)

        window_start, window_end, already_processed = fetch_headers.resolve_window(now, stale_state)

        self.assertEqual(window_start, datetime(2026, 6, 10, 13, 30, tzinfo=timezone.utc))
        self.assertEqual(window_end, datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc))
        self.assertFalse(already_processed)

    def test_marks_current_slot_as_already_processed(self):
        now = datetime(2026, 6, 11, 8, 35, tzinfo=timezone.utc)
        current_slot_end = datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc)

        _, window_end, already_processed = fetch_headers.resolve_window(now, current_slot_end)

        self.assertEqual(window_end, current_slot_end)
        self.assertTrue(already_processed)

    def test_force_ignores_processed_state(self):
        now = datetime(2026, 6, 11, 8, 35, tzinfo=timezone.utc)
        current_slot_end = datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc)

        _, window_end, already_processed = fetch_headers.resolve_window(now, current_slot_end, force=True)

        self.assertEqual(window_end, current_slot_end)
        self.assertFalse(already_processed)

    def test_wraps_to_previous_day_before_first_daily_slot(self):
        now = datetime(2026, 6, 11, 12, 0, tzinfo=timezone.utc)

        window_start, window_end, already_processed = fetch_headers.resolve_window(now, None)

        self.assertEqual(window_start, datetime(2026, 6, 10, 13, 30, tzinfo=timezone.utc))
        self.assertEqual(window_end, datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc))
        self.assertFalse(already_processed)

    def test_future_state_is_ignored(self):
        now = datetime(2026, 6, 11, 8, 35, tzinfo=timezone.utc)
        future_state = datetime(2026, 6, 12, 23, 30, tzinfo=timezone.utc)

        _, window_end, already_processed = fetch_headers.resolve_window(now, future_state)

        self.assertEqual(window_end, datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc))
        self.assertFalse(already_processed)


class TestDetectMissedWindows(unittest.TestCase):
    """Tests for missed window detection (AI-168 WP-D)."""

    def test_three_slot_gap_produces_two_misses(self):
        """3-slot gap (last_processed at slot 1, window_start at slot 4) ⇒ exactly 2 misses."""
        last = datetime(2026, 6, 10, 13, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 11, 23, 30, tzinfo=timezone.utc)

        missed = fetch_headers.detect_missed_windows(last, window_start)

        self.assertEqual(len(missed), 2)
        # Missed slot ends: 2026-06-10 23:30 and 2026-06-11 13:30
        self.assertEqual(missed[0]["timestamp"], "2026-06-10T23:30:00Z")
        self.assertEqual(missed[1]["timestamp"], "2026-06-11T13:30:00Z")
        for m in missed:
            self.assertIn("window", m)
            self.assertIn(" – ", m["window"])

    def test_no_gap_returns_empty_list(self):
        """No gap between last_processed and window_start ⇒ []."""
        last = datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)

        missed = fetch_headers.detect_missed_windows(last, window_start)

        self.assertEqual(missed, [])

    def test_last_processed_none_returns_empty_list(self):
        """last_processed is None ⇒ [] (no baseline, honest)."""
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)

        missed = fetch_headers.detect_missed_windows(None, window_start)

        self.assertEqual(missed, [])

    def test_missed_timestamps_are_slot_ends_not_run_times(self):
        """Miss timestamps are slot ENDS (13:30/23:30 UTC), not run times."""
        last = datetime(2026, 6, 10, 10, 0, tzinfo=timezone.utc)  # Some arbitrary time
        window_start = datetime(2026, 6, 11, 10, 0, tzinfo=timezone.utc)

        missed = fetch_headers.detect_missed_windows(last, window_start)

        # All timestamps should end at :30 (slot boundaries)
        for m in missed:
            self.assertTrue(m["timestamp"].endswith(":30:00Z"))
            # Should be either 13:30 or 23:30
            hour = int(m["timestamp"][11:13])
            self.assertIn(hour, [13, 23])

    def test_idempotent_on_already_processed_path(self):
        """already_processed path (window_start <= last_processed) ⇒ []."""
        # This is the strict-between check: last_processed < slot_end < window_start
        # When window_start <= last_processed, no slot can satisfy the condition
        last = datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 10, 23, 30, tzinfo=timezone.utc)  # Equal

        missed = fetch_headers.detect_missed_windows(last, window_start)

        self.assertEqual(missed, [])


if __name__ == "__main__":
    unittest.main()
