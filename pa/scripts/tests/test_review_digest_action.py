#!/usr/bin/env python3
"""
Tests for review_digest_action.py — the single writer for a conflict resolution
driven from a Telegram button (D10, buttons program, AI-158).

Covers:
- accept sets resolved/resolution/resolved_at, and only on the matching entry
- unparseable lines survive the rewrite byte-for-byte
- unknown id exits 2 and leaves the file unchanged
- an already-resolved entry exits 3
- a missing file exits 4
- the written file has LF-only line endings (checked in 'rb' mode)
- all three action words (accept/reject/ignore) map to the right resolution value
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Add pa/scripts to path for import (matches test_migrate_profile_metadata.py convention)
SCRIPT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from review_digest_action import apply_action, default_pending_path  # noqa: E402


def _write_jsonl_lf(path, entries_or_raw_lines):
    """Write a JSONL fixture with strictly LF line endings.

    Each item may be a dict (serialized via json.dumps) or a raw string (written
    verbatim, e.g. to simulate a blank or unparseable line).
    """
    lines = []
    for item in entries_or_raw_lines:
        if isinstance(item, str):
            lines.append(item)
        else:
            lines.append(json.dumps(item))
    content = '\n'.join(lines) + '\n'
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)


def _make_entry(conflict_id, resolved=False, resolution=None):
    return {
        'id': conflict_id,
        'created_at': '2026-08-20T12:00:00+00:00',
        'resolved': resolved,
        'resolved_at': None,
        'resolution': resolution,
        'key': 'some.fact.key',
        'new_text': 'The new fact text.',
        'existing_text': 'The old fact text.',
        'existing_valid_from': '2026-08-01',
        'category': 'preferences',
        'source': 'conversation',
        'source_ref': 'ref-abc123',
    }


class ReviewDigestActionTestCase(unittest.TestCase):
    """Base class with a temp pending-file per test."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix='test_review_digest_action_')
        self.pending_path = os.path.join(self.temp_dir, 'review-digest-pending.jsonl')

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def read_raw_bytes(self):
        with open(self.pending_path, 'rb') as f:
            return f.read()

    def read_entries(self):
        entries = []
        with open(self.pending_path, 'r', encoding='utf-8') as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    entries.append(json.loads(stripped))
                except json.JSONDecodeError:
                    entries.append(None)  # marker for an unparseable line
        return entries


class TestAcceptResolvesMatchingEntryOnly(ReviewDigestActionTestCase):
    def test_accept_sets_three_fields_on_matching_entry_only(self):
        other = _make_entry('cf-20260820120000-000')
        target = _make_entry('cf-20260820120000-001')
        _write_jsonl_lf(self.pending_path, [other, target])

        code = apply_action(self.pending_path, 'cf-20260820120000-001', 'accept')
        self.assertEqual(code, 0)

        entries = self.read_entries()
        self.assertEqual(len(entries), 2)

        # Untouched entry stays exactly as written.
        self.assertEqual(entries[0]['resolved'], False)
        self.assertIsNone(entries[0]['resolution'])
        self.assertIsNone(entries[0]['resolved_at'])

        # Matching entry gets all three fields, everything else untouched.
        self.assertEqual(entries[1]['resolved'], True)
        self.assertEqual(entries[1]['resolution'], 'accepted')
        self.assertIsNotNone(entries[1]['resolved_at'])
        # ISO-8601 UTC timestamp — should parse.
        from datetime import datetime
        datetime.fromisoformat(entries[1]['resolved_at'])
        self.assertEqual(entries[1]['key'], 'some.fact.key')
        self.assertEqual(entries[1]['new_text'], 'The new fact text.')
        self.assertEqual(entries[1]['existing_text'], 'The old fact text.')
        self.assertEqual(entries[1]['existing_valid_from'], '2026-08-01')
        self.assertEqual(entries[1]['category'], 'preferences')
        self.assertEqual(entries[1]['source'], 'conversation')
        self.assertEqual(entries[1]['source_ref'], 'ref-abc123')
        self.assertEqual(entries[1]['created_at'], '2026-08-20T12:00:00+00:00')
        self.assertEqual(entries[1]['id'], 'cf-20260820120000-001')


class TestActionWordMapping(ReviewDigestActionTestCase):
    def test_accept_maps_to_accepted(self):
        entry = _make_entry('cf-a')
        _write_jsonl_lf(self.pending_path, [entry])
        code = apply_action(self.pending_path, 'cf-a', 'accept')
        self.assertEqual(code, 0)
        self.assertEqual(self.read_entries()[0]['resolution'], 'accepted')

    def test_reject_maps_to_rejected(self):
        entry = _make_entry('cf-b')
        _write_jsonl_lf(self.pending_path, [entry])
        code = apply_action(self.pending_path, 'cf-b', 'reject')
        self.assertEqual(code, 0)
        self.assertEqual(self.read_entries()[0]['resolution'], 'rejected')

    def test_ignore_maps_to_ignored(self):
        entry = _make_entry('cf-c')
        _write_jsonl_lf(self.pending_path, [entry])
        code = apply_action(self.pending_path, 'cf-c', 'ignore')
        self.assertEqual(code, 0)
        self.assertEqual(self.read_entries()[0]['resolution'], 'ignored')


class TestUnparseableLinesSurviveByteForByte(ReviewDigestActionTestCase):
    def test_unparseable_and_blank_lines_preserved_verbatim(self):
        target = _make_entry('cf-target')
        garbage_line = '{this is not valid json,,,'
        blank_line = ''

        # Build the fixture by hand so we know the exact expected bytes.
        lines = [
            json.dumps(_make_entry('cf-before')),
            garbage_line,
            blank_line,
            json.dumps(target),
            json.dumps(_make_entry('cf-after')),
        ]
        content = '\n'.join(lines) + '\n'
        with open(self.pending_path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)

        code = apply_action(self.pending_path, 'cf-target', 'accept')
        self.assertEqual(code, 0)

        raw = self.read_raw_bytes().decode('utf-8')
        out_lines = raw.split('\n')
        # garbage_line and blank_line must appear byte-for-byte unchanged.
        self.assertIn(garbage_line, out_lines)
        self.assertEqual(out_lines[2], blank_line)

        entries = self.read_entries()
        # cf-before and cf-after present and untouched; the unparseable line
        # contributes a None marker; cf-target is resolved.
        by_id = {e['id']: e for e in entries if e is not None}
        self.assertEqual(by_id['cf-before']['resolved'], False)
        self.assertEqual(by_id['cf-after']['resolved'], False)
        self.assertEqual(by_id['cf-target']['resolved'], True)
        self.assertEqual(by_id['cf-target']['resolution'], 'accepted')
        self.assertIn(None, entries)  # the unparseable line is still present as a line


class TestUnknownIdLeavesFileUnchanged(ReviewDigestActionTestCase):
    def test_unknown_id_exits_2_and_file_is_byte_identical(self):
        entry = _make_entry('cf-known')
        _write_jsonl_lf(self.pending_path, [entry])
        before = self.read_raw_bytes()

        code = apply_action(self.pending_path, 'cf-does-not-exist', 'accept')
        self.assertEqual(code, 2)

        after = self.read_raw_bytes()
        self.assertEqual(before, after)


class TestAlreadyResolvedEntry(ReviewDigestActionTestCase):
    def test_already_resolved_exits_3_and_leaves_file_unchanged(self):
        entry = _make_entry('cf-done', resolved=True, resolution='accepted')
        entry['resolved_at'] = '2026-08-19T09:00:00+00:00'
        _write_jsonl_lf(self.pending_path, [entry])
        before = self.read_raw_bytes()

        code = apply_action(self.pending_path, 'cf-done', 'reject')
        self.assertEqual(code, 3)

        after = self.read_raw_bytes()
        self.assertEqual(before, after)
        # Resolution must not have been overwritten to 'rejected'.
        self.assertEqual(self.read_entries()[0]['resolution'], 'accepted')


class TestMissingFile(ReviewDigestActionTestCase):
    def test_missing_file_exits_4(self):
        # self.pending_path was never created.
        self.assertFalse(os.path.exists(self.pending_path))
        code = apply_action(self.pending_path, 'cf-anything', 'accept')
        self.assertEqual(code, 4)
        self.assertFalse(os.path.exists(self.pending_path))


class TestLfOnlyLineEndings(ReviewDigestActionTestCase):
    def test_written_file_has_lf_only_line_endings(self):
        entries = [_make_entry('cf-1'), _make_entry('cf-2'), _make_entry('cf-3')]
        _write_jsonl_lf(self.pending_path, entries)

        code = apply_action(self.pending_path, 'cf-2', 'accept')
        self.assertEqual(code, 0)

        raw = self.read_raw_bytes()
        self.assertNotIn(b'\r\n', raw)
        self.assertNotIn(b'\r', raw)
        self.assertIn(b'\n', raw)

    def test_lf_only_even_when_source_had_crlf(self):
        # Simulate a pending file written elsewhere with CRLF endings; the
        # rewrite must normalize to LF-only per the DONE criterion.
        entries = [_make_entry('cf-x'), _make_entry('cf-y')]
        lines = [json.dumps(e) for e in entries]
        content = '\r\n'.join(lines) + '\r\n'
        with open(self.pending_path, 'wb') as f:
            f.write(content.encode('utf-8'))

        code = apply_action(self.pending_path, 'cf-y', 'accept')
        self.assertEqual(code, 0)

        raw = self.read_raw_bytes()
        self.assertNotIn(b'\r', raw)


class TestNoRewriteOnErrorPathsIncludingOutputMessage(ReviewDigestActionTestCase):
    def test_stdout_prints_exactly_one_line_on_each_path(self):
        import io
        import contextlib

        entry = _make_entry('cf-only')
        _write_jsonl_lf(self.pending_path, [entry])

        # Success path.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = apply_action(self.pending_path, 'cf-only', 'accept')
        self.assertEqual(code, 0)
        printed = [l for l in buf.getvalue().split('\n') if l != '']
        self.assertEqual(len(printed), 1)

        # Already-resolved path.
        buf2 = io.StringIO()
        with contextlib.redirect_stdout(buf2):
            code2 = apply_action(self.pending_path, 'cf-only', 'reject')
        self.assertEqual(code2, 3)
        printed2 = [l for l in buf2.getvalue().split('\n') if l != '']
        self.assertEqual(len(printed2), 1)

        # Unknown id path.
        buf3 = io.StringIO()
        with contextlib.redirect_stdout(buf3):
            code3 = apply_action(self.pending_path, 'cf-nope', 'accept')
        self.assertEqual(code3, 2)
        printed3 = [l for l in buf3.getvalue().split('\n') if l != '']
        self.assertEqual(len(printed3), 1)

        # Missing file path.
        missing_path = os.path.join(self.temp_dir, 'does-not-exist.jsonl')
        buf4 = io.StringIO()
        with contextlib.redirect_stdout(buf4):
            code4 = apply_action(missing_path, 'cf-anything', 'accept')
        self.assertEqual(code4, 4)
        printed4 = [l for l in buf4.getvalue().split('\n') if l != '']
        self.assertEqual(len(printed4), 1)


class TestDefaultPendingPath(unittest.TestCase):
    def test_honors_pa_home_env(self):
        old = os.environ.get('PA_HOME')
        try:
            os.environ['PA_HOME'] = os.path.join('C:\\wt\\tmp', 'fake-pa-home')
            path = default_pending_path()
            self.assertEqual(
                path,
                os.path.join('C:\\wt\\tmp', 'fake-pa-home', 'review-digest-pending.jsonl'),
            )
        finally:
            if old is None:
                os.environ.pop('PA_HOME', None)
            else:
                os.environ['PA_HOME'] = old

    def test_falls_back_to_home_pa_when_pa_home_unset(self):
        old = os.environ.get('PA_HOME')
        try:
            os.environ.pop('PA_HOME', None)
            path = default_pending_path()
            expected = os.path.join(os.path.expanduser('~'), '.pa', 'review-digest-pending.jsonl')
            self.assertEqual(path, expected)
        finally:
            if old is not None:
                os.environ['PA_HOME'] = old


if __name__ == '__main__':
    unittest.main()
