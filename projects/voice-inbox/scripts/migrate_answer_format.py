#!/usr/bin/env python3
"""Migrate stored voice-inbox answers to the structured summary format.

Every worker now receives the `--summary` instruction added in commit
`d02b912` (2026-09-09): plain sentences, a blank line between distinct
points, each option or step on its own line starting with `1)`, `2)`... or
`-`, no markdown headings or asterisks. Answers written to `tasks.result_summary`
BEFORE that instruction landed are still in the old shape: one unbroken line
with inline `1) ... 2) ...` enumerators, or raw `**bold**`/`#` markdown the
PWA's renderer then displays as-is. This script finds those legacy rows and
reformats them through an external LLM command, keeping every word and
number exactly as written — only whitespace/markup shape changes.

Never creates ledger schema (same contract as the other worker scripts).
`--dry-run` (default) never writes to the ledger. `--apply` is destructive
(it snapshots first) and is meant to be run by an operator/orchestrator that
has reviewed the dry-run preview, never as part of routine automation.

Usage:
    python migrate_answer_format.py [--dry-run]
    python migrate_answer_format.py --apply
    python migrate_answer_format.py --apply --from-preview <preview.json>
    python migrate_answer_format.py --dry-run --task vi-xxxxxxxxxxxx
    python migrate_answer_format.py --dry-run --ledger <path> --llm-cmd "<cmd>"

Modes
-----
--dry-run (default): selects candidate rows, reformats each distinct text
    once through --llm-cmd, checks equivalence + shape, writes a preview JSON to
    `${PA_HOME:-~/.pa}/voice-inbox/migrations/answer-format-<UTC ts>.json`
    (list of {task_id, before, after, verdict, reason}), and prints one
    verdict line per task. Touches nothing in the ledger.
--apply: first snapshots the ledger (sqlite3 backup API — safe under WAL,
    unlike a raw file copy) to
    `${PA_HOME:-~/.pa}/voice-inbox/backups/ledger-<UTC ts>.sqlite`, then
    applies every accepted record with
    `UPDATE tasks SET result_summary = ? WHERE task_id = ? AND result_summary = ?`
    (optimistic on the ORIGINAL text — a row whose text changed underneath
    since selection/preview is skipped and reported, never overwritten).
    `updated_at` is never touched: list order and read-state must not move.
--from-preview <path>: reads a (possibly hand-reviewed) preview JSON instead
    of querying the ledger and calling the LLM. Verdicts are recomputed from
    the equivalence/shape gates against the preview's own before/after pairs
    (never blindly trusted) — the only thing skipped is the LLM call itself.
--task <id> restricts selection (live or --from-preview) to one task.
--ledger <path> overrides the ledger path (backups/previews still resolve
    under PA_HOME, matching the fixed spec paths above).

Exit codes: 0 every selected record accepted (or nothing needed migration);
2 any record rejected or skipped for drift (accepted ones still applied
under --apply); 1 on error (missing ledger, LLM command failure). Every line
printed is plain text; no secrets are ever read.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass

DEFAULT_LLM_CMD = "claude -p --model sonnet --output-format text"
LEDGER_MISSING_MSG = "ledger missing: start the server first"

# Mirrors public/app.js's findEnumerators() exactly (the renderer's own list-
# splitting rule): `1)`, `1.`, `-`, `.` or `*` counts only at text start or
# right after sentence punctuation + whitespace, and only when followed by
# whitespace itself.
INLINE_ENUM_RE = re.compile(r"(?:^|(?<=[.!?:]\s))(?:\d{1,3}[.)]|[-•*])\s+")

# Shape-gate line check: a line that itself starts with an enumerator marker.
LINE_ENUM_RE = re.compile(r"^(?:\d{1,3}[.)]|[-•*])\s+")

REFORMAT_PROMPT = (
    "Reformat the following text only — do not change its meaning, wording, "
    "or any word or number in it. Insert a blank line between distinct "
    "points. Put each option or step on its own line, keeping any existing "
    "1), 2)... numbering, or using - for an unnumbered item. Remove ** and * "
    "emphasis markers and # headings. Change no other character. Output "
    "only the reformatted text, nothing else.\n\n{text}"
)


class LlmError(RuntimeError):
    """Raised when the external reformat command cannot be run or fails."""


# ---------------------------------------------------------------------------
# Pure logic (spec §"Behaviour (fixed)")
# ---------------------------------------------------------------------------


def needs_migration(text: str) -> bool:
    """True when `text` is still in the pre-2026-09-09 flat/legacy shape."""
    if not text:
        return False
    if "**" in text:
        return True
    normalized = text.replace("\r\n", "\n")
    if any(line.lstrip().startswith("#") for line in normalized.split("\n")):
        return True
    has_blank_line = bool(re.search(r"\n[ \t]*\n", normalized))
    if not has_blank_line and len(text) > 300:
        return True
    if "\n" not in normalized and len(INLINE_ENUM_RE.findall(normalized)) >= 2:
        return True
    return False


def _normalize_for_equivalence(text: str) -> str:
    normalized = text.replace("\r\n", "\n")
    normalized = re.sub(r"^[ \t]*#+", "", normalized, flags=re.M)
    normalized = normalized.replace("**", "")
    normalized = re.sub(r"\s+", "", normalized)
    return normalized


def same_content(before: str, after: str) -> bool:
    """True when `after` differs from `before` only in whitespace, `**`
    emphasis, or leading `#` heading markers — any other character change
    (a word, a dropped sentence, `1)` rewritten as `-`, a changed digit)
    fails this."""
    return _normalize_for_equivalence(before) == _normalize_for_equivalence(after)


def has_target_shape(text: str) -> bool:
    """Shape gate: `after` must contain a blank line, or at least two lines
    starting with an enumerator — otherwise the reformat did nothing."""
    normalized = text.replace("\r\n", "\n")
    if re.search(r"\n[ \t]*\n", normalized):
        return True
    lines = normalized.split("\n")
    enumerated = sum(1 for line in lines if LINE_ENUM_RE.match(line.lstrip()))
    return enumerated >= 2


def evaluate(before: str, after: str) -> tuple[str, str | None]:
    """Runs the equivalence gate then the shape gate; returns (verdict, reason)."""
    if not same_content(before, after):
        return "rejected", "content changed"
    if not has_target_shape(after):
        return "rejected", "unchanged"
    return "accepted", None


def build_prompt(text: str) -> str:
    return REFORMAT_PROMPT.format(text=text)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# External reformat command
# ---------------------------------------------------------------------------


def child_env() -> dict[str, str]:
    """Copy of the current environment with the nested-launch guard vars
    removed, so the reformat command (often `claude` itself) does not refuse
    to start because it thinks it is being launched from inside itself."""
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)
    return env


def resolve_command(cmd: str) -> list[str]:
    """Splits the command string and resolves argv[0] via shutil.which —
    required on Windows, where a bare `claude` (a .cmd shim) is not found by
    subprocess's argv-list form the way a real .exe would be."""
    parts = shlex.split(cmd)
    if parts:
        found = shutil.which(parts[0])
        if found:
            parts[0] = found
    return parts


def call_llm(cmd: str, prompt: str, timeout: int = 180) -> str:
    argv = resolve_command(cmd)
    if not argv:
        raise LlmError("empty --llm-cmd")
    try:
        proc = subprocess.run(
            argv, input=prompt, text=True, encoding="utf-8",
            capture_output=True, timeout=timeout, env=child_env(),
        )
    except FileNotFoundError as exc:
        raise LlmError(f"llm command not found: {argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise LlmError(f"llm command timed out after {timeout}s") from exc
    if proc.returncode != 0:
        raise LlmError(
            f"llm command failed (exit {proc.returncode}): {proc.stderr.strip()}"
        )
    return proc.stdout


# ---------------------------------------------------------------------------
# Ledger access — never creates schema (same contract as the other worker
# scripts under scripts/).
# ---------------------------------------------------------------------------


def pa_home() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa"))


def default_ledger_path() -> Path:
    return pa_home() / "voice-inbox" / "ledger.sqlite"


def open_readonly(path: Path) -> sqlite3.Connection:
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def open_readwrite(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=3)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 3000")
    return conn


def ledger_has_schema(conn: sqlite3.Connection) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone() is not None


def select_candidates(
    conn: sqlite3.Connection, task_id: str | None
) -> list[tuple[str, str]]:
    sql = (
        "SELECT task_id, result_summary FROM tasks"
        " WHERE state = 'done' AND result_summary IS NOT NULL AND result_summary != ''"
    )
    params: tuple = ()
    if task_id:
        sql += " AND task_id = ?"
        params = (task_id,)
    sql += " ORDER BY task_id"
    rows = conn.execute(sql, params).fetchall()
    return [
        (row["task_id"], row["result_summary"])
        for row in rows
        if needs_migration(row["result_summary"])
    ]


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def snapshot_ledger(conn: sqlite3.Connection, home: Path) -> Path:
    """Ledger snapshot via the sqlite3 backup API — safe to run against a
    live WAL-mode database, unlike copying the .sqlite file directly."""
    backups_dir = home / "voice-inbox" / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backups_dir / f"ledger-{utc_stamp()}.sqlite"
    dest = sqlite3.connect(str(backup_path))
    try:
        conn.backup(dest)
    finally:
        dest.close()
    return backup_path


def apply_records(conn: sqlite3.Connection, records: list[dict]) -> None:
    """Applies every accepted record with an optimistic guard on the
    original text; annotates each record in place with `applied`:
    True (updated), False (not accepted, left alone), or "drift" (accepted
    but the row's text no longer matched `before` — skipped, not overwritten)."""
    for record in records:
        if record["verdict"] != "accepted":
            record["applied"] = False
            continue
        cur = conn.execute(
            "UPDATE tasks SET result_summary = ? WHERE task_id = ? AND result_summary = ?",
            (record["after"], record["task_id"], record["before"]),
        )
        conn.commit()
        record["applied"] = "drift" if cur.rowcount == 0 else True


# ---------------------------------------------------------------------------
# Preview file I/O
# ---------------------------------------------------------------------------


def write_preview(records: list[dict], home: Path) -> Path:
    migrations_dir = home / "voice-inbox" / "migrations"
    migrations_dir.mkdir(parents=True, exist_ok=True)
    preview_path = migrations_dir / f"answer-format-{utc_stamp()}.json"
    payload = [
        {
            "task_id": r["task_id"],
            "before": r["before"],
            "after": r["after"],
            "verdict": r["verdict"],
            "reason": r.get("reason"),
        }
        for r in records
    ]
    preview_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return preview_path


def load_preview(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [
        {"task_id": item["task_id"], "before": item["before"], "after": item["after"]}
        for item in data
    ]


def recompute_verdict(record: dict) -> dict:
    verdict, reason = evaluate(record["before"], record["after"])
    record["verdict"] = verdict
    record["reason"] = reason
    return record


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def fail(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate legacy voice-inbox result_summary text to the "
                     "structured 2026-09-09 answer format")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true",
                       help="preview only, touch nothing (default)")
    mode.add_argument("--apply", action="store_true",
                       help="snapshot the ledger, then apply accepted records")
    parser.add_argument("--from-preview", metavar="PATH",
                         help="apply a reviewed preview JSON without calling the LLM")
    parser.add_argument("--task", help="restrict to one task id")
    parser.add_argument("--ledger", help="override the ledger path")
    parser.add_argument("--llm-cmd", default=DEFAULT_LLM_CMD,
                         help="reformat command; the prompt is piped on stdin "
                              f"(default: {DEFAULT_LLM_CMD!r})")
    return parser.parse_args(argv)


def gather_live_records(ledger_path: Path, task_id: str | None,
                         llm_cmd: str) -> list[dict]:
    if not ledger_path.exists():
        raise LlmError(LEDGER_MISSING_MSG)
    ro_conn = open_readonly(ledger_path)
    try:
        if not ledger_has_schema(ro_conn):
            raise LlmError(LEDGER_MISSING_MSG)
        candidates = select_candidates(ro_conn, task_id)
    finally:
        ro_conn.close()

    records: list[dict] = []
    cache: dict[str, dict] = {}
    for candidate_task_id, text in candidates:
        key = sha256_hex(text)
        if key not in cache:
            after = call_llm(llm_cmd, build_prompt(text))
            verdict, reason = evaluate(text, after)
            cache[key] = {"after": after, "verdict": verdict, "reason": reason}
        cached = cache[key]
        records.append({
            "task_id": candidate_task_id,
            "before": text,
            "after": cached["after"],
            "verdict": cached["verdict"],
            "reason": cached["reason"],
        })
    return records


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    home = pa_home()
    ledger_path = Path(args.ledger) if args.ledger else default_ledger_path()

    try:
        if args.from_preview:
            records = load_preview(Path(args.from_preview))
            if args.task:
                records = [r for r in records if r["task_id"] == args.task]
            records = [recompute_verdict(r) for r in records]
        else:
            records = gather_live_records(ledger_path, args.task, args.llm_cmd)
    except LlmError as exc:
        fail(str(exc))

    for record in records:
        line = f"{record['task_id']}: {record['verdict']}"
        if record["verdict"] != "accepted" and record.get("reason"):
            line += f" ({record['reason']})"
        print(line)
    if not records:
        print("no answers need migration")

    if args.apply:
        conn = open_readwrite(ledger_path)
        try:
            if not ledger_has_schema(conn):
                conn.close()
                fail(LEDGER_MISSING_MSG)
            backup_path = snapshot_ledger(conn, home)
            print(f"ledger snapshot: {backup_path}")
            apply_records(conn, records)
        finally:
            conn.close()
        for record in records:
            if record.get("applied") == "drift":
                print(f"{record['task_id']}: skipped (row changed underneath)")
    else:
        preview_path = write_preview(records, home)
        print(f"preview written: {preview_path}")

    any_rejected = any(r["verdict"] != "accepted" for r in records)
    any_drift = any(r.get("applied") == "drift" for r in records)
    raise SystemExit(2 if (any_rejected or any_drift) else 0)


if __name__ == "__main__":
    main()
