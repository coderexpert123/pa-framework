#!/usr/bin/env python3
"""Tests for topic_consolidation.py (nightly topic merge, 2026-09-14).

Pure-function tests for census/overlap/candidate selection plus end-to-end
merge tests over real files in a temp PA_HOME. Fixture timestamps are always
computed relative to now (absolute dates go stale and silently flip window
edges).

Fixture convention: topics 5/6/7 carry high activity so the candidates under
test sit OUTSIDE the top-3-by-activity guard — otherwise the guard's
slots are occupied by the pair being tested and the guard, not the rule
under test, decides the outcome.
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import topic_consolidation as tc  # noqa: E402


def now_utc() -> datetime:
    return NOW


def iso(dt: datetime) -> str:
    return dt.isoformat().replace('+00:00', 'Z')


def within(hours_ago: float = 1.0) -> str:
    return iso(now_utc() - timedelta(hours=hours_ago))


NOW = datetime(2026, 9, 14, 18, 30, 0, tzinfo=timezone.utc)


class _FrozenDateTime(datetime):
    """run() reads datetime.now(timezone.utc); freezing the module attribute
    makes window-relative fixtures deterministic no matter the wall clock."""

    @classmethod
    def now(cls, tz=None):  # noqa: N805 — classmethod on a datetime subclass
        return NOW.astimezone(tz) if tz is not None else NOW


class TopicConsolidationTestBase(unittest.TestCase):
    """Shared PA_HOME-scoped fixture helpers."""

    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix='tc-test-')
        self.pa_home = os.path.join(self.test_dir, 'pa')
        os.makedirs(self.pa_home, exist_ok=True)
        self.paths = tc.resolve_paths(self.pa_home)
        self.prev_pa_home = os.environ.get('PA_HOME')
        os.environ['PA_HOME'] = self.pa_home
        self.prev_datetime = tc.datetime
        tc.datetime = _FrozenDateTime

    def tearDown(self):
        tc.datetime = self.prev_datetime
        if self.prev_pa_home is not None:
            os.environ['PA_HOME'] = self.prev_pa_home
        else:
            del os.environ['PA_HOME']

    # ── fixture builders ──────────────────────────────────────────────────────

    def write_registry(self, topics: dict):
        path = self.paths['topic_names']
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(topics))

    def write_archive(self, turns):
        with open(self.paths['conversation_history'], 'w', encoding='utf-8') as f:
            for t in turns:
                f.write(json.dumps(t) + '\n')

    def write_brain(self, topic_key: str, content: str):
        brain_dir = os.path.join(self.paths['topic_brains_dir'], topic_key)
        os.makedirs(brain_dir, exist_ok=True)
        with open(os.path.join(brain_dir, 'BRAIN.md'), 'w', encoding='utf-8') as f:
            f.write(content)

    def read_brain(self, topic_key: str) -> str:
        with open(os.path.join(self.paths['topic_brains_dir'], topic_key, 'BRAIN.md'),
                  encoding='utf-8') as f:
            return f.read()

    def write_exempt(self, rows: dict):
        os.makedirs(os.path.dirname(self.paths['exempt_registry']), exist_ok=True)
        with open(self.paths['exempt_registry'], 'w', encoding='utf-8') as f:
            json.dump(rows, f)

    def write_thread_store(self, topic_key: str, records: dict):
        os.makedirs(self.paths['topic_threads_dir'], exist_ok=True)
        with open(os.path.join(self.paths['topic_threads_dir'], f'{topic_key}.json'),
                  'w', encoding='utf-8') as f:
            json.dump(records, f)

    def write_task_store(self, topic_key: str, tasks, running=None, suffix='.json'):
        os.makedirs(self.paths['topic_tasks_dir'], exist_ok=True)
        with open(os.path.join(self.paths['topic_tasks_dir'], f'{topic_key}{suffix}'),
                  'w', encoding='utf-8') as f:
            json.dump(running if suffix == '.running.json' else tasks, f)


REGISTRY = {
    '-100111': {
        '1': {'name': 'whatsapp-drafts', 'description': 'drafts'},
        '2': {'name': 'whatsapp-integration', 'description': 'integration',
              'guide_message_id': 42},
        '3': {'name': 'claude-support'},
        '4': {'name': 'zclaude-support'},
        '0': {'name': 'general-knowledge'},
        '5': {'name': 'health'},
        '6': {'name': 'travel'},
        '7': {'name': 'equipment'},
    },
}

# Single-chat registry for tests where the pair under test needs to merge.
# The two-chat variant lives only in the collision test — a duplicate thread
# id anywhere in the registry blocks that thread EVERYWHERE, by design.

# Guard filler: 5/6/7 are the day's busy topics so 1-4 sit outside top-3.
GUARD_FILLER_CENSUS = {5: 12, 6: 11, 7: 10}


class CensusTests(TopicConsolidationTestBase):
    def test_counts_window_per_thread(self):
        self.write_archive([
            {'thread_id': 1, 'timestamp': within(1)},
            {'thread_id': 1, 'timestamp': within(2)},
            {'thread_id': 2, 'timestamp': within(3)},
        ])
        counts = tc.census_turns(self.paths['conversation_history'], now_utc(), 24)
        self.assertEqual(counts, {1: 2, 2: 1})

    def test_window_edges_and_hygiene(self):
        self.write_archive([
            {'thread_id': 5, 'timestamp': within(24)},           # boundary: exactly at cutoff counts
            {'thread_id': 1, 'timestamp': within(25)},           # too old
            {'thread_id': 2, 'timestamp': iso(now_utc() + timedelta(hours=1))},  # future
            {'thread_id': 3, 'timestamp': '1970-01-01T00:00:00.000Z'},  # epoch sentinel
            {'thread_id': 3, 'timestamp': 'not-a-date'},         # unparseable
            {'thread_id': 0, 'timestamp': within(1)},            # thread 0 never counted
            {'timestamp': within(1)},                            # no thread_id
            {'thread_id': True, 'timestamp': within(1)},         # bool thread_id
            {'thread_id': 4, 'timestamp': within(0.5)},          # valid
            'not json at all',
        ])
        counts = tc.census_turns(self.paths['conversation_history'], now_utc(), 24)
        self.assertEqual(counts, {5: 1, 4: 1})

    def test_missing_archive_is_empty(self):
        self.assertEqual(tc.census_turns(
            os.path.join(self.pa_home, 'absent.jsonl'), now_utc(), 24), {})


class OverlapTests(TopicConsolidationTestBase):
    def test_tokenize_drops_stopwords_keeps_digits(self):
        # 'claude' is meaningful signal; only the generic 'support' drops.
        self.assertEqual(tc.tokenize('Claude-Support!'), {'claude'})
        self.assertEqual(tc.tokenize('whatsapp-2'), {'2', 'whatsapp'})

    def test_containment_edges(self):
        self.assertEqual(tc.title_overlap('whatsapp-drafts', 'whatsapp'), 1.0)
        self.assertEqual(tc.title_overlap('health', 'travel'), 0.0)
        # Shared stopword only — the per-worker support topics must NOT overlap.
        self.assertEqual(tc.title_overlap('claude-support', 'zclaude-support'), 0.0)
        self.assertAlmostEqual(tc.title_overlap('whatsapp-drafts', 'whatsapp-integration'), 0.5)
        self.assertEqual(tc.title_overlap('support', 'misc'), 0.0)  # empty token sets

    def test_containment_uses_smaller_name(self):
        # 1 of the small name's 2 tokens covered = 0.5 even though the large
        # name has many more tokens.
        self.assertAlmostEqual(
            tc.title_overlap('farm-plans', 'farm-aira-p2 long name here'), 0.5)


class PlanTests(TopicConsolidationTestBase):
    def plan(self, census=None, exempt=None, registry=REGISTRY):
        return tc.plan_merges(registry, census or {}, exempt or {}, self.paths)

    def source_reasons(self, skipped):
        return {s['topic']: s['reason'] for s in skipped}

    def test_default_rules_are_frozen_values(self):
        self.assertEqual(tc.MIN_TURNS, 3)
        self.assertEqual(tc.OVERLAP_THRESHOLD, 0.5)
        self.assertEqual(tc.TOP_ACTIVITY_GUARD, 3)
        self.assertEqual(tc.WINDOW_HOURS, 24)

    def test_activity_floor_edge(self):
        # Exactly K turns (topic 3, 3 turns, outside top-3 guard) → skipped at
        # the floor; K-1 turns (topic 1) → candidate.
        census = {**GUARD_FILLER_CENSUS, 1: 2, 2: 9, 3: 3}
        merges, skipped = self.plan(census=census)
        reasons = self.source_reasons(skipped)
        self.assertIn('activity-floor', reasons['-100111_3'])
        by_source = {m['source']: m for m in merges}
        self.assertIn('-100111_1', by_source)
        self.assertEqual(by_source['-100111_1']['target'], '-100111_2')

    def test_top_activity_guard_protects_busy_topics(self):
        # Ranks: 5(12), 2(4), 3(2), then the 1-turn tail. Topic 3 is sub-floor
        # BUT rank-3 → the guard protects it as part of the day's pattern;
        # topic 1 (rank-4, 1 turn) sits outside the guard and merges normally.
        census = {5: 12, 2: 4, 3: 2, 7: 1, 1: 1}
        merges, skipped = self.plan(census=census)
        reasons = self.source_reasons(skipped)
        self.assertIn('top-3-by-activity', reasons['-100111_3'])
        self.assertEqual([m['source'] for m in merges], ['-100111_1'])

    def test_guard_uses_only_topics_with_activity(self):
        # Only topics 1 and 2 have turns; 0-turn topics never occupy guard
        # slots, but 1 and 2 themselves ARE the day's activity → protected.
        census = {1: 2, 2: 9}
        merges, skipped = self.plan(census=census)
        self.assertEqual(merges, [])
        self.assertIn('top-3-by-activity', self.source_reasons(skipped)['-100111_1'])

    def test_overlap_threshold_edge(self):
        # whatsapp-drafts vs whatsapp-integration = exactly 0.5 → merges.
        # claude-support vs zclaude-support = 0.0 → never merges even though
        # both are quiet.
        census = {**GUARD_FILLER_CENSUS, 1: 1, 2: 9, 3: 1, 4: 8}
        merges, skipped = self.plan(census=census)
        by_source = {m['source']: m for m in merges}
        self.assertIn('-100111_1', by_source)
        self.assertNotIn('-100111_3', by_source)
        self.assertIn('no-overlapping-larger-topic',
                      self.source_reasons(skipped)['-100111_3'])

    def test_target_must_be_strictly_larger_and_at_floor(self):
        # The only overlapping target (topic 2) has 2 turns — below the floor
        # and not strictly larger than the source → nothing merges.
        census = {**GUARD_FILLER_CENSUS, 1: 2, 2: 2}
        merges, skipped = self.plan(census=census)
        self.assertEqual(merges, [])
        self.assertIn('no-overlapping-larger-topic',
                      self.source_reasons(skipped)['-100111_1'])

    def test_general_topic_never_merged(self):
        merges, skipped = self.plan(census=dict(GUARD_FILLER_CENSUS))
        self.assertIn('general-topic', self.source_reasons(skipped)['-100111_0'])
        self.assertEqual(merges, [])

    def test_exempt_rows_never_merged(self):
        self.write_exempt({'-100111_1': 'one-off'})
        census = {**GUARD_FILLER_CENSUS, 1: 1, 2: 9}
        merges, skipped = self.plan(
            census=census,
            exempt=tc.load_exempt_registry(self.paths['exempt_registry']))
        self.assertEqual(merges, [])
        self.assertIn('operator-flagged', self.source_reasons(skipped)['-100111_1'])

    def test_exempt_target_not_eligible(self):
        # 2 overlaps 1 and is larger, but is operator-flagged → no merge.
        self.write_exempt({'-100111_2': 'pinned-guide'})
        census = {**GUARD_FILLER_CENSUS, 1: 1, 2: 9}
        merges, _ = self.plan(
            census=census,
            exempt=tc.load_exempt_registry(self.paths['exempt_registry']))
        self.assertEqual(merges, [])

    def test_thread_collision_blocks_both(self):
        registry = {
            '-100111': {'1': {'name': 'whatsapp-drafts'},
                        '2': {'name': 'whatsapp-integration'},
                        '5': {'name': 'health'}},
            '-100222': {'2': {'name': 'other-chat-topic'},
                        '5': {'name': 'other-filler'}},
        }
        census = {5: 12, 2: 9, 1: 1}
        merges, skipped = self.plan(registry=registry, census=census)
        reasons = self.source_reasons(skipped)
        self.assertIn('thread-id-collision', reasons['-100111_2'])
        self.assertIn('thread-id-collision', reasons['-100222_2'])
        # The colliding thread is also excluded as a merge TARGET.
        self.assertEqual(merges, [])

    def assert_blocked_by_active_records(self, setup_store):
        setup_store()
        census = {**GUARD_FILLER_CENSUS, 1: 1, 2: 9}
        merges, skipped = self.plan(census=census)
        self.assertEqual(merges, [])
        self.assertIn('active-records', self.source_reasons(skipped)['-100111_1'])

    def test_running_orchestrator_thread_blocks(self):
        self.assert_blocked_by_active_records(lambda: self.write_thread_store(
            '-100111_1', {'t-5': {'id': 't-5', 'status': 'running'}}))

    def test_queued_orchestrator_thread_blocks(self):
        self.assert_blocked_by_active_records(lambda: self.write_thread_store(
            '-100111_1', {'t-5': {'id': 't-5', 'status': 'queued'}}))

    def test_inflight_topic_task_blocks(self):
        self.assert_blocked_by_active_records(lambda: self.write_task_store(
            '-100111_1', [], running=[{'id': 'tt-1'}], suffix='.running.json'))

    def test_open_topic_task_blocks(self):
        self.assert_blocked_by_active_records(lambda: self.write_task_store(
            '-100111_1', [{'id': 'tt-2'}]))

    def test_operator_notes_are_not_live_records(self):
        # .notes.json is durable operator state, not live work — presence
        # alone must not block a merge (the merge never touches notes).
        self.write_task_store('-100111_1', None, suffix='.notes.json')
        census = {**GUARD_FILLER_CENSUS, 1: 1, 2: 9}
        merges, _ = self.plan(census=census)
        self.assertEqual([m['source'] for m in merges], ['-100111_1'])

    def test_terminal_threads_do_not_block(self):
        self.write_thread_store('-100111_1', {
            't-5': {'id': 't-5', 'status': 'done'},
            't-6': {'id': 't-6', 'status': 'cancelled'}})
        census = {**GUARD_FILLER_CENSUS, 1: 1, 2: 9}
        merges, _ = self.plan(census=census)
        self.assertEqual([m['source'] for m in merges], ['-100111_1'])

    def test_target_pick_highest_overlap_then_turns(self):
        registry = {'-100111': {
            '1': {'name': 'farm-visits'},
            '2': {'name': 'farm-plans'},        # overlap 0.5, 9 turns
            '3': {'name': 'farm-visits-log'},   # overlap 1.0, 4 turns
            '9': {'name': 'unrelated-stuff'},   # guard filler, no overlap
        }}
        census = {9: 12, 2: 9, 3: 4, 1: 1}
        merges, _ = self.plan(registry=registry, census=census)
        self.assertEqual(merges[0]['target'], '-100111_3')  # overlap outranks turns

        registry['-100111']['4'] = {'name': 'farm-visits-archive'}  # 1.0 too, more turns
        census[4] = 12
        merges, _ = self.plan(registry=registry, census=census)
        self.assertEqual(merges[0]['target'], '-100111_4')  # tie broken by turns


class MergeTests(TopicConsolidationTestBase):
    def build_fixture(self, source_stamp=None):
        self.write_registry(REGISTRY)
        source_brain = (source_stamp or '') + \
            '# whatsapp-drafts\n\n> Summary: Drafting WhatsApp replies.\n\n- Note one\n- Note two\n'
        self.write_brain('-100111_1', source_brain)
        self.write_brain('-100111_2', '# whatsapp-integration\n\n> Summary: Integration state.\n')
        turns = [{'thread_id': 1, 'timestamp': within(2), 'role': 'user', 'message_id': 1}]
        # Thread 2 is an established home (>= K turns, strictly larger).
        turns += [{'thread_id': 2, 'timestamp': within(1 + i / 24.0), 'message_id': 100 + i}
                  for i in range(4)]
        # Guard filler: 3 turns each so 5/6 rank above topic 1's single turn
        # (rank ties fall to thread id, and id 1 sorts first).
        turns += [{'thread_id': tid, 'timestamp': within(1), 'message_id': 200 + tid + i}
                  for tid in (5, 6, 7) for i in range(3)]
        self.write_archive(turns)

    def load_registry(self):
        with open(self.paths['topic_names'], encoding='utf-8') as f:
            return json.load(f)

    def test_merge_end_to_end(self):
        self.build_fixture()
        rc = tc.run(pa_home=self.pa_home)
        self.assertEqual(rc, 0)

        target = self.read_brain('-100111_2')
        self.assertIn('## Absorbed from whatsapp-drafts (', target)
        self.assertIn('> Summary: Drafting WhatsApp replies.', target)
        self.assertIn('- Note two', target)
        # Absorbed stamp lines must not ride along.
        self.assertNotIn('topic-brain:', target)

        source = self.read_brain('-100111_1')
        self.assertIn('folded-into=-100111_2', source)

        registry = self.load_registry()
        self.assertNotIn('1', registry['-100111'])
        # Sibling entries and their non-name fields survive verbatim.
        self.assertEqual(registry['-100111']['2'],
                         {'name': 'whatsapp-integration',
                          'description': 'integration', 'guide_message_id': 42})

        with open(self.paths['consolidation_audit'], encoding='utf-8') as f:
            rows = [json.loads(line) for line in f if line.strip()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['action'], 'topic-merged')
        self.assertEqual(rows[0]['fact_key'], '-100111_1')
        self.assertEqual(rows[0]['superseded_key'], '-100111_2')

    def test_merge_with_existing_stamp_preserves_values(self):
        self.build_fixture(
            source_stamp='<!-- topic-brain: consolidated=2026-09-01T10:00:00+05:30 '
                         'covers=2026-09-10T00:00:00.000Z -->\n')
        rc = tc.run(pa_home=self.pa_home)
        self.assertEqual(rc, 0)
        source = self.read_brain('-100111_1')
        self.assertIn('consolidated=2026-09-01T10:00:00+05:30', source)
        self.assertIn('covers=2026-09-10T00:00:00.000Z', source)
        self.assertIn('folded-into=-100111_2', source)

    def test_merge_without_source_brain(self):
        self.build_fixture()
        # Remove the source brain: merge still proceeds (pointer section +
        # registry removal).
        os.remove(os.path.join(self.paths['topic_brains_dir'], '-100111_1', 'BRAIN.md'))
        rc = tc.run(pa_home=self.pa_home)
        self.assertEqual(rc, 0)
        target = self.read_brain('-100111_2')
        self.assertIn('No topic brain existed for the absorbed topic.', target)
        self.assertNotIn('1', self.load_registry()['-100111'])

    def test_registry_failure_leaves_topic_registered(self):
        self.build_fixture()
        saved = tc.save_registry

        def boom(path, data):
            raise OSError('disk full')

        tc.save_registry = boom
        try:
            rc = tc.run(pa_home=self.pa_home)
        finally:
            tc.save_registry = saved
        self.assertEqual(rc, 1)
        # Fail-closed: the topic is STILL registered.
        self.assertIn('1', self.load_registry()['-100111'])

    def test_missing_registry_aborts(self):
        rc = tc.run(pa_home=self.pa_home)
        self.assertEqual(rc, 1)

    def test_dry_run_writes_nothing(self):
        self.build_fixture()
        rc = tc.run(pa_home=self.pa_home, dry_run=True)
        self.assertEqual(rc, 0)
        registry = self.load_registry()
        self.assertIn('1', registry['-100111'])
        self.assertNotIn('Absorbed from', self.read_brain('-100111_2'))
        self.assertFalse(os.path.exists(self.paths['consolidation_audit']))

    def test_activity_floor_holds_end_to_end(self):
        self.build_fixture()
        # Give the candidate 3 turns: at the floor, nothing may merge.
        turns = [{'thread_id': 1, 'timestamp': within(1 + i / 24.0), 'message_id': 300 + i}
                 for i in range(3)]
        turns += [{'thread_id': 2, 'timestamp': within(1), 'message_id': 400}]
        self.write_archive(turns)
        rc = tc.run(pa_home=self.pa_home)
        self.assertEqual(rc, 0)
        self.assertIn('1', self.load_registry()['-100111'])

    def test_result_line_carries_merge_report(self):
        self.build_fixture()
        import io
        from unittest.mock import patch
        buf = io.StringIO()
        with patch('sys.stdout', buf):
            tc.run(pa_home=self.pa_home)
        lines = buf.getvalue().splitlines()
        result_lines = [l for l in lines if l.startswith('TOPIC_CONSOLIDATION_RESULT: ')]
        self.assertEqual(len(result_lines), 1)
        summary = json.loads(result_lines[0].split(': ', 1)[1])
        self.assertEqual(len(summary['merged']), 1)
        self.assertEqual(summary['merged'][0]['source'], '-100111_1')
        self.assertEqual(summary['merged'][0]['source_turns'], 1)
        self.assertEqual(summary['merged'][0]['target_name'], 'whatsapp-integration')


if __name__ == '__main__':
    unittest.main()
