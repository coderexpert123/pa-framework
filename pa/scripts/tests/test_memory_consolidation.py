#!/usr/bin/env python3
"""
Tests for memory consolidation post-processor.

Tests cover staging file reading, profile candidate processing, conflict
routing, audit writing, and accepted conflict resolution.
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add pa/src and pa/scripts to path
SCRIPT_DIR = Path(__file__).parent.parent
SRC_DIR = SCRIPT_DIR.parent / 'src'
sys.path.insert(0, str(SRC_DIR))
sys.path.insert(0, str(SCRIPT_DIR))

import memory_consolidation
import learn_agent

# Patch learn_agent paths at import time to prevent accidental writes to real profile
_original_profile_path = learn_agent.PROFILE_PATH
_original_archive_path = learn_agent.ARCHIVE_PATH


class MemoryConsolidationTestCase(unittest.TestCase):
    """Base test case with temp directory and PA_HOME override."""

    def setUp(self):
        """Create temp directory and mock PA_HOME."""
        self.temp_dir = tempfile.mkdtemp()
        self.pa_home = os.path.join(self.temp_dir, '.pa')
        os.makedirs(self.pa_home, exist_ok=True)
        os.makedirs(os.path.join(self.pa_home, 'data'), exist_ok=True)

        # Set PA_HOME environment variable
        self.orig_pa_home = os.environ.get('PA_HOME')
        os.environ['PA_HOME'] = self.pa_home

        # Create initial profile.json
        self.profile_path = os.path.join(self.pa_home, 'data', 'profile.json')
        with open(self.profile_path, 'w') as f:
            json.dump({'history': []}, f)

        # Patch learn_agent paths to use temp directory
        learn_agent.PROFILE_PATH = self.profile_path
        learn_agent.ARCHIVE_PATH = os.path.join(self.pa_home, 'profile-history-archive.jsonl')

    def tearDown(self):
        """Clean up temp directory and restore PA_HOME."""
        if self.orig_pa_home:
            os.environ['PA_HOME'] = self.orig_pa_home
        else:
            os.environ.pop('PA_HOME', None)

        # Restore original learn_agent paths
        learn_agent.PROFILE_PATH = _original_profile_path
        learn_agent.ARCHIVE_PATH = _original_archive_path

        # Clean up temp files
        import shutil
        try:
            shutil.rmtree(self.temp_dir)
        except Exception:
            pass


class TestReadStagingFile(MemoryConsolidationTestCase):
    """Test staging file reading with torn-line tolerance."""

    def test_reads_valid_jsonl(self):
        """Fixture staging file with 3 valid lines → 3 candidates."""
        staging_path = os.path.join(self.pa_home, 'consolidation-staging-2026-08-18.jsonl')
        candidates_data = [
            {'key': 'test-1', 'text': 'Test fact 1', 'sink': 'profile'},
            {'key': 'test-2', 'text': 'Test fact 2', 'sink': 'profile'},
            {'key': 'test-3', 'text': 'Test fact 3', 'sink': 'profile'}
        ]

        with open(staging_path, 'w') as f:
            for candidate in candidates_data:
                f.write(json.dumps(candidate) + '\n')

        candidates = memory_consolidation.read_staging_file(staging_path)
        self.assertEqual(len(candidates), 3)
        self.assertEqual(candidates[0]['key'], 'test-1')
        self.assertEqual(candidates[1]['key'], 'test-2')
        self.assertEqual(candidates[2]['key'], 'test-3')

    def test_skips_unparseable_lines(self):
        """2 valid + 1 broken line → 2 candidates, broken line silently skipped."""
        staging_path = os.path.join(self.pa_home, 'consolidation-staging-2026-08-18.jsonl')

        with open(staging_path, 'w') as f:
            f.write(json.dumps({'key': 'test-1', 'text': 'Valid', 'sink': 'profile'}) + '\n')
            f.write('invalid json line\n')
            f.write(json.dumps({'key': 'test-2', 'text': 'Valid', 'sink': 'profile'}) + '\n')

        candidates = memory_consolidation.read_staging_file(staging_path)
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0]['key'], 'test-1')
        self.assertEqual(candidates[1]['key'], 'test-2')

    def test_returns_empty_for_empty_file(self):
        """Empty staging file → empty list."""
        staging_path = os.path.join(self.pa_home, 'consolidation-staging-2026-08-18.jsonl')

        # Create empty file
        with open(staging_path, 'w') as f:
            pass

        candidates = memory_consolidation.read_staging_file(staging_path)
        self.assertEqual(len(candidates), 0)

    def test_returns_empty_for_nonexistent_file(self):
        """Nonexistent staging file → empty list (not an error)."""
        staging_path = os.path.join(self.pa_home, 'consolidation-staging-2026-08-18.jsonl')

        candidates = memory_consolidation.read_staging_file(staging_path)
        self.assertEqual(len(candidates), 0)


class TestProcessProfileCandidates(MemoryConsolidationTestCase):
    """Test profile candidate processing through consolidate_fact()."""

    def test_auto_adds_new_candidate(self):
        """Candidate with resolution.type='new', sink='profile' → consolidate_fact called, audit entry written, count added=1."""
        candidates = [{
            'key': 'dietary-mushrooms',
            'text': 'Mushrooms OK when eating outside',
            'sink': 'profile',
            'valid_from': '2026-08-18',
            'source': 'conversation',
            'source_ref': 'turn-20260818-1234',
            'resolution': {'type': 'new'},
            'category': 'preference'
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False
        )

        self.assertEqual(summary['added'], 1)
        self.assertEqual(summary['superseded'], 0)
        self.assertEqual(summary['conflict'], 0)
        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'added')
        self.assertEqual(audit_entries[0]['fact_key'], 'dietary-mushrooms')

        # Verify profile.json was updated
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['key'], 'dietary-mushrooms')

    def test_auto_supersedes_matching_candidate(self):
        """Candidate with resolution.type='supersede', existing keyed entry in profile → consolidate_fact called, audit entry written, count superseded=1."""
        # Add initial entry
        initial_candidate = {
            'key': 'dietary-mushrooms',
            'text': 'Avoid mushrooms completely',
            'valid_from': '2026-06-15',
            'source': 'conversation',
            'source_ref': 'turn-20260615-0000'
        }
        learn_agent.consolidate_fact(initial_candidate)

        # Supersede with new entry
        supersede_candidate = [{
            'key': 'dietary-mushrooms',
            'text': 'Eats mushrooms regularly now',
            'sink': 'profile',
            'valid_from': '2026-08-18',
            'source': 'conversation',
            'source_ref': 'turn-20260818-1234',
            'resolution': {'type': 'supersede'},
            'category': 'preference'
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            supersede_candidate, audit_callback, dry_run=False
        )

        self.assertEqual(summary['added'], 0)
        self.assertEqual(summary['superseded'], 1)
        self.assertEqual(summary['conflict'], 0)
        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'superseded')

        # Verify profile.json has both entries (old superseded, new live)
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 2)
        live_entry = [e for e in profile['history'] if e.get('valid_until') is None]
        self.assertEqual(len(live_entry), 1)
        self.assertEqual(live_entry[0]['update'], 'Eats mushrooms regularly now')

    def test_routes_contradiction_to_pending(self):
        """Candidate with resolution.type='contradiction' → NOT passed to consolidate_fact, written to review-digest-pending.jsonl."""
        candidates = [{
            'key': 'dietary-mushrooms',
            'text': 'Eats mushrooms regularly',
            'sink': 'profile',
            'valid_from': '2026-08-18',
            'source': 'conversation',
            'source_ref': 'turn-20260818-1234',
            'resolution': {'type': 'contradiction'},
            'category': 'preference',
            'existing_text': 'Avoid mushrooms completely',
            'existing_valid_from': '2026-06-15'
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False
        )

        self.assertEqual(summary['conflict'], 1)
        self.assertEqual(summary['added'], 0)
        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'conflict')

        # Verify profile.json was NOT modified (no live entry added)
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 0)

    def test_skips_kb_only_candidates(self):
        """Candidate with sink='kb' → not processed, count 0."""
        candidates = [{
            'key': 'medical-condition',
            'text': 'Some medical fact',
            'sink': 'kb',
            'valid_from': '2026-08-18',
            'source': 'conversation',
            'resolution': {'type': 'new'}
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False
        )

        self.assertEqual(summary['added'], 0)
        self.assertEqual(summary['superseded'], 0)
        self.assertEqual(len(audit_entries), 0)

        # Verify profile.json was NOT modified
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 0)

    def test_dry_run_does_not_modify_profile(self):
        """--dry-run flag → no consolidate_fact calls, no file writes, summary printed."""
        candidates = [{
            'key': 'dietary-mushrooms',
            'text': 'Mushrooms OK when eating outside',
            'sink': 'profile',
            'valid_from': '2026-08-18',
            'source': 'conversation',
            'resolution': {'type': 'new'}
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=True
        )

        # Dry-run increments counts but doesn't call consolidate_fact
        self.assertEqual(summary['added'], 1)
        self.assertEqual(len(audit_entries), 0)

        # Verify profile.json was NOT modified
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 0)


class TestResolveAcceptedConflicts(MemoryConsolidationTestCase):
    """Test accepted conflict resolution."""

    def test_applies_accepted_conflict(self):
        """Pending entry with resolution='accepted' → profile_callback called, applied_at set."""
        pending_path = os.path.join(self.pa_home, 'review-digest-pending.jsonl')

        # Write a pending conflict entry that has been accepted
        pending_entry = {
            'id': 'cf-001',
            'created_at': '2026-08-18T21:15:00Z',
            'resolved': True,
            'resolution': 'accepted',
            'key': 'dietary-mushrooms',
            'new_text': 'Eats mushrooms regularly now',
            'existing_text': 'Avoid mushrooms completely',
            'existing_valid_from': '2026-06-15',
            'category': 'preference',
            'source': 'conversation',
            'source_ref': 'turn-20260818-1234'
        }

        with open(pending_path, 'w') as f:
            f.write(json.dumps(pending_entry) + '\n')

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.resolve_accepted_conflicts(
            pending_path,
            learn_agent.consolidate_fact,
            audit_callback
        )

        self.assertEqual(summary['applied'], 1)
        self.assertEqual(summary['rejected'], 0)
        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'conflict_accepted')

        # Verify profile.json was updated
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['update'], 'Eats mushrooms regularly now')

        # Verify pending file was updated with applied_at
        with open(pending_path, 'r') as f:
            updated_entry = json.loads(f.read().strip())
        self.assertIn('applied_at', updated_entry)

    def test_skips_rejected_conflict(self):
        """Pending entry with resolution='rejected' → no profile_callback call."""
        pending_path = os.path.join(self.pa_home, 'review-digest-pending.jsonl')

        pending_entry = {
            'id': 'cf-001',
            'created_at': '2026-08-18T21:15:00Z',
            'resolved': True,
            'resolution': 'rejected',
            'key': 'dietary-mushrooms',
            'new_text': 'Eats mushrooms regularly',
            'existing_text': 'Avoid mushrooms',
            'existing_valid_from': '2026-06-15',
            'category': 'preference',
            'source': 'conversation'
        }

        with open(pending_path, 'w') as f:
            f.write(json.dumps(pending_entry) + '\n')

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.resolve_accepted_conflicts(
            pending_path,
            learn_agent.consolidate_fact,
            audit_callback
        )

        self.assertEqual(summary['applied'], 0)
        self.assertEqual(summary['rejected'], 1)
        self.assertEqual(len(audit_entries), 0)

        # Verify profile.json was NOT modified
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 0)

    def test_skips_unresolved_conflict(self):
        """Pending entry with resolved=false → no action."""
        pending_path = os.path.join(self.pa_home, 'review-digest-pending.jsonl')

        pending_entry = {
            'id': 'cf-001',
            'created_at': '2026-08-18T21:15:00Z',
            'resolved': False,
            'resolution': None,
            'key': 'dietary-mushrooms',
            'new_text': 'Eats mushrooms regularly',
            'existing_text': 'Avoid mushrooms',
            'existing_valid_from': '2026-06-15',
            'category': 'preference',
            'source': 'conversation'
        }

        with open(pending_path, 'w') as f:
            f.write(json.dumps(pending_entry) + '\n')

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.resolve_accepted_conflicts(
            pending_path,
            learn_agent.consolidate_fact,
            audit_callback
        )

        self.assertEqual(summary['applied'], 0)
        self.assertEqual(summary['pending'], 1)
        self.assertEqual(len(audit_entries), 0)

        # Verify profile.json was NOT modified
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 0)


class TestWriteAuditEntries(MemoryConsolidationTestCase):
    """Test audit entry writing."""

    def test_appends_to_audit_jsonl(self):
        """3 entries → 3 lines in audit file."""
        audit_path = os.path.join(self.pa_home, 'consolidation-audit.jsonl')

        entries = [
            {
                'ts': '2026-08-18T21:15:00Z',
                'action': 'added',
                'fact_key': 'test-1',
                'fact_text': 'Test fact 1',
                'category': 'preference',
                'sink': 'profile',
                'source': 'conversation',
                'superseded_key': None,
                'superseded_text': None,
                'conflict_detail': None
            },
            {
                'ts': '2026-08-18T21:15:01Z',
                'action': 'superseded',
                'fact_key': 'test-2',
                'fact_text': 'Test fact 2',
                'category': 'preference',
                'sink': 'profile',
                'source': 'conversation',
                'superseded_key': 'test-2-old',
                'superseded_text': 'Old fact 2',
                'conflict_detail': None
            },
            {
                'ts': '2026-08-18T21:15:02Z',
                'action': 'conflict',
                'fact_key': 'test-3',
                'fact_text': 'Test fact 3',
                'category': 'preference',
                'sink': 'profile',
                'source': 'conversation',
                'superseded_key': None,
                'superseded_text': None,
                'conflict_detail': {'new_text': 'New', 'existing_text': 'Old'}
            }
        ]

        count = memory_consolidation.write_audit_entries(entries, audit_path)

        self.assertEqual(count, 3)

        # Verify all 3 lines were written
        with open(audit_path, 'r') as f:
            lines = [line.strip() for line in f if line.strip()]
        self.assertEqual(len(lines), 3)

        # Verify entry content
        entry1 = json.loads(lines[0])
        self.assertEqual(entry1['action'], 'added')
        self.assertEqual(entry1['fact_key'], 'test-1')

    def test_audit_entry_schema(self):
        """Verify all fields present (ts, action, fact_key, fact_text, category, sink, source)."""
        audit_path = os.path.join(self.pa_home, 'consolidation-audit.jsonl')

        entry = {
            'ts': '2026-08-18T21:15:00Z',
            'action': 'added',
            'fact_key': 'dietary-mushrooms',
            'fact_text': 'Mushrooms OK when eating outside',
            'category': 'preference',
            'sink': 'profile',
            'source': 'conversation',
            'superseded_key': None,
            'superseded_text': None,
            'conflict_detail': None
        }

        count = memory_consolidation.write_audit_entries([entry], audit_path)

        self.assertEqual(count, 1)

        # Verify all required fields are present
        with open(audit_path, 'r') as f:
            loaded_entry = json.loads(f.read().strip())

        required_fields = ['ts', 'action', 'fact_key', 'fact_text', 'category', 'sink', 'source']
        for field in required_fields:
            self.assertIn(field, loaded_entry)

        self.assertEqual(loaded_entry['ts'], '2026-08-18T21:15:00Z')
        self.assertEqual(loaded_entry['action'], 'added')
        self.assertEqual(loaded_entry['fact_key'], 'dietary-mushrooms')


if __name__ == '__main__':
    unittest.main()
