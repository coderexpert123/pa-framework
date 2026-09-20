#!/usr/bin/env python3
"""Read or tidy the operator's request on a voice-inbox task (2026-09-16).

Invoked BY the routing worker in the inbox topic, per the voice inbox injection
text, after the deterministic transcription path has written the transcript:

    python "<repo>/projects/voice-inbox/scripts/task_request.py" show --task vi-x
    python "<repo>/projects/voice-inbox/scripts/task_request.py" clean --task vi-x \\
        --text "<cleaned request>"

`show` prints one JSON line (task_id, state, source, transcript, request_text).
Read-only.

`clean` rewrites `tasks.request_text` ONLY; `tasks.transcript` is the immutable
raw transcript and is never touched. It is refused (exit 1, nothing written)
unless the task is a `voice` task in `received` with a non-empty transcript.
A blank value is an argparse error (exit 2). A value longer than
2 x the transcript + 200 characters is refused: cleanup, never authorship.
No event is written — this is display metadata, like conversation titles.
`updated_at` is bumped so every reader's change detection sees the rewrite.
A value equal to the current request_text writes nothing. The step is
best-effort: the caller routes the task whether or not this succeeds.

This script is deliberately NOT one of the five `BEGIN SHARED LEDGER HELPER`
twins (route / telemetry / input / complete / transcribe). Like
task_set_message_id.py it needs no shared vocabulary, only the same ledger
pragmas, so the byte-identity sync test does not pin it.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from typing import NoReturn

CLEAN_MAX_GROWTH_FACTOR = 2
CLEAN_MAX_GROWTH_CHARS = 200


def pa_home() -> str:
    """PA_HOME from env or ~/.pa (same resolution as the other pa python helpers)."""
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def ledger_path() -> str:
    return os.path.join(pa_home(), "voice-inbox", "ledger.sqlite")


def open_ledger() -> sqlite3.Connection:
    """Open the existing ledger read/write with the production pragmas.

    Refuses to create anything: a missing or schema-less file means the API
    server has not started yet, and this script must not invent the schema.
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


def emit(result: dict) -> None:
    """One JSON line on stdout (ascii-escaped; zero console-encoding risk)."""
    print(json.dumps({"ok": True, **result}))


def fail(message: str, code: int = 1) -> NoReturn:
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(code)


# Flags that take a value. A value starting with a single dash would otherwise
# be eaten by argparse as an option string; normalize_argv joins such pairs into
# `--flag=value` form. Double-dash tokens are real flags and stay untouched.
VALUE_FLAGS = ("--task", "--text")


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


def non_blank(value: str) -> str:
    if not value.strip():
        raise argparse.ArgumentTypeError("must be a non-empty string")
    return value


def cmd_show(args: argparse.Namespace) -> None:
    conn = open_ledger()
    try:
        row = conn.execute(
            "SELECT task_id, state, source, transcript, request_text FROM tasks WHERE task_id = ?",
            (args.task,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        fail(f"task not found: {args.task}")
    emit({"task_id": row["task_id"], "state": row["state"], "source": row["source"],
          "transcript": row["transcript"], "request_text": row["request_text"]})


def cmd_clean(args: argparse.Namespace) -> None:
    text = args.text.strip()
    conn = open_ledger()
    try:
        with conn:
            row = conn.execute(
                "SELECT task_id, state, source, transcript, request_text FROM tasks WHERE task_id = ?",
                (args.task,),
            ).fetchone()
            if row is None:
                fail(f"task not found: {args.task}")
            if row["source"] != "voice":
                fail(f"task {args.task} is a {row['source']} task; "
                     "request cleanup is valid only for voice tasks")
            if row["state"] != "received":
                fail(f"task {args.task} is {row['state']}; "
                     "request cleanup is valid only from received")
            transcript = (row["transcript"] or "").strip()
            if not transcript:
                fail(f"task {args.task} has no transcript; nothing to clean")
            limit = CLEAN_MAX_GROWTH_FACTOR * len(transcript) + CLEAN_MAX_GROWTH_CHARS
            if len(text) > limit:
                fail(f"cleaned request is {len(text)} characters against a {len(transcript)}-character "
                     f"transcript (limit {limit}); cleanup must not add content")
            if text == row["request_text"]:
                emit({"task_id": args.task, "state": "received", "changed": False, "chars": len(text)})
                return
            cursor = conn.execute(
                "UPDATE tasks SET request_text = ?, updated_at = ? WHERE task_id = ? AND state = 'received'",
                (text, now_iso(), args.task),
            )
            if cursor.rowcount != 1:
                fail(f"task {args.task} left received during cleanup; nothing written")
    finally:
        conn.close()
    emit({"task_id": args.task, "state": "received", "changed": True, "chars": len(text)})


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Read or tidy the operator's request on a voice-inbox task")
    sub = parser.add_subparsers(dest="command", required=True)
    show = sub.add_parser("show", help="print state, transcript and request_text as one JSON line")
    show.add_argument("--task", required=True, help="task id (vi-...)")
    clean = sub.add_parser("clean", help="rewrite request_text with a cleaned version of the transcript")
    clean.add_argument("--task", required=True, help="task id (vi-...)")
    clean.add_argument("--text", required=True, type=non_blank, help="the cleaned request")
    args = parser.parse_args(normalize_argv(argv))
    if args.command == "show":
        cmd_show(args)
    else:
        cmd_clean(args)


if __name__ == "__main__":
    main()
