#!/usr/bin/env python3
"""
Tests for profile metadata migration script.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Add pa/scripts to path
SCRIPT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from migrate_profile_metadata import derive_key_from_text, migrate_profile


class MigrationTestCase(unittest.TestCase):
    """Base class with temp directory and profile fixtures."""

    def setUp(self):
        """Create a temp directory and PA_HOME for each test."""
        self.temp_dir = tempfile.mkdtemp(prefix="test_profile_")
        self.pa_home = os.path.join(self.temp_dir, ".pa")
        self.data_dir = os.path.join(self.pa_home, "data")
        os.makedirs(self.data_dir, exist_ok=True)
        self.profile_path = os.path.join(self.data_dir, "profile.json")

    def tearDown(self):
        """Clean up temp directory."""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def write_profile(self, profile_data):
        """Write profile data to test file."""
        with open(self.profile_path, "w", encoding="utf-8") as f:
            json.dump(profile_data, f, indent=2)

    def read_profile(self):
        """Read profile data from test file."""
        with open(self.profile_path, "r", encoding="utf-8") as f:
            return json.load(f)


class TestMigrationBasic(MigrationTestCase):
    """Tests for basic field addition."""

    def test_adds_valid_from_from_timestamp(self):
        """Entry with only timestamp gets valid_from = timestamp."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(profile)

        result = migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertEqual(entry["valid_from"], "2026-08-15")
        self.assertEqual(result["migrated"], 1)

    def test_adds_null_valid_until(self):
        """Entry without valid_until gets valid_until = null."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertIsNone(entry["valid_until"])

    def test_adds_null_superseded_by(self):
        """Entry without superseded_by gets superseded_by = null."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertIsNone(entry["superseded_by"])

    def test_adds_legacy_source(self):
        """Entry without source gets source = 'legacy'."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertEqual(entry["source"], "legacy")

    def test_adds_null_source_ref(self):
        """Entry without source_ref gets source_ref = null."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertIsNone(entry["source_ref"])


class TestKeyDerivation(MigrationTestCase):
    """Tests for key derivation heuristic."""

    def test_derives_key_from_active_interest_prefix(self):
        """'Active interest/trait discovered: X' derives key from X."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Active interest/trait discovered: Pursuing the Procam Slam 2026-2027 running cycle",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertIn("key", entry)
        # Should strip prefix and derive from meaningful words
        self.assertIn("procam", entry["key"].lower())

    def test_derives_key_from_plain_text(self):
        """Plain text derives key from first meaningful words."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Wants easiest run on Sundays to visit Lalbaug with family",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertIn("key", entry)
        # Should derive from meaningful words (sunday, easiest, run)
        self.assertIn("sunday", entry["key"].lower())

    def test_deduplicates_colliding_keys(self):
        """Two entries that would derive the same key get -2 suffix."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Swimming training progress",
                },
                {
                    "timestamp": "2026-08-16",
                    "update": "Swimming training progress update",
                },
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        keys = [entry["key"] for entry in migrated_profile["history"]]

        # Both derive "swimming-training-progress" but second gets suffix
        self.assertNotEqual(keys[0], keys[1])
        # One should be "swimming-training-progress", the other "swimming-training-progress-2"
        self.assertTrue(
            (keys[0] == "swimming-training-progress" and keys[1] == "swimming-training-progress-2") or
            (keys[1] == "swimming-training-progress" and keys[0] == "swimming-training-progress-2")
        )

    def test_preserves_existing_keys(self):
        """Entry already with a key is not overwritten."""
        existing_key = "training-swimming-status"
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Swimming training active",
                    "key": existing_key,
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertEqual(entry["key"], existing_key)

    def test_key_truncated_to_80_chars(self):
        """Long keys are truncated to 80 characters."""
        long_text = "x" * 100  # 100 chars
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": long_text,
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertLessEqual(len(entry["key"]), 80)


class TestDryRun(MigrationTestCase):
    """Tests for dry-run mode."""

    def test_dry_run_does_not_write(self):
        """dry_run=True leaves profile file unchanged."""
        original_profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(original_profile)

        # Read original mtime
        original_mtime = os.path.getmtime(self.profile_path)

        migrate_profile(self.profile_path, dry_run=True)

        # Check mtime unchanged (file not written)
        current_mtime = os.path.getmtime(self.profile_path)
        self.assertEqual(original_mtime, current_mtime)

        # Check content unchanged
        current_profile = self.read_profile()
        self.assertEqual(current_profile, original_profile)

    def test_dry_run_prints_proposed_changes(self):
        """dry_run=True prints what would be migrated."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(profile)

        import io
        import sys

        # Capture stdout
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()

        try:
            migrate_profile(self.profile_path, dry_run=True)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout

        self.assertIn("Would migrate entry", output)
        self.assertIn("key=", output)
        self.assertIn("valid_from=", output)


class TestIdempotence(MigrationTestCase):
    """Tests for idempotence (running twice is safe)."""

    def test_running_twice_is_idempotent(self):
        """Running migration twice produces no changes on second run."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact about swimming",
                }
            ]
        }
        self.write_profile(profile)

        # First run
        result1 = migrate_profile(self.profile_path, dry_run=False)
        profile_after_first = self.read_profile()

        # Second run
        result2 = migrate_profile(self.profile_path, dry_run=False)
        profile_after_second = self.read_profile()

        # Second run should migrate 0 entries (all already current)
        self.assertEqual(result2["migrated"], 0)
        self.assertEqual(result2["already_current"], 1)

        # Profile should be identical
        self.assertEqual(profile_after_first, profile_after_second)

    def test_partial_metadata_preserved(self):
        """Entry with some new fields already set preserves them."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Test fact",
                    "valid_from": "2026-08-15",
                    "source": "manual",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        # Preserves existing fields
        self.assertEqual(entry["valid_from"], "2026-08-15")
        self.assertEqual(entry["source"], "manual")
        # Adds missing fields
        self.assertIsNone(entry["valid_until"])
        self.assertIsNone(entry["superseded_by"])
        self.assertIn("key", entry)


class TestEdgeCases(MigrationTestCase):
    """Tests for edge cases and error handling."""

    def test_empty_history(self):
        """Profile with empty history handles gracefully."""
        profile = {"history": []}
        self.write_profile(profile)

        result = migrate_profile(self.profile_path, dry_run=False)

        self.assertEqual(result["total"], 0)
        self.assertEqual(result["migrated"], 0)

    def test_entry_without_timestamp(self):
        """Entry without timestamp uses current date for valid_from."""
        profile = {
            "history": [
                {
                    "update": "Test fact",
                }
            ]
        }
        self.write_profile(profile)

        migrate_profile(self.profile_path, dry_run=False)

        migrated_profile = self.read_profile()
        entry = migrated_profile["history"][0]

        self.assertIn("valid_from", entry)
        # Should be a date string (YYYY-MM-DD)
        self.assertRegex(entry["valid_from"], r"\d{4}-\d{2}-\d{2}")

    def test_mixed_legacy_and_current_entries(self):
        """Mixed profile (some with metadata, some without) handled correctly."""
        profile = {
            "history": [
                {
                    "timestamp": "2026-08-15",
                    "update": "Legacy entry",
                },
                {
                    "timestamp": "2026-08-16",
                    "update": "Modern entry",
                    "valid_from": "2026-08-16",
                    "valid_until": None,
                    "superseded_by": None,
                    "key": "modern-entry",
                    "source": "conversation",
                    "source_ref": "turn-123",
                },
            ]
        }
        self.write_profile(profile)

        result = migrate_profile(self.profile_path, dry_run=False)

        # First entry migrated, second already current
        self.assertEqual(result["migrated"], 1)
        self.assertEqual(result["already_current"], 1)

        migrated_profile = self.read_profile()

        # First entry should now have all fields
        first_entry = migrated_profile["history"][0]
        for field in ["valid_from", "valid_until", "superseded_by", "key", "source", "source_ref"]:
            self.assertIn(field, first_entry)

        # Second entry unchanged
        second_entry = migrated_profile["history"][1]
        self.assertEqual(second_entry["key"], "modern-entry")
        self.assertEqual(second_entry["source"], "conversation")


if __name__ == "__main__":
    unittest.main()
