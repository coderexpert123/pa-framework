#!/usr/bin/env python3
"""Emit telemetry events for a voice-inbox task (the worker-side checkpoint feed).

Invoked BY the worker that owns the task, per the route injection text:

    python "<repo>/projects/voice-inbox/scripts/task_telemetry.py" start --task vi-x
    python "<repo>/projects/voice-inbox/scripts/task_telemetry.py" progress --task vi-x --step "..."
    python "<repo>/projects/voice-inbox/scripts/task_telemetry.py" --event task.failed \\
        --task vi-x --reason "..."

The script is the worker-side writer of progress / result-ready / failed
events and moves the task through the state machine exactly as the ledger's
transition table allows: a progress event from `routed` moves the task to
`running`; from `running` it appends without a state change. It never chats.
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


# Event kinds this script may write; everything else in the vocabulary is
# owned by the API (received / input_received / cancelled), route_task.py
# (routed / rerouted), task_input.py (input_needed) or task_complete.py
# (completed).
TELEMETRY_EVENT_KINDS = ["task.progress", "task.result_ready", "task.failed"]

STEP_MAX = 60
PREVIEW_MAX = 200
FAILED_REASON_MAX = 300
EVENT_SUMMARY_MAX = 200


def _truncate(value: str, cap: int) -> str:
    return value[:cap]


def write_event(conn: sqlite3.Connection, task: dict, kind: str,
                payload: dict, summary: str | None, ts: str) -> str:
    """Insert one event row; caller owns the open transaction."""
    ref_id = make_ref_id()
    conn.execute(
        "INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (task["tenant_id"], task["task_id"], ref_id, kind,
         _truncate(summary, EVENT_SUMMARY_MAX) if summary is not None else None,
         json.dumps(payload, ensure_ascii=False), ts),
    )
    return ref_id


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Emit voice-inbox task telemetry")
    parser.add_argument("command", nargs="?", choices=["start", "progress"],
                        help="shorthand for the two progress forms")
    parser.add_argument("--task", help="task id (vi-...)")
    parser.add_argument("--event", choices=TELEMETRY_EVENT_KINDS,
                        help="explicit event kind (alternative to the command form)")
    parser.add_argument("--step", help="short progress label, <=60 chars")
    parser.add_argument("--preview", help="result preview, <=200 chars (task.result_ready)")
    parser.add_argument("--reason", help="failure reason, required for task.failed")
    parser.add_argument("--summary", help="model-phrased event summary, truncated to 200 chars")
    args = parser.parse_args(normalize_argv(argv))

    if not args.task:
        parser.error("--task is required")
    if not args.command and not args.event:
        parser.error("give a command (start|progress) or --event <kind>")
    kind = args.event if args.event else "task.progress"
    if args.command == "progress" and not args.step:
        parser.error("--step is required for progress")
    if kind == "task.progress" and not args.step and args.command != "start":
        parser.error("--step is required for a progress event (use the start command for the default label)")
    if kind == "task.failed" and not args.reason:
        parser.error("--reason is required for task.failed")

    step = args.step if args.step else ("started" if args.command == "start" else None)
    payload: dict
    if kind == "task.progress":
        payload = {"step": _truncate(step, STEP_MAX)}
    elif kind == "task.result_ready":
        payload = {"preview": _truncate(args.preview, PREVIEW_MAX)} if args.preview else {}
    else:  # task.failed — reason is required (checked above)
        payload = {"reason": _truncate(args.reason, FAILED_REASON_MAX)}

    summary_text = _truncate(args.summary, EVENT_SUMMARY_MAX) if args.summary is not None else None
    conn = open_ledger()
    try:
        with conn:
            # The read happens inside the write lock (begin_immediate), so the
            # non-transitional paths below check a state no writer can change
            # under them; transitions are gated by transition_task's UPDATE.
            begin_immediate(conn)
            row = conn.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (args.task,)
            ).fetchone()
            if row is None:
                fail(f"task not found: {args.task}")
            task = dict(row)
            state = task["state"]
            ts = now_iso()
            ref_id = None

            if kind == "task.progress":
                if state in ("routed", "received"):
                    # The first progress checkpoint moves the task to running —
                    # covers both the routed shortcut and the received->running
                    # transcribed-while-worker-already-progressing shortcut.
                    ref_id, ts = transition_task(
                        conn, args.task, "running", kind, payload, summary=summary_text,
                        narrow="state IN ('received', 'routed')",
                        refuse=lambda s: (f"task {args.task} is {s}; a progress event is valid "
                                          "from received, routed or running"))
                elif state != "running":
                    fail(f"task {args.task} is {state}; a progress event is valid "
                         "from received, routed or running")
            elif kind == "task.failed":
                ref_id, ts = transition_task(
                    conn, args.task, "failed", kind, payload, summary=summary_text,
                    refuse=lambda s: f"task {args.task} is {s}; it cannot fail (terminal)")
            else:  # task.result_ready — an in-flight announcement, no state change
                if state in ("transcribe_failed", "done", "failed", "cancelled"):
                    fail(f"task {args.task} is {state}; no further events are accepted")

            # The worker records its own identity. PA_WORKER_RESOURCE is the
            # worker-pids `skill` key (the LANE) and PA_WORKER_DISPATCH_ID is
            # this DISPATCH; a bare topic resource is reused by every message
            # in the topic, so a later kill needs both to prove it is still
            # aiming at the dispatch it meant. PA_WORKER_CLI / _MODEL / _EFFORT
            # (schema v15) are the answer's provenance, stamped by the
            # dispatching session's env; a NULL means the run was not
            # instrumented (fallback dispatches) and the PWA fails open.
            # PA_ROUTING_* (schema v16) are the serving turn's routing
            # metadata (decision / placement / target / steer / steer decider
            # / effort projection / pre-success failover count), stamped by
            # the same env path; absent env -> NULL, fail open. Later
            # progress events overwrite earlier values (LAST WRITER WINS —
            # the same semantics worker_* already has): a steer or a
            # re-resume re-stamps.
            # Written together in one UPDATE so the set can never be
            # half-recorded.
            resource = (os.environ.get("PA_WORKER_RESOURCE") or "").strip()
            dispatch_id = (os.environ.get("PA_WORKER_DISPATCH_ID") or "").strip()
            cli = (os.environ.get("PA_WORKER_CLI") or "").strip()
            model = (os.environ.get("PA_WORKER_MODEL") or "").strip()
            effort = (os.environ.get("PA_WORKER_EFFORT") or "").strip()
            router_decision = (os.environ.get("PA_ROUTING_DECISION") or "").strip()
            router_placement = (os.environ.get("PA_ROUTING_PLACEMENT") or "").strip()
            router_target = (os.environ.get("PA_ROUTING_TARGET") or "").strip()
            router_steer = (os.environ.get("PA_ROUTING_STEER") or "").strip()
            router_steer_by = (os.environ.get("PA_ROUTING_STEER_BY") or "").strip()
            router_effort_proj = (os.environ.get("PA_ROUTING_EFFORT_PROJ") or "").strip()
            router_failovers = (os.environ.get("PA_ROUTING_FAILOVERS") or "").strip()
            if kind == "task.progress" and resource:
                conn.execute(
                    "UPDATE tasks SET worker_resource = ?, worker_dispatch_id = ?,"
                    " worker_cli = ?, worker_model = ?, worker_effort = ?,"
                    " router_decision = ?, router_placement = ?, router_target = ?,"
                    " router_steer = ?, router_steer_by = ?, router_effort_proj = ?,"
                    " router_failovers = ?,"
                    " updated_at = ? WHERE task_id = ?",
                    (resource, dispatch_id or None, cli or None, model or None,
                     effort or None, router_decision or None,
                     router_placement or None, router_target or None,
                     router_steer or None, router_steer_by or None,
                     router_effort_proj or None,
                     int(router_failovers) if router_failovers.isdigit() else None,
                     ts, args.task),
                )

            if ref_id is None:
                ref_id = write_event(conn, task, kind, payload, args.summary, ts)
    finally:
        conn.close()

    emit({"task_id": args.task, "kind": kind, "task_state": (
        "running" if kind == "task.progress" else
        "failed" if kind == "task.failed" else
        task["state"]
    ), "ref_id": ref_id})


if __name__ == "__main__":
    main()
