#!/usr/bin/env python3
"""Record the Telegram message_id of a voice-inbox task's FYI reply (AI-218).

Invoked BY the telegram bot, right after it posts the worker's result to the
routed topic and reads the ``message_id`` off the ``sendMessage`` response:

    python "<repo>/projects/voice-inbox/scripts/task_set_message_id.py" \\
        --task vi-x --message-id 4242

Writes ``tasks.tg_message_id`` (schema v11) — a plain column update with NO
state transition and NO event. The message_id is display plumbing for the
voice-inbox deep link (``https://t.me/c/<chatId>/<threadId>/<messageId>``),
not task lifecycle. Tenant-scoped by the task's own row (the script takes no
tenant argument; the task id is globally unique). Best-effort by design: a
missing task or a non-integer id exits non-zero with a JSON ``{"ok": false}``
line, and the bot's caller logs it and moves on — a lost message_id loses a
deep-link anchor, never the delivered reply.

This script is deliberately NOT one of the five ``BEGIN SHARED LEDGER HELPER``
twins (route / telemetry / input / complete / transcribe): it carries none of
the shared vocabulary (TASK_STATES, transitions, event kinds, meta upsert) and
opening the ledger with the same pragmas is all it needs, so the byte-identity
sync test does not pin it.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from typing import NoReturn


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
VALUE_FLAGS = ("--task", "--message-id")


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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Record the Telegram message_id of a voice-inbox task's FYI reply")
    parser.add_argument("--task", required=True, help="task id (vi-...)")
    parser.add_argument("--message-id", required=True, type=int,
                        help="Telegram message_id of the FYI reply posted to the topic")
    args = parser.parse_args(normalize_argv(argv))

    conn = open_ledger()
    try:
        with conn:
            row = conn.execute(
                "SELECT task_id, tenant_id, state FROM tasks WHERE task_id = ?",
                (args.task,),
            ).fetchone()
            if row is None:
                fail(f"task not found: {args.task}")
            ts = now_iso()
            conn.execute(
                "UPDATE tasks SET tg_message_id = ?, updated_at = ? WHERE task_id = ?",
                (args.message_id, ts, args.task),
            )
    finally:
        conn.close()

    emit({"task_id": args.task, "tg_message_id": args.message_id})


if __name__ == "__main__":
    main()
