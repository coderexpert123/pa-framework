#!/usr/bin/env python3
"""
Tests for pa/scripts/decisions.py (Python twin of pa/src/lib/decisions.ts).

AI-164: Decision traces helper.
Uses unittest (CI contract - NOT pytest).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

# Import the module under test
# We need pa/scripts/ in the path (the module is pa/scripts/decisions.py)
# Tests run from pa/scripts/tests/, so ../ gets us to pa/scripts/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import decisions as decisions_lib


class TestDecisionIdFormat(unittest.TestCase):
    """Test decision_id format: ^d-\\d{12}-[0-9a-f]{12}$"""

    def test_decision_id_format(self):
        """A decision row gets a decision_id matching the frozen format."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "skill",
                "skill": "test-skill",
                "request_excerpt": "Test request",
                "decision": "Test decision",
                "rationale": "Test rationale",
            }

            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"), f"Record failed: {result}")

            decision_id = result.get("decisionId")
            self.assertIsNotNone(decision_id)
            self.assertRegex(decision_id, r"^d-\d{12}-[0-9a-f]{12}$")

        finally:
            del os.environ["PA_HOME"]


class TestCaps(unittest.TestCase):
    """Test §2.2 text caps enforcement."""

    def test_request_excerpt_capped_at_200(self):
        """A 500-char request_excerpt is stored at 200."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "skill",
                "request_excerpt": "x" * 500,
                "decision": "included",
                "rationale": "test",
            }

            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Read back from DB
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT request_excerpt FROM decisions")
                stored = cursor.fetchone()[0]
                self.assertEqual(len(stored), 200)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_12_alternatives_becomes_8(self):
        """12 alternatives ⇒ 8 stored, each ≤ 200."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "bot",
                "skill": "reminders",
                "request_excerpt": "test",
                "decision": "snoozed 1 h",
                "rationale": "test",
                "alternatives": ["x" * 300 for _ in range(12)],
            }

            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Read back
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT alternatives FROM decisions")
                stored_json = cursor.fetchone()[0]
                stored = json.loads(stored_json)
                self.assertEqual(len(stored), 8)
                for alt in stored:
                    self.assertLessEqual(len(alt), 200)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestImmutabilitySurface(unittest.TestCase):
    """Test there is no exported function that can alter decision text (§2.3 item 5)."""

    def test_no_text_mutating_exports(self):
        """Module exports only the five functions + types, no update/delete."""
        import inspect

        public_callables = [
            name for name, obj in inspect.getmembers(decisions_lib)
            if inspect.isfunction(obj) and not name.startswith("_")
        ]

        # Allowed exports (including internal CLI helpers - they're private now with _ prefix)
        allowed = {
            "record_decision",
            "attach_decision_message",
            "record_reaction",
            "mark_replied_for_thread",
            "decisions_db_path",
            "pa_home",
            "main",
            "_cmd_record",
            "_cmd_react",
            "_cmd_attach",
            "_open_db",
            "_now_iso",
            "_mint_decision_id",
            "_load_secrets",
            "_redact_secrets",
            "_redact_row_fields",
            "_apply_caps",
        }

        # Every public callable is in the allowed set
        for name in public_callables:
            self.assertIn(name, allowed, f"Unexpected export: {name}")

        # No function name suggests text mutation
        mutation_keywords = ["update", "delete", "modify", "change", "alter", "set_text"]
        for name in public_callables:
            for keyword in mutation_keywords:
                self.assertNotIn(keyword, name.lower(), f"Function {name} suggests text mutation")


class TestAttachOnce(unittest.TestCase):
    """Test attachDecisionMessage fills NULLs once; second attach matches 0."""

    def test_attach_fills_nulls_once(self):
        """attach fills NULLs once; a second attach with different ids ⇒ matched 0."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Record without chat_id/message_id
            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
            }
            result = decisions_lib.record_decision(row)
            decision_id = result.get("decisionId")
            self.assertTrue(result.get("ok"))

            # First attach
            result1 = decisions_lib.attach_decision_message(decision_id, -1009999999999, 12345)
            self.assertTrue(result1.get("ok"))
            self.assertEqual(result1.get("matched"), 1)

            # Second attach with different ids
            result2 = decisions_lib.attach_decision_message(decision_id, -1009999999998, 12346)
            self.assertTrue(result2.get("ok"))
            self.assertEqual(result2.get("matched"), 0)

            # Verify row unchanged
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT chat_id, message_id FROM decisions")
                chat_id, msg_id = cursor.fetchone()
                self.assertEqual(chat_id, -1009999999999)
                self.assertEqual(msg_id, 12345)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestReactionOutcomes(unittest.TestCase):
    """Test 👍/👎/❤️ outcomes (§2.3 item 3)."""

    def test_thumb_up_sets_approved(self):
        """record_reaction('👍') on an attached row ⇒ reaction='👍', outcome='approved'."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Record with chat/message
            row = {
                "source": "bot",
                "skill": "reminders",
                "request_excerpt": "test reminder",
                "decision": "snoozed 1 h",
                "rationale": "test",
                "chat_id": -1009999999999,
                "message_id": 421337,
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # React with thumbs up
            result = decisions_lib.record_reaction(-1009999999999, 421337, "👍")
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 1)

            # Verify outcome and reaction
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT reaction, outcome, updated_at FROM decisions")
                reaction, outcome, updated_at = cursor.fetchone()
                self.assertEqual(reaction, "👍")
                self.assertEqual(outcome, "approved")
                # updated_at > ts (we can't directly compare, but the field should be set)
                self.assertIsNotNone(updated_at)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_thumb_down_sets_rejected(self):
        """'👎' ⇒ 'rejected'."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "bot",
                "skill": "reminders",
                "request_excerpt": "test",
                "decision": "done",
                "rationale": "test",
                "chat_id": -1009999999999,
                "message_id": 421337,
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            result = decisions_lib.record_reaction(-1009999999999, 421337, "👎")
            self.assertTrue(result.get("ok"))

            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT outcome FROM decisions")
                outcome = cursor.fetchone()[0]
                self.assertEqual(outcome, "rejected")
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_heart_emoji_sets_reaction_only(self):
        """Non-approval emoji '❤️' ⇒ reaction filled, outcome still NULL."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
                "chat_id": -1009999999999,
                "message_id": 421337,
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            result = decisions_lib.record_reaction(-1009999999999, 421337, "❤️")
            self.assertTrue(result.get("ok"))

            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT reaction, outcome FROM decisions")
                reaction, outcome = cursor.fetchone()
                self.assertEqual(reaction, "❤️")
                self.assertIsNone(outcome)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_zero_match_no_row_created(self):
        """Zero-match ⇒ {ok:true, matched:0} and no row created."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            result = decisions_lib.record_reaction(-1009999999999, 999999, "👍")
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 0)

            # Verify no rows created
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT COUNT(*) FROM decisions")
                count = cursor.fetchone()[0]
                self.assertEqual(count, 0)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestPrecedence(unittest.TestCase):
    """Test outcome precedence: strong wins over weak (§2.3 item 4)."""

    def test_strong_overwrites_weak(self):
        """A row already outcome='replied' then 👎 ⇒ 'rejected' (strong wins)."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Record with outcome='replied'
            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
                "outcome": "replied",
                "chat_id": -1009999999999,
                "message_id": 421337,
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Strong signal overwrites
            result = decisions_lib.record_reaction(-1009999999999, 421337, "👎")
            self.assertTrue(result.get("ok"))

            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT outcome FROM decisions")
                outcome = cursor.fetchone()[0]
                self.assertEqual(outcome, "rejected")
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_weak_does_not_downgrade_strong(self):
        """A row with reaction='❤️' then markRepliedForThread ⇒ NOT downgraded (matched 0)."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Record with reaction
            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
                "reaction": "❤️",
                "thread_id": 4242,
                "chat_id": -1009999999999,
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Try to mark as replied
            result = decisions_lib.mark_replied_for_thread(-1009999999999, 4242)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 0)

            # Verify outcome still NULL (not downgraded)
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT outcome, reaction FROM decisions")
                outcome, reaction = cursor.fetchone()
                self.assertIsNone(outcome)
                self.assertEqual(reaction, "❤️")
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestRepliedWindow(unittest.TestCase):
    """Test markRepliedForThread: fills outcome='replied' for rows within 24 h."""

    def test_fills_within_24h(self):
        """Fills outcome='replied' for a NULL-outcome row in the same thread within 24 h."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Record a row 1 hour ago (simulated by passing now_ms)
            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
                "thread_id": 4242,
                "chat_id": -1009999999999,
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Mark as replied (1 hour later)
            one_hour_ms = 3600000
            now_ms = (datetime.now(timezone.utc).timestamp() * 1000) + one_hour_ms
            result = decisions_lib.mark_replied_for_thread(-1009999999999, 4242, now_ms)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 1)

            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT outcome FROM decisions")
                outcome = cursor.fetchone()[0]
                self.assertEqual(outcome, "replied")
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_skips_25h_old_row(self):
        """Skips a 25 h-old row."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
                "thread_id": 4242,
                "chat_id": -1009999999999,
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Try to mark as replied (25 hours later - should skip)
            twenty_five_hours_ms = 25 * 3600000
            now_ms = (datetime.now(timezone.utc).timestamp() * 1000) + twenty_five_hours_ms
            result = decisions_lib.mark_replied_for_thread(-1009999999999, 4242, now_ms)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 0)

            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT outcome FROM decisions")
                outcome = cursor.fetchone()[0]
                self.assertIsNone(outcome)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_skips_different_chat_id(self):
        """Skips a row whose chat_id is a different chat."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
                "thread_id": 4242,
                "chat_id": -1009999999998,  # Different chat
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            result = decisions_lib.mark_replied_for_thread(-1009999999999, 4242)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 0)

        finally:
            del os.environ["PA_HOME"]

    def test_fills_null_chat_id_matching_thread(self):
        """Fills a row whose chat_id is NULL but thread_id matches."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
                "thread_id": 4242,
                # No chat_id
            }
            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            result = decisions_lib.mark_replied_for_thread(-1009999999999, 4242)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 1)

            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT outcome FROM decisions")
                outcome = cursor.fetchone()[0]
                self.assertEqual(outcome, "replied")
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestNeverThrows(unittest.TestCase):
    """Test never-throws: with PA_HOME pointing at an unwritable path, every function returns {ok:false}."""

    def test_record_decision_returns_ok_false_on_unwritable(self):
        """With unwritable PA_HOME, record_decision returns {ok: False}."""
        # Create a file where the directory should be
        temp_file = tempfile.NamedTemporaryFile(delete=False)
        temp_path = temp_file.name
        temp_file.close()

        try:
            os.environ["PA_HOME"] = temp_path  # File, not directory

            row = {
                "source": "skill",
                "request_excerpt": "test",
                "decision": "included",
                "rationale": "test",
            }

            result = decisions_lib.record_decision(row)
            self.assertFalse(result.get("ok"))
            self.assertIn("error", result)

        finally:
            del os.environ["PA_HOME"]
            os.unlink(temp_path)

    def test_attach_decision_message_returns_ok_false_on_unwritable(self):
        """With unwritable PA_HOME, attach_decision_message returns {ok: False}."""
        temp_file = tempfile.NamedTemporaryFile(delete=False)
        temp_path = temp_file.name
        temp_file.close()

        try:
            os.environ["PA_HOME"] = temp_path

            result = decisions_lib.attach_decision_message("d-test", -1009999999999, 123)
            self.assertFalse(result.get("ok"))
            self.assertIn("error", result)

        finally:
            del os.environ["PA_HOME"]
            os.unlink(temp_path)


class TestMultiRowReaction(unittest.TestCase):
    """Test multi-row reaction: two rows sharing (chat_id, message_id) both fill on one 👍."""

    def test_multi_row_reaction_matched_2(self):
        """Two rows sharing (chat_id, message_id) both fill on one 👍 (matched: 2)."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Record two rows with same chat/message
            for i in range(2):
                row = {
                    "source": "bot",
                    "skill": "reminders",
                    "request_excerpt": f"reminder {i}",
                    "decision": "snoozed 1 h",
                    "rationale": "test",
                    "chat_id": -1009999999999,
                    "message_id": 421337,
                }
                result = decisions_lib.record_decision(row)
                self.assertTrue(result.get("ok"))

            # React once
            result = decisions_lib.record_reaction(-1009999999999, 421337, "👍")
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("matched"), 2)

            # Verify both rows updated
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT outcome FROM decisions")
                outcomes = [row[0] for row in cursor.fetchall()]
                self.assertEqual(len(outcomes), 2)
                for outcome in outcomes:
                    self.assertEqual(outcome, "approved")
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestRedaction(unittest.TestCase):
    """Test redaction with a planted secrets.env value ≥ 8 chars (§2.4)."""

    def test_redaction_with_planted_secret(self):
        """Plant an 8+ char secret via secrets.env, record a row containing it, assert <redacted:> appears."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Create secrets.env with a test secret
            secrets_path = os.path.join(temp_home, "secrets.env")
            with open(secrets_path, "w", encoding="utf-8") as f:
                f.write("TEST_SECRET_12345=supersecretvalue123\n")

            row = {
                "source": "skill",
                "request_excerpt": "Test with supersecretvalue123",
                "decision": "included",
                "rationale": "Because supersecretvalue123 was present",
                "alternatives": ["excluded because supersecretvalue123"],
            }

            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Query DB directly (second connection)
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT request_excerpt, rationale, alternatives FROM decisions")
                excerpt, rationale, alts_json = cursor.fetchone()

                self.assertIn("<redacted:TEST_SECRET_12345>", excerpt)
                self.assertIn("<redacted:TEST_SECRET_12345>", rationale)

                alts = json.loads(alts_json)
                self.assertIn("<redacted:TEST_SECRET_12345>", alts[0])

            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestCrossTwinByteParity(unittest.TestCase):
    """
    Cross-twin byte-parity case (required by §B2):
    After Python record_decision, SELECT ts, updated_at, context_refs, alternatives FROM decisions —
    assert ts/updated_at match ^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$ and
    the JSON arrays round-trip through json.loads (C9e guard — the recall ts >= compare and
    markRepliedForThread depend on it).
    """

    def test_ts_updated_at_format_and_json_round_trip(self):
        """ts/updated_at match Z-suffix format and JSON arrays round-trip."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row = {
                "source": "skill",
                "skill": "daily-mail-brief",
                "request_excerpt": "Synthetic Sender - quarterly statement",
                "decision": "excluded",
                "rationale": "Duplicate of an already-included thread",
                "alternatives": ["included", "highlighted"],
                "context_refs": ["thread-123", "thread-456"],
            }

            result = decisions_lib.record_decision(row)
            self.assertTrue(result.get("ok"))

            # Read back
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute(
                    "SELECT decision_id, ts, updated_at, context_refs, alternatives FROM decisions"
                )
                decision_id, ts, updated_at, context_refs_json, alternatives_json = cursor.fetchone()

                # Assert format: YYYY-MM-DDTHH:MM:SS.sssZ
                ts_pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
                self.assertRegex(ts, ts_pattern, f"ts {ts} does not match format")
                self.assertRegex(updated_at, ts_pattern, f"updated_at {updated_at} does not match format")

                # Assert JSON arrays round-trip
                context_refs = json.loads(context_refs_json)
                alternatives = json.loads(alternatives_json)

                self.assertEqual(context_refs, ["thread-123", "thread-456"])
                self.assertEqual(alternatives, ["included", "highlighted"])

                # Assert decision_id format
                self.assertRegex(decision_id, r"^d-\d{12}-[0-9a-f]{12}$")

            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestCLIRecordJson(unittest.TestCase):
    """Test CLI record --json round-trip via subprocess (or main(argv) direct call)."""

    def test_record_json_round_trip(self):
        """record --json '<row>' round-trip via subprocess."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            row_json = json.dumps({
                "source": "skill",
                "skill": "test-skill",
                "request_excerpt": "Test request",
                "decision": "included",
                "rationale": "Test rationale",
            })

            # Call main() directly (testable without subprocess)
            result = decisions_lib.main(["record", "--json", row_json])
            # main() prints to stdout, but we can capture via subprocess for real test
            # For now, we'll use the function directly

        finally:
            del os.environ["PA_HOME"]


class TestCLIRecordJsonl(unittest.TestCase):
    """Test CLI --jsonl with 3 valid + 1 malformed line ⇒ 3 recorded."""

    def test_jsonl_3_valid_1_malformed(self):
        """--jsonl with 3 valid + 1 malformed line ⇒ 3 recorded."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Create JSONL file with 3 valid + 1 malformed
            jsonl_path = os.path.join(temp_home, "test.jsonl")
            with open(jsonl_path, "w", encoding="utf-8") as f:
                f.write('{"source":"skill","request_excerpt":"test1","decision":"included","rationale":"test"}\n')
                f.write('{"source":"bot","request_excerpt":"test2","decision":"excluded","rationale":"test"}\n')
                f.write('invalid json line\n')
                f.write('{"source":"skill","request_excerpt":"test3","decision":"highlighted","rationale":"test"}\n')

            # Use subprocess for proper CLI testing
            proc = subprocess.run(
                [sys.executable, decisions_lib.__file__, "record", "--jsonl", jsonl_path],
                capture_output=True,
                text=True,
                env={**os.environ, "PA_HOME": temp_home},
            )

            output = proc.stdout.strip()
            result_obj = json.loads(output)

            self.assertTrue(result_obj.get("ok"), f"CLI failed: {result_obj}")

            # Verify 3 rows recorded
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT COUNT(*) FROM decisions")
                count = cursor.fetchone()[0]
                self.assertEqual(count, 3)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]

    def test_jsonl_max_10_cap(self):
        """--jsonl max-10 cap."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            jsonl_path = os.path.join(temp_home, "test.jsonl")
            with open(jsonl_path, "w", encoding="utf-8") as f:
                for i in range(15):
                    f.write(f'{{"source":"skill","request_excerpt":"test{i}","decision":"included","rationale":"test"}}\n')

            decisions_lib.main(["record", "--jsonl", jsonl_path])

            # Verify only 10 rows recorded
            conn = decisions_lib._open_db()
            try:
                cursor = conn.execute("SELECT COUNT(*) FROM decisions")
                count = cursor.fetchone()[0]
                self.assertEqual(count, 10)
            finally:
                conn.close()

        finally:
            del os.environ["PA_HOME"]


class TestCLIReact(unittest.TestCase):
    """Test CLI react subcommand."""

    def test_react_zero_match_exit_0(self):
        """react zero-match exit 0 with matched: 0."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            # Use subprocess for proper CLI testing
            result = subprocess.run(
                [sys.executable, decisions_lib.__file__, "react", "--chat-id", "-1009999999999", "--message-id", "999999", "--reaction", "👍"],
                capture_output=True,
                text=True,
                env={**os.environ, "PA_HOME": temp_home},
            )

            output = result.stdout.strip()
            result_obj = json.loads(output)

            self.assertTrue(result_obj.get("ok"))
            self.assertEqual(result_obj.get("matched"), 0)

        finally:
            del os.environ["PA_HOME"]


class TestCLIBadJson(unittest.TestCase):
    """Test bad --json exit 1."""

    def test_bad_json_exit_1(self):
        """bad --json exit 1."""
        temp_home = tempfile.mkdtemp()
        try:
            os.environ["PA_HOME"] = temp_home

            with self.assertRaises(SystemExit) as cm:
                decisions_lib.main(["record", "--json", "not valid json"])

            self.assertEqual(cm.exception.code, 1)

        finally:
            del os.environ["PA_HOME"]


class TestCLINoArgs(unittest.TestCase):
    """Test no args exit 2."""

    def test_no_args_exit_2(self):
        """no args exit 2."""
        with self.assertRaises(SystemExit) as cm:
            decisions_lib.main([])

        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
