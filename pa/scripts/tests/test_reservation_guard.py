"""Unit tests for pa/scripts/hooks/reservation-guard.py (Wave C, W-C4, AI-156).

Drives the script end-to-end (stdin -> stdout / app.log.jsonl / hook-warned.json)
against a temp PA_HOME and a temp REPO_ROOT, never touching the real ~/.pa or
this repo's own checkout.

Import note: the module file is named `reservation-guard.py` (hyphenated —
matching the exact hook command in .claude/settings.json and every other
reference in the wave spec), which a bare `import reservation_guard`
statement cannot locate (Python's import machinery requires the filename to
match the identifier). Loaded via importlib.util.spec_from_file_location
under the module name `reservation_guard` instead, so the rest of this file
reads exactly as the spec's "import reservation_guard" instruction intends.

Run: python -m unittest pa.scripts.tests.test_reservation_guard -v
     (or, matching CI/every skill gate:)
     python -m unittest discover -s pa/scripts/tests -p "test_reservation_guard.py" -v
"""
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

_HOOKS_DIR = Path(__file__).resolve().parents[1] / 'hooks'
_MODULE_PATH = _HOOKS_DIR / 'reservation-guard.py'


def _load_reservation_guard():
    spec = importlib.util.spec_from_file_location('reservation_guard', _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules['reservation_guard'] = module
    spec.loader.exec_module(module)
    return module


reservation_guard = _load_reservation_guard()


def _iso(dt: datetime) -> str:
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


class ReservationGuardTestCase(unittest.TestCase):
    def setUp(self):
        # .resolve() is load-bearing: on this machine the default TEMP is a
        # directory link whose target lives on the data drive; mkdtemp returns
        # the link spelling, and the guard resolves every input path - an
        # unresolved REPO_ROOT then never contains any resolved input (8F/2E at
        # the first worktree push gate, 2026-08-24, default-TEMP only).
        self.tmp_root = Path(tempfile.mkdtemp(prefix='rg-test-')).resolve()
        self.repo_root = self.tmp_root / 'repo'
        self.repo_root.mkdir()
        self.pa_home = self.tmp_root / 'pa-home'
        self.pa_home.mkdir()

        self._orig_repo_root = reservation_guard.REPO_ROOT
        self._orig_pa_home_env = os.environ.get('PA_HOME')
        reservation_guard.REPO_ROOT = self.repo_root
        os.environ['PA_HOME'] = str(self.pa_home)

    def tearDown(self):
        reservation_guard.REPO_ROOT = self._orig_repo_root
        if self._orig_pa_home_env is None:
            os.environ.pop('PA_HOME', None)
        else:
            os.environ['PA_HOME'] = self._orig_pa_home_env
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    # ---- helpers ----

    def _future_iso(self, minutes=30):
        return _iso(datetime.now(timezone.utc) + timedelta(minutes=minutes))

    def _past_iso(self, minutes=30):
        return _iso(datetime.now(timezone.utc) - timedelta(minutes=minutes))

    def _write_reservations(self, reservations):
        with open(self.pa_home / 'reservations.json', 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'reservations': reservations}, f)

    def _write_raw(self, name, content):
        with open(self.pa_home / name, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)

    def _make_file(self, rel_path):
        p = self.repo_root / rel_path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('// x', encoding='utf-8')
        return p

    def _run_hook(self, payload):
        """Runs main() with stdin/stdout swapped for exactly the call.
        Returns (exit_code, captured_stdout)."""
        stdin = io.StringIO(json.dumps(payload) if not isinstance(payload, str) else payload)
        old_stdin, old_stdout = sys.stdin, sys.stdout
        sys.stdin = stdin
        captured = io.StringIO()
        sys.stdout = captured
        try:
            exit_code = reservation_guard.main()
        finally:
            sys.stdin, sys.stdout = old_stdin, old_stdout
        return exit_code, captured.getvalue()

    def _default_reservation(self, **overrides):
        r = {
            'id': 'r-abc123',
            'paths': ['pa/src/lib/reservations.ts'],
            'session': 'someone-else',
            'note': 'refactoring reservations',
            'claimedAt': self._past_iso(60),
            'expiresAt': self._future_iso(30),
        }
        r.update(overrides)
        return r

    def _app_log_lines(self):
        log_path = self.pa_home / 'app.log.jsonl'
        if not log_path.exists():
            return []
        text = log_path.read_text(encoding='utf-8')
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    # ---- 1. reserved path warns, additionalContext present, no permissionDecision ----

    def test_reserved_path_warns_with_additional_context_no_permission_decision(self):
        self._write_reservations([self._default_reservation()])
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 'my-claude-session',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })

        self.assertEqual(exit_code, 0)
        self.assertTrue(out.strip(), 'expected a warning on stdout')
        parsed = json.loads(out.strip())
        hso = parsed['hookSpecificOutput']
        self.assertEqual(hso['hookEventName'], 'PreToolUse')
        self.assertNotIn('permissionDecision', hso)
        ctx = hso['additionalContext']
        self.assertIn('r-abc123', ctx)
        self.assertIn('someone-else', ctx)
        self.assertIn('refactoring reservations', ctx)

    # ---- 2. second identical invocation (same session_id) is silent ----

    def test_second_identical_invocation_same_session_is_silent(self):
        self._write_reservations([self._default_reservation()])
        file_path = self._make_file('pa/src/lib/reservations.ts')
        payload = {
            'session_id': 'my-claude-session',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        }

        exit1, out1 = self._run_hook(payload)
        self.assertEqual(exit1, 0)
        self.assertTrue(out1.strip())

        exit2, out2 = self._run_hook(payload)
        self.assertEqual(exit2, 0)
        self.assertEqual(out2.strip(), '')

    # ---- 3. same reservation, different session_id, warns again ----

    def test_same_reservation_different_session_id_warns_again(self):
        self._write_reservations([self._default_reservation()])
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit1, out1 = self._run_hook({
            'session_id': 'session-A',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit1, 0)
        self.assertTrue(out1.strip())

        exit2, out2 = self._run_hook({
            'session_id': 'session-B',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit2, 0)
        self.assertTrue(out2.strip(), 'a different session_id must warn again — the cache is per session')

    # ---- 4. unreserved path in the repo -> silent ----

    def test_unreserved_path_is_silent(self):
        self._write_reservations([self._default_reservation(paths=['pa/src/lib/other.ts'])])
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 5. path outside the repo root -> silent ----

    def test_path_outside_repo_root_is_silent(self):
        self._write_reservations([self._default_reservation(paths=['elsewhere.ts'])])
        outside_dir = self.tmp_root / 'not-the-repo'
        outside_dir.mkdir()
        outside_file = outside_dir / 'elsewhere.ts'
        outside_file.write_text('// x', encoding='utf-8')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(outside_file)},
        })
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 6. non-edit tool (Read) -> silent ----

    def test_non_edit_tool_is_silent(self):
        self._write_reservations([self._default_reservation()])
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Read',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 7. tool_input.path fallback (V5) ----

    def test_tool_input_path_fallback_still_warns(self):
        self._write_reservations([self._default_reservation()])
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertTrue(out.strip(), 'tool_input.path must be honored as a fallback for file_path')

    # ---- 8. malformed stdin -> silent, exit 0, never a traceback ----

    def test_malformed_stdin_is_silent(self):
        exit_code, out = self._run_hook('not json at all {{{')
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 9. missing reservations.json -> silent ----

    def test_missing_reservations_json_is_silent(self):
        # No reservations.json ever written for this temp PA_HOME.
        file_path = self._make_file('pa/src/lib/reservations.ts')
        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 10. corrupt (truncated) reservations.json -> silent ----

    def test_corrupt_reservations_json_is_silent(self):
        self._write_raw('reservations.json', '{"reservations": [ { "id": "r-1", "pa')
        file_path = self._make_file('pa/src/lib/reservations.ts')
        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 11. corrupt hook-warned.json -> warns anyway, rewrites the cache ----

    def test_corrupt_hook_warned_json_warns_anyway_and_rewrites_cache(self):
        self._write_reservations([self._default_reservation()])
        self._write_raw('hook-warned.json', 'not valid json {{{')
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertTrue(out.strip(), 'corrupt cache must not suppress the warning')

        with open(self.pa_home / 'hook-warned.json', encoding='utf-8') as f:
            cache = json.load(f)
        self.assertIn('s-1|r-abc123', cache)

    # ---- 12. expired reservation -> no warning ----

    def test_expired_reservation_no_warning(self):
        self._write_reservations([self._default_reservation(expiresAt=self._past_iso(5))])
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 13. logical @-resource never matches a file path ----

    def test_logical_at_resource_never_matches_file_path(self):
        self._write_reservations([self._default_reservation(id='r-build', paths=['@build'])])
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.strip(), '')

    # ---- 14. directory-prefix overlap, both ways, and the classic prefix bug ----

    def test_directory_prefix_overlap_and_classic_prefix_bug(self):
        # (a) a reservation on the directory "pa/src" overlaps a nested file edit.
        self._write_reservations([self._default_reservation(id='r-dir', paths=['pa/src'])])
        nested_file = self._make_file('pa/src/lib/x.ts')
        exit_code, out = self._run_hook({
            'session_id': 's-dir',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(nested_file)},
        })
        self.assertEqual(exit_code, 0)
        self.assertTrue(out.strip(), 'a directory reservation must cover a nested file edit')

        # (b) the classic prefix bug: "pa/src/a.ts" must NOT match an edit to
        # "pa/src/ab.ts" — a raw (non-boundary-aware) string-prefix check would
        # wrongly treat "pa/src/a.ts" as a prefix of "pa/src/ab.ts".
        self._write_reservations([self._default_reservation(id='r-a', paths=['pa/src/a.ts'])])
        ab_file = self._make_file('pa/src/ab.ts')
        exit_code2, out2 = self._run_hook({
            'session_id': 's-prefix',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(ab_file)},
        })
        self.assertEqual(exit_code2, 0)
        self.assertEqual(out2.strip(), '', 'pa/src/a.ts must not overlap pa/src/ab.ts')

    # ---- 15. exactly one log line per emitted warning; suppressed repeat appends nothing ----

    def test_warning_appends_exactly_one_log_line_suppressed_repeat_appends_none(self):
        self._write_reservations([self._default_reservation()])
        file_path = self._make_file('pa/src/lib/reservations.ts')
        payload = {
            'session_id': 's-log',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        }

        exit1, out1 = self._run_hook(payload)
        self.assertEqual(exit1, 0)
        self.assertTrue(out1.strip())

        lines = self._app_log_lines()
        self.assertEqual(len(lines), 1)
        entry = lines[0]
        self.assertEqual(entry['module'], 'reservations')
        self.assertEqual(entry['message'], 'hook warning')
        self.assertRegex(entry['refId'], r'^s-[0-9a-f]{12}$')
        self.assertEqual(entry['reservationId'], 'r-abc123')
        self.assertEqual(entry['holder'], 'someone-else')

        # Suppressed repeat: no new line appended.
        exit2, out2 = self._run_hook(payload)
        self.assertEqual(exit2, 0)
        self.assertEqual(out2.strip(), '')
        self.assertEqual(len(self._app_log_lines()), 1, 'a suppressed repeat must not append another log line')

    # ---- 16. relative file_path resolved against payload cwd ----

    def test_relative_file_path_resolved_against_cwd(self):
        self._write_reservations([self._default_reservation()])
        self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-1',
            'tool_name': 'Edit',
            'cwd': str(self.repo_root / 'pa' / 'src' / 'lib'),
            'tool_input': {'file_path': 'reservations.ts'},
        })
        self.assertEqual(exit_code, 0)
        self.assertTrue(out.strip(), 'a relative file_path must resolve against payload.cwd')

    # ---- 17. 3+ matches -> at most 3 rows rendered, additionalContext <= 1200 chars ----
    #
    # Note: with MAX_ROWS=3 and the fixed §7.2 per-row template (~400+ chars
    # each), three full rows alone already approach or exceed
    # MAX_CONTEXT_CHARS=1200, so the "(+N more…)" suffix is routinely
    # truncated away by the final 1200-char cap — that is correct behaviour
    # per §4 step 4 ("render 3 and append … Truncate the whole string to
    # 1200 chars"), not a bug. The DONE criterion this test proves is the
    # row cap and the character cap, not that the suffix always survives.
    def test_three_or_more_matches_capped_at_three_rows_and_1200_chars(self):
        reservations = [
            self._default_reservation(
                id=f'r-{i:03d}',
                session=f'session-{i}',
                note=f'doing thing number {i} with a reasonably descriptive note to pad length',
                paths=['pa/src/lib/reservations.ts'],
            )
            for i in range(5)
        ]
        self._write_reservations(reservations)
        file_path = self._make_file('pa/src/lib/reservations.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-many',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        parsed = json.loads(out.strip())
        ctx = parsed['hookSpecificOutput']['additionalContext']
        self.assertLessEqual(len(ctx), 1200)
        rendered_rows = len(re.findall(r'\[pa reservation-guard\]', ctx))
        self.assertLessEqual(rendered_rows, 3, 'at most 3 rows must be rendered')

    # Separately, with short enough field values that 3 rows + the "+N more"
    # suffix together still fit under 1200 chars, the suffix must be present.
    def test_more_suffix_present_when_it_fits_under_the_char_cap(self):
        reservations = [
            self._default_reservation(id=f'r{i}', session=f's{i}', note='x', paths=['a.ts'])
            for i in range(5)
        ]
        self._write_reservations(reservations)
        file_path = self._make_file('a.ts')

        exit_code, out = self._run_hook({
            'session_id': 's-many-short',
            'tool_name': 'Edit',
            'tool_input': {'file_path': str(file_path)},
        })
        self.assertEqual(exit_code, 0)
        parsed = json.loads(out.strip())
        ctx = parsed['hookSpecificOutput']['additionalContext']
        self.assertLessEqual(len(ctx), 1200)
        rendered_rows = len(re.findall(r'\[pa reservation-guard\]', ctx))
        self.assertLessEqual(rendered_rows, 3)
        if len(ctx) < 1200:
            self.assertIn('more active reservations overlap this path', ctx)


if __name__ == '__main__':
    unittest.main()
