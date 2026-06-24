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


if __name__ == "__main__":
    unittest.main()
