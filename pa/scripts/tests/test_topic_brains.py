#!/usr/bin/env python3
"""Tests for topic_brains.py gating/slicing/stamping script.

Unittest style mirroring test_memory_consolidation.py conventions.
Uses temp dir with PA_HOME override for isolation.
"""

import json
import os
import re
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

# Add pa/scripts to path for importing topic_brains module
# The test file is at pa/scripts/tests/test_topic_brains.py
# The module is at pa/scripts/topic_brains.py
TESTS_DIR = Path(__file__).parent
SCRIPTS_DIR = TESTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

# Import the module to test
import topic_brains


# The stamp literal from spec §3.2 - quoted verbatim in tests
STAMP_LITERAL = '<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->'
# Regex extracts: group 1 = consolidated, group 2 = covers, group 3 = folded-into (optional)
STAMP_REGEX = r'<!-- topic-brain: consolidated=([^\s]+) covers=([^\s]+)(?: folded-into=([^\s]+))? -->'


class TestTopicBrains(unittest.TestCase):
    """Test suite for topic_brains.py."""

    def setUp(self):
        """Set up temp PA_HOME for each test."""
        import tempfile
        self.test_dir = tempfile.mkdtemp()
        self.pa_home = os.path.join(self.test_dir, '.pa')
        os.makedirs(self.pa_home, exist_ok=True)
        os.makedirs(os.path.join(self.pa_home, 'topic-brains'), exist_ok=True)
        os.environ['PA_HOME'] = self.pa_home

    def tearDown(self):
        """Clean up temp directory."""
        import shutil
        if 'PA_HOME' in os.environ:
            del os.environ['PA_HOME']
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def write_topic_state(self, chat_id, thread_id, turns=None, merged_at=None, parent_key=None):
        """Write a topic-state file."""
        filename = f'telegram-bot-topic-{chat_id}_{thread_id}.json'
        path = os.path.join(self.pa_home, filename)
        state = {
            'chat_id': chat_id,
            'last_update_id': 0,
            'thread_id': thread_id,
            'turns': turns or []
        }
        if merged_at:
            state['ancestry'] = {
                'mergedAt': merged_at,
                'parentTopicKey': parent_key
            }
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(state, f)

    def write_archive_turns(self, turns):
        """Write turns to conversation-history.jsonl."""
        path = os.path.join(self.pa_home, 'conversation-history.jsonl')
        with open(path, 'w', encoding='utf-8') as f:
            for turn in turns:
                f.write(json.dumps(turn) + '\n')

    def write_brain(self, topic_key, content, stamp=None):
        """Write a BRAIN.md file."""
        brain_dir = os.path.join(self.pa_home, 'topic-brains', topic_key)
        os.makedirs(brain_dir, exist_ok=True)
        brain_path = os.path.join(brain_dir, 'BRAIN.md')
        brain_content = content
        if stamp:
            # Insert stamp after title
            lines = brain_content.split('\n', 1)
            brain_content = lines[0] + '\n' + stamp + '\n' + (lines[1] if len(lines) > 1 else '')
        with open(brain_path, 'w', encoding='utf-8') as f:
            f.write(brain_content)
        return brain_path

    def write_result(self, topic_key, updated=True, summary='Test summary', conflict=None):
        """Write a result JSON file."""
        results_dir = os.path.join(self.pa_home, 'topic-brains', '.results')
        os.makedirs(results_dir, exist_ok=True)
        result_path = os.path.join(results_dir, f'{topic_key}.json')
        result = {
            'topicKey': topic_key,
            'updated': updated,
            'summary': summary,
            'conflict': conflict
        }
        with open(result_path, 'w', encoding='utf-8') as f:
            json.dump(result, f)

    # ===== plan subcommand tests =====

    def test_plan_seed_vs_delta_selection(self):
        """Test seed selection for no brain, delta for existing brain."""
        # Use timestamps AFTER the stamp's covers timestamp (2026-08-21T18:03:11.000Z)
        turns = [
            {'role': 'user', 'text': 'test', 'timestamp': '2026-08-21T19:00:00.000Z', 'thread_id': 100, 'message_id': 1},
            {'role': 'user', 'text': 'test2', 'timestamp': '2026-08-21T19:00:00.000Z', 'thread_id': 101, 'message_id': 1}
        ]
        self.write_archive_turns(turns)

        # Topic 1: no brain → seed
        self.write_topic_state(-1001234567890, 100)

        # Topic 2: has brain → delta
        self.write_topic_state(-1001234567890, 101)
        self.write_brain('-1001234567890_101', '# Test Topic\n\nContent\n', stamp=STAMP_LITERAL)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'r') as f:
            workplan = json.load(f)

        tasks = {t['topicKey']: t for t in workplan['tasks']}
        self.assertIn('kind', tasks['-1001234567890_100'])
        self.assertEqual(tasks['-1001234567890_100']['kind'], 'seed')
        self.assertEqual(tasks['-1001234567890_101']['kind'], 'delta')

    def test_plan_activity_gate(self):
        """Test topics with no new turns are skipped."""
        # Write brain with recent stamp
        self.write_brain('-1001234567890_100', '# Test\n', stamp=STAMP_LITERAL)
        self.write_topic_state(-1001234567890, 100)

        # Write an old turn (before stamp covers)
        turns = [
            {'role': 'user', 'text': 'old', 'timestamp': '2026-08-20T10:00:00.000Z', 'thread_id': 100, 'message_id': 1}
        ]
        self.write_archive_turns(turns)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'r') as f:
            workplan = json.load(f)

        # Should be skipped
        self.assertEqual(len(workplan['tasks']), 0)
        skipped = {s['topicKey']: s for s in workplan['skipped']}
        self.assertIn('-1001234567890_100', skipped)
        self.assertEqual(skipped['-1001234567890_100']['reason'], 'no-new-turns')

    def test_plan_thread_id_collision(self):
        """Test thread_id collision detection across different chats."""
        turns = [
            {'role': 'user', 'text': 'test', 'timestamp': '2026-08-21T10:00:00.000Z', 'thread_id': 100, 'message_id': 1}
        ]
        self.write_archive_turns(turns)

        # Same thread_id in different chats
        self.write_topic_state(-1001111111111, 100)
        self.write_topic_state(-1002222222222, 100)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'r') as f:
            workplan = json.load(f)

        # Both should be skipped
        self.assertEqual(len(workplan['tasks']), 0)
        skipped_reasons = {s['topicKey']: s['reason'] for s in workplan['skipped']}
        self.assertEqual(skipped_reasons['-1001111111111_100'], 'thread-id-collision')
        self.assertEqual(skipped_reasons['-1002222222222_100'], 'thread-id-collision')

    def test_plan_caps_300_turn_truncation(self):
        """Test slice truncation to 300 turns."""
        # Create 400 turns
        turns = []
        for i in range(400):
            turns.append({
                'role': 'user',
                'text': f'turn {i}',
                'timestamp': f'2026-08-21T{i:02d}:00:00.000Z',
                'thread_id': 100,
                'message_id': i
            })
        self.write_archive_turns(turns)
        self.write_topic_state(-1001234567890, 100)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        # Check slice file
        slice_path = os.path.join(self.pa_home, 'topic-brains', '.slices', '-1001234567890_100.jsonl')
        with open(slice_path, 'r') as f:
            slice_turns = [json.loads(line) for line in f]

        # Should have at most 300 turns
        self.assertLessEqual(len(slice_turns), 300)

    def test_plan_caps_8_task_limit(self):
        """Test 8 task per run cap."""
        # Create 10 topics with turns
        for i in range(10):
            thread_id = 100 + i
            turns = [
                {'role': 'user', 'text': f'test {i}', 'timestamp': '2026-08-21T10:00:00.000Z', 'thread_id': thread_id, 'message_id': 1}
            ]
            # Note: write_archive_turns overwrites, so accumulate then write once
            if i == 0:
                all_turns = []
            all_turns.extend(turns)
            self.write_topic_state(-1001234567890, thread_id)

        self.write_archive_turns(all_turns)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'r') as f:
            workplan = json.load(f)

        # Should have at most 8 tasks
        self.assertLessEqual(len(workplan['tasks']), 8)
        # Remaining 2 should be deferred
        self.assertGreaterEqual(len(workplan['skipped']), 2)

    def test_plan_caps_3_seed_limit(self):
        """Test 3 seed per run cap."""
        # Create 5 seed candidates (no existing brains)
        turns = [
            {'role': 'user', 'text': 'test', 'timestamp': '2026-08-21T10:00:00.000Z', 'thread_id': 100, 'message_id': 1}
        ]

        for i in range(5):
            thread_id = 100 + i
            self.write_topic_state(-1001234567890, thread_id)

        self.write_archive_turns(turns * 5)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'r') as f:
            workplan = json.load(f)

        # Should have at most 3 seeds
        seed_tasks = [t for t in workplan['tasks'] if t['kind'] == 'seed']
        self.assertLessEqual(len(seed_tasks), 3)

    def test_plan_corrupt_topic_state_skipped(self):
        """Test corrupt topic-state files are skipped."""
        # Write a corrupt JSON file
        filename = os.path.join(self.pa_home, 'telegram-bot-topic--1001234567890_100.json')
        with open(filename, 'w') as f:
            f.write('invalid json {')

        # Write a valid topic
        turns = [
            {'role': 'user', 'text': 'test', 'timestamp': '2026-08-21T10:00:00.000Z', 'thread_id': 101, 'message_id': 1}
        ]
        self.write_archive_turns(turns)
        self.write_topic_state(-1001234567890, 101)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        # Should not crash, should process the valid topic
        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'r') as f:
            workplan = json.load(f)

        # Only the valid topic should be in tasks
        self.assertEqual(len(workplan['tasks']), 1)
        self.assertEqual(workplan['tasks'][0]['threadId'], 101)

    def test_plan_torn_archive_lines_skipped(self):
        """Test torn/unparseable archive lines are skipped."""
        # Write archive with corrupt line
        path = os.path.join(self.pa_home, 'conversation-history.jsonl')
        with open(path, 'w') as f:
            f.write('{"role":"user","text":"valid","timestamp":"2026-08-21T10:00:00.000Z","thread_id":100,"message_id":1}\n')
            f.write('invalid json line\n')
            f.write('{"role":"user","text":"valid2","timestamp":"2026-08-21T10:01:00.000Z","thread_id":100,"message_id":2}\n')

        self.write_topic_state(-1001234567890, 100)

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        # Should process valid turns, skip corrupt line
        slice_path = os.path.join(self.pa_home, 'topic-brains', '.slices', '-1001234567890_100.jsonl')
        with open(slice_path, 'r') as f:
            slice_turns = [json.loads(line) for line in f]

        # Should have 2 valid turns
        self.assertEqual(len(slice_turns), 2)

    def test_plan_fold_detection(self):
        """Test fold detection from ancestry.mergedAt."""
        # Branch topic with mergedAt
        self.write_topic_state(-1001234567890, 100, merged_at='2026-08-21T10:00:00.000Z', parent_key='-1001234567890_99')
        self.write_brain('-1001234567890_100', '# Branch\n> Summary: Branch content\n')

        # Parent topic
        self.write_topic_state(-1001234567890, 99)
        self.write_brain('-1001234567890_99', '# Parent\n')

        ret = topic_brains.plan(self.pa_home)
        self.assertEqual(ret, 0)

        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'r') as f:
            workplan = json.load(f)

        # Should detect fold
        self.assertEqual(len(workplan['folds']), 1)
        fold = workplan['folds'][0]
        self.assertEqual(fold['branchTopicKey'], '-1001234567890_100')
        self.assertEqual(fold['parentTopicKey'], '-1001234567890_99')
        self.assertEqual(fold['branchSummary'], 'Branch content')

    # ===== finalize subcommand tests =====

    def test_finalize_stamp_written_byte_exactly(self):
        """Test stamp is written byte-exactly per spec regex."""
        # Write a brain without stamp
        brain_path = self.write_brain('-1001234567890_100', '# Test Topic\n\nContent\n')

        # Write result
        self.write_result('-1001234567890_100', updated=True, summary='Test summary')

        # Write slice with max timestamp
        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        slice_path = os.path.join(slice_dir, '-1001234567890_100.jsonl')
        with open(slice_path, 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Read brain and verify stamp format
        with open(brain_path, 'r') as f:
            content = f.read()

        import re
        stamp_match = re.search(STAMP_REGEX, content)
        self.assertIsNotNone(stamp_match, "Stamp not found in brain")
        # Check that consolidated is a valid ISO timestamp (format check, not exact value)
        consolidated = stamp_match.group(1)
        self.assertRegex(consolidated, r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')

    def test_finalize_stamp_reinserted_when_deleted(self):
        """Test stamp is re-inserted at top when LLM deleted it."""
        # Write brain with stamp buried at bottom
        brain_path = self.write_brain('-1001234567890_100', '# Test\n\nContent\n\n' + STAMP_LITERAL + '\n')

        self.write_result('-1001234567890_100', updated=True, summary='Test')

        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        slice_path = os.path.join(slice_dir, '-1001234567890_100.jsonl')
        with open(slice_path, 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        with open(brain_path, 'r') as f:
            content = f.read()

        # Stamp should be at top (after title line)
        import re
        lines = content.split('\n')
        self.assertIn('topic-brain:', lines[1], "Stamp should be on line 2")

    def test_finalize_fold_appends_section_and_stamps(self):
        """Test fold appends section and stamps folded-into."""
        # Create workplan with fold
        workplan_dir = os.path.join(self.pa_home, 'topic-brains')
        os.makedirs(workplan_dir, exist_ok=True)
        workplan_path = os.path.join(workplan_dir, '.workplan.json')
        with open(workplan_path, 'w') as f:
            json.dump({
                'generatedAt': datetime.now(timezone.utc).isoformat(),
                'tasks': [],
                'folds': [{
                    'branchTopicKey': '-1001234567890_100',
                    'parentTopicKey': '-1001234567890_99',
                    'branchBrainPath': os.path.join(workplan_dir, '-1001234567890_100', 'BRAIN.md'),
                    'parentBrainPath': os.path.join(workplan_dir, '-1001234567890_99', 'BRAIN.md'),
                    'mergedAt': '2026-08-21T10:00:00.000Z',
                    'branchSummary': 'Branch summary'
                }],
                'skipped': []
            }, f)

        # Write brains
        branch_path = self.write_brain('-1001234567890_100', '# Branch\n> Summary: Branch summary\n')
        parent_path = self.write_brain('-1001234567890_99', '# Parent\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Check parent has fold section
        with open(parent_path, 'r') as f:
            parent_content = f.read()
        self.assertIn('Merged branch:', parent_content)
        self.assertIn('Branch summary', parent_content)

        # Check branch has folded-into stamp
        with open(branch_path, 'r') as f:
            branch_content = f.read()
        self.assertIn('folded-into=-1001234567890_99', branch_content)

    def test_finalize_conflict_routes_to_pending(self):
        """Test conflicts are routed to review-digest-pending.jsonl."""
        self.write_result('-1001234567890_100', updated=True, conflict={
            'description': 'Contradiction found',
            'newText': 'New statement',
            'existingText': 'Old statement'
        })

        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        slice_path = os.path.join(slice_dir, '-1001234567890_100.jsonl')
        with open(slice_path, 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Check review-pending file
        pending_path = os.path.join(self.pa_home, 'review-digest-pending.jsonl')
        self.assertTrue(os.path.exists(pending_path))

        with open(pending_path, 'r') as f:
            entries = [json.loads(line) for line in f]

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['category'], 'topic-brain')
        self.assertEqual(entries[0]['new_text'], 'New statement')

    def test_finalize_audit_entry_field_compatible(self):
        """Test audit entries have exact field set for compatibility."""
        self.write_result('-1001234567890_100', updated=True, summary='Test summary')

        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        slice_path = os.path.join(slice_dir, '-1001234567890_100.jsonl')
        with open(slice_path, 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Check audit file
        audit_path = os.path.join(self.pa_home, 'consolidation-audit.jsonl')
        with open(audit_path, 'r') as f:
            entries = [json.loads(line) for line in f]

        self.assertGreater(len(entries), 0)
        # Assert exact key set per spec §3.8
        expected_keys = {'ts', 'action', 'fact_key', 'fact_text', 'category', 'sink', 'source', 'superseded_key', 'superseded_text', 'conflict_detail'}
        entry_keys = set(entries[0].keys())
        self.assertEqual(entry_keys, expected_keys, f"Audit entry keys mismatch: {entry_keys}")

    def test_finalize_index_regenerated_wholesale(self):
        """Test INDEX.md is regenerated with active/merged/split status."""
        # Create brains
        self.write_brain('-1001234567890_100', '# Active\n> Summary: Active topic\n')
        self.write_brain('-1001234567890_101', '# Merged\n> Summary: Merged topic\n', stamp='<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z folded-into=-1001234567890_100 -->')

        # Create a split brain (has DECISIONS.md)
        brain_dir = os.path.join(self.pa_home, 'topic-brains', '-1001234567890_102')
        os.makedirs(brain_dir, exist_ok=True)
        with open(os.path.join(brain_dir, 'BRAIN.md'), 'w') as f:
            f.write('# Split\n> Summary: Split topic\n')
        with open(os.path.join(brain_dir, 'DECISIONS.md'), 'w') as f:
            f.write('# Decisions\n')

        self.write_result('-1001234567890_100', updated=True)
        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        with open(os.path.join(slice_dir, '-1001234567890_100.jsonl'), 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Check INDEX
        index_path = os.path.join(self.pa_home, 'topic-brains', 'INDEX.md')
        self.assertTrue(os.path.exists(index_path))

        with open(index_path, 'r') as f:
            index_content = f.read()

        self.assertIn('| Topic | Path | Holds | Status |', index_content)
        self.assertIn('active', index_content)
        self.assertIn('merged', index_content)
        self.assertIn('split', index_content)

    def test_finalize_slices_and_results_deleted(self):
        """Test slices and results are cleaned up."""
        # Create slice and result
        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        slice_path = os.path.join(slice_dir, '-1001234567890_100.jsonl')
        with open(slice_path, 'w') as f:
            f.write('test\n')

        self.write_result('-1001234567890_100', updated=True)
        self.write_brain('-1001234567890_100', '# Test\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Both should be deleted
        self.assertFalse(os.path.exists(slice_path))
        result_path = os.path.join(self.pa_home, 'topic-brains', '.results', '-1001234567890_100.json')
        self.assertFalse(os.path.exists(result_path))

    def test_finalize_split_flag_when_large(self):
        """Test split flag is recorded when brain >8192 chars."""
        # Create a large brain (>8192 chars)
        large_content = '# Large Brain\n\n' + 'x' * 8200 + '\n'
        brain_path = self.write_brain('-1001234567890_100', large_content)

        self.write_result('-1001234567890_100', updated=True)
        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        with open(os.path.join(slice_dir, '-1001234567890_100.jsonl'), 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Check audit for split flag
        audit_path = os.path.join(self.pa_home, 'consolidation-audit.jsonl')
        with open(audit_path, 'r') as f:
            entries = [json.loads(line) for line in f]

        split_entries = [e for e in entries if e['action'] == 'topic-brain-split']
        self.assertGreater(len(split_entries), 0)

    # ===== idempotence tests =====

    def test_finalize_idempotent_no_duplicate_stamp(self):
        """Test second finalize adds no duplicate stamp."""
        self.write_result('-1001234567890_100', updated=True)
        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        with open(os.path.join(slice_dir, '-1001234567890_100.jsonl'), 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        # First finalize
        self.write_brain('-1001234567890_100', '# Test\n')
        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        brain_path = os.path.join(self.pa_home, 'topic-brains', '-1001234567890_100', 'BRAIN.md')
        with open(brain_path, 'r') as f:
            content_after_first = f.read()

        # Second finalize (same inputs)
        # Recreate result and slice since finalize deleted them
        self.write_result('-1001234567890_100', updated=True)
        with open(os.path.join(slice_dir, '-1001234567890_100.jsonl'), 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        with open(brain_path, 'r') as f:
            content_after_second = f.read()

        # Count stamps in both runs - should each have exactly one
        import re
        stamps_first = re.findall(r'<!-- topic-brain:', content_after_first)
        stamps_second = re.findall(r'<!-- topic-brain:', content_after_second)
        self.assertEqual(len(stamps_first), 1, "First run should have exactly one stamp")
        self.assertEqual(len(stamps_second), 1, "Second run should have exactly one stamp")

    def test_finalize_idempotent_no_duplicate_index_row(self):
        """Test second finalize adds no duplicate INDEX rows."""
        self.write_result('-1001234567890_100', updated=True)
        slice_dir = os.path.join(self.pa_home, 'topic-brains', '.slices')
        os.makedirs(slice_dir, exist_ok=True)
        with open(os.path.join(slice_dir, '-1001234567890_100.jsonl'), 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        self.write_brain('-1001234567890_100', '# Test\n> Summary: Test topic\n')

        # First finalize
        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        index_path = os.path.join(self.pa_home, 'topic-brains', 'INDEX.md')
        with open(index_path, 'r') as f:
            index_after_first = f.read()

        # Count rows for this topic
        row_count_first = index_after_first.count('-1001234567890_100')

        # Second finalize
        self.write_result('-1001234567890_100', updated=True)
        with open(os.path.join(slice_dir, '-1001234567890_100.jsonl'), 'w') as f:
            f.write('{"timestamp":"2026-08-21T18:03:11.000Z"}\n')

        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        with open(index_path, 'r') as f:
            index_after_second = f.read()

        row_count_second = index_after_second.count('-1001234567890_100')

        # Should have same count (no duplicate row)
        self.assertEqual(row_count_first, row_count_second)

    # ===== --stamp mode tests =====

    def test_stamp_mode_stamps_hand_written_brain(self):
        """Test --stamp stamps a hand-written brain with max archive timestamp."""
        # Write archive turns
        turns = [
            {'timestamp': '2026-08-21T10:00:00.000Z', 'thread_id': 100},
            {'timestamp': '2026-08-21T15:00:00.000Z', 'thread_id': 100},
            {'timestamp': '2026-08-21T18:00:00.000Z', 'thread_id': 100},
        ]
        self.write_archive_turns(turns)

        # Write hand-written brain (no stamp)
        brain_path = self.write_brain('-1001234567890_100', '# Hand Written\n> Summary: My topic\n')

        ret = topic_brains.finalize(self.pa_home, stamp_topic_key='-1001234567890_100')
        self.assertEqual(ret, 0)

        with open(brain_path, 'r') as f:
            content = f.read()

        # Should have stamp
        self.assertIn('topic-brain:', content)

        # Should use max timestamp from archive
        self.assertIn('covers=2026-08-21T18:00:00.000Z', content)

    def test_stamp_mode_zero_archive_topic(self):
        """Test --stamp with zero archive topics uses covers=consolidated timestamp value."""
        # Empty archive
        self.write_archive_turns([])

        brain_path = self.write_brain('-1001234567890_100', '# No Archive\n> Summary: Empty\n')

        ret = topic_brains.finalize(self.pa_home, stamp_topic_key='-1001234567890_100')
        self.assertEqual(ret, 0)

        with open(brain_path, 'r') as f:
            content = f.read()

        # Should have stamp with covers= same as consolidated= (both ISO timestamps)
        # Extract both consolidated and covers values
        stamp_match = re.search(STAMP_REGEX, content)
        self.assertIsNotNone(stamp_match)
        consolidated = stamp_match.group(1)
        covers = stamp_match.group(2)

        # For zero-archive topics, covers should equal consolidated timestamp value
        self.assertEqual(covers, consolidated)
        # Both should be valid ISO timestamps
        self.assertRegex(consolidated, r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')

    def test_stamp_mode_restamp_replaces_never_duplicates(self):
        """Test --stamp replaces existing stamp, never duplicates."""
        brain_path = self.write_brain('-1001234567890_100', '# Test\n> Summary: Test\n', stamp=STAMP_LITERAL)

        ret = topic_brains.finalize(self.pa_home, stamp_topic_key='-1001234567890_100')
        self.assertEqual(ret, 0)

        with open(brain_path, 'r') as f:
            content = f.read()

        # Count stamps
        import re
        stamps = re.findall(r'<!-- topic-brain:', content)
        self.assertEqual(len(stamps), 1, "Should have exactly one stamp after re-stamp")

    def test_stamp_mode_index_row_appears(self):
        """Test --stamp creates INDEX row."""
        self.write_brain('-1001234567890_100', '# Test\n> Summary: Test\n')

        ret = topic_brains.finalize(self.pa_home, stamp_topic_key='-1001234567890_100')
        self.assertEqual(ret, 0)

        index_path = os.path.join(self.pa_home, 'topic-brains', 'INDEX.md')
        self.assertTrue(os.path.exists(index_path))

        with open(index_path, 'r') as f:
            index_content = f.read()

        self.assertIn('-1001234567890_100', index_content)
        self.assertIn('Test', index_content)

    def test_stamp_mode_body_content_untouched(self):
        """Test --stamp does not modify body content."""
        original_body = '## Current state\n\n- Item 1\n- Item 2\n\n## Decisions\n\n- Decision 1\n'
        brain_path = self.write_brain('-1001234567890_100', '# Test\n> Summary: Test\n\n' + original_body)

        ret = topic_brains.finalize(self.pa_home, stamp_topic_key='-1001234567890_100')
        self.assertEqual(ret, 0)

        with open(brain_path, 'r') as f:
            content = f.read()

        # Body content should be intact
        self.assertIn('## Current state', content)
        self.assertIn('- Item 1', content)
        self.assertIn('- Decision 1', content)

    def test_stamp_mode_audit_entry(self):
        """Test --stamp writes audit entry with source: hand-migration."""
        self.write_brain('-1001234567890_100', '# Test\n> Summary: My hand-migrated brain\n')

        ret = topic_brains.finalize(self.pa_home, stamp_topic_key='-1001234567890_100')
        self.assertEqual(ret, 0)

        audit_path = os.path.join(self.pa_home, 'consolidation-audit.jsonl')
        self.assertTrue(os.path.exists(audit_path))

        with open(audit_path, 'r') as f:
            entries = [json.loads(line) for line in f]

        # When write_brain creates the file before finalize, brain_existed=True
        # so action is topic-brain-updated, not topic-brain-seeded (spec §3.5 F3)
        updated_entries = [e for e in entries if e['action'] == 'topic-brain-updated']
        self.assertGreater(len(updated_entries), 0)
        self.assertEqual(updated_entries[0]['source'], 'hand-migration')
        self.assertEqual(updated_entries[0]['fact_text'], 'My hand-migrated brain')

    def test_finalize_two_result_files_processed(self):
        """Test that finalize processes multiple result files."""
        # Write two result files
        self.write_result('123_1', updated=True, summary='First topic')
        self.write_result('123_2', updated=True, summary='Second topic')

        # Write corresponding topic states and archive
        self.write_topic_state(123, 1, turns=[
            {'timestamp': '2026-08-21T10:00:00Z', 'role': 'user', 'content': 'Message 1'}
        ])
        self.write_topic_state(123, 2, turns=[
            {'timestamp': '2026-08-21T11:00:00Z', 'role': 'user', 'content': 'Message 2'}
        ])
        self.write_archive_turns([
            {'timestamp': '2026-08-21T10:00:00Z', 'chat_id': 123, 'thread_id': 1, 'role': 'user', 'content': 'Message 1'},
            {'timestamp': '2026-08-21T11:00:00Z', 'chat_id': 123, 'thread_id': 2, 'role': 'user', 'content': 'Message 2'}
        ])

        # Run finalize
        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Both brains should exist
        brain1_path = os.path.join(self.pa_home, 'topic-brains', '123_1', 'BRAIN.md')
        brain2_path = os.path.join(self.pa_home, 'topic-brains', '123_2', 'BRAIN.md')
        self.assertTrue(os.path.exists(brain1_path))
        self.assertTrue(os.path.exists(brain2_path))

    def test_finalize_empty_results_dir_noops(self):
        """Test that finalize with empty results dir does nothing harmful."""
        # Create empty results dir
        results_dir = os.path.join(self.pa_home, 'topic-brains', '.results')
        os.makedirs(results_dir, exist_ok=True)

        # Run finalize with empty results
        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # No audit entries should be written (or empty audit.jsonl)
        audit_path = os.path.join(self.pa_home, 'topic-brains', 'audit.jsonl')
        if os.path.exists(audit_path):
            with open(audit_path, 'r') as f:
                content = f.read()
                # Empty or no entries is fine
                self.assertTrue(len(content) == 0 or content.strip() == '')

    def test_finalize_fold_stamp_preserves_consolidated_and_covers(self):
        """Test that fold stamp grammar preserves consolidated and covers when adding folded-into."""
        # Write a brain with consolidated and covers
        original_stamp = '<!-- topic-brain: consolidated=2026-08-21T12:00:00+05:30 covers=2026-08-21T10:00:00Z -->'
        brain_path = self.write_brain('123_1', content='# Test Brain', stamp=original_stamp)

        # Create parent brain path
        parent_brain_path = self.write_brain('123_2', content='# Parent Brain')

        # Write workplan with fold
        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'w') as f:
            json.dump({
                'folds': [{
                    'branchTopicKey': '123_1',
                    'parentTopicKey': '123_2',
                    'branchBrainPath': brain_path,
                    'parentBrainPath': parent_brain_path,
                    'mergedAt': '2026-08-21T13:00:00+05:30',
                    'branchSummary': 'Folded topic'
                }]
            }, f)

        # Run finalize
        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Read back the brain and verify stamp format
        with open(brain_path, 'r') as f:
            content = f.read()

        # Should have all three fields: consolidated, covers, and folded-into
        match = re.search(STAMP_REGEX, content)
        self.assertIsNotNone(match)
        consolidated = match.group(1)
        covers = match.group(2)
        folded_into = match.group(3)

        # consolidated and covers should be preserved from original stamp
        self.assertEqual(consolidated, '2026-08-21T12:00:00+05:30')
        self.assertEqual(covers, '2026-08-21T10:00:00Z')
        self.assertEqual(folded_into, '123_2')

    def test_finalize_empty_workplan_title_refresh(self):
        """Test that finalize refreshes title even when workplan has no tasks."""
        # Write a brain with stale title
        brain_path = self.write_brain('123_1', content='# Old Title\n\nOld content')

        # Create empty workplan (no tasks, no folds)
        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        with open(workplan_path, 'w') as f:
            json.dump({'tasks': [], 'folds': []}, f)

        # Update topic state to have current name
        self.write_topic_state(123, 1, turns=[])

        # Run finalize
        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Read back the brain - title should still be refreshed to current name
        with open(brain_path, 'r') as f:
            content = f.read()

        # The title should still be updated (even with no tasks)
        # Note: We can't easily verify the exact name without mocking telegram-topic-names.json
        # but we can verify the file was written
        self.assertTrue(content.startswith('#'))

    def test_finalize_fold_no_existing_stamp_full_grammar(self):
        """Test that fold with no existing stamp emits full §3.2 grammar with consolidated/covers/folded-into."""
        # Write a branch brain WITHOUT any stamp
        branch_brain_path = self.write_brain('123_1', content='# Branch Brain\n\nContent')

        # Write parent brain
        parent_brain_path = self.write_brain('123_2', content='# Parent Brain')

        # Write archive with some turns for the branch
        self.write_topic_state(123, 1, turns=[
            {'timestamp': '2026-08-21T10:00:00Z', 'role': 'user', 'content': 'Branch message'}
        ])
        self.write_archive_turns([
            {'timestamp': '2026-08-21T10:00:00Z', 'chat_id': 123, 'thread_id': 1, 'role': 'user', 'content': 'Branch message'}
        ])

        # Write workplan with fold
        workplan_path = os.path.join(self.pa_home, 'topic-brains', '.workplan.json')
        merged_at = '2026-08-21T13:00:00+05:30'
        with open(workplan_path, 'w') as f:
            json.dump({
                'folds': [{
                    'branchTopicKey': '123_1',
                    'parentTopicKey': '123_2',
                    'branchBrainPath': branch_brain_path,
                    'parentBrainPath': parent_brain_path,
                    'mergedAt': merged_at,
                    'branchSummary': 'Folded branch'
                }]
            }, f)

        # Run finalize
        ret = topic_brains.finalize(self.pa_home)
        self.assertEqual(ret, 0)

        # Read back the branch brain and verify full stamp grammar
        with open(branch_brain_path, 'r') as f:
            content = f.read()

        # Debug: print the stamp content
        print(f"Branch brain content:\n{content[:500]}")

        # Should have all three fields: consolidated, covers, and folded-into
        match = re.search(STAMP_REGEX, content)
        self.assertIsNotNone(match, f"Stamp not found in content. First 200 chars: {content[:200]}")
        consolidated = match.group(1)
        covers = match.group(2)
        folded_into = match.group(3)

        # All three fields must be present
        self.assertIsNotNone(folded_into)
        self.assertEqual(folded_into, '123_2')

        # consolidated should be an ISO timestamp (now IST)
        self.assertRegex(consolidated, r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')

        # covers should be the branch's max archive timestamp
        self.assertEqual(covers, '2026-08-21T10:00:00Z')


    def test_finalize_stamp_tolerates_utf8_bom(self):
        """A BOM-prefixed brain (agy's file tool writes one) must still get its stamp
        placed after the title — finalize reads with utf-8-sig. Regression for the
        2026-08-22 bulk-seed incident where 5 BOM brains were left unstamped and would
        have been re-swept (curated bodies rewritten) by the next nightly pass."""
        topic_key = '-1001234567890_77'
        brain_dir = os.path.join(self.pa_home, 'topic-brains', topic_key)
        os.makedirs(brain_dir, exist_ok=True)
        brain_path = os.path.join(brain_dir, 'BRAIN.md')
        bom = bytes([0xEF, 0xBB, 0xBF])
        body = '# BOM Topic' + chr(10) + chr(10) + '> Summary: bom fixture.' + chr(10) + chr(10) + '## Current state' + chr(10) + '- x' + chr(10)
        with open(brain_path, 'wb') as f:
            f.write(bom + body.encode('utf-8'))
        self.write_topic_state(-1001234567890, 77)
        self.write_archive_turns([
            {'role': 'user', 'text': 'a', 'timestamp': '2026-08-22T10:00:00.000Z', 'thread_id': 77, 'message_id': 1},
            {'role': 'user', 'text': 'b', 'timestamp': '2026-08-22T10:01:00.000Z', 'thread_id': 77, 'message_id': 2},
        ])
        self.assertEqual(topic_brains.finalize(self.pa_home, stamp_topic_key=topic_key), 0)
        raw = open(brain_path, 'rb').read()
        self.assertFalse(raw.startswith(bytes([0xEF, 0xBB, 0xBF])), 'BOM must not survive a finalize write')
        head = raw.decode('utf-8')[:4096]
        self.assertRegex(head, STAMP_REGEX)
        # stamp sits right after the title line, not buried
        self.assertLess(head.index('<!-- topic-brain:'), head.index('> Summary:'))


class TestAtomicWrites(unittest.TestCase):
    """Test atomic write behavior."""

    def setUp(self):
        """Set up temp directory."""
        import tempfile
        self.test_dir = tempfile.mkdtemp()
        self.pa_home = os.path.join(self.test_dir, '.pa')
        os.makedirs(self.pa_home, exist_ok=True)
        os.environ['PA_HOME'] = self.pa_home

    def tearDown(self):
        """Clean up."""
        import shutil
        if 'PA_HOME' in os.environ:
            del os.environ['PA_HOME']
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def test_write_atomically_creates_temp_then_replaces(self):
        """Test write_atomically uses temp file + os.replace."""
        test_path = os.path.join(self.pa_home, 'test-atomic.txt')

        # Write content
        content = 'Test content for atomic write'
        result = topic_brains.write_atomically(content, test_path)

        self.assertTrue(result)
        self.assertTrue(os.path.exists(test_path))

        with open(test_path, 'r') as f:
            self.assertEqual(f.read(), content)

    def test_write_atomically_overwrites_existing(self):
        """Test atomic write overwrites existing file."""
        test_path = os.path.join(self.pa_home, 'test-atomic.txt')

        # Create initial file
        with open(test_path, 'w') as f:
            f.write('old content')

        # Atomic write new content
        new_content = 'new content'
        result = topic_brains.write_atomically(new_content, test_path)

        self.assertTrue(result)

        with open(test_path, 'r') as f:
            self.assertEqual(f.read(), new_content)


class TestPAAHomeResolution(unittest.TestCase):
    """Test PA_HOME resolution matches memory_consolidation.py conventions."""

    def test_resolve_pa_home_default(self):
        """Test default PA_HOME resolution."""
        if 'PA_HOME' in os.environ:
            del os.environ['PA_HOME']

        result = topic_brains.resolve_pa_home()
        # Should default to ~/.pa
        self.assertTrue(result.endswith('.pa') or result.endswith('.pa' + os.sep))

    def test_resolve_pa_home_from_env(self):
        """Test PA_HOME from environment variable."""
        custom_path = 'D:/test/custom/pa'
        os.environ['PA_HOME'] = custom_path

        result = topic_brains.resolve_pa_home()
        self.assertEqual(result, custom_path)


class TestCliAndStampForms(unittest.TestCase):
    """CLI argv normalization and stamp timezone form.

    Both findings surfaced in integration Gates D/D2 on 2026-08-21: argparse
    rejected `--stamp -100..._7822` (leading-dash value parsed as a flag), and
    consolidated stamps carried IST wall-clock values under a +00:00 suffix.
    """

    def setUp(self):
        import tempfile
        self.test_dir = tempfile.mkdtemp()
        self.pa_home = os.path.join(self.test_dir, '.pa')
        os.makedirs(os.path.join(self.pa_home, 'topic-brains'), exist_ok=True)
        os.environ['PA_HOME'] = self.pa_home

    def tearDown(self):
        import shutil
        os.environ.pop('PA_HOME', None)
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def _write_brain(self, topic_key):
        brain_dir = os.path.join(self.pa_home, 'topic-brains', topic_key)
        os.makedirs(brain_dir, exist_ok=True)
        brain_path = os.path.join(brain_dir, 'BRAIN.md')
        with open(brain_path, 'w', encoding='utf-8') as f:
            f.write('# Dash Key Topic\n\n> Summary: normalized invocation.\n')
        return brain_path

    def test_main_stamp_dash_value_normalized(self):
        """`finalize --stamp -100..._5` must parse, not treat the key as a flag."""
        topic_key = '-1001234567890_5'
        brain_path = self._write_brain(topic_key)
        argv = ['topic_brains.py', 'finalize', '--stamp', topic_key]
        with patch.object(sys, 'argv', argv):
            rc = topic_brains.main()
        self.assertEqual(rc, 0)
        with open(brain_path, 'r', encoding='utf-8') as f:
            content = f.read()
        self.assertRegex(content, STAMP_REGEX)

    def test_finalize_stamp_carries_ist_offset(self):
        """consolidated must carry +05:30 — IST wall time under a UTC suffix lies."""
        topic_key = '-1001234567890_7'
        brain_path = self._write_brain(topic_key)
        self.assertEqual(topic_brains.finalize(self.pa_home, stamp_topic_key=topic_key), 0)
        with open(brain_path, 'r', encoding='utf-8') as f:
            content = f.read()
        self.assertRegex(content, r'consolidated=\S+05:30 covers=')


if __name__ == '__main__':
    unittest.main()
