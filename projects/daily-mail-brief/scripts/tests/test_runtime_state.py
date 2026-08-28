"""Tests for runtime_state.py SLO misses functions (AI-168 WP-D)."""

import json
import os
import sys
import tempfile
import shutil
import unittest
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPT_DIR)

import runtime_state


class TestSloMissesFile(unittest.TestCase):
    """Tests for slo_misses_file() and append_window_misses()."""

    def setUp(self):
        self.temp_pa_home = tempfile.mkdtemp()
        self.misses_dir = os.path.join(self.temp_pa_home, "daily-mail-brief")
        self.misses_file = os.path.join(self.misses_dir, "latest.json")
        # Set PA_HOME so runtime_state uses our temp directory
        os.environ['PA_HOME'] = self.temp_pa_home

    def tearDown(self):
        if os.path.exists(self.temp_pa_home):
            shutil.rmtree(self.temp_pa_home)
        # Clean up env var
        if 'PA_HOME' in os.environ:
            del os.environ['PA_HOME']

    def _read_misses_file(self) -> dict:
        if not os.path.exists(self.misses_file):
            return {}
        with open(self.misses_file, encoding="utf-8") as f:
            return json.load(f)

    def test_merge_dedup_same_timestamp(self):
        """Same timestamp twice ⇒ 1 entry (dedup by timestamp)."""
        miss1 = {"timestamp": "2026-08-27T13:30:00Z", "window": "window1"}
        miss2 = {"timestamp": "2026-08-27T13:30:00Z", "window": "window2"}
        miss3 = {"timestamp": "2026-08-27T23:30:00Z", "window": "window3"}

        runtime_state.append_window_misses([miss1, miss2])
        data = self._read_misses_file()
        self.assertEqual(len(data["misses"]), 1)
        self.assertEqual(data["misses"][0]["window"], "window2")  # Last wins

        runtime_state.append_window_misses([miss3])
        data = self._read_misses_file()
        self.assertEqual(len(data["misses"]), 2)

    def test_cap_at_200_most_recent(self):
        """File capped at 200 most recent (by timestamp desc)."""
        # Create 250 unique misses (one per hour across multiple days)
        misses = []
        for i in range(250):
            day = 27 - (i // 24)
            hour = 23 - (i % 24)
            misses.append({
                "timestamp": f"2026-08-{day:02d}T{hour:02d}:30:00Z",
                "window": f"window{i}",
            })

        runtime_state.append_window_misses(misses)
        data = self._read_misses_file()

        self.assertEqual(len(data["misses"]), 200)
        # Verify sorted descending (most recent first)
        timestamps = [m["timestamp"] for m in data["misses"]]
        self.assertEqual(timestamps, sorted(timestamps, reverse=True))

    def test_atomic_file_exists_with_structure(self):
        """File written atomically with misses + updatedAt keys."""
        miss = {"timestamp": "2026-08-27T13:30:00Z", "window": "window1"}

        runtime_state.append_window_misses([miss])
        data = self._read_misses_file()

        self.assertIn("misses", data)
        self.assertIn("updatedAt", data)
        self.assertEqual(len(data["misses"]), 1)
        self.assertRegex(data["updatedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$")

    def test_corrupt_existing_file_overridden_cleanly(self):
        """Corrupt feed file is overwritten cleanly."""
        # Write corrupt data
        os.makedirs(self.misses_dir, exist_ok=True)
        with open(self.misses_file, "w", encoding="utf-8") as f:
            f.write("not json at all{{{broken")

        miss = {"timestamp": "2026-08-27T13:30:00Z", "window": "window1"}

        # Should not raise; corrupt data treated as empty
        runtime_state.append_window_misses([miss])

        data = self._read_misses_file()
        self.assertEqual(len(data["misses"]), 1)

    def test_empty_misses_list_creates_valid_structure(self):
        """Empty misses list still writes valid structure."""
        runtime_state.append_window_misses([])

        data = self._read_misses_file()
        self.assertIn("misses", data)
        self.assertIn("updatedAt", data)
        self.assertEqual(data["misses"], [])


if __name__ == "__main__":
    unittest.main()
