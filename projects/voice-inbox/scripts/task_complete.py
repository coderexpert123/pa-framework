#!/usr/bin/env python3
"""Complete a voice-inbox task (the worker-side finish line).

Invoked BY the worker that owns the task, per the route injection text:

    python "<repo>/projects/voice-inbox/scripts/task_complete.py" --task vi-x \\
        --summary "<plain-language result>" [--attach /path/result.png ...]

Fills `result_summary` (and `result_short` when --short is given), moves
the task to `done` (legal from routed and running — an asking task is
refused, since closing it would drop the operator's question) and writes
the paired `task.completed` event with the summary's character count. The
summary is plain-language copy for the operator's timeline and read-aloud;
it is never an answer value. It is never process output either — a routing
receipt, command output or transcript re-paste is refused by the
summary-shape guard below. The script never chats.

`--attach <path>` (repeatable) attaches a result artifact — a generated
image, PDF, export — to the finished task. Each file is copied into the
task's attachment directory (``PA_HOME/voice-inbox/files/<task_id>/``)
under the attachments backend's exact rules (src/routes.ts), the SAME copy
semantics as task_blocker_ask.py's screenshot: sanitized basename, a
``result-`` prefix so the name can never collide with the reserved
``audio.*`` recording or the invisible ``tmp-*`` staging prefix, ``-2``/
``-3`` de-conflict on a name collision, staged as ``tmp-*`` first so a
partial copy never registers. The app lists attachments straight from that
directory — the copy IS the registration; nothing else to call. Every
path is checked BEFORE the first copy, so a missing file fails
side-effect-free. A ledger-stage refusal (unknown task, illegal state, a
guard rejection) deliberately keeps the copies — they are the produced
artifacts, visible on the task — and a corrected re-run de-conflicts the
names.
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
# Duplicate-close guard (2026-09-12, incident vi-499aac51e800): a worker
# closed the operator's tap-to-record request with "already transcribed and
# routed ... closes out a duplicate/stale ledger entry for the same task" —
# no covering task existed, the request silently vanished, and the loss only
# surfaced when the operator asked where their message had gone. A summary
# that claims this request is covered elsewhere must now NAME the covering
# task with --covered-by, and the claim is verified against the LEDGER (the
# artifact), never taken on faith:
#   1. the covering task must exist in this tenant;
#   2. it must have actually progressed (running/awaiting_input/done — the
#      incident's phantom target was "already routed" yet nothing carried
#      the request anywhere);
#   3. it must carry the SAME request, by content-word overlap.
# The overlap floor is calibrated on the incident itself: the dropped
# request vs the logo-consistency request it was wrongly closed against
# scores 0.071; paraphrased genuine duplicates score 0.20+. 0.15 sits in
# that gap, pinned from both sides by tests/test_worker_scripts.py. The
# regex was tuned against all 259 real completion summaries in the ledger:
# bare "duplicate"/"already sent"/"same task" phrasings fire on ordinary
# prose, so only close-out anchors are matched (~4/259, 3 of them true
# duplicate-closes). A worker the gate refuses can still complete by doing
# the work and writing a plain outcome summary — the refusal message says so.
# ---------------------------------------------------------------------------
DUPLICATE_CLAIM_RE = re.compile(
    r"\bcloses?\s+out\s+(?:an?\s+|the\s+)?(?:duplicate|stale)\b"
    r"|\bstale\s+duplicate\b"
    r"|\bduplicate\s+(?:of|ledger|entry|dispatch|task|note|request|ask|route)\b"
    r"|\balready\s+(?:been\s+)?(?:transcribed|routed|under\s?way)\b"
    r"|\bstale\s+ledger\b",
    re.IGNORECASE)
COVERED_BY_MIN_OVERLAP = 0.15
COVERED_BY_ACTIVE_STATES = ("running", "awaiting_input", "done")
GUARD_STOPWORDS = frozenset("""a an the and or but if then else when at by for with about against
between into through during before after above below to from up down in out on off over under again
further once here there all any both each few more most other some such no nor not only own same so
than too very can will just should now i is are was were be been being have has had do does did doing
would could ought it its this that these those of as my me you your he she they them their we us what
which who whom am until while yeah actually""".split())


def content_words(text: str) -> set[str]:
    """Lowercased content words (3+ chars, stopwords dropped) for overlap."""
    return {w for w in re.findall(r"[a-z0-9']+", (text or "").lower())
            if len(w) > 2 and w not in GUARD_STOPWORDS}


def request_overlap(a: str, b: str) -> float:
    """Jaccard overlap of two requests' content-word sets (0.0..1.0)."""
    wa, wb = content_words(a), content_words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def verify_covered_by(conn, task: dict, cover_id: str) -> None:
    """Refuse (via fail) any --covered-by claim the ledger does not support."""
    cover = conn.execute(
        "SELECT task_id, tenant_id, state, request_text FROM tasks WHERE task_id = ?",
        (cover_id,),
    ).fetchone()
    if cover is None:
        fail(f"covering task not found: {cover_id} — a duplicate close must name a "
             f"real task that carries this same request")
    if cover_id == task["task_id"]:
        fail(f"covering task is this task itself — a request cannot cover itself; "
             f"name a different task carrying the same request or do the work")
    if cover["tenant_id"] != task["tenant_id"]:
        fail(f"covering task belongs to another tenant: {cover_id}")
    if cover["state"] not in COVERED_BY_ACTIVE_STATES:
        fail(f"covering task {cover_id} is still '{cover['state']}' — a duplicate "
             f"close needs it to have actually progressed (running/awaiting_input/"
             f"done); wait for it or do the work here")
    overlap = request_overlap(task["request_text"], cover["request_text"])
    if overlap < COVERED_BY_MIN_OVERLAP:
        fail(f"covering task {cover_id} requests different work (word overlap "
             f"{overlap:.0%} < {COVERED_BY_MIN_OVERLAP:.0%}) — a duplicate close "
             f"must point at a task carrying the SAME request; either do the work "
             f"or pick the right covering task")


# ---------------------------------------------------------------------------
# Summary-shape guard (2026-09-14): the --summary is the OUTCOME for the
# operator — what was asked and what resulted, in plain language. The junk
# source this kills: transcribe-route workers closing tasks with the ROUTING
# COMMAND OUTPUT as the summary ("Routed and verified. **Command output**
# (exit 0): ```json ..."). Refusals anchor on the structural furniture only
# receipts carry — the Command output / exit 0 / {"ok" markers, and a
# transcript re-paste of 2+ verbatim request sentences — with the receipt
# verb prefixes as the fast path (verb AND marker together, so an honest
# "Routed to billing; the refund is confirmed" outcome never fires). A bare
# code fence is deliberately NOT a marker: the route injection teaches fenced
# blocks as legitimate answer-card formatting and the card renders them.
# False refusals are worse than misses; every refusal exits non-zero naming
# the standard, so the worker retries with a real summary.
# ---------------------------------------------------------------------------
RECEIPT_PREFIX_RE = re.compile(
    r"^\s*(?:routed\b|done\.\s*task\b|transcribed\s+and\s+routed\b)",
    re.IGNORECASE)
RECEIPT_MARKER_RE = re.compile(r"Command output|exit 0|\{\"ok\"", re.IGNORECASE)
REPASTE_MIN_SENTENCES = 2
REPASTE_MIN_WORDS = 10


def receipt_summary_refusal(summary: str) -> str | None:
    """One-line refusal for a receipt-shaped --summary, or None when it passes."""
    if RECEIPT_MARKER_RE.search(summary) is None:
        return None
    shape = ("receipt verb + command-output markers"
             if RECEIPT_PREFIX_RE.search(summary) else "command-output markers")
    return ("--summary reads like a routing receipt (" + shape + "), not an outcome: "
            "the summary must state the outcome for the operator — what was asked "
            "and what resulted — in plain language, never the command output or "
            "other process output; re-run with a real plain-language summary")


def transcript_repaste_hit(summary: str, request_text: str | None) -> bool:
    """True when 2+ full request sentences (>=10 words each) appear verbatim in
    the summary — a re-pasted transcript is process, never the answer."""
    normalized = " ".join((summary or "").lower().split())
    if not normalized:
        return False
    sentences = re.split(r"(?<=[.!?])\s+", (request_text or "").replace("\n", " "))
    long_sentences = (" ".join(s.lower().split()) for s in sentences
                      if len(s.split()) >= REPASTE_MIN_WORDS)
    hits = sum(1 for s in long_sentences if s in normalized)
    return hits >= REPASTE_MIN_SENTENCES


# ---------------------------------------------------------------------------
# Quick-reply chips (--suggest, AI-234): the worker emits 0..4 plain-language
# follow-up labels in the SAME task_complete.py call as the answer. The
# plain-language guard (sanitize_suggested_items) is the Python twin of the
# TS sanitizeSuggestedItems in projects/telegram-bot/src/logic.ts — the two
# regex sets are pinned byte-equal by tests/test_worker_scripts.py. Fail-OPEN:
# drop the offender, keep the survivors; chips never block the answer. A
# fully-non-plain set (all dropped) exits non-zero so the worker sees it, but
# the --summary still writes.
# ---------------------------------------------------------------------------
SUGGESTED_ITEM_MAX = 4
SUGGESTED_ITEM_LABEL_MAX = 40
# The exact regex set from the AI-234 spec: the structural furniture that only
# appears in code/paths/URLs, never in plain product prose. Byte-synced to the
# TS twin in projects/telegram-bot/src/logic.ts (the sync test pins the string).
SUGGESTED_ITEM_NONPLAIN_RE = re.compile(
    r"[`{}[\]<>|=]"
    r"|\/\/"
    r"|\\"
    r"|\.\w{1,4}\b"
    r"|http"
    r"|0x[0-9a-fA-F]+",
    re.IGNORECASE)


def sanitize_suggested_items(raw: list[str] | None) -> list[str]:
    """Drop any chip that is not plain product language. Fail-OPEN: keep the
    survivors, drop the offenders. Mirrors the TS sanitizeSuggestedItems."""
    if not raw:
        return []
    seen: set[str] = set()
    kept: list[str] = []
    for label in raw:
        if not isinstance(label, str):
            continue
        text = label.strip()
        if not text or len(text) > SUGGESTED_ITEM_LABEL_MAX:
            continue
        if SUGGESTED_ITEM_NONPLAIN_RE.search(text) is not None:
            continue
        if text in seen:
            continue
        seen.add(text)
        kept.append(text)
    return kept[:SUGGESTED_ITEM_MAX]


# ---------------------------------------------------------------------------
# Structured answer data (--structured, P1): validates the JSON shape the
# worker passes alongside --summary. The shape is intentionally permissive —
# required fields only (type, items/steps, item.name), unknown fields allowed
# (forward-compatible). The markdown --summary is always the full answer;
# structured data is ADDITIONAL, not a replacement. The PWA falls back to
# markdown when result_structured is NULL or unparseable.
# ---------------------------------------------------------------------------
STRUCTURED_MAX_BYTES = 65536  # 64 KB
STRUCTURED_TYPES = ("comparison", "listing", "guide", "form-set", "summary")
STRUCTURED_MAX_ITEMS = 20
ACTION_KINDS = ("call", "link", "task", "save", "share")


def validate_structured(data: object, source_path: str) -> str:
    """Validate the structured-data JSON object and return it as a compact
    JSON string. Calls parser.error (via fail) on any validation failure."""
    if not isinstance(data, dict):
        fail(f"--structured: {source_path} must contain a JSON object, got {type(data).__name__}")
    # type
    type_val = data.get("type")
    if not isinstance(type_val, str):
        fail(f"--structured: 'type' must be a string, got {type(type_val).__name__}")
    if type_val not in STRUCTURED_TYPES:
        fail(f"--structured: 'type' must be one of {', '.join(STRUCTURED_TYPES)}, got '{type_val}'")
    # items vs steps
    if type_val == "form-set":
        steps = data.get("steps")
        if not isinstance(steps, list):
            fail(f"--structured: 'steps' must be an array for type 'form-set'")
        if not 1 <= len(steps) <= STRUCTURED_MAX_ITEMS:
            fail(f"--structured: 'steps' has {len(steps)} entries, max {STRUCTURED_MAX_ITEMS}")
        submit = data.get("submit")
        if submit is not None and submit not in ("create-task", "update-conversation", "save-only"):
            fail("--structured: 'submit' must be one of create-task, update-conversation, save-only")
        if "submit_early" in data and not isinstance(data["submit_early"], bool):
            fail("--structured: 'submit_early' must be a boolean")
        # Pass 1 — step ids must exist and be unique before any branch can be
        # checked against them (a branch may target a later step).
        step_ids: set[str] = set()
        for i, step in enumerate(steps):
            if not isinstance(step, dict):
                fail(f"--structured: steps[{i}] must be an object")
            step_id = step.get("id")
            if not isinstance(step_id, str) or not re.fullmatch(
                    r"[a-z0-9][a-z0-9-]{0,39}", step_id):
                fail(f"--structured: steps[{i}].id must match ^[a-z0-9][a-z0-9-]{{0,39}}$")
            if step_id in step_ids:
                fail(f"--structured: steps[{i}].id '{step_id}' is not unique")
            step_ids.add(step_id)
        # Pass 2 — per-step shape. The question text is `prompt` or `title`
        # (either; the widget schema's word and the SPEC example's word).
        for i, step in enumerate(steps):
            where = f"steps[{i}]"
            raw_prompt = step.get("prompt")
            prompt = raw_prompt if (isinstance(raw_prompt, str) and raw_prompt.strip()) else step.get("title")
            if not isinstance(prompt, str) or not prompt.strip():
                fail(f"--structured: {where} needs a non-empty 'prompt' or 'title'")
            locked = step.get("locked") is True
            if locked:
                if not isinstance(step.get("answer"), str) or not step["answer"].strip():
                    fail(f"--structured: {where}.answer must be a non-empty string on a locked step")
            step_type = step.get("type")
            if step_type is not None and step_type not in ("choice", "text", "confirm", "file"):
                fail(f"--structured: {where}.type must be one of choice, text, confirm, file")
            labels: list[str] = []
            if step_type in (None, "choice", "confirm") and not locked:
                options = step.get("options")
                if step_type != "confirm" or options is not None:
                    if not isinstance(options, list) or not options:
                        fail(f"--structured: {where}.options must be a non-empty array")
                    for j, opt in enumerate(options):
                        label = opt if isinstance(opt, str) else (opt.get("label") if isinstance(opt, dict) else None)
                        if not isinstance(label, str) or not label.strip():
                            fail(f"--structured: {where}.options[{j}] needs a non-empty label")
                        labels.append(label)
                else:
                    # A confirm without options answers Yes/No on the client —
                    # seed the implicit labels so `preselected` and `branch`
                    # keys are checked against what the operator can answer.
                    labels = ["Yes", "No"]
            if len(labels) != len(set(labels)):
                fail(f"--structured: {where}.options labels must be unique")
            if "preselected" in step:
                if locked or step_type == "file":
                    fail(f"--structured: {where}.preselected needs an answerable option/text step")
                if step_type == "text":
                    if not isinstance(step["preselected"], str) or not step["preselected"].strip():
                        fail(f"--structured: {where}.preselected must be a non-empty string")
                elif step["preselected"] not in labels:
                    fail(f"--structured: {where}.preselected must equal one option label")
            if submit == "save-only" and step_type == "file":
                fail(f"--structured: {where} is a file step but 'submit' is save-only — a file cannot be kept on-device")
            branch = step.get("branch")
            if branch is not None:
                if not isinstance(branch, dict):
                    fail(f"--structured: {where}.branch must be an object")
                if not locked and step_type in ("text", "file"):
                    fail(f"--structured: {where}.branch needs option/answer-keyed steps, not a {step_type} step")
                for key, target in branch.items():
                    if locked:
                        if key != step.get("answer"):
                            fail(f"--structured: {where}.branch['{key}'] must match the locked step's answer")
                    elif labels and key not in labels:
                        fail(f"--structured: {where}.branch['{key}'] must match an option label")
                    if not isinstance(target, str) or target not in step_ids:
                        fail(f"--structured: {where}.branch['{key}'] must name a declared step id")
                    if target == step.get("id"):
                        fail(f"--structured: {where}.branch['{key}'] must not point at its own step")
    else:
        items = data.get("items")
        if not isinstance(items, list):
            fail(f"--structured: 'items' must be an array for type '{type_val}'")
        if len(items) > STRUCTURED_MAX_ITEMS:
            fail(f"--structured: 'items' has {len(items)} entries, max {STRUCTURED_MAX_ITEMS}")
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                fail(f"--structured: items[{i}] must be an object")
            if not isinstance(item.get("name"), str) or not item["name"].strip():
                fail(f"--structured: items[{i}].name must be a non-empty string")
            attrs = item.get("attributes")
            if attrs is not None and not isinstance(attrs, dict):
                fail(f"--structured: items[{i}].attributes must be an object")
            actions = item.get("actions")
            if actions is not None:
                if not isinstance(actions, list):
                    fail(f"--structured: items[{i}].actions must be an array")
                for j, action in enumerate(actions):
                    if not isinstance(action, dict):
                        fail(f"--structured: items[{i}].actions[{j}] must be an object")
                    if not isinstance(action.get("label"), str) or not action["label"].strip():
                        fail(f"--structured: items[{i}].actions[{j}].label must be a non-empty string")
                    kind = action.get("kind")
                    if not isinstance(kind, str) or kind not in ACTION_KINDS:
                        fail(f"--structured: items[{i}].actions[{j}].kind must be one of {', '.join(ACTION_KINDS)}, got '{kind}'")
            if "summary" in item and not isinstance(item["summary"], str):
                fail(f"--structured: items[{i}].summary must be a string")
            if "description" in item and not isinstance(item["description"], str):
                fail(f"--structured: items[{i}].description must be a string")
            if "points" in item:
                if not isinstance(item["points"], list):
                    fail(f"--structured: items[{i}].points must be an array")
                for j, point in enumerate(item["points"]):
                    if not isinstance(point, str) or not point.strip():
                        fail(f"--structured: items[{i}].points[{j}] must be a non-empty string")
            if "done" in item and not isinstance(item["done"], bool):
                fail(f"--structured: items[{i}].done must be a boolean")
    # Size cap. allow_nan=False: Python's default emits bare NaN/Infinity,
    # which json.loads reads back but JSON.parse REJECTS — a stored value the
    # PWA can never parse would silently fall back to markdown while looking
    # like a stored structured answer.
    try:
        encoded = json.dumps(data, ensure_ascii=False, allow_nan=False)
    except ValueError:
        fail(f"--structured: {source_path} contains a non-finite number "
             "(NaN/Infinity are not valid JSON)")
    if len(encoded.encode("utf-8")) > STRUCTURED_MAX_BYTES:
        fail(f"--structured: JSON exceeds {STRUCTURED_MAX_BYTES} bytes")
    return encoded


# ---------------------------------------------------------------------------
# Result attachments (--attach, AI-244): copies into files/<task_id>/ under
# the attachments backend's rules — byte-for-byte the same copy semantics
# as task_blocker_ask.py's screenshot attach (sanitize_name +
# stored_result_name below mirror its sanitize_name + stored_blocker_name,
# prefix swapped to result-). The directory listing IS the registration:
# the app's attachmentEntries serves every non-audio.*/non-tmp-* file on
# the task's card, so a copied artifact surfaces with no contract field.
# ---------------------------------------------------------------------------
def sanitize_name(filename: str) -> str:
    """The attachments backend's sanitizeUploadName (src/routes.ts), same rules:
    keep [A-Za-z0-9._-], strip leading dots, fall back to upload.bin."""
    base = (filename or "").replace("\\", "/").split("/").pop()
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", base).lstrip(".")
    return cleaned or "upload.bin"


def stored_result_name(task_dir: str, source_path: str) -> str:
    """`result-<sanitized basename>`, de-conflicted with -2, -3, … before the
    extension (storedAttachmentName's loop). The prefix is the registration
    guarantee: the listing excludes `^audio\\.` and `^tmp-`, and a `result-`
    name can match neither."""
    candidate = "result-" + sanitize_name(os.path.basename(source_path))
    stem, dot, ext = candidate.rpartition(".")
    n = 2
    while os.path.exists(os.path.join(task_dir, candidate)):
        candidate = f"{stem}-{n}{dot}{ext}" if dot else f"{candidate}-{n}"
        n += 1
    return candidate


def copy_attachments(task_id: str, paths: list[str], files_dir: str) -> list[tuple[str, str]]:
    """Copy each --attach file into files/<task_id>/ and return
    [(stored name, absolute forward-slashed path)]. Every path is checked
    BEFORE the first copy — a missing file fails side-effect-free. No
    --attach means no files dir created at all."""
    if not paths:
        return []
    for path in paths:
        if not os.path.isfile(path):
            fail(f"attachment not found: {path}")
    task_dir = os.path.join(files_dir, task_id)
    os.makedirs(task_dir, exist_ok=True)
    copied: list[tuple[str, str]] = []
    for path in paths:
        stored = stored_result_name(task_dir, path)
        staging = os.path.join(task_dir, "tmp-" + stored)
        shutil.copyfile(path, staging)
        final = os.path.join(task_dir, stored)
        os.replace(staging, final)
        copied.append((stored, final.replace("\\", "/")))
    return copied


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
# notification, not the result.
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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Complete a voice-inbox task with a plain-language result summary")
    parser.add_argument("--task", required=True, help="task id (vi-...)")
    parser.add_argument("--summary", required=True,
                        help="plain-language result for the operator's timeline")
    parser.add_argument("--short",
                        help="the answer in one or two plain sentences for an average "
                             "non-technical reader — the card's IN SHORT lead; the verdict, "
                             "not the reasoning, never a truncated start of the long answer")
    parser.add_argument("--covered-by",
                        help="task id of the covering task, required when the summary "
                             "claims this request is a duplicate / already routed or "
                             "covered elsewhere; verified against the ledger (must "
                             "exist in this tenant, have progressed, and carry the "
                             "same request) before the completion is accepted")
    parser.add_argument("--title", help="short noun phrase naming what this conversation is "
                                        "about (<=60 chars); overwrites any stored title")
    parser.add_argument("--recap", help="one or two plain sentences saying what is happening "
                                        "and where it stands (<=400 chars)")
    parser.add_argument("--next", help="one line naming what the operator has to do next; "
                                       "for a reply that ends in a NEXT ACTIONS block, this is "
                                       "its first You step; omitted or empty clears any stored "
                                       "action item, but is an error when --summary contains a "
                                       "literal NEXT ACTIONS line")
    parser.add_argument("--attach", action="append", default=[], metavar="PATH",
                        help="path to a result artifact on disk (a generated image, "
                             "PDF, export — repeatable); each is copied into "
                             "files/<task_id>/ under the attachments backend's "
                             "rules (result- prefix, -N de-conflict, tmp- staging) "
                             "so it renders on the finished task's card")
    parser.add_argument("--suggest", action="append", default=None, metavar="LABEL",
                        help="a short plain-language follow-up the user could tap "
                             "instead of typing (repeatable, 0..4, <=40 chars each, "
                             "no code/symbols); the script drops any entry that is "
                             "not plain language — chips never block the answer")
    parser.add_argument("--structured", metavar="PATH",
                        help="path to a JSON file with structured answer data "
                             "(comparison, listing, guide, form-set, or summary); "
                             "validated and stored in result_structured. "
                             "Shape: {\"type\": \"comparison\"|\"listing\"|\"guide\"|\"form-set\"|\"summary\", "
                             "\"title\": \"...\", \"recommendation\": \"...\", "
                             "\"items\": [{\"name\": \"...\", \"attributes\": {\"<label>\": \"<value>\"}, "
                             "\"actions\": [{\"label\": \"...\", "
                             "\"kind\": \"call\"|\"link\"|\"task\"|\"save\"|\"share\"}]}]}. "
                             "Per-kind action fields: \"call\" needs \"value\" (the phone "
                             "number), \"link\" needs \"url\" (http(s) only), \"task\" takes "
                             "optional \"prompt\" (the new task's request text; the label is "
                             "the fallback) — \"save\" and \"share\" need nothing beyond "
                             "label+kind. An action missing its target field renders no "
                             "control in the app. "
                             "Per-type item fields: \"listing\" items take \"summary\" or "
                             "\"description\" (one line); \"guide\" items add \"done\": bool and "
                             "\"points\" bullets; \"summary\" items take \"points\" or "
                             "\"attributes\" per section. "
                             "The form-set type carries \"steps\" instead of \"items\": each "
                             "step is {\"id\": \"<a-z0-9->\", \"prompt\" (or \"title\"): \"<the question>\", "
                             "\"type\": \"choice\"(default)|\"text\"|\"confirm\"|\"file\"}, options as "
                             "[{\"label\", \"note\"}] or bare strings, optional \"locked\"+\"answer\", "
                             "\"preselected\", and \"branch\" mapping an option label to a declared "
                             "step id. {\"submit\": \"create-task\"(default)|\"update-conversation\"|"
                             "\"save-only\", \"submit_early\": bool}. "
                             "The --summary stays the full answer; structured data is additional.")
    args = parser.parse_args(normalize_argv(argv))

    if not args.summary.strip():
        parser.error("--summary must not be empty")
    if args.short is not None and not args.short.strip():
        parser.error("--short must not be empty")
    if args.title is not None and not args.title.strip():
        parser.error("--title must not be empty")
    if args.recap is not None and not args.recap.strip():
        parser.error("--recap must not be empty")
    has_next_actions_line = any(line.strip() == "NEXT ACTIONS" for line in args.summary.splitlines())
    if has_next_actions_line and not (args.next and args.next.strip()):
        parser.error("--next must not be empty when --summary contains a NEXT ACTIONS line")
    receipt_refusal = receipt_summary_refusal(args.summary)
    if receipt_refusal:
        parser.error(receipt_refusal)

    # AI-234: sanitize the --suggest chips (fail-OPEN — drop offenders, keep
    # survivors). Chips never block the answer: the --summary write below runs
    # regardless. all_suggest_dropped tracks whether --suggest was passed AND
    # every entry was non-plain, so the script can exit non-zero AFTER the
    # completion lands (a warning, not a blocking refusal).
    suggest_passed = args.suggest is not None
    suggested_items = sanitize_suggested_items(args.suggest)
    all_suggest_dropped = suggest_passed and len(suggested_items) == 0 and len(args.suggest) > 0

    # P1: structured answer data (--structured). Optional — when absent,
    # result_structured stays NULL and the PWA falls back to markdown.
    result_structured_json = None
    if args.structured is not None:
        try:
            with open(args.structured, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError as exc:
            fail(f"--structured: cannot read {args.structured}: {exc}")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            fail(f"--structured: invalid JSON in {args.structured}: {exc}")
        result_structured_json = validate_structured(parsed, args.structured)

    # Result artifacts copy BEFORE the ledger work (task_blocker_ask.py's
    # ordering): every path must exist up front — a missing one fails
    # side-effect-free — and a later refusal keeps the copies as evidence.
    attached = copy_attachments(
        args.task, args.attach or [],
        os.path.join(pa_home(), "voice-inbox", "files"))

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
            completed_payload: dict = {"result_chars": len(args.summary)}
            if attached:
                # Optional key, omitted when none (the route-queue optional-key
                # convention); TS residual: contracts.ts TaskCompletedPayload
                # gains `attachments?: string[]` (AI-244).
                completed_payload["attachments"] = [name for name, _ in attached]
            if suggested_items:
                # AI-234: mirrors the tasks.suggested_items column for audit
                # parity with attachments (contracts.ts TaskCompletedPayload
                # gains `suggested_items?: string[]`).
                completed_payload["suggested_items"] = suggested_items
            if result_structured_json:
                # P1: a stored flag, not the JSON — the event only needs to
                # say structured data landed on the row (audit parity with
                # attachments/suggested_items; TaskCompletedPayload gains
                # `result_structured?: boolean`).
                completed_payload["result_structured"] = True
            # The completion: ONE UPDATE gated on the table's `done` sources
            # (routed, running) through the shared helper. An asking task is
            # refused with the way out named — closing it would drop the
            # operator's question (thread lifecycle, 2026-09-17).
            ref_id, ts = transition_task(
                conn, args.task, "done", "task.completed", completed_payload,
                sets=[
                    ("result_summary = ?", args.summary),
                    ("result_short = COALESCE(?, result_short)",
                     args.short if args.short and args.short.strip() else None),
                    ("suggested_items = ?",
                     json.dumps(suggested_items, ensure_ascii=False) if suggested_items else None),
                    ("result_structured = COALESCE(?, result_structured)", result_structured_json),
                ],
                refuse=lambda state: (
                    f"task {args.task} is awaiting_input; it is waiting on the operator's "
                    "answer, and completing it would drop that question — withdraw the "
                    f"question first (task_input.py cancel --task {args.task}) or wait for "
                    "the answer, then run task_complete.py again"
                    if state == "awaiting_input" else
                    f"illegal task state transition: {state} -> done "
                    f"(task {args.task} is {state})"))
            # The duplicate-close gate: engage when the worker names a cover
            # OR when the summary's phrasing claims one. A refusal exits 1 and
            # rolls the completion above back — the task stays in its state.
            if args.covered_by is not None or DUPLICATE_CLAIM_RE.search(args.summary):
                if args.covered_by is None:
                    fail("duplicate-close guard: the summary claims this request is "
                         "already covered elsewhere; pass --covered-by <task-id> of "
                         "the task carrying the same request, or do the work and "
                         "complete with a plain outcome summary — an unverified "
                         "coverage close silently drops the operator's request "
                         "(incident 2026-09-12, vi-499aac51e800)")
                verify_covered_by(conn, task, args.covered_by)
            if transcript_repaste_hit(args.summary, task["request_text"]):
                fail("--summary re-pastes the request transcript verbatim (2+ "
                     "sentences) — the summary is the OUTCOME for the operator: "
                     "what was asked and what resulted, in plain language, never "
                     "the transcript or other process output; re-run with a real "
                     "plain-language summary")
            # Own asks only (2026-09-17): a finished task leaves no stray pending
            # ask of its OWN behind; another task's question is never touched —
            # the newest message's handler concludes the thread, and an older
            # task finishing must not erase a newer task's ask.
            cur = conn.execute(
                "UPDATE input_requests SET status = 'cancelled', answered_at = ?"
                " WHERE task_id = ? AND tenant_id = ? AND status = 'pending'",
                (ts, args.task, task["tenant_id"]),
            )
            cancelled_pending_inputs = cur.rowcount
            # next_action (2026-09-17): completion writes --next, or clears it,
            # only when this task IS the conversation's newest task by send time;
            # an older task finishing keeps the action a newer ask set.
            newest = conn.execute(
                "SELECT task_id FROM tasks WHERE conversation_id = ? AND tenant_id = ?"
                " ORDER BY created_at DESC, task_id DESC LIMIT 1",
                (task["conversation_id"], task["tenant_id"]),
            ).fetchone()
            is_newest = newest is not None and newest[0] == args.task
            set_conversation_meta(conn, task["conversation_id"], task["tenant_id"], ts,
                                  title=args.title, recap=args.recap,
                                  next_action=((args.next if args.next else None)
                                               if is_newest else "__keep__"))
    finally:
        conn.close()

    # Response-ready page: the ledger row alone sat invisible until the app was
    # opened (2026-09-11) — the mirror is what reaches the operator.
    fire_attention_ping(
        args.title or f"Task done — {args.task}",
        args.recap or args.summary,
    )

    result = {"task_id": args.task, "state": "done", "ref_id": ref_id,
              "cancelled_pending_inputs": cancelled_pending_inputs}
    if attached:
        result["attachments"] = [name for name, _ in attached]
        result["attachment_paths"] = [path for _, path in attached]
    if suggested_items:
        result["suggested_items"] = suggested_items
    if result_structured_json:
        result["result_structured"] = True
    if all_suggest_dropped:
        # The answer wrote; the chips did not. Non-zero so the worker sees it,
        # but the completion already landed — chips never block the answer.
        result["suggested_items_dropped"] = len(args.suggest)
        print(json.dumps({"ok": True, **result}))
        raise SystemExit(1)
    emit(result)


if __name__ == "__main__":
    main()
