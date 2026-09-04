#!/usr/bin/env python3
"""
Tests for the memory consolidation post-processor engine.

Tests cover staging file reading, profile candidate processing, conflict
routing, audit writing, and accepted conflict resolution. The engine is
driven with a FakeStore (the real profile store is private; the
engine-vs-real-store seam is exercised by test_unconfirmed_facts.py).
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Add pa/src and pa/scripts to path
SCRIPT_DIR = Path(__file__).parent.parent
SRC_DIR = SCRIPT_DIR.parent / 'src'
sys.path.insert(0, str(SRC_DIR))
sys.path.insert(0, str(SCRIPT_DIR))

import memory_consolidation


class FakeStore:
    """Minimal stand-in for the deployment's private profile store.

    Implements only the consolidate_fact actions these fixtures exercise —
    add, supersede, duplicate adopt/fold — against the temp profile.json and
    archive, records every call, and normalizes source_ref on write with the
    engine's own normalize_source_ref helper (mirroring the real store's
    contract).
    """

    def __init__(self, profile_path, archive_path):
        self.profile_path = profile_path
        self.archive_path = archive_path
        self.calls = []

    @staticmethod
    def _norm(text):
        return (text or '').strip().lower()[:80]

    def _read_profile(self):
        with open(self.profile_path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def _archive(self, entries):
        with open(self.archive_path, 'a', encoding='utf-8') as f:
            for entry in entries:
                f.write(json.dumps(entry) + '\n')

    def consolidate_fact(self, candidate):
        self.calls.append(candidate)
        key = candidate.get('key')
        text = candidate.get('text')
        valid_from = candidate.get('valid_from')
        source = candidate.get('source')
        normalized_ref, _ = memory_consolidation.normalize_source_ref(candidate.get('source_ref'))
        resolution = candidate.get('resolution') or {}
        resolution_type = resolution.get('type') if isinstance(resolution, dict) else None

        profile = self._read_profile()
        history = profile['history']

        if resolution_type == 'duplicate' and resolution.get('duplicate_of_text'):
            anchor = self._norm(resolution['duplicate_of_text'])
            unkeyed_index = next(
                (i for i, e in enumerate(history)
                 if 'key' not in e
                 and self._norm(e.get('update') or e.get('text', '')) == anchor),
                None
            )
            if unkeyed_index is not None:
                unkeyed_entry = history[unkeyed_index]
                keyed_exists = any(
                    e.get('key') == key and e.get('valid_until') is None
                    for e in history
                )
                if not keyed_exists:
                    # Adopt: stamp the unkeyed entry in place with the key
                    unkeyed_entry['key'] = key
                    unkeyed_entry['valid_from'] = unkeyed_entry.get(
                        'timestamp', unkeyed_entry.get('valid_from'))
                    unkeyed_entry['valid_until'] = None
                    unkeyed_entry['superseded_by'] = None
                    unkeyed_entry['source'] = 'learn'
                    unkeyed_entry['source_ref'] = normalized_ref
                    memory_consolidation._atomic_write_json(self.profile_path, profile)
                    return {'action': 'adopted', 'key': key,
                            'archived_entry': None, 'conflict_detail': None}
                # Fold: archive the unkeyed entry and remove it from history
                self._archive([unkeyed_entry])
                history.pop(unkeyed_index)
                memory_consolidation._atomic_write_json(self.profile_path, profile)
                return {'action': 'folded', 'key': key,
                        'archived_entry': unkeyed_entry,
                        'conflict_detail': {'folded_into': key}}

        existing_index = next(
            (i for i, e in enumerate(history)
             if e.get('key') == key and e.get('valid_until') is None),
            None
        )

        if existing_index is None:
            history.append({
                'timestamp': valid_from,
                'update': text,
                'valid_from': valid_from,
                'valid_until': None,
                'key': key,
                'superseded_by': None,
                'source': source,
                'source_ref': normalized_ref
            })
            memory_consolidation._atomic_write_json(self.profile_path, profile)
            return {'action': 'added', 'key': key, 'archived_entry': None}

        # Supersede the live entry (archived copy first, then replace+append)
        superseded_copy = history[existing_index].copy()
        existing_valid_from = superseded_copy.get('valid_from') or superseded_copy.get('timestamp')
        clamped = max(valid_from, existing_valid_from) if existing_valid_from else valid_from
        superseded_copy['valid_until'] = clamped
        superseded_copy['superseded_by'] = key
        self._archive([superseded_copy])
        history[existing_index] = superseded_copy
        history.append({
            'timestamp': valid_from,
            'update': text,
            'valid_from': valid_from,
            'valid_until': None,
            'key': key,
            'superseded_by': None,
            'source': source,
            'source_ref': normalized_ref
        })
        memory_consolidation._atomic_write_json(self.profile_path, profile)
        return {'action': 'superseded', 'key': key,
                'archived_entry': superseded_copy, 'conflict_detail': None}


class MemoryConsolidationTestCase(unittest.TestCase):
    """Base test case with temp directory, PA_HOME override, and a FakeStore
    bound to the temp profile/archive."""

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

        self.archive_path = os.path.join(self.pa_home, 'profile-history-archive.jsonl')
        self.store = FakeStore(self.profile_path, self.archive_path)

    def tearDown(self):
        """Clean up temp directory and restore PA_HOME."""
        if self.orig_pa_home:
            os.environ['PA_HOME'] = self.orig_pa_home
        else:
            os.environ.pop('PA_HOME', None)

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
            # Canonical list-of-turn-pointers shape (F1, 2026-08-24 recall-
            # traces wave) with a user-role pointer — the old free-text
            # example this fixture used ('turn-20260818-1234') is retired
            # (§6.3) and, wrapped by normalize_source_ref as legacy evidence
            # with no role, would now be routed 'agent_output' and held back
            # by F2 instead of added; this fixture is testing the plain
            # added-with-user-evidence pathway, not legacy-string handling
            # (see test_legacy_string_source_ref_is_normalized_on_write for
            # that).
            'source_ref': [{'thread_id': 4242, 'message_id': 1234, 'ts': '2026-08-18T00:00:00Z', 'role': 'user'}],
            'resolution': {'type': 'new'},
            'category': 'preference'
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False, store=self.store
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
        self.store.consolidate_fact(initial_candidate)

        # Supersede with new entry
        supersede_candidate = [{
            'key': 'dietary-mushrooms',
            'text': 'Eats mushrooms regularly now',
            'sink': 'profile',
            'valid_from': '2026-08-18',
            'source': 'conversation',
            # Canonical shape with a user-role pointer — see the note in
            # test_auto_adds_new_candidate.
            'source_ref': [{'thread_id': 4242, 'message_id': 1234, 'ts': '2026-08-18T00:00:00Z', 'role': 'user'}],
            'resolution': {'type': 'supersede'},
            'category': 'preference'
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            supersede_candidate, audit_callback, dry_run=False, store=self.store
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
            # Canonical shape with a user-role pointer — see the note in
            # test_auto_adds_new_candidate.
            'source_ref': [{'thread_id': 4242, 'message_id': 1234, 'ts': '2026-08-18T00:00:00Z', 'role': 'user'}],
            'resolution': {'type': 'contradiction'},
            'category': 'preference',
            'existing_text': 'Avoid mushrooms completely',
            'existing_valid_from': '2026-06-15'
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False, store=self.store
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
            candidates, audit_callback, dry_run=False, store=self.store
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
            candidates, audit_callback, dry_run=True, store=self.store
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
            self.store.consolidate_fact,
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
            self.store.consolidate_fact,
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
            self.store.consolidate_fact,
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


class TestKbAuthoritativeSuppression(MemoryConsolidationTestCase):
    """Test KB-authoritative key prefix suppression (AI-151)."""

    def test_suppresses_kb_authoritative_prefix(self):
        """Registry with training- prefix, candidate key training-x sink both → suppressed with matched_prefix."""
        # Create registry file
        registry_path = os.path.join(self.pa_home, 'kb-authoritative-keys.json')
        with open(registry_path, 'w') as f:
            json.dump({'key_prefixes': ['training-']}, f)

        registry = memory_consolidation.load_kb_authoritative_keys(self.pa_home)
        self.assertEqual(registry, {'training-'})

        candidates = [{
            'key': 'training-x',
            'text': 'Training fact',
            'sink': 'both',
            'valid_from': '2026-08-22',
            'source': 'conversation',
            'resolution': {'type': 'new'}
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False, kb_authoritative_registry=registry,
            store=self.store
        )

        self.assertEqual(summary['suppressed'], 1)
        self.assertEqual(summary['added'], 0)
        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'suppressed')
        self.assertEqual(audit_entries[0]['sink'], 'kb')
        self.assertEqual(audit_entries[0]['conflict_detail']['matched_prefix'], 'training-')
        self.assertEqual(audit_entries[0]['conflict_detail']['original_sink'], 'both')

    def test_registry_missing_fails_open(self):
        """No registry file → empty set, sink both → added."""
        # No registry file created
        registry = memory_consolidation.load_kb_authoritative_keys(self.pa_home)
        self.assertEqual(registry, set())

        candidates = [{
            'key': 'fitness-x',
            'text': 'Fitness fact',
            'sink': 'both',
            'valid_from': '2026-08-22',
            'source': 'conversation',
            'resolution': {'type': 'new'}
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False, kb_authoritative_registry=registry,
            store=self.store
        )

        self.assertEqual(summary['added'], 1)
        self.assertEqual(summary['suppressed'], 0)

    def test_registry_malformed_fails_open(self):
        """Garbage JSON file → empty set + stderr, sink both → added."""
        import contextlib

        # Create malformed registry file
        registry_path = os.path.join(self.pa_home, 'kb-authoritative-keys.json')
        with open(registry_path, 'w') as f:
            f.write('{invalid json}')

        # Capture stderr around the LOADER call — the warning fires at load
        # time, not during candidate processing (the original redirect window
        # started after the call and captured nothing).
        import io
        stderr_capture = io.StringIO()
        with contextlib.redirect_stderr(stderr_capture):
            registry = memory_consolidation.load_kb_authoritative_keys(self.pa_home)
        self.assertEqual(registry, set())
        self.assertIn('Failed to load kb-authoritative-keys.json', stderr_capture.getvalue())

        candidates = [{
            'key': 'fitness-x',
            'text': 'Fitness fact',
            'sink': 'both',
            'valid_from': '2026-08-22',
            'source': 'conversation',
            'resolution': {'type': 'new'}
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False, kb_authoritative_registry=registry,
            store=self.store
        )

        self.assertEqual(summary['added'], 1)
        self.assertEqual(summary['suppressed'], 0)
        stderr_output = stderr_capture.getvalue()
        self.assertIn('Failed to load kb-authoritative-keys.json', stderr_output)


class TestDuplicateRouting(MemoryConsolidationTestCase):
    """Test duplicate resolution routing (adopt/fold) for AI-150."""

    def test_duplicate_candidate_adopted(self):
        """Unkeyed entry seeded, candidate duplicate with verbatim anchor → adopted, entry keyed in place."""
        # Seed unkeyed entry directly into profile.json — update_profile takes a
        # plain string (the learn path), not an entry dict; the spec's seeding
        # hint was wrong (found in cross-WP gate 2026-08-22).
        unkeyed_entry = {
            'update': 'Ekadashi observance follows Sri Vaishnava traditions',
            'timestamp': '2026-08-20T10:00:00Z',
            'source': 'learn'
        }
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        profile['history'].append(unkeyed_entry)
        memory_consolidation._atomic_write_json(self.profile_path, profile)

        # Verify unkeyed entry exists
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 1)
        self.assertIsNone(profile['history'][0].get('key'))

        # Candidate with duplicate resolution
        candidates = [{
            'key': 'ekadashi-srivaishnava-content',
            'text': unkeyed_entry['update'],
            'sink': 'profile',
            'valid_from': '2026-08-22',
            'source': 'conversation',
            'resolution': {
                'type': 'duplicate',
                'duplicate_of_text': unkeyed_entry['update']
            }
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False, store=self.store
        )

        self.assertEqual(summary['adopted'], 1)
        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'adopted')
        self.assertEqual(audit_entries[0]['source'], 'learn')

        # Verify entry is now keyed in place (history length unchanged)
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['key'], 'ekadashi-srivaishnava-content')
        self.assertEqual(profile['history'][0]['source'], 'learn')

    def test_duplicate_candidate_folded(self):
        """Unkeyed + live keyed seeded, candidate duplicate → folded, unkeyed in archive and gone from history."""
        # Seed unkeyed entry
        unkeyed_entry = {
            'update': 'Ekadashi observance follows Sri Vaishnava traditions',
            'timestamp': '2026-08-20T10:00:00Z',
            'source': 'learn'
        }
        # Seed both entries directly into profile.json (update_profile takes a
        # plain string, not entry dicts — see the adopted test's note).
        keyed_entry = {
            'key': 'ekadashi-srivaishnava-content',
            'update': 'Ekadashi observance follows Sri Vaishnava traditions',
            'timestamp': '2026-08-20T12:00:00Z',
            'valid_from': '2026-08-20',
            'valid_until': None,
            'superseded_by': None,
            'source': 'consolidation'
        }
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        profile['history'].append(unkeyed_entry)
        profile['history'].append(keyed_entry)
        memory_consolidation._atomic_write_json(self.profile_path, profile)

        # Verify both entries exist
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 2)

        # Candidate with duplicate resolution anchored on unkeyed text
        candidates = [{
            'key': 'ekadashi-srivaishnava-content',
            'text': unkeyed_entry['update'],
            'sink': 'profile',
            'valid_from': '2026-08-22',
            'source': 'conversation',
            'resolution': {
                'type': 'duplicate',
                'duplicate_of_text': unkeyed_entry['update']
            }
        }]

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        summary = memory_consolidation.process_profile_candidates(
            candidates, audit_callback, dry_run=False, store=self.store
        )

        self.assertEqual(summary['folded'], 1)
        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'folded')
        self.assertEqual(audit_entries[0]['conflict_detail']['folded_into'], 'ekadashi-srivaishnava-content')

        # Verify unkeyed entry is gone from history (only keyed remains)
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['key'], 'ekadashi-srivaishnava-content')

        # Verify unkeyed entry is in archive
        with open(self.archive_path, 'r') as f:
            archive_lines = [line.strip() for line in f if line.strip()]
        self.assertEqual(len(archive_lines), 1)
        archived_entry = json.loads(archive_lines[0])
        self.assertIsNone(archived_entry.get('key'))
        self.assertEqual(archived_entry['update'], unkeyed_entry['update'])


class TestHistoryWindowValidator(MemoryConsolidationTestCase):
    """Test validity window validator for AI-149."""

    def test_validator_repairs_inverted_history(self):
        """Seed two inverted entries → both collapse to valid_until == valid_from, audit repaired ×2."""
        # Seed profile with two inverted entries
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)

        profile['history'] = [
            {
                'key': 'dietary-mushrooms',
                'update': 'Entry 1',
                'timestamp': '2026-08-18T10:00:00Z',
                'valid_from': '2026-08-18',
                'valid_until': '2026-06-15',
                'source': 'test'
            },
            {
                'key': 'dietary-test',
                'update': 'Entry 2',
                'timestamp': '2026-08-17T10:00:00Z',
                'valid_from': '2026-08-17',
                'valid_until': '2026-08-16',
                'source': 'test'
            }
        ]

        with open(self.profile_path, 'w') as f:
            json.dump(profile, f)

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        counts = memory_consolidation.validate_history_windows(
            self.profile_path, audit_callback, dry_run=False
        )

        self.assertEqual(counts['checked'], 2)
        self.assertEqual(counts['repaired'], 2)
        self.assertEqual(len(audit_entries), 2)

        # Verify both audit entries are 'repaired'
        self.assertEqual(audit_entries[0]['action'], 'repaired')
        self.assertEqual(audit_entries[1]['action'], 'repaired')
        self.assertEqual(audit_entries[0]['conflict_detail']['surface'], 'history')
        self.assertEqual(audit_entries[1]['conflict_detail']['surface'], 'history')

        # Verify profile was repaired
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)

        for entry in profile['history']:
            if entry.get('valid_from') and entry.get('valid_until'):
                self.assertLessEqual(entry['valid_from'], entry['valid_until'])

    def test_validator_clean_history_is_noop(self):
        """Clean profile → file bytes unchanged, zero audit entries."""
        # Seed clean profile
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)

        profile['history'] = [
            {
                'key': 'dietary-mushrooms',
                'update': 'Valid entry',
                'timestamp': '2026-08-18T10:00:00Z',
                'valid_from': '2026-08-18',
                'valid_until': None,
                'source': 'test'
            }
        ]

        with open(self.profile_path, 'w') as f:
            json.dump(profile, f)

        # Read file bytes before
        with open(self.profile_path, 'rb') as f:
            bytes_before = f.read()

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        counts = memory_consolidation.validate_history_windows(
            self.profile_path, audit_callback, dry_run=False
        )

        self.assertEqual(counts['checked'], 1)
        self.assertEqual(counts['repaired'], 0)
        self.assertEqual(len(audit_entries), 0)

        # Verify file bytes unchanged
        with open(self.profile_path, 'rb') as f:
            bytes_after = f.read()
        self.assertEqual(bytes_before, bytes_after)

    def test_dry_run_validator_does_not_write(self):
        """Inverted entry + dry-run → file unchanged."""
        # Seed inverted entry
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)

        profile['history'] = [
            {
                'key': 'dietary-mushrooms',
                'update': 'Inverted entry',
                'timestamp': '2026-08-18T10:00:00Z',
                'valid_from': '2026-08-18',
                'valid_until': '2026-06-15',
                'source': 'test'
            }
        ]

        with open(self.profile_path, 'w') as f:
            json.dump(profile, f)

        # Read file bytes before
        with open(self.profile_path, 'rb') as f:
            bytes_before = f.read()

        audit_entries = []
        audit_callback = lambda e: audit_entries.append(e)

        counts = memory_consolidation.validate_history_windows(
            self.profile_path, audit_callback, dry_run=True
        )

        self.assertEqual(counts['checked'], 1)
        self.assertEqual(counts['repaired'], 1)
        self.assertEqual(len(audit_entries), 1)

        # Verify file bytes unchanged (dry-run)
        with open(self.profile_path, 'rb') as f:
            bytes_after = f.read()
        self.assertEqual(bytes_before, bytes_after)

        # Verify profile still has inverted window
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertGreater(profile['history'][0]['valid_from'], profile['history'][0]['valid_until'])

    def test_validator_counts_legacy_entries_with_no_repair(self):
        """Entries with a falsy source_ref are counted 'legacy', never
        repaired or audited (D4.3/F4, 2026-08-24 recall-traces wave)."""
        with open(self.profile_path, 'r') as f:
            profile = json.load(f)

        profile['history'] = [
            {
                'key': 'legacy-a', 'update': 'Entry with no source_ref key',
                'timestamp': '2026-08-18T10:00:00Z', 'valid_from': '2026-08-18', 'valid_until': None,
            },
            {
                'key': 'legacy-b', 'update': 'Entry with source_ref None',
                'timestamp': '2026-08-18T10:00:00Z', 'valid_from': '2026-08-18', 'valid_until': None,
                'source_ref': None,
            },
            {
                'key': 'has-ref', 'update': 'Entry with real source_ref',
                'timestamp': '2026-08-18T10:00:00Z', 'valid_from': '2026-08-18', 'valid_until': None,
                'source_ref': [{'thread_id': 1, 'message_id': 2, 'role': 'user'}],
            },
        ]

        with open(self.profile_path, 'w') as f:
            json.dump(profile, f)

        audit_entries = []
        counts = memory_consolidation.validate_history_windows(
            self.profile_path, lambda e: audit_entries.append(e), dry_run=False
        )

        self.assertEqual(counts['checked'], 3)
        self.assertEqual(counts['repaired'], 0)
        self.assertEqual(counts['legacy'], 2)
        self.assertEqual(len(audit_entries), 0)


class TestNewSummaryKeyAndNormalizedSourceRef(MemoryConsolidationTestCase):
    """F1/F2 (2026-08-24 recall-traces wave): the new 'unconfirmed' summary
    key, the new 'unconfirmed'/'promoted' audit actions, and source_ref
    reaching profile.json in normalized list form."""

    def test_summary_has_unconfirmed_key_defaulting_to_zero(self):
        summary = memory_consolidation.process_profile_candidates(
            [], lambda e: None, dry_run=False, store=self.store
        )
        self.assertIn('unconfirmed', summary)
        self.assertEqual(summary['unconfirmed'], 0)

    def test_assistant_only_candidate_produces_unconfirmed_audit_action(self):
        review_pending_path = os.path.join(self.pa_home, 'review-digest-pending.jsonl')
        candidates = [{
            'key': 'dietary-mushrooms',
            'text': 'Mushrooms mentioned in passing',
            'sink': 'profile',
            'valid_from': '2026-08-24',
            'source': 'conversation',
            'source_ref': [{'thread_id': 4242, 'message_id': 41230, 'role': 'assistant'}],
            'resolution': {'type': 'new'},
            'category': 'preference',
        }]

        audit_entries = []
        summary = memory_consolidation.process_profile_candidates(
            candidates, lambda e: audit_entries.append(e), dry_run=False,
            review_pending_path=review_pending_path, store=self.store
        )

        self.assertEqual(summary['unconfirmed'], 1)
        self.assertEqual(audit_entries[0]['action'], 'unconfirmed')
        self.assertEqual(audit_entries[0]['sink'], 'review-pending')

        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 0)

    def test_source_ref_reaches_profile_json_in_normalized_list_form(self):
        candidate = {
            'key': 'dietary-mushrooms',
            'text': 'Eats mushrooms regularly now',
            'valid_from': '2026-08-24',
            'source': 'conversation',
            'source_ref': [{'thread_id': 4242, 'message_id': 41231, 'ts': '2026-08-24T10:01:00Z', 'role': 'user'}],
        }
        self.store.consolidate_fact(candidate)

        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['source_ref'], candidate['source_ref'])

    def test_legacy_string_source_ref_is_normalized_on_write(self):
        """A legacy free-text source_ref is never discarded — it lands in
        profile.json wrapped in the canonical list shape (F1)."""
        candidate = {
            'key': 'legacy-key',
            'text': 'Some archive-mined fact',
            'valid_from': '2026-08-24',
            'source': 'archive',
            'source_ref': 'archive-line-58',
        }
        self.store.consolidate_fact(candidate)

        with open(self.profile_path, 'r') as f:
            profile = json.load(f)
        self.assertEqual(profile['history'][0]['source_ref'], [{'legacy': 'archive-line-58'}])


class TestConflictAndUnconfirmedCoexistence(MemoryConsolidationTestCase):
    """cf- contradictions and uf- unconfirmed facts share
    review-digest-pending.jsonl (F3) — neither reader picks up the other's
    rows."""

    def test_cf_and_uf_entries_coexist_without_cross_contamination(self):
        review_pending_path = os.path.join(self.pa_home, 'review-digest-pending.jsonl')

        contradiction_candidates = [{
            'key': 'dietary-mushrooms',
            'text': 'Eats mushrooms regularly',
            'sink': 'profile',
            'valid_from': '2026-08-18',
            'source': 'conversation',
            'source_ref': [{'thread_id': 1, 'message_id': 2, 'role': 'user'}],
            'resolution': {'type': 'contradiction'},
            'category': 'preference',
            'existing_text': 'Avoid mushrooms completely',
            'existing_valid_from': '2026-06-15',
        }]
        conflicts_written = memory_consolidation.write_conflicts(contradiction_candidates, review_pending_path)
        self.assertEqual(conflicts_written, 1)

        assistant_candidate = {
            'key': 'other-key',
            'text': 'Assistant-inferred fact',
            'category': 'preference',
            'source': 'conversation',
            'source_ref': [{'thread_id': 1, 'message_id': 3, 'role': 'assistant'}],
            'valid_from': '2026-08-18',
        }
        ok = memory_consolidation.write_unconfirmed(assistant_candidate, review_pending_path)
        self.assertTrue(ok)

        with open(review_pending_path, 'r') as f:
            all_lines = [json.loads(line) for line in f if line.strip()]
        self.assertEqual(len(all_lines), 2)
        ids = {e['id'][:3] for e in all_lines}
        self.assertEqual(ids, {'cf-', 'uf-'})

        # read_unconfirmed_entries only ever picks up uf- rows.
        unconfirmed_only = memory_consolidation.read_unconfirmed_entries(review_pending_path)
        self.assertEqual(len(unconfirmed_only), 1)
        self.assertTrue(unconfirmed_only[0]['id'].startswith('uf-'))
        self.assertEqual(unconfirmed_only[0]['key'], 'other-key')


if __name__ == '__main__':
    unittest.main()
