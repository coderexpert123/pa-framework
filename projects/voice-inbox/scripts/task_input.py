#!/usr/bin/env python3
"""Typed input requests for voice-inbox tasks (the worker-side widget creator).

Invoked BY the worker that owns the task, per the route injection text:

    python "<repo>/projects/voice-inbox/scripts/task_input.py" create --help
    python "<repo>/projects/voice-inbox/scripts/task_input.py" create --task vi-x \\
        --kind choice --prompt "Which plan?" --param options='["Plan A","Plan B"]'
    python "<repo>/projects/voice-inbox/scripts/task_input.py" check --task vi-x
    python "<repo>/projects/voice-inbox/scripts/task_input.py" cancel --task vi-x \\
        --reason "answered in chat"

`create` is the ONLY way a worker creates a request. It validates against the
six-kind widget contract (the exact-key mirror of the ledger's validator —
unknown kinds, unknown param keys, oversize copy and wrong types all reject),
inserts the request row, moves the task running -> awaiting_input and writes
the paired `task.input_needed` event. `check` is the answer-forward: when an
answer has arrived it prints the pointer line so the resumed worker turn reads
the answer from its file path, never from chat. `cancel` withdraws the task's
still-pending requests (the bot's reverse-clear when the answer lands on the
Telegram side). The script never chats.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
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


# ---------------------------------------------------------------------------
# Attention page — retired to opt-in (2026-09-11, vi-08b2360d27b3): the
# operator-facing channel is now the web app's browser notifications, and this
# best-effort `pa ping` (Windows toast + operator private-chat mirror) no-ops
# unless PA_ATTENTION_ENABLED=1. The sanctioned pa send path is kept
# (ref-minted, logged; this script never calls the Telegram Bot API itself) so
# a deliberate re-enable pages here too. Model-authored copy rides a temp JSON
# payload file, never the command line, so no quoting surface exists.
# PA_NOTIFY_DISABLED=1 remains the kill switch (the test suites' global gate).
# Never raises and never blocks the ledger outcome: a lost page loses a
# notification, not the request.
# ---------------------------------------------------------------------------
def fire_attention_ping(title: str, body: str) -> None:
    if os.environ.get("PA_NOTIFY_DISABLED") == "1":
        return
    exe = shutil.which("pa")
    if not exe:
        return
    payload_path = None
    try:
        fd, payload_path = tempfile.mkstemp(suffix=".json", prefix="pa-ping-")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"title": title, "body": body}, handle, ensure_ascii=False)
        subprocess.Popen(
            [exe, "ping", "--payload-file", payload_path, "--cleanup"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        if payload_path and os.path.exists(payload_path):
            try:
                os.unlink(payload_path)
            except OSError:
                pass


# --- Widget contract (the exact-key mirror of the ledger's validator) -------

# Providers the generalized oauth widget accepts (the auth broker's frozen
# list, Phase A) — byte-synced against contracts.ts's OAUTH_PROVIDERS by
# test_oauth_providers_sync.
OAUTH_PROVIDERS = ["google"]

# Exact allowed param keys per kind; anything outside the kind's set rejects.
# This is what makes a model-supplied auth_url impossible: it is not a key of
# the oauth param set, so it cannot pass validation.
INPUT_PARAM_KEYS: dict[str, list[str]] = {
    "secret": ["placeholder"],
    "text": ["placeholder", "multiline"],
    "choice": ["options"],
    "confirm": [],
    "oauth": ["provider", "user_code", "confirmable"],
    "file": ["accept", "max_bytes"],
    "form": ["steps"],
}

# Create-side limits (the answer-side limits live in the API's validator).
INPUT_LIMITS = {
    "PROMPT_MAX": 500,
    "PLACEHOLDER_MAX": 100,
    "CHOICE_OPTIONS_MAX": 6,
    "CHOICE_OPTION_MAX": 60,
    "FILE_ACCEPT_MAX": 5,
    "FILE_MAX_BYTES_MAX": 26_214_400,
    "FORM_STEPS_MAX": 8,
    "FORM_STEP_TITLE_MAX": 60,
    "FORM_STEP_DECIDE_MAX": 200,
    "FORM_OPTION_NOTE_MAX": 200,
    "FORM_STEPS_JSON_MAX": 20_000,
}

EVENT_SUMMARY_MAX = 200


def _check_placeholder(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > INPUT_LIMITS["PLACEHOLDER_MAX"]:
        return (f"placeholder must be a string of at most "
                f"{INPUT_LIMITS['PLACEHOLDER_MAX']} chars")
    return None


def validate_form_steps(steps: object) -> str | None:
    """The `form` steps validator — the exact-key mirror of contracts.ts's
    checkFormSteps (§ the form contract); returns an error string or None.
    Hostile input never throws."""
    if not isinstance(steps, list) or not (1 <= len(steps) <= INPUT_LIMITS["FORM_STEPS_MAX"]):
        return f"params.steps must be an array of 1..{INPUT_LIMITS['FORM_STEPS_MAX']} steps"
    seen_ids: set[str] = set()
    for index, step in enumerate(steps):
        where = f"params.steps[{index}]"
        if not isinstance(step, dict):
            return f"{where} must be an object"
        step_keys = list(step)
        is_locked = "locked" in step
        if is_locked:
            if step["locked"] is not True:
                return f"{where}.locked must be true"
            allowed = ["id", "title", "decide", "locked", "answer"]
            for key in step_keys:
                if key not in allowed:
                    return f'{where}: unknown field "{key}" for a locked step'
        else:
            allowed = ["id", "title", "decide", "options", "preselected"]
            for key in step_keys:
                if key not in allowed:
                    return f'{where}: unknown field "{key}"'
        step_id = step.get("id")
        if not isinstance(step_id, str) or not re.fullmatch(
                r"[a-z0-9][a-z0-9-]{0,39}", step_id):
            return f"{where}.id must match ^[a-z0-9][a-z0-9-]{{0,39}}$"
        if step_id in seen_ids:
            return f'{where}.id "{step_id}" is not unique'
        seen_ids.add(step_id)
        for key, max_len in (("title", INPUT_LIMITS["FORM_STEP_TITLE_MAX"]),
                             ("decide", INPUT_LIMITS["FORM_STEP_DECIDE_MAX"])):
            value = step.get(key)
            if not isinstance(value, str) or not (1 <= len(value) <= max_len):
                return f"{where}.{key} must be a string of 1..{max_len} chars"
        if is_locked:
            answer = step.get("answer")
            if not isinstance(answer, str) or not (
                    1 <= len(answer) <= INPUT_LIMITS["FORM_STEP_DECIDE_MAX"]):
                return (f"{where}.answer must be a string of "
                        f"1..{INPUT_LIMITS['FORM_STEP_DECIDE_MAX']} chars")
            if "options" in step or "preselected" in step:
                return f"{where}: a locked step carries no options"
            continue
        options = step.get("options")
        if not isinstance(options, list) or not (
                1 <= len(options) <= INPUT_LIMITS["CHOICE_OPTIONS_MAX"]):
            return (f"{where}.options must be an array of "
                    f"1..{INPUT_LIMITS['CHOICE_OPTIONS_MAX']} options")
        labels: list[str] = []
        for opt_index, option in enumerate(options):
            opt_where = f"{where}.options[{opt_index}]"
            if not isinstance(option, dict):
                return f"{opt_where} must be an object"
            for key in option:
                if key not in ("label", "note"):
                    return f'{opt_where}: unknown field "{key}"'
            label = option.get("label")
            note = option.get("note")
            if not isinstance(label, str) or not (
                    1 <= len(label) <= INPUT_LIMITS["CHOICE_OPTION_MAX"]):
                return (f"{opt_where}.label must be a string of "
                        f"1..{INPUT_LIMITS['CHOICE_OPTION_MAX']} chars")
            if not isinstance(note, str) or not (
                    1 <= len(note) <= INPUT_LIMITS["FORM_OPTION_NOTE_MAX"]):
                return (f"{opt_where}.note must be a string of "
                        f"1..{INPUT_LIMITS['FORM_OPTION_NOTE_MAX']} chars")
            labels.append(label)
        if "preselected" in step and step["preselected"] not in labels:
            return f"{where}.preselected must equal exactly one option label"
    if len(json.dumps(steps, ensure_ascii=False, separators=(",", ":"))) > \
            INPUT_LIMITS["FORM_STEPS_JSON_MAX"]:
        return (f"params.steps must serialize to at most "
                f"{INPUT_LIMITS['FORM_STEPS_JSON_MAX']} chars")
    return None


def validate_request(kind: str, prompt: object, params: object) -> str | None:
    """Mirror of the ledger's exact-key validator; returns an error string or None."""
    if not isinstance(prompt, str) or not (1 <= len(prompt) <= INPUT_LIMITS["PROMPT_MAX"]):
        return f"prompt must be 1..{INPUT_LIMITS['PROMPT_MAX']} chars"
    if not isinstance(params, dict):
        return "params must be an object"
    allowed = INPUT_PARAM_KEYS[kind]
    for key in params:
        if key not in allowed:
            return f'params: unknown field "{key}" for kind "{kind}"'
    if kind == "secret":
        if "placeholder" in params:
            return _check_placeholder(params["placeholder"])
        return None
    if kind == "text":
        if "placeholder" in params:
            error = _check_placeholder(params["placeholder"])
            if error:
                return error
        if "multiline" in params and not isinstance(params["multiline"], bool):
            return "params.multiline must be a boolean"
        return None
    if kind == "choice":
        options = params.get("options")
        if not isinstance(options, list) or not (1 <= len(options) <= INPUT_LIMITS["CHOICE_OPTIONS_MAX"]):
            return (f"params.options must be an array of 1..{INPUT_LIMITS['CHOICE_OPTIONS_MAX']} options")
        for index, option in enumerate(options):
            if not isinstance(option, str) or not (1 <= len(option) <= INPUT_LIMITS["CHOICE_OPTION_MAX"]):
                return (f"params.options[{index}] must be a string of "
                        f"1..{INPUT_LIMITS['CHOICE_OPTION_MAX']} chars")
        return None
    if kind == "confirm":
        return None
    if kind == "form":
        return validate_form_steps(params.get("steps"))
    if kind == "oauth":
        provider = params.get("provider")
        if not isinstance(provider, str) or provider not in OAUTH_PROVIDERS:
            return f"params.provider must be one of {', '.join(OAUTH_PROVIDERS)}"
        user_code = params.get("user_code")
        if user_code is not None:
            if not isinstance(user_code, str) or not re.fullmatch(
                    r"[A-Za-z0-9][A-Za-z0-9-]{3,15}", user_code):
                return "params.user_code must be 4..16 chars of A-Z, a-z, 0-9 and -"
        confirmable = params.get("confirmable")
        if confirmable is not None and not isinstance(confirmable, bool):
            return "params.confirmable must be a boolean"
        return None
    # file
    if "accept" in params:
        accept = params["accept"]
        if not isinstance(accept, list) or not (1 <= len(accept) <= INPUT_LIMITS["FILE_ACCEPT_MAX"]):
            return (f"params.accept must be an array of 1..{INPUT_LIMITS['FILE_ACCEPT_MAX']} "
                    "dot-extensions")
        for index, ext in enumerate(accept):
            if not isinstance(ext, str) or not ext.startswith(".") or len(ext) < 2:
                return f'params.accept[{index}] must be a dot-extension like ".pdf"'
    if "max_bytes" in params:
        max_bytes = params["max_bytes"]
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or not (
                1 <= max_bytes <= INPUT_LIMITS["FILE_MAX_BYTES_MAX"]):
            return (f"params.max_bytes must be an integer of 1.."
                    f"{INPUT_LIMITS['FILE_MAX_BYTES_MAX']}")
    return None


def parse_param(raw: str) -> tuple[str, object]:
    """`--param key=value`; the value parses as JSON when it can, else stays a string."""
    key, sep, value = raw.partition("=")
    if not sep or not key:
        raise argparse.ArgumentTypeError(f"--param expects key=value, got: {raw}")
    try:
        return key, json.loads(value)
    except json.JSONDecodeError:
        return key, value


def cmd_create(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if args.kind not in INPUT_KINDS:
        fail(f"invalid input request: kind must be one of {', '.join(INPUT_KINDS)}")
    if args.kind == "form":
        if args.param:
            fail("form steps come from --steps-file; --param is not supported for this kind")
        if not args.steps_file:
            fail("kind form requires --steps-file <path>")
        try:
            with open(args.steps_file, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
        except OSError as exc:
            fail(f"--steps-file cannot be read: {exc}")
        except json.JSONDecodeError as exc:
            fail(f"--steps-file is not valid JSON: {exc}")
        steps = loaded.get("steps") if isinstance(loaded, dict) else loaded
        params = {"steps": steps}
        error = validate_request(args.kind, args.prompt, params)
        if error:
            fail(f"invalid input request: {error}")
    else:
        if args.steps_file:
            fail("--steps-file is only valid with --kind form")
        params = dict(args.param or [])
        error = validate_request(args.kind, args.prompt, params)
        if error:
            fail(f"invalid input request: {error}")
    if args.title is not None and not args.title.strip():
        parser.error("--title must not be empty")
    if args.recap is not None and not args.recap.strip():
        parser.error("--recap must not be empty")

    conn = open_ledger()
    try:
        with conn:
            begin_immediate(conn)
            row = conn.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (args.task,)
            ).fetchone()
            if row is None:
                fail(f"task not found: {args.task}")
            task = dict(row)
            request_id = "ir-" + secrets.token_hex(6)
            # Legal only from running (the transition table's awaiting_input
            # row); the gate is transition_task's UPDATE predicate.
            ref_id, ts = transition_task(
                conn, args.task, "awaiting_input", "task.input_needed",
                {"request_id": request_id, "kind": args.kind},
                summary=args.summary[:EVENT_SUMMARY_MAX] if args.summary else None,
                refuse=lambda state: (f"task {args.task} is {state}; input requests are created "
                                      "from running"))
            conn.execute(
                "INSERT INTO input_requests"
                " (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
                (request_id, args.task, task["tenant_id"], args.kind, args.prompt,
                 json.dumps(params, ensure_ascii=False, sort_keys=True), ts),
            )
            # A question leaves a standing action item alone unless it names a
            # new one — "__keep__" when --next was not supplied at all.
            set_conversation_meta(conn, task["conversation_id"], task["tenant_id"], ts,
                                  title=args.title, recap=args.recap,
                                  next_action=args.next if args.next is not None else "__keep__")
    finally:
        conn.close()

    # Action-needed page: a pending widget sat invisible until the app was
    # opened (2026-09-11) — the mirror is what reaches the operator.
    fire_attention_ping(
        args.title or "PA needs your input",
        f"{args.prompt}\nTask: {args.task}",
    )

    emit({"task_id": args.task, "request_id": request_id, "kind": args.kind,
          "task_state": "awaiting_input", "ref_id": ref_id})


CANCEL_REASON_MAX = 200


def cmd_cancel(args: argparse.Namespace) -> None:
    """Withdraw the task's still-pending input requests (the bot's reverse-clear).

    Inside one transaction: every `pending` input_requests row of the task
    flips to `cancelled`; if at least one flipped AND the task is
    `awaiting_input`, the task returns to `running` (a legal transition). No
    event row is written — no existing kind fits a cancel; the app renders
    `input_requests.status`, and the caller's log plus this stdout JSON are
    the audit. A task with no pending requests is a no-op success
    (`cancelled: 0`). `--reason` is audit-only: it appears in the caller's log
    line and nowhere in the ledger.
    """
    if args.reason is not None and len(args.reason.strip()) > CANCEL_REASON_MAX:
        fail(f"--reason must be at most {CANCEL_REASON_MAX} chars")

    conn = open_ledger()
    try:
        with conn:
            begin_immediate(conn)
            row = conn.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (args.task,)
            ).fetchone()
            if row is None:
                fail(f"task not found: {args.task}")
            cur = conn.execute(
                "UPDATE input_requests SET status = 'cancelled'"
                " WHERE task_id = ? AND status = 'pending'",
                (args.task,),
            )
            cancelled = cur.rowcount
            state = dict(row)["state"]
            if cancelled >= 1 and state == "awaiting_input":
                # No event row: no existing kind fits a withdrawal (see docstring).
                transition_task(
                    conn, args.task, "running", None,
                    narrow="state = 'awaiting_input'",
                    refuse=lambda s: (f"task {args.task} is {s}; the question was withdrawn "
                                      "but the task no longer waits on it"))
                state = "running"
    finally:
        conn.close()

    emit({"task_id": args.task, "cancelled": cancelled, "task_state": state})


def cmd_check(args: argparse.Namespace) -> None:
    """The answer-forward: report each request's status; answered ones as pointer lines."""
    conn = open_ledger()
    try:
        if args.request:
            rows = conn.execute(
                "SELECT * FROM input_requests WHERE task_id = ? AND request_id = ?"
                " ORDER BY created_at ASC",
                (args.task, args.request),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM input_requests WHERE task_id = ? ORDER BY created_at ASC",
                (args.task,),
            ).fetchall()
    finally:
        conn.close()

    if not rows:
        suffix = f" matching {args.request}" if args.request else ""
        print(f"No input requests for {args.task}{suffix}.")
        return
    for row in rows:
        request = dict(row)
        if request["status"] == "answered":
            if os.path.exists(request["answer_pointer"]):
                # The pinned resume-delivery line: the value itself never
                # travels through chat — the worker reads it from the file at
                # the pointer.
                print(f"Answer for {request['request_id']} is at {request['answer_pointer']}"
                      " — read it; never repeat its value in chat.")
            else:
                # Delivered-once: the reaper (or a fast delete-once-read
                # worker) has already erased the answer file.
                print(f"Answer for {request['request_id']} was delivered and has been erased "
                      "(answers to secret requests are kept only briefly). Ask again with "
                      "task_input.py create if you still need it.")
        elif request["status"] == "pending":
            print(f"Request {request['request_id']} is still pending "
                  f"(kind={request['kind']}).")
        else:
            print(f"Request {request['request_id']} is {request['status']}.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Create, check or cancel typed input requests for a voice-inbox task")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="create an input request (from running)")
    create.add_argument("--task", required=True, help="task id (vi-...)")
    create.add_argument("--kind", required=True,
                        help=f"widget kind: {', '.join(INPUT_KINDS)}")
    create.add_argument("--prompt", required=True,
                        help="plain-language question for the operator, 1..500 chars — "
                             "no ids, tool names, file paths, or technical terms; "
                             "phrase it as a person would ask it")
    create.add_argument("--param", action="append", type=parse_param, metavar="KEY=VALUE",
                        help="per-kind param; value parses as JSON when it can "
                             "(e.g. options='[\"a\",\"b\"]'); choice-option labels "
                             "are plain product language — no ids, tool names, "
                             "file paths, or technical terms")
    create.add_argument("--steps-file", help="form only: path to a JSON file holding "
                        "the steps array (bare array or {\"steps\": [...]}); never "
                        "pass steps on the command line")
    create.add_argument("--summary", help="model-phrased event summary, truncated to 200 chars")
    create.add_argument("--title", help="short noun phrase naming what this conversation is "
                                        "about (<=60 chars); overwrites any stored title")
    create.add_argument("--recap", help="one or two plain sentences saying what is happening "
                                        "and where it stands (<=400 chars)")
    create.add_argument("--next", help="one line naming what the operator has to do next; "
                                       "omitted leaves any stored action item untouched, "
                                       "empty clears it")
    create.set_defaults(func=cmd_create, parser=parser)

    check = subparsers.add_parser("check", help="report request status / answer pointers")
    check.add_argument("--task", required=True, help="task id (vi-...)")
    check.add_argument("--request", help="single request id (ir-...)")
    check.set_defaults(func=cmd_check)

    cancel = subparsers.add_parser("cancel", help="withdraw the task's pending input requests")
    cancel.add_argument("--task", required=True, help="task id (vi-...)")
    cancel.add_argument("--reason", help=f"why the ask is withdrawn, <= {CANCEL_REASON_MAX} chars "
                                         "(audit-only: the caller's log, never the ledger)")
    cancel.set_defaults(func=cmd_cancel)

    args = parser.parse_args(normalize_argv(argv))
    if hasattr(args, "parser"):
        args.func(args, args.parser)
    else:
        args.func(args)


if __name__ == "__main__":
    main()
