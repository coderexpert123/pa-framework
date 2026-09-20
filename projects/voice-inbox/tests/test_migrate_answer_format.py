"""Tests for scripts/migrate_answer_format.py (2026-09-10 answer-format
migration — plans/2026-09-10-voiceinbox-answer-migration-SPEC.md).

Two layers, same convention as test_worker_scripts.py:

1. Pure-function tests — `needs_migration` and `same_content`/`evaluate` are
   imported directly and exercised against hand-built shapes. `same_content`
   is an equivalence GATE: per project CLAUDE.md ("A check must be able to
   FAIL"), it is proven capable of failing on real content changes, not just
   shown to pass.
2. Functional tests — the script runs as a real subprocess against a ledger
   built from the SAME extracted `LEDGER_SCHEMA_SQL` test_worker_scripts.py
   uses (imported from there, never a fifth hand-copy), with a fake
   `--llm-cmd` pointing at tiny canned-reformat helper scripts.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
SCRIPTS = PROJECT / "scripts"
SCRIPT_PATH = SCRIPTS / "migrate_answer_format.py"

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SCRIPTS))
import test_worker_scripts as sync  # noqa: E402 — reuse its schema extraction, never re-copy it
import migrate_answer_format as mig  # noqa: E402

TENANT_ID = "t-42"
CHAT_ID = -1001234567890


# ---------------------------------------------------------------------------
# needs_migration — six shapes
# ---------------------------------------------------------------------------


def test_needs_migration_short_flat_is_already_fine():
    text = "Sure, that is confirmed and there is nothing else to add here."
    assert mig.needs_migration(text) is False


def test_needs_migration_long_flat_needs_migration():
    text = ("This is a single unbroken paragraph describing the outcome in "
            "full detail without any structure at all, going on for quite a "
            "while so that it comfortably exceeds the three hundred character "
            "threshold that marks a wall of text as needing reformatting into "
            "readable shape for the operator to actually read on their phone "
            "screen without losing their place halfway through the sentence.")
    assert len(text) > 300
    assert mig.needs_migration(text) is True


def test_needs_migration_bold_needs_migration():
    text = "The answer is **confirmed** for tomorrow."
    assert mig.needs_migration(text) is True


def test_needs_migration_heading_needs_migration():
    text = "# Steps\nDo the first thing.\nThen the second thing."
    assert mig.needs_migration(text) is True


def test_needs_migration_inline_enum_flat_needs_migration():
    text = ("You have two choices: 1) Renew the plan now. 2) Wait until next "
            "month and decide then.")
    assert "\n" not in text
    assert mig.needs_migration(text) is True


def test_needs_migration_already_structured_is_fine():
    text = ("Here is the plan.\n\n1) First step goes here.\n"
            "2) Second step goes here.\n\nLet me know if you want changes.")
    assert mig.needs_migration(text) is False


def test_needs_migration_empty_text_is_fine():
    assert mig.needs_migration("") is False


# ---------------------------------------------------------------------------
# same_content — the equivalence gate. Base text carries numbered items so the
# "1) rewritten as -" and "changed digit" cases are meaningful deltas.
# ---------------------------------------------------------------------------

BASE_TEXT = (
    "Here is the plan.\n\n1) First step goes here.\n2) Second step goes here."
    "\n\nLet me know if you want changes."
)


def test_same_content_passes_whitespace_only_delta():
    after = BASE_TEXT.replace("\n\n", "\n \n").replace(". ", ".  ")
    assert mig.same_content(BASE_TEXT, after) is True


def test_same_content_passes_bold_only_delta():
    after = ("Here is the **plan**.\n\n1) **First** step goes here.\n"
             "2) Second step goes here.\n\nLet me know if you want changes.")
    assert mig.same_content(BASE_TEXT, after) is True


def test_same_content_passes_heading_only_delta():
    after = ("# Here is the plan.\n\n# 1) First step goes here.\n"
             "2) Second step goes here.\n\nLet me know if you want changes.")
    assert mig.same_content(BASE_TEXT, after) is True


def test_same_content_fails_one_word_changed():
    after = BASE_TEXT.replace("First step", "Initial step")
    assert mig.same_content(BASE_TEXT, after) is False


def test_same_content_fails_one_sentence_dropped():
    after = BASE_TEXT.replace("\n\nLet me know if you want changes.", "")
    assert mig.same_content(BASE_TEXT, after) is False


def test_same_content_fails_enumerator_rewritten_as_dash():
    after = BASE_TEXT.replace("1) First", "- First")
    assert mig.same_content(BASE_TEXT, after) is False


def test_same_content_fails_one_digit_changed():
    after = BASE_TEXT.replace("2) Second", "3) Second")
    assert mig.same_content(BASE_TEXT, after) is False


def test_same_content_gate_is_shown_to_fail_against_a_true_stub():
    """A gate never seen to fail is unverified (project CLAUDE.md). Prove the
    four failing deltas above would NOT be caught by a broken gate that
    always returns True, so the real assertions above are actually
    discriminating and not vacuously true."""
    def always_true(_before: str, _after: str) -> bool:
        return True

    deltas = [
        BASE_TEXT.replace("First step", "Initial step"),
        BASE_TEXT.replace("\n\nLet me know if you want changes.", ""),
        BASE_TEXT.replace("1) First", "- First"),
        BASE_TEXT.replace("2) Second", "3) Second"),
    ]
    # Against the stub, every delta wrongly "passes" (red case).
    assert all(always_true(BASE_TEXT, d) for d in deltas)
    # Against the real gate, every one of the same deltas is caught (green case).
    assert all(mig.same_content(BASE_TEXT, d) is False for d in deltas)


# ---------------------------------------------------------------------------
# evaluate() / has_target_shape() — shape gate
# ---------------------------------------------------------------------------


def test_evaluate_rejects_unchanged_when_shape_gate_fails():
    # Passes equivalence (only whitespace differs) but never gains a blank line
    # or a second enumerator LINE start — still "flat".
    after = BASE_TEXT.replace("\n\n", " ").replace("\n", " ")
    verdict, reason = mig.evaluate(BASE_TEXT, after)
    assert verdict == "rejected"
    assert reason == "unchanged"


def test_evaluate_accepts_when_both_gates_pass():
    verdict, reason = mig.evaluate(BASE_TEXT, BASE_TEXT)
    assert verdict == "accepted"
    assert reason is None


# ---------------------------------------------------------------------------
# Functional tests — real subprocess, real extracted schema, canned --llm-cmd
# ---------------------------------------------------------------------------

FLAT_TEXT = ("Here is the plan. 1) First step goes here. 2) Second step "
             "goes here. Let me know if you want changes.")
assert mig.needs_migration(FLAT_TEXT) is True

# Tiny canned "--llm-cmd" stand-ins, written into each test's own tmp_path
# (never as committed repo files — this test file is the only thing this
# build owns under tests/). The "good" one performs a real, content-preserving
# reformat (inserts a blank line before " 2) "); the "bad" one additionally
# corrupts a word, to prove the equivalence gate actually rejects something.
GOOD_REFORMAT_SRC = (
    "import os, sys\n"
    "log_path = os.environ.get('CALL_LOG_PATH')\n"
    "if log_path:\n"
    "    with open(log_path, 'a', encoding='utf-8') as f:\n"
    "        f.write('call\\n')\n"
    "prompt = sys.stdin.read()\n"
    # The real prompt is '<instructions>\\n\\n<text>' — a real LLM answers with
    # only the reformatted text, so the stand-in must strip the instructions
    # too, not echo the whole prompt back.
    "text = prompt.split('\\n\\n', 1)[1]\n"
    "text = text.replace(' 2) ', '\\n\\n2) ')\n"
    "sys.stdout.write(text)\n"
)

BAD_REFORMAT_SRC = (
    "import sys\n"
    "prompt = sys.stdin.read()\n"
    "text = prompt.split('\\n\\n', 1)[1]\n"
    "text = text.replace(' 2) ', '\\n\\n2) ')\n"
    "text = text.replace('First step', 'Initial step')\n"
    "sys.stdout.write(text)\n"
)


def write_reformatter(tmp_path: Path, filename: str, source: str) -> str:
    """Writes a canned reformatter and returns a `--llm-cmd` string. Both
    paths are forward-slashed: migrate_answer_format.py's resolve_command()
    tokenizes the command with shlex (POSIX mode, which treats backslash as
    an escape character) — a raw Windows backslash path would be silently
    mangled (`C:\\Users\\x` -> `C:Usersx`)."""
    path = tmp_path / filename
    path.write_text(source, encoding="utf-8")
    return f"{Path(sys.executable).as_posix()} {path.as_posix()}"


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_ledger(tmp_path: Path) -> Path:
    """Executes the schema SQL extracted from the committed src/ledger.ts —
    the exact same extraction test_worker_scripts.py uses, never a
    hand-copy."""
    vi_dir = tmp_path / "voice-inbox"
    vi_dir.mkdir(parents=True)
    db_path = vi_dir / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(sync.extract_schema_sql())
    conn.execute(f"PRAGMA user_version = {sync.extract_ledger_schema_version()}")
    conn.commit()
    conn.close()
    return db_path


def seed_done_task(db_path: Path, task_id: str, result_summary: str,
                    updated_at: str | None = None) -> str:
    ts = iso_now()
    updated_at = updated_at or ts
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO tenants"
            " (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)"
            " VALUES (?, 42, ?, 'Operator', ?)",
            (TENANT_ID, CHAT_ID, ts),
        )
        conn.execute(
            "INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text,"
            " state, result_summary, created_at, updated_at, conversation_id)"
            " VALUES (?, ?, 'text', NULL, 'the original request', 'done', ?, ?, ?, ?)",
            (task_id, TENANT_ID, result_summary, ts, updated_at, task_id),
        )
    conn.close()
    return updated_at


def fetch_task(db_path: Path, task_id: str) -> dict:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


def run_migrate(*argv: str, pa_home: Path,
                 extra_env: dict[str, str | None] | None = None) -> subprocess.CompletedProcess:
    env = {**os.environ, "PA_HOME": str(pa_home)}
    for key, value in (extra_env or {}).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *argv],
        capture_output=True, encoding="utf-8", errors="replace", env=env, timeout=60,
    )


def test_dry_run_writes_preview_and_prints_verdict_without_touching_ledger(tmp_path):
    db_path = make_ledger(tmp_path)
    seed_done_task(db_path, "vi-" + "aa" * 6, FLAT_TEXT)
    good_cmd = write_reformatter(tmp_path, "good_reformat.py", GOOD_REFORMAT_SRC)
    proc = run_migrate("--dry-run", "--llm-cmd", good_cmd, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert "vi-aaaaaaaaaaaa: accepted" in proc.stdout
    previews = list((tmp_path / "voice-inbox" / "migrations").glob("answer-format-*.json"))
    assert len(previews) == 1
    payload = json.loads(previews[0].read_text(encoding="utf-8"))
    assert payload[0]["task_id"] == "vi-" + "aa" * 6
    assert payload[0]["verdict"] == "accepted"
    task = fetch_task(db_path, "vi-" + "aa" * 6)
    assert task["result_summary"] == FLAT_TEXT  # untouched


def test_apply_snapshot_exists_and_opens(tmp_path):
    db_path = make_ledger(tmp_path)
    seed_done_task(db_path, "vi-" + "bb" * 6, FLAT_TEXT)
    good_cmd = write_reformatter(tmp_path, "good_reformat.py", GOOD_REFORMAT_SRC)
    proc = run_migrate("--apply", "--llm-cmd", good_cmd, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    backups = list((tmp_path / "voice-inbox" / "backups").glob("ledger-*.sqlite"))
    assert len(backups) == 1
    conn = sqlite3.connect(backups[0])
    try:
        count = conn.execute("SELECT count(*) FROM tasks").fetchone()[0]
        assert count == 1
    finally:
        conn.close()


def test_apply_leaves_updated_at_untouched(tmp_path):
    db_path = make_ledger(tmp_path)
    fixed_updated_at = "2026-01-01T00:00:00.000Z"
    seed_done_task(db_path, "vi-" + "cc" * 6, FLAT_TEXT, updated_at=fixed_updated_at)
    good_cmd = write_reformatter(tmp_path, "good_reformat.py", GOOD_REFORMAT_SRC)
    proc = run_migrate("--apply", "--llm-cmd", good_cmd, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_task(db_path, "vi-" + "cc" * 6)
    assert task["updated_at"] == fixed_updated_at
    assert task["result_summary"] != FLAT_TEXT
    assert mig.same_content(FLAT_TEXT, task["result_summary"])


def test_apply_two_rows_sharing_text_both_updated_from_one_call(tmp_path):
    db_path = make_ledger(tmp_path)
    seed_done_task(db_path, "vi-" + "d1" * 6, FLAT_TEXT)
    seed_done_task(db_path, "vi-" + "d2" * 6, FLAT_TEXT)
    call_log = tmp_path / "calls.log"
    good_cmd = write_reformatter(tmp_path, "good_reformat.py", GOOD_REFORMAT_SRC)
    proc = run_migrate("--apply", "--llm-cmd", good_cmd, pa_home=tmp_path,
                        extra_env={"CALL_LOG_PATH": str(call_log)})
    assert proc.returncode == 0, proc.stderr
    calls = call_log.read_text(encoding="utf-8").splitlines() if call_log.exists() else []
    assert len(calls) == 1, f"expected exactly one LLM call, got {calls}"
    for task_id in ("vi-" + "d1" * 6, "vi-" + "d2" * 6):
        task = fetch_task(db_path, task_id)
        assert task["result_summary"] != FLAT_TEXT
        assert mig.same_content(FLAT_TEXT, task["result_summary"])


def test_apply_optimistic_guard_skips_row_that_changed_underneath(tmp_path):
    """A `--from-preview` run against a stale preview: the ledger row moved
    on since the preview was generated, so the optimistic
    `WHERE result_summary = <original>` update matches nothing and the row
    is skipped, not overwritten."""
    db_path = make_ledger(tmp_path)
    task_id = "vi-" + "e0" * 6
    seed_done_task(db_path, task_id, FLAT_TEXT)
    drifted_text = "Someone already answered this a different way in the meantime."
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET result_summary = ? WHERE task_id = ?",
                     (drifted_text, task_id))
    conn.close()

    good_after = FLAT_TEXT.replace(" 2) ", "\n\n2) ")
    preview_path = tmp_path / "stale-preview.json"
    preview_path.write_text(json.dumps([
        {"task_id": task_id, "before": FLAT_TEXT, "after": good_after,
         "verdict": "accepted", "reason": None},
    ]), encoding="utf-8")

    proc = run_migrate("--apply", "--from-preview", str(preview_path), pa_home=tmp_path)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert f"{task_id}: skipped (row changed underneath)" in proc.stdout
    task = fetch_task(db_path, task_id)
    assert task["result_summary"] == drifted_text  # never overwritten


def test_apply_from_preview_applies_without_invoking_the_command(tmp_path):
    db_path = make_ledger(tmp_path)
    task_id = "vi-" + "f0" * 6
    seed_done_task(db_path, task_id, FLAT_TEXT)
    good_after = FLAT_TEXT.replace(" 2) ", "\n\n2) ")
    preview_path = tmp_path / "reviewed-preview.json"
    preview_path.write_text(json.dumps([
        {"task_id": task_id, "before": FLAT_TEXT, "after": good_after,
         "verdict": "accepted", "reason": None},
    ]), encoding="utf-8")
    call_log = tmp_path / "calls.log"
    good_cmd = write_reformatter(tmp_path, "good_reformat.py", GOOD_REFORMAT_SRC)

    proc = run_migrate("--apply", "--from-preview", str(preview_path),
                        "--llm-cmd", good_cmd, pa_home=tmp_path,
                        extra_env={"CALL_LOG_PATH": str(call_log)})
    assert proc.returncode == 0, proc.stderr
    assert not call_log.exists(), "the LLM command must not be invoked under --from-preview"
    task = fetch_task(db_path, task_id)
    assert task["result_summary"] == good_after


def test_apply_equivalence_failure_leaves_row_untouched_and_exits_2(tmp_path):
    db_path = make_ledger(tmp_path)
    task_id = "vi-" + "aa" * 5 + "bb"
    seed_done_task(db_path, task_id, FLAT_TEXT)
    bad_cmd = write_reformatter(tmp_path, "bad_reformat.py", BAD_REFORMAT_SRC)
    proc = run_migrate("--apply", "--llm-cmd", bad_cmd, pa_home=tmp_path)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert f"{task_id}: rejected (content changed)" in proc.stdout
    task = fetch_task(db_path, task_id)
    assert task["result_summary"] == FLAT_TEXT  # never overwritten
