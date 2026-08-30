#!/usr/bin/env python3
"""
Decision traces helper (Python twin of pa/src/lib/decisions.ts).

AI-164: Records judgment calls with rationale and alternatives.
Immutable after insert except outcome/reaction/message fills.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sqlite3
import sys
from datetime import datetime, timezone


# §2.1 Schema (verbatim - frozen contract)
DECISIONS_SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(decision_id UNINDEXED, request_excerpt, decision, rationale);
CREATE INDEX IF NOT EXISTS decisions_thread_ts ON decisions(thread_id, ts);
CREATE INDEX IF NOT EXISTS decisions_chat_msg  ON decisions(chat_id, message_id);
"""


def pa_home() -> str:
    """Get PA_HOME from env or ~/.pa (the projects/reminders/add_reminder.py:6 precedent)."""
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def decisions_db_path() -> str:
    """Path to decisions.sqlite (join(paHome(), 'decisions.sqlite'))."""
    return os.path.join(pa_home(), "decisions.sqlite")


def _now_iso() -> str:
    """
    UTC ISO-8601, millisecond precision, Z suffix (C9e).
    Python: datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    """
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace("+00:00", "Z")


def _mint_decision_id() -> str:
    """
    d-<YYYYMMDDHHMM>-<12 lowercase hex> - UTC in both.
    Python: 'd-' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M') + '-' + secrets.token_hex(6)
    """
    return f"d-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}-{secrets.token_hex(6)}"


def _load_secrets() -> dict[str, str]:
    """
    Parse ~/.pa/secrets.env for redaction (literal-secrets half only).
    Env-var values win (standalone-script convention).
    Collect values with len >= 8, sort longest-first.
    """
    secrets_path = os.path.join(pa_home(), "secrets.env")
    secret_values = {}

    # First, env vars win
    for key, value in os.environ.items():
        if len(value) >= 8:
            secret_values[key] = value

    # Then, secrets.env file (if exists)
    if os.path.exists(secrets_path):
        with open(secrets_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip()
                    # Only if not already set by env
                    if key not in secret_values and len(value) >= 8:
                        secret_values[key] = value

    # Sort longest-first for redaction (most specific first)
    return dict(sorted(secret_values.items(), key=lambda x: -len(x[1])))


def _redact_secrets(text: str, secrets_dict: dict[str, str]) -> str:
    """
    Redact literal secrets from text (§2.4 Python half).
    Sort longest-first, replace with <redacted:NAME>.
    Generic token-shape pass is a documented accepted gap.
    """
    for name, value in secrets_dict.items():
        if value in text:
            text = text.replace(value, f"<redacted:{name}>")
    return text


def _redact_row_fields(row: dict[str, any], secrets_dict: dict[str, str]) -> None:
    """
    Redact request_excerpt, decision, rationale, every alternatives[] entry,
    every context_refs[] entry (§2.4). Mutates row in-place.
    """
    fields_to_redact = ["request_excerpt", "decision", "rationale"]

    for field in fields_to_redact:
        if field in row and row[field]:
            row[field] = _redact_secrets(str(row[field]), secrets_dict)

    # Redact alternatives array entries
    if "alternatives" in row and isinstance(row["alternatives"], list):
        row["alternatives"] = [
            _redact_secrets(str(alt), secrets_dict) for alt in row["alternatives"]
        ]

    # Redact context_refs array entries
    if "context_refs" in row and isinstance(row["context_refs"], list):
        row["context_refs"] = [
            _redact_secrets(str(ref), secrets_dict) for ref in row["context_refs"]
        ]


def _apply_caps(row: dict[str, any]) -> dict[str, any]:
    """
    Apply §2.2 caps at INSERT (request_excerpt 200, decision 500, rationale 1000,
    alternatives ≤ 8 entries × 200 chars each, context_refs ≤ 8 entries × 200 chars each).
    Returns a capped copy (does NOT mutate input).
    """
    capped = row.copy()

    # Cap text fields
    capped["request_excerpt"] = str(row.get("request_excerpt", ""))[:200]
    capped["decision"] = str(row.get("decision", ""))[:500]
    capped["rationale"] = str(row.get("rationale", ""))[:1000]

    # Cap alternatives
    if "alternatives" in capped and isinstance(capped["alternatives"], list):
        capped["alternatives"] = [
            str(alt)[:200] for alt in capped["alternatives"][:8]
        ]

    # Cap context_refs
    if "context_refs" in capped and isinstance(capped["context_refs"], list):
        capped["context_refs"] = [
            str(ref)[:200] for ref in capped["context_refs"][:8]
        ]

    return capped


def _open_db() -> sqlite3.Connection:
    """
    Open decisions.sqlite with pragmas (busy_timeout=3000, journal_mode=WAL).
    Per-call open/close in try/finally (recall-store.ts:213-220 discipline).
    """
    db_path = decisions_db_path()
    db_dir = os.path.dirname(db_path)

    # Ensure directory exists
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(db_path, timeout=3)
    conn.execute("PRAGMA busy_timeout=3000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(DECISIONS_SCHEMA_SQL)

    return conn


def record_decision(row: dict[str, any]) -> dict:
    """
    Insert a decision row + FTS row in one transaction.
    Mint decision_id, ts, updated_at; caller-supplied values ignored.
    Returns {"ok": true, "decisionId": "d-..."} or {"ok": False, "error": "..."}.
    Never throws (§2.3 item 1).
    """
    try:
        # Validate required fields
        source = row.get("source")
        if source not in ("skill", "bot"):
            return {"ok": False, "error": "invalid row: source must be 'skill' or 'bot'"}

        # Apply caps
        capped = _apply_caps(row)

        # Trim to check if empty after trim
        if not capped["request_excerpt"].strip() or not capped["decision"].strip() or not capped["rationale"].strip():
            return {"ok": False, "error": "invalid row: empty required field after trim"}

        # Redact secrets
        secrets_dict = _load_secrets()
        _redact_row_fields(capped, secrets_dict)

        # Mint IDs and timestamps
        decision_id = _mint_decision_id()
        now = _now_iso()

        # Serialize JSON arrays
        context_refs_json = json.dumps(capped.get("context_refs", []), ensure_ascii=False)
        alternatives_json = json.dumps(capped.get("alternatives", []), ensure_ascii=False)

        conn = _open_db()
        try:
            with conn:
                # Insert main row
                conn.execute(
                    """
                    INSERT INTO decisions (
                        decision_id, refId, session_id, thread_id, source, skill,
                        request_excerpt, context_refs, decision, rationale, alternatives,
                        outcome, reaction, chat_id, message_id, ts, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        decision_id,
                        row.get("refId"),
                        row.get("session_id"),
                        row.get("thread_id"),
                        capped["source"],
                        row.get("skill"),
                        capped["request_excerpt"],
                        context_refs_json,
                        capped["decision"],
                        capped["rationale"],
                        alternatives_json,
                        row.get("outcome"),  # NULL unless caller passes it
                        row.get("reaction"),  # NULL unless caller passes it
                        row.get("chat_id"),
                        row.get("message_id"),
                        now,
                        now,
                    ),
                )

                # Insert FTS row (same transaction)
                conn.execute(
                    """
                    INSERT INTO decisions_fts (decision_id, request_excerpt, decision, rationale)
                    VALUES (?, ?, ?, ?)
                    """,
                    (decision_id, capped["request_excerpt"], capped["decision"], capped["rationale"]),
                )

        finally:
            conn.close()

        return {"ok": True, "decisionId": decision_id}

    except Exception as e:
        # Never throws - return error dict
        return {"ok": False, "error": str(e)}


def attach_decision_message(decision_id: str, chat_id: int, message_id: int) -> dict:
    """
    UPDATE decisions SET chat_id=?, message_id=?, updated_at=?
    WHERE decision_id=? AND chat_id IS NULL AND message_id IS NULL
    (§2.3 item 2). Matched 0|1.
    Returns {"ok": true, "matched": 0|1} or {"ok": False, "error": "..."}.
    """
    try:
        conn = _open_db()
        try:
            with conn:
                cursor = conn.execute(
                    """
                    UPDATE decisions
                    SET chat_id = ?, message_id = ?, updated_at = ?
                    WHERE decision_id = ? AND chat_id IS NULL AND message_id IS NULL
                    """,
                    (chat_id, message_id, _now_iso(), decision_id),
                )
                matched = cursor.rowcount
        finally:
            conn.close()

        return {"ok": True, "matched": matched}

    except Exception as e:
        return {"ok": False, "error": str(e)}


def record_reaction(chat_id: int, message_id: int, reaction: str) -> dict:
    """
    UPDATE EVERY row matching (chat_id, message_id) - a brief message can
    legitimately carry several rows and one 👍 applies to the batch (§2.3 item 3).
    Sets reaction=<emoji>, updated_at=now, and outcome='approved' for '👍' /
    'rejected' for '👎' (strong signal overwrites weak 'replied'); any other emoji
    fills reaction only. Zero matches ⇒ matched 0, not an error.
    Returns {"ok": true, "matched": <rows updated>} or {"ok": False, "error": "..."}.
    """
    try:
        # Determine outcome based on reaction
        outcome = None
        if reaction == "👍":
            outcome = "approved"
        elif reaction == "👎":
            outcome = "rejected"
        # Any other emoji: reaction only, outcome untouched

        conn = _open_db()
        try:
            with conn:
                if outcome:
                    cursor = conn.execute(
                        """
                        UPDATE decisions
                        SET reaction = ?, outcome = ?, updated_at = ?
                        WHERE chat_id = ? AND message_id = ?
                        """,
                        (reaction, outcome, _now_iso(), chat_id, message_id),
                    )
                else:
                    cursor = conn.execute(
                        """
                        UPDATE decisions
                        SET reaction = ?, updated_at = ?
                        WHERE chat_id = ? AND message_id = ?
                        """,
                        (reaction, _now_iso(), chat_id, message_id),
                    )
                matched = cursor.rowcount
        finally:
            conn.close()

        return {"ok": True, "matched": matched}

    except Exception as e:
        return {"ok": False, "error": str(e)}


def mark_replied_for_thread(chat_id: int, thread_id: int, now_ms: int | None = None) -> dict:
    """
    UPDATE decisions SET outcome='replied', updated_at=?
    WHERE thread_id=? AND (chat_id IS NULL OR chat_id=?) AND outcome IS NULL
    AND reaction IS NULL AND ts >= ?
    (§2.3 item 4). The reaction IS NULL guard keeps a filled reaction (strong)
    from ever being downgraded to 'replied' (weak).
    Cutoff: new Date(nowMs - 86_400_000).toISOString().
    Returns {"ok": true, "matched": <rows updated>} or {"ok": False, "error": "..."}.
    """
    try:
        from datetime import timedelta

        if now_ms is None:
            # Use current time if not provided
            cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec='milliseconds').replace("+00:00", "Z")
        else:
            # Convert ms to ISO timestamp
            cutoff_dt = datetime.fromtimestamp(now_ms / 1000, timezone.utc) - timedelta(days=1)
            cutoff = cutoff_dt.isoformat(timespec='milliseconds').replace("+00:00", "Z")

        conn = _open_db()
        try:
            with conn:
                cursor = conn.execute(
                    """
                    UPDATE decisions
                    SET outcome = 'replied', updated_at = ?
                    WHERE thread_id = ?
                      AND (chat_id IS NULL OR chat_id = ?)
                      AND outcome IS NULL
                      AND reaction IS NULL
                      AND ts >= ?
                    """,
                    (_now_iso(), thread_id, chat_id, cutoff),
                )
                matched = cursor.rowcount
        finally:
            conn.close()

        return {"ok": True, "matched": matched}

    except Exception as e:
        return {"ok": False, "error": str(e)}


# ============================================================================
# CLI (argparse, subcommands; exit 0 success / 1 failure / 2 usage)
# ============================================================================

def _cmd_record(args) -> None:
    """Handle 'record' subcommand."""
    rows_to_record = []

    if args.json:
        # Single row from --json
        try:
            row = json.loads(args.json)
            rows_to_record.append(row)
        except json.JSONDecodeError as e:
            result = {"ok": False, "error": f"Invalid JSON: {e}"}
            print(json.dumps(result))
            sys.exit(1)

    elif args.jsonl:
        # Batch from --jsonl file (C7: one JSON object per line; malformed lines skipped; max 10 rows)
        jsonl_path = args.jsonl
        if not os.path.exists(jsonl_path):
            result = {"ok": False, "error": f"File not found: {jsonl_path}"}
            print(json.dumps(result))
            sys.exit(1)

        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    rows_to_record.append(row)
                except json.JSONDecodeError:
                    print(f"[WARN] Skipping malformed line {line_num}: not valid JSON", file=sys.stderr)

                if len(rows_to_record) >= 10:
                    break

    if not rows_to_record:
        result = {"ok": False, "error": "No valid rows to record"}
        print(json.dumps(result))
        sys.exit(1)

    # Record each row
    results = []
    for row in rows_to_record:
        # Unknown JSON keys are ignored (forward compatibility)
        result = record_decision(row)
        results.append(result)

    # Print last result (or all if we want - but spec says "one JSON line")
    # For batch, print the last one; if all succeeded, it's ok=True
    print(json.dumps(results[-1]))

    # Exit 1 if any failed
    if not all(r.get("ok", False) for r in results):
        sys.exit(1)


def _cmd_react(args) -> None:
    """Handle 'react' subcommand."""
    result = record_reaction(args.chat_id, args.message_id, args.reaction)
    print(json.dumps(result))

    if not result.get("ok", False):
        sys.exit(1)


def _cmd_attach(args) -> None:
    """Handle 'attach' subcommand."""
    result = attach_decision_message(args.id, args.chat_id, args.message_id)
    print(json.dumps(result))

    if not result.get("ok", False):
        sys.exit(1)


def main(argv: list[str] | None = None) -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Decision traces helper (AI-164)",
        prog="decisions.py",
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommand")

    # 'record' subcommand
    record_parser = subparsers.add_parser("record", help="Record a decision row")
    record_group = record_parser.add_mutually_exclusive_group(required=True)
    record_group.add_argument("--json", help="Single row as JSON string")
    record_group.add_argument("--jsonl", help="Batch from JSONL file (max 10 rows)")

    # 'react' subcommand
    react_parser = subparsers.add_parser("react", help="Record a reaction")
    react_parser.add_argument("--chat-id", type=int, required=True, help="Chat ID")
    react_parser.add_argument("--message-id", type=int, required=True, help="Message ID")
    react_parser.add_argument("--reaction", required=True, help="Emoji reaction")

    # 'attach' subcommand
    attach_parser = subparsers.add_parser("attach", help="Attach a decision to a message")
    attach_parser.add_argument("--id", required=True, help="Decision ID (d-...)")
    attach_parser.add_argument("--chat-id", type=int, required=True, help="Chat ID")
    attach_parser.add_argument("--message-id", type=int, required=True, help="Message ID")

    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        sys.exit(2)

    if args.command == "record":
        _cmd_record(args)
    elif args.command == "react":
        _cmd_react(args)
    elif args.command == "attach":
        _cmd_attach(args)
    else:
        parser.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
