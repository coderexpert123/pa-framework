#!/usr/bin/env python3
"""Record a voice transcription result for a voice-inbox task (the write-back step).

Invoked BY the deterministic transcription path — the telegram bot's poll-tick
drain and the pa voice-inbox-fallback job, one shared implementation in
pa/src/lib/voice-inbox-transcribe.ts (2026-09-16). Workers never call it:

    python "<repo>/projects/voice-inbox/scripts/task_transcribe.py" --task vi-x \\
        --transcript "<transcript text>" [--engine <name>]

or, when transcription itself failed:

    python "<repo>/projects/voice-inbox/scripts/task_transcribe.py" --task vi-x \\
        --fail --reason "<why>" [--code too_short]

Deterministic duties only: validate that the task sits in the `transcribing`
stage, then either write the transcript back (state `received`, the request
text becomes the transcript, paired `task.transcribed` event) or move the task
to the terminal `transcribe_failed` with a `task.failed` event. The script
never transcribes audio, never writes the route queue, and never chats —
routing stays a separate route_task.py decision made after the transcript
lands.

`--code` (AI-223, optional, `--fail` only) is a machine-readable failure
classifier appended to the `task.failed` payload alongside the unchanged
`reason` text — `too_short` for a sub-floor/empty/near-silence-artefact
recording, so the PWA can hide it from the list and the triage count instead
of leaving it stuck as an unresolvable "Not placed yet" row. Omitted for any
other failure (a real transcription/infra error the operator should still see).
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sqlite3
import sys
from datetime import datetime, timezone
from typing import NoReturn

# ---------------------------------------------------------------------------
# BEGIN SHARED LEDGER HELPER
# Byte-identical in route_task.py, task_telemetry.py, task_input.py,
# task_complete.py and task_transcribe.py; the sync test
# (tests/test_worker_scripts.py) asserts equality across all five copies.
# Edit all five together, never one.
# Opens the ledger the API server owns; NEVER creates or alters schema.
# ---------------------------------------------------------------------------
TASK_STATES = ['received', 'transcribing', 'routed', 'running', 'awaiting_input',
               'transcribe_failed', 'done', 'failed', 'cancelled']
TASK_EVENT_KINDS = ['task.received', 'task.routed', 'task.progress', 'task.input_needed',
                    'task.input_received', 'task.result_ready', 'task.completed',
                    'task.failed', 'task.cancelled', 'task.rerouted', 'task.transcribed']
INPUT_KINDS = ['secret', 'text', 'choice', 'oauth', 'file', 'confirm', 'form']
# Mirrors the ledger's transition table (source state -> allowed targets);
# done/cancelled are terminal; failed/transcribe_failed leave only by the operator's cancel.
TASK_TRANSITIONS = {
    'received': ['routed', 'running', 'failed', 'cancelled'],
    'transcribing': ['received', 'transcribe_failed', 'cancelled'],
    'routed': ['routed', 'running', 'done', 'failed', 'cancelled'],
    'running': ['routed', 'awaiting_input', 'done', 'failed', 'cancelled'],
    'awaiting_input': ['routed', 'running', 'failed', 'cancelled'],
    'transcribe_failed': ['cancelled'],
    'done': [],
    'failed': ['cancelled'],
    'cancelled': [],
}


def pa_home() -> str:
    """PA_HOME from env or ~/.pa (same resolution as the other pa python helpers)."""
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def ledger_path() -> str:
    return os.path.join(pa_home(), "voice-inbox", "ledger.sqlite")


def open_ledger() -> sqlite3.Connection:
    """Open the existing ledger read/write with the production pragmas.

    Refuses to create anything: a missing or schema-less file means the API
    server has not started yet, and the worker scripts must not invent the
    schema — the sync test pins them to the ledger's own SQL instead.
    """
    path = ledger_path()
    if not os.path.exists(path):
        fail("ledger missing: start the server first")
    conn = sqlite3.connect(path, timeout=3)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 3000")
    conn.execute("PRAGMA journal_mode = WAL")
    has_tasks = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone()
    if not has_tasks:
        conn.close()
        fail("ledger missing: start the server first")
    return conn


def now_iso() -> str:
    """UTC ISO-8601 with milliseconds and Z suffix (the TS writers' toISOString shape)."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_ref_id() -> str:
    """`s-<12 hex>` — the ref-ID every event carries, minted by its writer."""
    return "s-" + secrets.token_hex(6)


# Conversation summary lines (AI-222). Clamps are the ledger's, not a per-script
# choice; the TS twins are CONVERSATION_TITLE_MAX / _RECAP_MAX / _NEXT_ACTION_MAX
# in src/ledger.ts.
TITLE_MAX = 60
RECAP_MAX = 400
NEXT_ACTION_MAX = 200


def set_conversation_meta(conn, conversation_id: str, tenant_id: str, ts: str,
                          title: str | None = None, recap: str | None = None,
                          next_action: object = "__keep__",
                          title_if_absent: bool = False) -> None:
    """Partial upsert of one conversation's summary lines.

    Supplied values write (clamped); omitted ones are untouched. `next_action`
    takes the sentinel "__keep__" for "not supplied", None for "clear", a string
    for "set". `title_if_absent` writes the title only when none is stored — the
    routing worker's title is an INITIAL title and must never overwrite one a
    working worker chose (AI-222 D4).
    """
    conn.execute(
        "INSERT OR IGNORE INTO conversation_meta"
        " (conversation_id, tenant_id, updated_at) VALUES (?, ?, ?)",
        (conversation_id, tenant_id, ts),
    )
    sets: list[str] = []
    params: list[object] = []
    if title is not None:
        sets.append("title = ?" if not title_if_absent else "title = COALESCE(title, ?)")
        params.append(title.strip()[:TITLE_MAX])
    if recap is not None:
        sets.append("recap = ?")
        params.append(recap.strip()[:RECAP_MAX])
    if next_action != "__keep__":
        sets.append("next_action = ?")
        params.append(None if next_action is None
                      else (str(next_action).strip()[:NEXT_ACTION_MAX] or None))
    if not sets:
        return
    sets.append("updated_at = ?")
    params.append(ts)
    params.append(conversation_id)
    conn.execute(
        "UPDATE conversation_meta SET " + ", ".join(sets) + " WHERE conversation_id = ?",
        params,
    )


def emit(result: dict) -> None:
    """One JSON line on stdout (ascii-escaped; zero console-encoding risk)."""
    print(json.dumps({"ok": True, **result}))


def fail(message: str, code: int = 1) -> NoReturn:
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(code)


# Guarded transitions (thread lifecycle, 2026-09-17). Every worker-side state
# change goes through transition_task(): ONE UPDATE whose WHERE names the legal
# source states from TASK_TRANSITIONS (plus an optional caller predicate that
# can only narrow), a rowcount check, and the paired event, all inside one
# BEGIN IMMEDIATE transaction. Zero rows = refusal: nothing is written and the
# script exits 1. Mirrors src/ledger.ts transitionTask: entering routed clears
# the worker identity; leaving awaiting_input for any state but running expires
# the task's OWN pending asks (cancelled when the target is cancelled).


def begin_immediate(conn) -> None:
    """Take the ledger write lock now, so every read that follows sees the
    state the write will see. No-op when a transaction is already open."""
    if conn.in_transaction:
        return
    try:
        conn.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as exc:
        fail(f"ledger busy: {exc}")


def source_states_for(to_state: str) -> list[str]:
    """Every state TASK_TRANSITIONS allows into `to_state`, in TASK_STATES order."""
    return [state for state in TASK_STATES if to_state in TASK_TRANSITIONS.get(state, [])]


def transition_task(conn, task_id: str, to_state: str, event_kind: str | None,
                    payload: dict | None = None, summary: str | None = None,
                    sets: list | None = None, narrow: str | None = None,
                    narrow_params: tuple = (), refuse=None) -> tuple[str | None, str]:
    """Move one task to `to_state` atomically and write its paired event.

    `sets` holds extra `(sql_fragment, value)` assignments, each fragment with
    exactly one `?` (e.g. `("result_short = COALESCE(?, result_short)", s)`).
    `narrow` is an extra SQL predicate ANDed onto the source-state gate; it may
    only narrow the gate. `refuse(state)` builds the refusal message from the
    task's current state. `event_kind` None writes no event (task_input.py
    cancel's documented no-event withdrawal). Returns (ref_id or None, ts).
    """
    sources = source_states_for(to_state)
    if not sources:
        fail(f"no state may move to {to_state}")
    begin_immediate(conn)
    row = conn.execute(
        "SELECT tenant_id, state FROM tasks WHERE task_id = ?", (task_id,)
    ).fetchone()
    if row is None:
        fail(f"task not found: {task_id}")
    tenant_id, prior_state = row[0], row[1]
    ts = now_iso()
    assignments = ["state = ?", "updated_at = ?"]
    params: list[object] = [to_state, ts]
    for fragment, value in (sets or []):
        assignments.append(fragment)
        params.append(value)
    if to_state == "routed":
        assignments.append("worker_resource = NULL")
        assignments.append("worker_dispatch_id = NULL")
    where = "task_id = ? AND state IN (" + ", ".join("?" for _ in sources) + ")"
    params.append(task_id)
    params.extend(sources)
    if narrow:
        where += " AND (" + narrow + ")"
        params.extend(narrow_params)
    cursor = conn.execute(
        "UPDATE tasks SET " + ", ".join(assignments) + " WHERE " + where, params)
    if cursor.rowcount != 1:
        current = conn.execute(
            "SELECT state FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        state = current[0] if current is not None else "missing"
        fail(refuse(state) if refuse is not None
             else f"task {task_id} is {state}; it cannot move to {to_state}")
    if prior_state == "awaiting_input" and to_state != "running":
        conn.execute(
            "UPDATE input_requests SET status = ?, answered_at = ?"
            " WHERE task_id = ? AND tenant_id = ? AND status = 'pending'",
            ("cancelled" if to_state == "cancelled" else "expired", ts, task_id, tenant_id))
    ref_id = None
    if event_kind is not None:
        ref_id = make_ref_id()
        conn.execute(
            "INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (tenant_id, task_id, ref_id, event_kind, summary,
             json.dumps(payload or {}, ensure_ascii=False), ts))
    return ref_id, ts


# Flags that take a value. A value starting with a single dash — topic keys do
# (`-100..._<thread>`), and reasons/previews may — would otherwise be eaten by
# argparse as an option string; normalize_argv joins such pairs into
# `--flag=value` form. Double-dash tokens are real flags and stay untouched.
VALUE_FLAGS = ("--task", "--topic", "--reason", "--step", "--preview", "--summary", "--short",
               "--kind", "--prompt", "--param", "--steps-file", "--request", "--event", "--transcript",
               "--engine", "--title", "--recap", "--next", "--attach", "--suggest", "--structured")


def normalize_argv(argv: list[str] | None) -> list[str]:
    if argv is None:
        argv = sys.argv[1:]
    normalized: list[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if (token in VALUE_FLAGS and index + 1 < len(argv)
                and argv[index + 1].startswith("-")
                and not argv[index + 1].startswith("--")):
            normalized.append(f"{token}={argv[index + 1]}")
            index += 2
        else:
            normalized.append(token)
            index += 1
    return normalized


for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass
# END SHARED LEDGER HELPER


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Record a voice transcription result for a voice-inbox task")
    parser.add_argument("--task", required=True, help="task id (vi-...)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--transcript", help="the transcribed text")
    group.add_argument("--fail", action="store_true",
                       help="record that the transcription failed")
    parser.add_argument("--engine", help="transcription engine name (success path)")
    parser.add_argument("--reason", help="failure reason (required with --fail)")
    parser.add_argument("--code", help="machine-readable failure code, e.g. too_short "
                                        "(optional, --fail only)")
    args = parser.parse_args(normalize_argv(argv))

    if args.fail and not args.reason:
        parser.error("--reason is required with --fail")
    if args.code and not args.fail:
        parser.error("--code is only valid with --fail")

    # The ledger precondition is checked first: a server that never started is
    # the more fundamental failure, whatever else is wrong with the request.
    conn = open_ledger()
    try:
        with conn:
            # The transcribing stage is the only legal source: the transcript
            # write-back IS the transcribing stage's success outcome. The gate is
            # transition_task's UPDATE predicate (thread lifecycle, 2026-09-17).
            refuse = (lambda state: f"task {args.task} is {state}; "
                      "transcription write-back is valid only from transcribing")
            if args.fail:
                # AI-223: reason text is unchanged; code is an optional,
                # machine-readable classifier appended LAST (existing keys
                # first) so the PWA can hide a too_short recording from the
                # list/triage count without parsing the reason string.
                fail_payload: dict[str, object] = {"reason": args.reason}
                if args.code:
                    fail_payload["code"] = args.code
                ref_id, _ts = transition_task(
                    conn, args.task, "transcribe_failed", "task.failed", fail_payload,
                    refuse=refuse)
                state = "transcribe_failed"
            else:
                transcript = args.transcript
                if not transcript.strip():
                    fail("transcript must be a non-empty string")
                payload = {"chars": len(transcript)}
                if args.engine:
                    payload["engine"] = args.engine[:60]
                ref_id, _ts = transition_task(
                    conn, args.task, "received", "task.transcribed", payload,
                    sets=[("transcript = ?", transcript), ("request_text = ?", transcript)],
                    refuse=refuse)
                state = "received"
    finally:
        conn.close()

    emit({"task_id": args.task, "state": state, "ref_id": ref_id})


if __name__ == "__main__":
    main()
