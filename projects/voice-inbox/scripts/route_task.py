#!/usr/bin/env python3
"""Route a voice-inbox task to a Telegram topic (the worker-side routing step).

Invoked BY the worker sitting in the configured inbox topic, per the injection
text the app wrote at task creation:

    python "<repo>/projects/voice-inbox/scripts/route_task.py" --task vi-x \\
        --topic <chatId>_<threadId> --reason "<one line>"

Deterministic duties only: validate the task and the target topic, move the
task to `routed` with its paired `task.routed` event, append the target-topic
route entry to the shared route queue, and write one decision-trace row (the
explainability feed). With `--create-topic` (the caller judged that no
existing bucket fits) it may also FORM the destination topic first —
see "Route-stage topic formation" below. The script never chats — the bot
drain picks the queue entry up and injects it as a synthetic turn in the
target topic.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn, Iterator

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


# Conversation briefing constants (§3.1 of the AI-conversation-context spec,
# 2026-09-10). STEER_MESSAGE_LIMIT is a hand-copy of the bot's
# STEER_MESSAGE_MAX (projects/telegram-bot/src/voice-inbox-steer.ts), pinned
# by test_steer_message_limit_matches_the_bot. INBOX_BRIEFING_MAX is NOT
# defined here — python never writes an inbox entry. The 200-char margin
# below the steer limit was consumed by the pinned surface sentence
# (2026-09-13, feedback long-press); recalibrated to 50 — future template
# growth now fails the python end-to-end steer-limit gate visibly instead of
# being silently absorbed.
CONVERSATION_BRIEFING_MAX = 1200
CONVERSATION_BRIEFING_MIN = 200
CONVERSATION_BRIEFING_FIELD_MAX = 400
STEER_MESSAGE_LIMIT = 4000
ROUTE_TEXT_MAX = STEER_MESSAGE_LIMIT - 50
BRIEFING_TRIM_MARKER = " [trimmed]"


# The target-topic injection text, verbatim from the route-queue contract in
# the 2026-09-05 build spec; the sync test transcribes it independently and
# asserts the rendered entry byte-for-byte. `<repo>` resolves at runtime.
TARGET_INJECTION_TEMPLATE = (
    "[Voice task {task_id} routed from inbox — reason: {reason}] {briefing}{framing}{request_text}. {attachments}"
    "This task arrives from the voice-inbox app (our own PWA, fully ours — long-press menus, custom sheets and inline widgets all possible); design UI answers for that surface, not Telegram's Bot-API constraints. "
    "Run first: python \"{repo}/projects/voice-inbox/scripts/task_telemetry.py\" start --task {task_id}. "
    "For operator input (secret, choice, confirm/yes-no, file, Google consent), use "
    "python \"{repo}/projects/voice-inbox/scripts/task_input.py\" create --help — "
    "a typed widget, never chat text, never HTML. "
    "If a tool needs authorization (a URL, code, key, password, or a yes/no you cannot answer): pa auth request with the shape, pa auth wait, then re-run non-interactively — never stall or ask in chat. "
    "Choose autonomously — never ask which topic (no choice widget, no chat question); "
    "if torn, route to the closest match and state the reason. "
    "Emit progress via task_telemetry.py (plan:/build:/verify: prefix optional; else plain Running); "
    "finish with python \"{repo}/projects/voice-inbox/scripts/task_complete.py\" --task {task_id} "
    "--summary \"<the complete answer>\". "
    "The summary is what the operator reads — every substantive detail of the answer, "
    "no length trimming; strip only technical narration "
    "(tool names, paths, commands, steps). "
    "Also pass --short \"<the verdict, not the reasoning>\" — one or two plain sentences an average non-technical user understands, in the product's own terms. Never a truncated start; never capped. "
    "Never narrate internal housekeeping (brain upkeep, claims, gates, telemetry, coordination) — do it silently, or page via pa ping only if the operator must act. "
    "Format richly for the answer card (it renders markdown): blank line between points, "
    "### headings, **bold**, - or 1) lists, pipe tables with a |---| row, code fences, "
    "[text](url) or bare links. "
    "Never hard-code colours in HTML. "
    "Keep the conversation's three summary lines current: pass --title (a short noun phrase "
    "for the conversation, at most 60 characters, never a transcription of "
    "the request), --recap (one or two plain sentences on what is happening and "
    "where it stands) and --next (one line for the operator's next step, omitted "
    "when there is nothing) to task_complete.py, and the same three flags to task_input.py "
    "create whenever you ask a question. "
    "Phrase --prompt and choice labels in plain language — no ids, tool names, paths, or technical terms. "
    "Pass --suggest \"<plain follow-up>\" repeatable (0..4), ≤40 chars each, "
    "plain words only; non-plain entries dropped. Omit when nothing natural follows. "
    "For comparison/listing/guide/form-set/summary answers, pass --structured <json> (task_complete.py --help). "
)


# --- Attachments segment (task attachments, 2026-09-13) ----------------------
# Twin of src/bridge-writer.ts buildAttachmentsSegment / ATTACHMENTS_SEGMENT_
# SUFFIX; pinned byte-equal by src/tests/sync-twins.test.ts (shared suffix
# literal + golden render) and tests/test_worker_scripts.py (golden render).
ATTACHMENTS_SEGMENT_SUFFIX = (
    " Open them from disk when the task needs them; audio or video attachments "
    "can be transcribed with transcribe_voice.py. "
)

ATTACHMENTS_DIR_CAP = 10


def build_attachments_segment(paths: list[str]) -> str:
    """The ONE canonical attachments segment. '' when there are no paths, so
    every existing pinned byte stays unchanged for attachment-less tasks."""
    if not paths:
        return ""
    return f"Attachments ({len(paths)}): {'; '.join(paths)}." + ATTACHMENTS_SEGMENT_SUFFIX


def task_attachment_paths(files_dir: str) -> list[str]:
    """Eligible attachment paths for one task's files dir — everything except
    the voice recording (audio.*) and tmp-* partials, sorted by name, absolute
    forward-slashed. [] when the dir is missing/unreadable. Logic twin of
    taskAttachmentPaths in src/routes.ts (not byte-pinned)."""
    if not os.path.isdir(files_dir):
        return []
    out: list[str] = []
    for name in sorted(os.listdir(files_dir)):
        if name.startswith("tmp-") or re.match(r"^audio\.", name, re.IGNORECASE):
            continue
        full = os.path.join(files_dir, name)
        if not os.path.isfile(full):
            continue
        out.append(full.replace("\\", "/"))
    return out


def attachments_display_paths(files_dir: str) -> list[str]:
    """The dir listing as a display list for the injection-text segment:
    capped at ATTACHMENTS_DIR_CAP paths with a trailing '… and <k> more in
    <dir>' element when the dir holds more (defensive — the API caps at 10).
    Logic twin of attachmentsDisplayPaths in src/routes.ts."""
    all_paths = task_attachment_paths(files_dir)
    if len(all_paths) <= ATTACHMENTS_DIR_CAP:
        return all_paths
    more = f"… and {len(all_paths) - ATTACHMENTS_DIR_CAP} more in {files_dir.replace(chr(92), '/')}"
    return all_paths[:ATTACHMENTS_DIR_CAP] + [more]


# --- Conversation briefing (§3.2, python twin of conversation-briefing.ts) ---
# FROZEN: implements the same field rendering as the TS golden implementation,
# verbatim. `tests/test_worker_scripts.py` pins the two byte-identical via
# GOLDEN_BRIEFING/EXPECTED_TARGET_TEXT.

def _render_briefing_field(raw: str | None) -> str:
    """Collapse whitespace, trim, neutralise the `[Voice task ` / `[Voice inbox
    task ` bracket shape (so a briefing never injects spurious ids into
    taskIdsInText), then clamp at CONVERSATION_BRIEFING_FIELD_MAX with
    BRIEFING_TRIM_MARKER. None/empty renders ''."""
    if raw is None:
        return ""
    value = re.sub(r"\s+", " ", raw).strip()
    if not value:
        return ""
    value = value.replace("[Voice task ", "(voice task ").replace(
        "[Voice inbox task ", "(voice inbox task ")
    if len(value) > CONVERSATION_BRIEFING_FIELD_MAX:
        value = value[:CONVERSATION_BRIEFING_FIELD_MAX] + BRIEFING_TRIM_MARKER
    return value


def _briefing_lookup_line(conversation_id: str, ledger_path: str) -> str:
    """The single lookup line replacing the old per-turn dump: a runnable
    sqlite3 query against the ledger, not the prior turns inlined. Workers
    already run direct sqlite3 queries against this exact ledger file in
    production, so this hands over a proven retrieval path instead of a dead
    bare id."""
    return (
        f'Full turn-by-turn record: sqlite3 "{ledger_path}" "SELECT created_at, request_text, '
        f"result_summary FROM tasks WHERE conversation_id = '{conversation_id}' ORDER BY created_at ASC\".\n"
    )


def build_conversation_briefing(conn, tenant_id: str, conversation_id: str,
                                 exclude_task_id: str, ledger_path_str: str,
                                 max_chars: int) -> str:
    """Build the bounded conversation briefing (§3.2 format, implemented
    verbatim). Returns '' when the conversation has no prior turns, when
    max_chars cannot fit even the head + lookup line + foot, or when the
    assembled result would exceed max_chars (the terminating guard — this
    function NEVER returns a string longer than max_chars)."""
    rows = conn.execute(
        "SELECT * FROM tasks WHERE tenant_id = ? AND conversation_id = ?"
        " ORDER BY created_at ASC, task_id ASC",
        (tenant_id, conversation_id),
    ).fetchall()
    prior = [dict(row) for row in rows if row["task_id"] != exclude_task_id]
    n = len(prior)
    if n == 0:
        return ""

    meta = conn.execute(
        "SELECT * FROM conversation_meta WHERE conversation_id = ? AND tenant_id = ?",
        (conversation_id, tenant_id),
    ).fetchone()

    head_lines = [f"Conversation so far ({conversation_id}): {n} earlier turn(s), oldest first.\n"]
    title = _render_briefing_field(meta["title"] if meta is not None else None)
    if title:
        head_lines.append(f"Title: {title}\n")
    recap = _render_briefing_field(meta["recap"] if meta is not None else None)
    if recap:
        head_lines.append(f"Where it stands: {recap}\n")
    next_action = _render_briefing_field(meta["next_action"] if meta is not None else None)
    if next_action:
        head_lines.append(f"Next: {next_action}\n")
    head = "".join(head_lines)
    foot = "End of the conversation record.\n"

    result = head + _briefing_lookup_line(conversation_id, ledger_path_str) + foot
    if len(result) > max_chars:
        return ""  # terminating guard: never overflow
    return result


def build_feedback_framing(about: str, title: str | None, level: str) -> str:
    """Python twin of bridge-writer.ts's buildFeedbackFraming (byte-pinned by
    the framing golden tests on both sides)."""
    target = "task" if level == "task" else "conversation"
    clean = ""
    if title is not None:
        clean = re.sub(r"\s+", " ", title).strip().replace('"', "'")[:TITLE_MAX]
    if not clean:
        return f"(operator feedback about voice-inbox {target} {about})"
    return f'(operator feedback about voice-inbox {target} {about}, "{clean}")'


# Field order of one route-queue line (the shared cross-process contract).
QUEUE_FIELDS = ["q_id", "ts", "task_id", "tenant_id", "chat_id", "thread_id", "text", "ref_id"]

# Optional keys, appended after the frozen 8-key prefix in this fixed order and
# omitted entirely when absent (route-queue contract v3).
QUEUE_OPTIONAL_FIELDS = ["kind", "worker_resource", "worker_dispatch_id",
                         "steer_mode", "steer_conversation"]


def repo_root() -> str:
    """Repo root from this file's location (scripts/ sits three levels below it)."""
    return Path(__file__).resolve().parents[3].as_posix()


# --- Route-queue mutex -------------------------------------------------------
# Spec §7: BOTH writers of route-queue.jsonl guard appends with the same
# proper-lockfile mutex the bot's drain takes when it rewrites the file. A
# plain unlocked append loses races against the drain's read→rewrite→rename:
# the line lands in the renamed-away inode and the route decision silently
# never reaches the topic. This is a faithful mkdir-based replica of
# proper-lockfile's on-disk shape (a directory at `<file>.lock`, mtime
# staleness, rmdir release), so all three processes hold one compatible lock.

ROUTE_QUEUE_LOCK_STALE_MS = 5_000  # same value the TS writers pass
ROUTE_QUEUE_LOCK_RETRIES = 5       # same budget as the TS writers: ~1.25 s, then fail loudly
ROUTE_QUEUE_LOCK_MIN_SLEEP_S = 0.05
ROUTE_QUEUE_LOCK_MAX_SLEEP_S = 0.5


def route_queue_path() -> str:
    return os.path.join(pa_home(), "voice-inbox", "route-queue.jsonl")


@contextmanager
def route_queue_lock() -> Iterator[None]:
    """Acquire the shared route-queue mutex; release on exit (never throws on
    release). A >stale-window-old lock directory is a dead holder's leftover
    and is removed; a live holder is waited on for the retry budget, then the
    caller FAILS — an unguarded append is precisely the silent loss the
    mutex exists to prevent, so there is no unlocked fallback."""
    lock_dir = route_queue_path() + ".lock"
    sleep_s = ROUTE_QUEUE_LOCK_MIN_SLEEP_S
    attempts = 0
    while True:
        try:
            os.mkdir(lock_dir)
            break  # acquired
        except FileExistsError:
            held = True
            try:
                age_ms = (time.time() - os.stat(lock_dir).st_mtime) * 1000
            except FileNotFoundError:
                held = False  # holder released between mkdir and stat — retry now
            if held and age_ms > ROUTE_QUEUE_LOCK_STALE_MS:
                shutil.rmtree(lock_dir, ignore_errors=True)  # dead holder: steal
                held = False
            if held:
                if attempts >= ROUTE_QUEUE_LOCK_RETRIES:
                    fail("route queue is locked by another writer (live lock held past "
                         f"{ROUTE_QUEUE_LOCK_RETRIES} retries); not appending unguarded — rerun "
                         "this command once the other writer finishes")
                time.sleep(sleep_s)
                sleep_s = min(sleep_s * 2, ROUTE_QUEUE_LOCK_MAX_SLEEP_S)
            # Vanish/steal paths retry immediately, but every path counts: a
            # hard ceiling stops a pathological acquire/vanish cycle from
            # spinning forever — falling through UNLOCKED (the alternative)
            # is the exact silent loss this mutex exists to prevent.
            attempts += 1
            if attempts > ROUTE_QUEUE_LOCK_RETRIES * 3:
                fail("route queue lock kept racing (vanished/stale repeatedly); "
                     "not appending unguarded — rerun this command")
    try:
        yield
    finally:
        try:
            os.rmdir(lock_dir)
        except OSError:
            pass  # stolen by a stale-check or already gone


def ensure_queue_file(queue_path: str) -> None:
    """Create the queue file before locking if absent (same convention as
    bridge-writer.ts's ensureQueueFile: proper-lockfile wants an existing
    target; a concurrent creator racing here is harmless — 'a' never truncates)."""
    if os.path.exists(queue_path):
        return
    with open(queue_path, "a", encoding="utf-8", newline="\n"):
        pass


def resolve_topic(key: str) -> tuple[int, int]:
    """Validate a `<chatId>_<threadId>` key against ~/.pa/telegram-topic-names.json."""
    chat_str, sep, thread_str = key.rpartition("_")
    if not sep or not chat_str.lstrip("-").isdigit() or not thread_str.isdigit():
        fail(f"invalid topic key: {key} (expected <chatId>_<threadId>)")
    topics_path = os.path.join(pa_home(), "telegram-topic-names.json")
    if not os.path.exists(topics_path):
        fail(f"topics file missing: {topics_path}")
    with open(topics_path, "r", encoding="utf-8") as fh:
        try:
            topics = json.load(fh)
        except json.JSONDecodeError as exc:
            fail(f"topics file malformed: {exc}")
    if not isinstance(topics, dict):
        fail("topics file malformed: expected an object keyed by chat id")
    entry = topics.get(chat_str, {})
    entry = entry.get(thread_str) if isinstance(entry, dict) else None
    # Registry entries come in two shapes — the legacy bare string
    # ("<tid>": "<name>") and the {"name": ..., "description": ...} dict.
    # Every other reader (setup-topics' same-name skip, the bot's
    # loadTopicNames, existing_thread_for_name) accepts both; resolve_topic
    # must too, or a legacy entry names a real topic yet refuses routing.
    entry_name = entry if isinstance(entry, str) else (
        entry.get("name") if isinstance(entry, dict) else None)
    if not isinstance(entry_name, str) or not entry_name:
        fail(f"unknown topic: {key} (not in telegram-topic-names.json)")
    return int(chat_str), int(thread_str)


# --- Route-stage topic formation (operator feature, 2026-09-14; informed-
# decision rework same day) ----------------------------------------------
# When the caller (today: the deterministic fallback's classifier, which knows
# its keyword table found no bucket) passes --create-topic, the router FORMS a
# topic instead of forcing the fallback bucket. The decision is informed, not
# thresholded: it consults the chat's REAL existing topics from the registry
# (name match, case-insensitive — the entries' purpose descriptions ride
# along for the maintenance below), derives the name deterministically from
# the task's transcript/request (first meaningful words, title-cased; no LLM
# dispatch is burned on naming in v1), and the routing_reason records WHY no
# existing topic took the task ('formed <name>: no existing topic matched by
# name'; 'existing topic matched: <name>' on reuse). Descriptions are
# maintained as part of the routing act: a minted topic is born with a
# purpose line from the arriving work, and a matched topic with no
# description gains one. The ONLY guard on minting is the deterministic
# identity check — a derived name that already names an existing topic
# routes to that topic instead of minting a duplicate (correctness, not
# restriction); there is deliberately NO volume cap.
#
# Conscious-decision takeover seam (designed, NOT yet wired — these flags do
# not exist today): a --print-context flag would print the minimal decisive
# context (message + topics with descriptions) and a --decision-file flag
# would consume an LLM routing judge's decision over exactly that context
# (the bot's orchestrator/judge path is the precedent). On-demand depth —
# looking into a topic's transcripts when a description isn't decisive — is
# the judge's to fetch, never bundled here. On ANY creation failure (no
# token, API error, registry write failure) the task falls back to the
# caller's --topic bucket with a reason note, so placement never depends on
# formation.

TOPIC_NAME_MAX = 40
TOPIC_NAME_SOURCE_MAX = 220          # scan window over the transcript/request
TOPIC_NAME_WORD_TARGET = 6           # first 4-6 meaningful words per the design
TOPIC_DESCRIPTION_MAX = 160          # registry purpose line; matches the bot's MAX_DESCRIPTION_LEN
TELEGRAM_API_BASE_ENV = "VOICE_INBOX_TELEGRAM_API_BASE"  # test seam only (local stub); production never sets it

NAME_STOPWORDS = frozenset("""
a an the and or but if then else for of to in on at by with from about into over under after before
is are was were be been being am do does did done doing have has had having i we you he she it they
them me my mine our ours your yours their theirs his her hers its this that these those there here
can could will would shall should may might must please let us so as no not now just also very
really some any what when where which who whom whose why how um uh hmm er ah oh okay ok yeah yes
hey hi thanks thank want need know try make get give tell show help
""".split())


def _utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def derive_topic_name(text: str, date_str: str | None = None) -> str:
    """Short title-cased noun phrase from the task's transcript/request: the
    first <=6 meaningful (non-stopword, non-filler, alphanumeric) words, capped
    at TOPIC_NAME_MAX chars on a word boundary. Empty or garbage input (nothing
    left after stopword/filler/punctuation filtering) falls back to
    'New work <UTC date>'."""
    words = re.sub(r"\s+", " ", (text or "")[:TOPIC_NAME_SOURCE_MAX]).strip().split()
    picked: list[str] = []
    for word in words:
        cleaned = word.strip(".,!?;:'\"()[]{}…-—`*")
        if not cleaned or cleaned.lower() in NAME_STOPWORDS:
            continue
        if not re.search(r"[A-Za-z0-9]", cleaned):
            continue
        picked.append(cleaned)
        if len(picked) >= TOPIC_NAME_WORD_TARGET:
            break
    if not picked:
        return f"New work {date_str or _utc_today()}"
    name = " ".join(w[:1].upper() + w[1:] for w in picked)
    while len(name) > TOPIC_NAME_MAX and " " in name:
        name = name.rsplit(" ", 1)[0]
    return name[:TOPIC_NAME_MAX] if name else f"New work {date_str or _utc_today()}"


def derive_topic_description(text: str) -> str:
    """Purpose line from the arriving work, capped at TOPIC_DESCRIPTION_MAX."""
    value = re.sub(r"\s+", " ", (text or "").strip())
    return value[:TOPIC_DESCRIPTION_MAX]


def _redact_bot_token(text: object) -> str:
    """Error text embeds /bot<TOKEN>/... in the request path — never print or
    persist it raw (same guardrail as telegram_notify.py)."""
    return re.sub(r"/bot[^/\s]+", "/bot<redacted>", str(text))


def _normalize_proxy(u: str | None) -> str | None:
    """socks5 normalizer twin of telegram_notify.py's _normalize_socks."""
    u = (u or "").strip()
    if not u:
        return None
    if u.startswith("socks5h://"):
        return u
    if u.startswith("socks5://"):
        return "socks5h://" + u[len("socks5://"):]
    if re.match(r"^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$", u):
        return f"socks5h://{u}"
    return None


def load_telegram_token() -> str | None:
    """TELEGRAM_BOT_TOKEN from the environment, else ~/.pa/secrets.env
    (os.environ wins — the standalone-python convention)."""
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if token:
        return token
    try:
        with open(os.path.join(pa_home(), "secrets.env"), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                if key.strip() == "TELEGRAM_BOT_TOKEN":
                    value = value.strip().strip("\"'")
                    return value or None
    except OSError:
        pass
    return None


def _proxy_pool_create(chat_id: int, name: str, token: str) -> int:
    """ONE proxy-pool attempt, reached only when the direct call provably never
    reached Telegram (DNS failure / connect refused) — the connect-stage-only
    reroute rule. `requests` is imported lazily: route delivery must not
    depend on it, and a missing install simply skips the dormant pool."""
    import requests  # noqa: PLC0415 — deliberately lazy (see docstring)

    urls: list[str] = []
    for part in os.environ.get("TELEGRAM_PROXY_URLS", "").split(","):
        normalized = _normalize_proxy(part)
        if normalized and normalized not in urls:
            urls.append(normalized)
    try:
        with open(os.path.join(pa_home(), "telegram-proxies.json"), encoding="utf-8") as fh:
            for u in json.load(fh).get("healthy", []):
                normalized = _normalize_proxy(u)
                if normalized and normalized not in urls:
                    urls.append(normalized)
    except (OSError, ValueError):
        pass
    if not urls:
        raise RuntimeError("direct createForumTopic failed pre-connect and the proxy pool is empty")
    last_error: Exception | None = None
    for u in urls:
        try:
            resp = requests.post(
                f"https://api.telegram.org/bot{token}/createForumTopic",
                json={"chat_id": chat_id, "name": name},
                proxies={"http": u, "https": u}, timeout=(10, 15))
            data = resp.json()
            result = data.get("result") if isinstance(data, dict) else None
            if data.get("ok") and isinstance(result, dict) and isinstance(result.get("message_thread_id"), int):
                return int(result["message_thread_id"])
            raise RuntimeError(f"createForumTopic returned not ok: {_redact_bot_token(json.dumps(data)[:200])}")
        except Exception as exc:  # noqa: BLE001 — try the next proxy
            last_error = exc
    raise RuntimeError(f"all {len(urls)} pool proxies failed: {_redact_bot_token(last_error)}")


def create_forum_topic(chat_id: int, name: str, token: str) -> int:
    """createForumTopic via HTTPS, direct-first (the telegram-proxy.ts
    contract, python side per telegram_notify.py). TLS verification stays on
    (urllib default, never disabled). Failover to the SOCKS5 pool happens ONLY
    on a provably pre-connect failure — an ambiguous mid-transfer error fails
    toward 'no topic', never toward a possible duplicate. Returns the new
    message_thread_id; raises RuntimeError (token-redacted) otherwise."""
    base = (os.environ.get(TELEGRAM_API_BASE_ENV) or "https://api.telegram.org").rstrip("/")
    url = f"{base}/bot{token}/createForumTopic"
    body = json.dumps({"chat_id": chat_id, "name": name}).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (socket.gaierror, ConnectionRefusedError)):
            return _proxy_pool_create(chat_id, name, token)
        raise RuntimeError(f"createForumTopic failed: {_redact_bot_token(exc)}") from exc
    result = data.get("result") if isinstance(data, dict) else None
    if not (isinstance(data, dict) and data.get("ok") and isinstance(result, dict)):
        raise RuntimeError(f"createForumTopic returned not ok: {_redact_bot_token(json.dumps(data)[:200])}")
    thread_id = result.get("message_thread_id")
    if not isinstance(thread_id, int):
        raise RuntimeError(f"createForumTopic returned no message_thread_id: {_redact_bot_token(json.dumps(data)[:200])}")
    return thread_id


def existing_thread_for_name(registry: dict, chat_key: str, name: str) -> int | None:
    """The chat's existing topic whose name matches `name` (case-insensitive) —
    the same-name skip from setup-topics' idempotency check, reused so the
    task JOINS the topic the name matches instead of minting a duplicate."""
    chat = registry.get(chat_key)
    if not isinstance(chat, dict):
        return None
    for thread_str, entry in chat.items():
        entry_name = entry if isinstance(entry, str) else (
            entry.get("name") if isinstance(entry, dict) else None)
        if isinstance(entry_name, str) and entry_name.strip().lower() == name.strip().lower():
            try:
                return int(thread_str)
            except ValueError:
                continue
    return None


def register_new_topic(chat_key: str, thread_id: int, name: str, description: str) -> None:
    """Registry write per setup-topics' exact mechanism: entry
    {"name": ..., "description": ...} under registry[chatId][threadId],
    atomic tmp+rename."""
    registry = load_topic_registry()
    registry.setdefault(chat_key, {})[str(thread_id)] = {"name": name, "description": description}
    path = os.path.join(pa_home(), "telegram-topic-names.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(registry, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def ensure_topic_description(chat_key: str, thread_id: int, description: str) -> None:
    """Add a purpose description to an existing registry entry that lacks one.
    Rewrites the file ONLY when something actually changed — an already-
    described entry leaves the registry untouched (a no-op rewrite would still
    pay the whole read-modify-write race window for nothing)."""
    registry = load_topic_registry()
    chat = registry.get(chat_key)
    if not isinstance(chat, dict):
        return
    key = str(thread_id)
    entry = chat.get(key)
    if isinstance(entry, str):
        chat[key] = {"name": entry, "description": description}
    elif isinstance(entry, dict):
        if entry.get("description"):
            return  # already described — nothing to write
        entry["description"] = description
    else:
        return
    path = os.path.join(pa_home(), "telegram-topic-names.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(registry, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_topic_registry() -> dict:
    """setup-topics' loadRegistry twin: {} on missing/corrupt (creation's
    registry read must never hard-fail; the caller's --topic bucket already
    validated against the same file via resolve_topic)."""
    try:
        with open(os.path.join(pa_home(), "telegram-topic-names.json"), encoding="utf-8") as fh:
            registry = json.load(fh)
        return registry if isinstance(registry, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def form_topic_target(chat_id: int, source_text: str) -> tuple[str, int, str, str]:
    """The no-fit decision's outcome. Returns (status, thread_id, name, reason):
      ('formed', <new tid>, <name>, <why no existing match>) — topic minted
        and registered with a purpose description;
      ('reused', <existing tid>, <name>, '') — a topic with the derived name
        already exists; the task joins it (description backfilled if absent);
      ('failed', -1, <name>, <note>) — fall back to the caller's bucket.
    'failed' is the NORMAL degradation outcome, never an exception path:
    placement must not regress because formation can't run."""
    name = derive_topic_name(source_text)
    description = derive_topic_description(source_text)
    chat_key = str(chat_id)
    registry = load_topic_registry()
    existing = existing_thread_for_name(registry, chat_key, name)
    if existing is not None:
        try:
            ensure_topic_description(chat_key, existing, description)
        except OSError as exc:
            print(f"[WARN] matched topic exists but description update failed: {exc}", file=sys.stderr)
        return ("reused", existing, name, "")
    token = load_telegram_token()
    if not token:
        return ("failed", -1, name, "no TELEGRAM_BOT_TOKEN available for topic creation")
    try:
        new_thread_id = create_forum_topic(chat_id, name, token)
    except Exception as exc:  # noqa: BLE001 — any creation failure falls back to the bucket
        return ("failed", -1, name, f"topic creation failed: {_redact_bot_token(exc)}")
    try:
        register_new_topic(chat_key, new_thread_id, name, description)
    except OSError as exc:
        # Topic minted but unregistered: delivery still lands (the queue entry
        # carries ids, not a registry lookup) and the bot's own
        # forum_topic_created handler re-registers the name on its next poll —
        # so this is a warn-and-continue, not a fallback.
        print(f"[WARN] topic formed but registry write failed: {exc}", file=sys.stderr)
    return ("formed", new_thread_id, name, "no existing topic matched by name")


def append_route_entry(entry: dict) -> None:
    """Append one queue line in a single write; field order is the contract.

    Runs under the shared proper-lockfile mutex (see route_queue_lock) — the
    spec §7 contract the build missed for this writer; without it the bot's
    drain can rename the file out from under this append.
    """
    queue_path = route_queue_path()
    os.makedirs(os.path.dirname(queue_path), exist_ok=True)
    ensure_queue_file(queue_path)
    ordered = {field: entry[field] for field in QUEUE_FIELDS}
    for field in QUEUE_OPTIONAL_FIELDS:
        if field in entry:
            ordered[field] = entry[field]
    line = json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))
    with route_queue_lock():
        with open(queue_path, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(line + "\n")


def write_decision_trace(task: dict, topic_key: str, reason: str) -> None:
    """One decision-trace row via the worker-facing record CLI.

    The trace is the explainability feed, not the routing path: a failure here
    warns on stderr and leaves the (already committed) routing in place.
    """
    decisions_py = Path(__file__).resolve().parents[3] / "pa" / "scripts" / "decisions.py"
    row = {
        "source": "skill",
        "skill": "voice-inbox",
        "request_excerpt": task["request_text"],
        "decision": f"routed to {topic_key}",
        "rationale": reason,
    }
    tmp_path = None
    try:
        if not decisions_py.exists():
            raise FileNotFoundError(str(decisions_py))
        fd, tmp_path = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        proc = subprocess.run(
            [sys.executable, str(decisions_py), "record", "--jsonl", tmp_path],
            capture_output=True, encoding="utf-8", errors="replace", timeout=30,
        )
        stdout = (proc.stdout or "").strip()
        outcome = json.loads(stdout.splitlines()[-1]) if stdout else {}
        if proc.returncode != 0 or not outcome.get("ok"):
            raise RuntimeError(
                f"record rc={proc.returncode}: {stdout} {(proc.stderr or '').strip()}"
            )
    except Exception as exc:  # noqa: BLE001 — the trace must never break a routed task
        print(f"[WARN] decision trace not recorded: {exc}", file=sys.stderr)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Route a voice-inbox task to a Telegram topic")
    parser.add_argument("--task", required=True, help="task id (vi-...)")
    parser.add_argument("--topic", required=True, help="target topic key <chatId>_<threadId>")
    parser.add_argument("--reason", required=True, help="one-line routing reason")
    parser.add_argument("--continues", help="task id of the conversation this task joins")
    parser.add_argument("--title", help="short noun phrase naming what this conversation is "
                                        "about (<=60 chars); written only when no title is "
                                        "stored yet (AI-222 D4)")
    parser.add_argument("--create-topic", action="store_true",
                        help="no existing bucket fits (the CALLER decides this): form a topic "
                             "from the task's transcript/request instead of routing to --topic "
                             "(on any failure --topic is used with a reason note)")
    args = parser.parse_args(normalize_argv(argv))

    if args.title is not None and not args.title.strip():
        parser.error("--title must not be empty")
    if args.create_topic and args.continues:
        parser.error("--create-topic cannot be combined with --continues "
                     "(a task merging into an existing conversation must not mint a topic)")

    steer_mode = ""
    steer_outcome = "not-requested"
    steer_reason = None
    briefing = ""
    effective_topic = args.topic
    reason = args.reason
    formed_name: str | None = None

    # The ledger precondition is checked first: a server that never started is
    # the more fundamental failure, whatever else is wrong with the request.
    conn = open_ledger()
    chat_id, thread_id = resolve_topic(args.topic)
    # Route-stage topic formation reads the task's routing source text with a
    # PLAIN read, before the write transaction: the createForumTopic HTTPS call
    # below must never run inside the open ledger transaction (it would hold
    # the write lock for the whole request timeout).
    if args.create_topic:
        source_row = conn.execute(
            "SELECT transcript, request_text, state, routed_to FROM tasks WHERE task_id = ?",
            (args.task,)
        ).fetchone()
        # Formation runs BEFORE the write transaction (the createForumTopic
        # HTTPS call must never hold the ledger lock), so the state gate is
        # pre-checked here too: a --create-topic on a task the gate below
        # would refuse (done/failed/cancelled/transcribing) must not mint an
        # orphan topic before the refusal fires.
        if source_row is not None and (
                source_row["state"] in ("received", "routed")
                or (source_row["state"] == "running" and source_row["routed_to"] is None)):
            source_text = (source_row["transcript"] or "").strip() or (source_row["request_text"] or "")
            status, formed_thread_id, formed_name, detail = form_topic_target(chat_id, source_text)
            if status in ("formed", "reused"):
                reason = (f"formed {formed_name}: {detail}" if status == "formed"
                          else f"existing topic matched: {formed_name}")
                effective_topic = f"{chat_id}_{formed_thread_id}"
                thread_id = formed_thread_id
            else:
                reason = f"{args.reason} ({detail})"
    try:
        with conn:
            begin_immediate(conn)
            task = conn.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (args.task,)
            ).fetchone()
            if task is None:
                fail(f"task not found: {args.task}")
            task = dict(task)
            # The worker-side routing step accepts a fresh (received) task, a
            # re-route of an already-routed one, or (2026-09-17, OD-1) a running
            # task no route ever placed — routed_to NULL means the only worker on
            # it is the inbox router that posted progress too early. The gate is
            # the UPDATE inside transition_task() below, never this read.
            first_routing = (task["state"] == "received"
                             or (task["state"] == "running" and task["routed_to"] is None))

            # --continues (D2, automatic path): the model may only merge into a
            # NON-cancelled conversation — cancel is an explicit operator "stop
            # this" and a model guess must never undo it. The explicit operator
            # create path (routes.ts) allows any conversation, terminal included;
            # this refusal is belt-and-braces for a model naming an id it saw
            # elsewhere.
            conversation_id = task["conversation_id"]
            if args.continues:
                target = conn.execute(
                    "SELECT * FROM tasks WHERE task_id = ?", (args.continues,)
                ).fetchone()
                if target is None:
                    fail(f"continues target not found: {args.continues}")
                target = dict(target)
                if target["tenant_id"] != task["tenant_id"]:
                    fail("continues target belongs to another tenant")
                conv = target["conversation_id"]
                if conv != task["conversation_id"]:
                    newest = conn.execute(
                        "SELECT state FROM tasks WHERE conversation_id = ? AND tenant_id = ?"
                        " ORDER BY created_at DESC, task_id DESC LIMIT 1",
                        (conv, task["tenant_id"]),
                    ).fetchone()
                    if newest is not None and newest["state"] == "cancelled":
                        fail(f"conversation of task {args.continues} was cancelled; not merging")
                conversation_id = conv

            # WP-5: the operator recorded this follow-up as a steer at create
            # time (tasks.steer_mode). This script only WRITES the verb entry —
            # it never resolves the target or picks a branch, because a verdict
            # frozen here goes stale before the bot's drain reads it. The bot
            # re-reads the ledger every poll tick and decides there.
            steer_mode = (task["steer_mode"] or "").strip()
            if steer_mode in ("queue", "interrupt"):
                if not first_routing:
                    steer_outcome = "none"
                    steer_reason = "re-route: steering fires only on first routing"
                else:
                    steer_outcome = "queued"

            framing = ""
            fb_about = (task["feedback_about"] or "").strip()
            briefing_conversation_id = conversation_id
            if fb_about:
                ref_row = conn.execute(
                    "SELECT conversation_id FROM tasks WHERE task_id = ?", (fb_about,)
                ).fetchone()
                if ref_row is not None and ref_row["conversation_id"] != fb_about:
                    level = "task"
                    target_conv = ref_row["conversation_id"]
                    title_row = conn.execute(
                        "SELECT title FROM conversation_meta WHERE conversation_id = ? AND tenant_id = ?",
                        (target_conv, task["tenant_id"]),
                    ).fetchone()
                else:
                    level = "conversation"
                    target_conv = fb_about
                    title_row = conn.execute(
                        "SELECT title FROM conversation_meta WHERE conversation_id = ? AND tenant_id = ?",
                        (fb_about, task["tenant_id"]),
                    ).fetchone()
                framing = build_feedback_framing(
                    fb_about, title_row["title"] if title_row is not None else None, level) + " "

                # Feedback is about a prior conversation: brief the worker
                # from THAT conversation's turns so it has the context the
                # feedback is about. The routing topic is NOT changed —
                # feedback can be processed in any topic the caller chooses
                # (the caller's --topic or --create-topic stands). The
                # framing line + briefing carry the link and context; the
                # worker knows what the feedback is about without being on
                # the same topic as the original conversation.
                if target_conv is not None:
                    briefing_conversation_id = target_conv

            payload = {"routed_to": effective_topic, "reason": reason}
            if args.continues:
                payload["continues"] = args.continues
                payload["conversation_id"] = conversation_id
            if steer_mode in ("queue", "interrupt"):
                payload["steer"] = steer_mode
                payload["steer_conversation"] = conversation_id
                payload["steer_outcome"] = steer_outcome
                if steer_reason is not None:
                    payload["steer_reason"] = steer_reason
            # Entering routed clears the worker identity (transition_task), as
            # ledger.ts transitionTask does.
            ref_id, ts = transition_task(
                conn, args.task, "routed", "task.routed", payload,
                sets=[("routed_to = ?", effective_topic), ("routing_reason = ?", reason),
                      ("conversation_id = ?", conversation_id)],
                narrow="state IN ('received', 'routed')"
                       " OR (state = 'running' AND routed_to IS NULL)",
                refuse=lambda state: (f"task {args.task} is {state}; routing is valid from "
                                      "received or routed, or from running before any route"))
            if args.title:
                set_conversation_meta(conn, conversation_id, task["tenant_id"], ts,
                                      title=args.title, title_if_absent=True)
            elif formed_name is not None:
                # The name derived for formation is a natural initial
                # conversation title even when minting itself failed (the
                # task still landed in the fallback bucket, and the name
                # still describes the work) — same never-overwrite
                # semantics as --title.
                set_conversation_meta(conn, conversation_id, task["tenant_id"], ts,
                                      title=formed_name, title_if_absent=True)

            attachments_segment = build_attachments_segment(
                attachments_display_paths(
                    os.path.join(pa_home(), "voice-inbox", "files", args.task)
                )
            )
            base = TARGET_INJECTION_TEMPLATE.format(
                task_id=args.task, reason=reason,
                request_text=task["request_text"], repo=repo_root(), briefing="",
                framing=framing, attachments=attachments_segment)
            budget = min(CONVERSATION_BRIEFING_MAX, ROUTE_TEXT_MAX - len(base))
            briefing = build_conversation_briefing(
                conn, task["tenant_id"], briefing_conversation_id, args.task,
                ledger_path().replace("\\", "/"), budget
            ) if budget >= CONVERSATION_BRIEFING_MIN else ""
    finally:
        conn.close()

    # The queue entry carries the ALREADY-RESOLVED ids (args.topic resolved
    # pre-transaction; a formed/reused thread_id is minted above). Do NOT
    # re-lookup effective_topic through resolve_topic here: it can fail AFTER
    # the routed commit (a minted topic whose registry write failed), which
    # strands the task as 'routed' with no queue line — delivery lands on ids,
    # never on the registry.
    entry = {
        "q_id": "rq-" + secrets.token_hex(6),
        "ts": now_iso(),
        "task_id": args.task,
        "tenant_id": task["tenant_id"],
        "chat_id": chat_id,
        "thread_id": thread_id,
        "text": TARGET_INJECTION_TEMPLATE.format(
            task_id=args.task, reason=reason,
            request_text=task["request_text"], repo=repo_root(), briefing=briefing,
            framing=framing, attachments=attachments_segment),
        "ref_id": ref_id,
    }
    if steer_outcome == "queued":
        entry["kind"] = "steer"
        entry["steer_mode"] = steer_mode
        entry["steer_conversation"] = conversation_id
    append_route_entry(entry)
    write_decision_trace(task, effective_topic, reason)
    emit({"task_id": args.task, "state": "routed", "routed_to": effective_topic,
          "ref_id": ref_id, "q_id": entry["q_id"], "conversation_id": conversation_id,
          "steer_outcome": steer_outcome})


if __name__ == "__main__":
    main()
