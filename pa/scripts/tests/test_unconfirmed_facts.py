#!/usr/bin/env python3
"""
Tests for unconfirmed-fact memory hygiene (WP-F, AI-166,
plans/2026-08-24-recall-traces-wave-SPEC.md §3.6).

Covers: learn_agent.normalize_source_ref, process_profile_candidates' F2
assistant-only-evidence blocking, write_unconfirmed/read_unconfirmed_entries/
promote_unconfirmed_facts (F3), the weekly_digest renderer-compatibility
guard for the frozen file WP-F may not edit (C25), and torn-line tolerance.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Add pa/src and pa/scripts to path (same order as test_memory_consolidation.py)
SCRIPT_DIR = Path(__file__).parent.parent
SRC_DIR = SCRIPT_DIR.parent / 'src'
sys.path.insert(0, str(SRC_DIR))
sys.path.insert(0, str(SCRIPT_DIR))

import memory_consolidation
import learn_agent
import weekly_digest

# Patch learn_agent paths at import time to prevent accidental writes to real profile
_original_profile_path = learn_agent.PROFILE_PATH
_original_archive_path = learn_agent.ARCHIVE_PATH


class UnconfirmedFactsTestCase(unittest.TestCase):
    """Base test case with temp directory and PA_HOME override (mirrors
    test_memory_consolidation.py's MemoryConsolidationTestCase)."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.pa_home = os.path.join(self.temp_dir, '.pa')
        os.makedirs(self.pa_home, exist_ok=True)
        os.makedirs(os.path.join(self.pa_home, 'data'), exist_ok=True)

        self.orig_pa_home = os.environ.get('PA_HOME')
        os.environ['PA_HOME'] = self.pa_home

        self.profile_path = os.path.join(self.pa_home, 'data', 'profile.json')
        with open(self.profile_path, 'w', encoding='utf-8') as f:
            json.dump({'history': []}, f)

        self.review_pending_path = os.path.join(self.pa_home, 'review-digest-pending.jsonl')

        learn_agent.PROFILE_PATH = self.profile_path
        learn_agent.ARCHIVE_PATH = os.path.join(self.pa_home, 'profile-history-archive.jsonl')

    def tearDown(self):
        if self.orig_pa_home:
            os.environ['PA_HOME'] = self.orig_pa_home
        else:
            os.environ.pop('PA_HOME', None)

        learn_agent.PROFILE_PATH = _original_profile_path
        learn_agent.ARCHIVE_PATH = _original_archive_path

        try:
            shutil.rmtree(self.temp_dir)
        except Exception:
            pass

    def read_profile(self):
        with open(self.profile_path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def read_pending_lines(self):
        if not os.path.exists(self.review_pending_path):
            return []
        with open(self.review_pending_path, 'r', encoding='utf-8') as f:
            return [json.loads(line) for line in f if line.strip()]


class TestNormalizeSourceRef(unittest.TestCase):
    """Pure function — no PA_HOME needed."""

    def test_canonical_list_with_user_pointer(self):
        value = [
            {'thread_id': 7822, 'message_id': 41231, 'ts': '2026-08-20T11:02:03.000Z', 'role': 'user'},
        ]
        normalized, has_user = learn_agent.normalize_source_ref(value)
        self.assertEqual(normalized, value)
        self.assertTrue(has_user)

    def test_canonical_list_assistant_only(self):
        value = [
            {'thread_id': 7822, 'message_id': 41230, 'ts': '2026-08-20T11:01:00.000Z', 'role': 'assistant'},
        ]
        normalized, has_user = learn_agent.normalize_source_ref(value)
        self.assertEqual(normalized, value)
        self.assertFalse(has_user)

    def test_canonical_list_mixed_roles_counts_as_user_evidence(self):
        value = [
            {'thread_id': 7822, 'message_id': 41230, 'ts': '2026-08-20T11:01:00.000Z', 'role': 'assistant'},
            {'thread_id': 7822, 'message_id': 41231, 'ts': '2026-08-20T11:02:03.000Z', 'role': 'user'},
        ]
        normalized, has_user = learn_agent.normalize_source_ref(value)
        self.assertEqual(normalized, value)
        self.assertTrue(has_user)

    def test_bare_dict_is_wrapped(self):
        value = {'thread_id': 7822, 'message_id': 41231, 'ts': '2026-08-20T11:02:03.000Z', 'role': 'user'}
        normalized, has_user = learn_agent.normalize_source_ref(value)
        self.assertEqual(normalized, [value])
        self.assertTrue(has_user)

    def test_bare_dict_non_user_role(self):
        value = {'thread_id': 7822, 'message_id': 41230, 'role': 'assistant'}
        normalized, has_user = learn_agent.normalize_source_ref(value)
        self.assertEqual(normalized, [value])
        self.assertFalse(has_user)

    def test_legacy_string_kept_verbatim(self):
        normalized, has_user = learn_agent.normalize_source_ref('archive-line-58')
        self.assertEqual(normalized, [{'legacy': 'archive-line-58'}])
        self.assertFalse(has_user)

    def test_none_returns_none_false(self):
        normalized, has_user = learn_agent.normalize_source_ref(None)
        self.assertIsNone(normalized)
        self.assertFalse(has_user)

    def test_junk_type_returns_none_false(self):
        normalized, has_user = learn_agent.normalize_source_ref(12345)
        self.assertIsNone(normalized)
        self.assertFalse(has_user)

    def test_list_of_non_dicts_is_junk(self):
        normalized, has_user = learn_agent.normalize_source_ref(['turn-1', 'turn-2'])
        self.assertIsNone(normalized)
        self.assertFalse(has_user)


class TestAssistantOnlyBlocking(UnconfirmedFactsTestCase):
    """F2: a candidate whose only evidence is an assistant turn is held back."""

    def _assistant_only_candidate(self, key='dietary-mushrooms', text='Mushrooms mentioned in passing'):
        return {
            'key': key,
            'text': text,
            'sink': 'profile',
            'valid_from': '2026-08-24',
            'source': 'conversation',
            'source_ref': [{'thread_id': 7822, 'message_id': 41230, 'ts': '2026-08-24T10:00:00Z', 'role': 'assistant'}],
            'resolution': {'type': 'new'},
            'category': 'preference',
        }

    def test_assistant_only_candidate_not_written_to_profile(self):
        candidates = [self._assistant_only_candidate()]
        audit_entries = []
        summary = memory_consolidation.process_profile_candidates(
            candidates, lambda e: audit_entries.append(e), dry_run=False,
            review_pending_path=self.review_pending_path
        )

        self.assertEqual(summary['unconfirmed'], 1)
        self.assertEqual(summary['added'], 0)

        profile = self.read_profile()
        self.assertEqual(len(profile['history']), 0)

        self.assertEqual(len(audit_entries), 1)
        self.assertEqual(audit_entries[0]['action'], 'unconfirmed')

    def test_assistant_only_candidate_written_to_review_pending(self):
        candidates = [self._assistant_only_candidate()]
        memory_consolidation.process_profile_candidates(
            candidates, lambda e: None, dry_run=False,
            review_pending_path=self.review_pending_path
        )

        lines = self.read_pending_lines()
        self.assertEqual(len(lines), 1)
        entry = lines[0]
        self.assertTrue(entry['id'].startswith('uf-'))
        self.assertFalse(entry['resolved'])
        self.assertTrue(entry['category'].startswith('unconfirmed:'))
        self.assertEqual(entry['category'], 'unconfirmed:preference')
        self.assertEqual(entry['key'], 'dietary-mushrooms')
        self.assertEqual(entry['new_text'], 'Mushrooms mentioned in passing')
        self.assertEqual(entry['existing_text'], '(assistant-originated — awaiting a user turn to confirm)')

    def test_dry_run_does_not_write_review_pending(self):
        """--dry-run must never mutate review-digest-pending.jsonl (integration
        gate 5.2 step 13 runs dry-run against the REAL PA_HOME)."""
        candidates = [self._assistant_only_candidate()]
        summary = memory_consolidation.process_profile_candidates(
            candidates, lambda e: None, dry_run=True,
            review_pending_path=self.review_pending_path
        )
        self.assertEqual(summary['unconfirmed'], 1)
        self.assertFalse(os.path.exists(self.review_pending_path))

    def test_user_evidence_candidate_is_applied_and_writes_no_uf_entry(self):
        candidate = self._assistant_only_candidate()
        candidate['source_ref'] = [
            {'thread_id': 7822, 'message_id': 41231, 'ts': '2026-08-24T10:01:00Z', 'role': 'user'}
        ]
        summary = memory_consolidation.process_profile_candidates(
            [candidate], lambda e: None, dry_run=False,
            review_pending_path=self.review_pending_path
        )

        self.assertEqual(summary['added'], 1)
        self.assertEqual(summary['unconfirmed'], 0)

        profile = self.read_profile()
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['source_ref'], candidate['source_ref'])

        self.assertEqual(self.read_pending_lines(), [])

    def test_no_source_ref_candidate_applied_unchanged(self):
        """No source_ref at all keeps today's behaviour — retro-blocking every
        legacy candidate would silently stop the pipeline (R8)."""
        candidate = self._assistant_only_candidate()
        candidate['source_ref'] = None
        summary = memory_consolidation.process_profile_candidates(
            [candidate], lambda e: None, dry_run=False,
            review_pending_path=self.review_pending_path
        )

        self.assertEqual(summary['added'], 1)
        self.assertEqual(summary['unconfirmed'], 0)

        profile = self.read_profile()
        self.assertEqual(len(profile['history']), 1)
        self.assertIsNone(profile['history'][0]['source_ref'])
        self.assertEqual(self.read_pending_lines(), [])


class TestRendererCompatibility(UnconfirmedFactsTestCase):
    """The one test that can catch the unconfirmed-entry shape drifting away
    from weekly_digest.py's frozen, un-owned reader/renderer (C25/R18)."""

    def test_weekly_digest_renders_unconfirmed_fact(self):
        candidate = {
            'key': 'dietary-mushrooms',
            'text': 'Mushrooms mentioned in passing',
            'category': 'preference',
            'source': 'conversation',
            'source_ref': [{'thread_id': 7822, 'message_id': 41230, 'ts': '2026-08-24T10:00:00Z', 'role': 'assistant'}],
            'valid_from': '2026-08-24',
        }
        ok = memory_consolidation.write_unconfirmed(candidate, self.review_pending_path)
        self.assertTrue(ok)

        # weekly_digest._pa_home() reads PA_HOME from the environment, which
        # setUp already pointed at this test's temp .pa directory.
        pending_conflicts = weekly_digest.read_pending_conflicts(days=7)
        self.assertEqual(len(pending_conflicts), 1)

        result = weekly_digest.compose_digest(
            audit_entries=[], maintenance_summary={'skipped': []}, parked_skills=[],
            pending_conflicts=pending_conflicts
        )

        self.assertIn('## Memory Conflicts Pending Review', result)
        self.assertIn('dietary-mushrooms', result)
        self.assertIn('Mushrooms mentioned in passing', result)
        self.assertIn('(assistant-originated — awaiting a user turn to confirm)', result)
        self.assertIn('unconfirmed:preference', result)


class TestWriteUnconfirmedRefresh(UnconfirmedFactsTestCase):
    """F3: idempotent refresh (R19) vs. genuinely new text."""

    def _candidate(self, text):
        return {
            'key': 'dietary-mushrooms',
            'text': text,
            'category': 'preference',
            'source': 'conversation',
            'source_ref': [{'thread_id': 7822, 'message_id': 41230, 'ts': '2026-08-24T10:00:00Z', 'role': 'assistant'}],
            'valid_from': '2026-08-24',
        }

    def test_rewriting_same_fact_refreshes_created_at_without_duplicating(self):
        memory_consolidation.write_unconfirmed(self._candidate('Mushrooms OK now'), self.review_pending_path)
        lines_before = self.read_pending_lines()
        self.assertEqual(len(lines_before), 1)
        first_created_at = lines_before[0]['created_at']

        # Force a distinguishable timestamp on refresh.
        import time
        time.sleep(0.01)
        memory_consolidation.write_unconfirmed(self._candidate('Mushrooms OK now'), self.review_pending_path)

        lines_after = self.read_pending_lines()
        self.assertEqual(len(lines_after), 1)
        self.assertEqual(lines_after[0]['id'], lines_before[0]['id'])
        self.assertGreaterEqual(lines_after[0]['created_at'], first_created_at)

    def test_rewriting_with_different_text_appends(self):
        memory_consolidation.write_unconfirmed(self._candidate('Mushrooms OK now'), self.review_pending_path)
        memory_consolidation.write_unconfirmed(self._candidate('Actually avoids mushrooms again'), self.review_pending_path)

        lines = self.read_pending_lines()
        self.assertEqual(len(lines), 2)
        texts = {line['new_text'] for line in lines}
        self.assertEqual(texts, {'Mushrooms OK now', 'Actually avoids mushrooms again'})


class TestPromoteUnconfirmedFacts(UnconfirmedFactsTestCase):
    """F3: a later user-evidence run resolves the held entry and applies the
    fact exactly once; a subsequent run neither re-promotes nor re-applies."""

    def test_promotion_applies_once_and_is_idempotent(self):
        assistant_candidate = {
            'key': 'dietary-mushrooms',
            'text': 'Mushrooms mentioned in passing',
            'sink': 'profile',
            'valid_from': '2026-08-24',
            'source': 'conversation',
            'source_ref': [{'thread_id': 7822, 'message_id': 41230, 'ts': '2026-08-24T10:00:00Z', 'role': 'assistant'}],
            'resolution': {'type': 'new'},
            'category': 'preference',
        }
        memory_consolidation.process_profile_candidates(
            [assistant_candidate], lambda e: None, dry_run=False,
            review_pending_path=self.review_pending_path
        )
        self.assertEqual(len(self.read_pending_lines()), 1)
        self.assertEqual(len(self.read_profile()['history']), 0)

        # Run 2: a user turn confirms the same key.
        user_candidate = {
            'key': 'dietary-mushrooms',
            'text': 'Eats mushrooms regularly now',
            'sink': 'profile',
            'valid_from': '2026-08-25',
            'source': 'conversation',
            'source_ref': [{'thread_id': 7822, 'message_id': 41240, 'ts': '2026-08-25T09:00:00Z', 'role': 'user'}],
            'resolution': {'type': 'new'},
            'category': 'preference',
        }
        audit_entries = []
        promote_summary = memory_consolidation.promote_unconfirmed_facts(
            [user_candidate], self.review_pending_path, lambda e: audit_entries.append(e)
        )
        self.assertEqual(promote_summary['promoted'], 1)
        self.assertEqual(audit_entries[0]['action'], 'promoted')

        pending_lines = self.read_pending_lines()
        self.assertEqual(len(pending_lines), 1)
        self.assertTrue(pending_lines[0]['resolved'])
        self.assertEqual(pending_lines[0]['resolution'], 'superseded-by-user-turn')

        # The candidate proceeds through process_profile_candidates normally.
        summary = memory_consolidation.process_profile_candidates(
            [user_candidate], lambda e: None, dry_run=False,
            review_pending_path=self.review_pending_path
        )
        self.assertEqual(summary['added'], 1)
        profile = self.read_profile()
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['update'], 'Eats mushrooms regularly now')

        # Run 3: same user candidate again — no re-promotion (already resolved),
        # and process_profile_candidates would independently skip on identical
        # text via the pre-existing guard, so no double-apply either way.
        promote_summary_2 = memory_consolidation.promote_unconfirmed_facts(
            [user_candidate], self.review_pending_path, lambda e: None
        )
        self.assertEqual(promote_summary_2['promoted'], 0)

        summary_2 = memory_consolidation.process_profile_candidates(
            [user_candidate], lambda e: None, dry_run=False,
            review_pending_path=self.review_pending_path
        )
        self.assertEqual(summary_2['added'], 0)
        self.assertEqual(summary_2['skipped'], 1)
        profile_2 = self.read_profile()
        self.assertEqual(len(profile_2['history']), 1)

    def test_no_user_evidence_candidates_promotes_nothing(self):
        candidate = {
            'key': 'dietary-mushrooms',
            'text': 'Mushrooms mentioned in passing',
            'category': 'preference',
            'source': 'conversation',
            'source_ref': [{'thread_id': 7822, 'message_id': 41230, 'ts': '2026-08-24T10:00:00Z', 'role': 'assistant'}],
            'valid_from': '2026-08-24',
        }
        memory_consolidation.write_unconfirmed(candidate, self.review_pending_path)

        summary = memory_consolidation.promote_unconfirmed_facts(
            [candidate], self.review_pending_path, lambda e: None
        )
        self.assertEqual(summary['promoted'], 0)
        self.assertFalse(self.read_pending_lines()[0]['resolved'])


class TestOperatorAcceptPath(UnconfirmedFactsTestCase):
    """C25's 'bonus': resolve_accepted_conflicts already applies a
    hand-accepted uf- entry through the existing path, no new code."""

    def test_operator_accepted_uf_entry_is_applied(self):
        pending_entry = {
            'id': 'uf-20260824100000-000',
            'created_at': '2026-08-24T10:00:00Z',
            'resolved': True,
            'resolved_at': None,
            'resolution': 'accepted',
            'key': 'dietary-mushrooms',
            'category': 'unconfirmed:preference',
            'new_text': 'Mushrooms OK when eating outside',
            'existing_text': '(assistant-originated — awaiting a user turn to confirm)',
            'existing_valid_from': None,
            'source': 'conversation',
            'source_ref': [{'thread_id': 7822, 'message_id': 41230, 'role': 'assistant'}],
            'provenance': 'agent_output',
            'valid_from': '2026-08-24',
        }
        with open(self.review_pending_path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(pending_entry) + '\n')

        audit_entries = []
        with patch('learn_agent.consolidate_fact', wraps=learn_agent.consolidate_fact) as spy:
            summary = memory_consolidation.resolve_accepted_conflicts(
                self.review_pending_path,
                learn_agent.consolidate_fact,
                lambda e: audit_entries.append(e)
            )

        self.assertEqual(summary['applied'], 1)
        profile = self.read_profile()
        self.assertEqual(len(profile['history']), 1)
        self.assertEqual(profile['history'][0]['update'], 'Mushrooms OK when eating outside')


class TestTornLineTolerance(UnconfirmedFactsTestCase):
    """review-digest-pending.jsonl survives a torn final line (matches the
    torn-line guard write_conflicts already relies on)."""

    def test_survives_torn_final_line(self):
        good_entry = {
            'id': 'uf-20260824090000-000', 'created_at': '2026-08-24T09:00:00Z',
            'resolved': False, 'resolved_at': None, 'resolution': None,
            'key': 'existing-key', 'category': 'unconfirmed:preference',
            'new_text': 'Existing text', 'existing_text': '(assistant-originated — awaiting a user turn to confirm)',
            'existing_valid_from': None, 'source': 'conversation', 'source_ref': None,
            'provenance': 'agent_output', 'valid_from': '2026-08-23',
        }
        with open(self.review_pending_path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(good_entry) + '\n')
            f.write('{"id": "uf-truncated-mid-wri')  # torn, no trailing newline

        entries = memory_consolidation._read_pending_entries(self.review_pending_path)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['key'], 'existing-key')

        unconfirmed = memory_consolidation.read_unconfirmed_entries(self.review_pending_path)
        self.assertEqual(len(unconfirmed), 1)

        # A subsequent write_unconfirmed call must still work (torn line is
        # dropped on the next full rewrite).
        new_candidate = {
            'key': 'dietary-mushrooms', 'text': 'New fact', 'category': 'preference',
            'source': 'conversation',
            'source_ref': [{'thread_id': 1, 'message_id': 2, 'role': 'assistant'}],
            'valid_from': '2026-08-24',
        }
        ok = memory_consolidation.write_unconfirmed(new_candidate, self.review_pending_path)
        self.assertTrue(ok)

        final_entries = memory_consolidation._read_pending_entries(self.review_pending_path)
        self.assertEqual(len(final_entries), 2)


if __name__ == '__main__':
    unittest.main()
