#!/usr/bin/env python3
"""Deterministic digest of ~/.pa/rate-limit-unparseable.jsonl.

Prints either the single word NO_OUTPUT (nothing new since the last run) or a
compact grouped report of the entries that have never been reported before.

Why this exists
---------------
`rate-limit-retrospective` used to be an hourly gemini skill that (a) could not
read the input file at all, because the gemini shim forces cwd to the repo root
and `--yolo` sandboxes file tools to that tree — 9 runs failed the read outright
and 7 delivered raw sandbox-error text to the user as if it were content; and
(b) filtered "entries within the last 65 minutes" by LLM arithmetic, which
triple-reported the audit window's single real event. It burned 106 gemini runs
(~288 minutes) for ONE input line.

Both problems are structural, not promptable:
  * A plain Python process has no sandbox, so the file is simply readable.
  * "Have I already reported this line?" is a cursor, not a time window. The
    cursor is a line index, so an entry is reported exactly once no matter how
    often the skill runs or how the clocks drift.
  * Grouping, counting and pattern classification are all deterministic, so no
    LLM is invoked on any run.

Cursor semantics
----------------
`<PA_HOME>/rate-limit-retrospective-cursor.json` stores `processedLines`. New
entries are `lines[processedLines:]`. If the file is shorter than the cursor it
was rotated or truncated, so the cursor resets to 0 and everything is reported
(loud, once — silent loss is worse than a duplicate). On the very first run
(no cursor file) only entries inside `--first-run-window-hours` are reported,
so adopting this script does not dump months of history into Telegram; the
cursor still advances past everything. A cursor file that exists but is corrupt
(bad JSON, wrong shape, non-int or negative `processedLines`) is treated as no
cursor at all — same window-guarded adoption, never a crash.

Usage:  python rate_limit_digest.py
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windows pipes default to cp1252 and these raw snippets carry the middle-dot
# and smart quotes that z.ai/Anthropic error strings use (same bug class as the
# 2026-07-08 PII-guard encoding fix).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_FIRST_RUN_WINDOW_HOURS = 24
MAX_REPORT_CHARS = 1500
MAX_SNIPPET_CHARS = 300

# Ordered — first match wins. Specific causes before generic ones.
HYPOTHESES = (
    (re.compile(r"insufficient balance|no resource package|out of credit", re.I),
     "account credit exhausted — top up or switch preferred_worker"),
    (re.compile(r"\bquota\b|usage limit|weekly limit", re.I),
     "provider quota exhausted — wait for the window to roll or switch worker"),
    (re.compile(r"\b429\b|too many requests|rate.?limit", re.I),
     "genuine upstream 429 with wording rate-limits.ts has no pattern for"),
    (re.compile(r"\b5\d\d\b|overloaded|internal server error|bad gateway", re.I),
     "upstream server error misclassified as a rate limit"),
    (re.compile(r"exited with code|exit code|killed|timed out", re.I),
     "worker died without emitting rate-limit evidence — not a real rate limit"),
)

NOVEL_HYPOTHESIS = "NOVEL — no known pattern; file as a backlog item"


def pa_home() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa"))


def hypothesis_for(raw: str) -> str:
    """Deterministic one-line cause for a raw unparseable rate-limit string."""
    for pattern, text in HYPOTHESES:
        if pattern.search(raw or ""):
            return text
    return NOVEL_HYPOTHESIS


def read_lines(path: Path) -> list[str]:
    """Non-empty raw lines, or [] when the file does not exist."""
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    return [ln for ln in (l.strip() for l in text.splitlines()) if ln]


def select_new_lines(lines: list[str], processed: int) -> tuple[list[str], int, bool]:
    """(new_lines, effective_processed, rotated).

    A file shorter than the cursor means rotation/truncation: replay everything
    rather than silently skipping entries.
    """
    rotated = len(lines) < processed
    effective = 0 if rotated else processed
    return lines[effective:], effective, rotated


def parse_entries(lines: list[str]) -> tuple[list[dict], int]:
    """(parsed entries, count of lines that were not valid JSON objects)."""
    entries: list[dict] = []
    malformed = 0
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            malformed += 1
            continue
        if isinstance(obj, dict):
            entries.append(obj)
        else:
            malformed += 1
    return entries, malformed


def parse_ts(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def within_window(entries: list[dict], now: datetime, hours: int) -> list[dict]:
    """First-run guard. Entries with an unparseable timestamp count as historical."""
    cutoff = now - timedelta(hours=hours)
    kept = []
    for e in entries:
        ts = parse_ts(e.get("timestamp"))
        if ts is not None and ts >= cutoff:
            kept.append(e)
    return kept


def group_entries(entries: list[dict]) -> list[dict]:
    """Group by (worker, reason); biggest group first, then alphabetical."""
    groups: dict[tuple, dict] = {}
    for e in entries:
        key = (str(e.get("worker") or "unknown"), str(e.get("reason") or "unknown"))
        g = groups.setdefault(key, {"worker": key[0], "reason": key[1],
                                    "count": 0, "snippet": "", "latest": ""})
        g["count"] += 1
        raw = str(e.get("raw") or "")
        if not g["snippet"]:
            g["snippet"] = raw[:MAX_SNIPPET_CHARS]
            g["hypothesis"] = hypothesis_for(raw)
        ts = str(e.get("timestamp") or "")
        if ts > g["latest"]:
            g["latest"] = ts
    return sorted(groups.values(), key=lambda g: (-g["count"], g["worker"], g["reason"]))


def render_report(groups: list[dict], malformed: int, rotated: bool) -> str:
    """Compact Markdown report. sendToTelegram handles MarkdownV2 escaping."""
    total = sum(g["count"] for g in groups)
    lines = [f"*Rate-limit parser misses — {total} new entr{'y' if total == 1 else 'ies'}*"]
    if rotated:
        lines.append("_(cursor reset: the log was rotated or truncated — replaying it)_")
    for g in groups:
        lines.append("")
        lines.append(f"*{g['worker']}* × {g['count']} — reason `{g['reason']}`")
        lines.append(f"`{g['snippet']}`")
        lines.append(g.get("hypothesis", NOVEL_HYPOTHESIS))
    if malformed:
        lines.append("")
        lines.append(f"⚠️ {malformed} malformed line(s) skipped.")
    lines.append("")
    lines.append("Action: file as backlog if the pattern is novel; ignore if transient.")
    report = "\n".join(lines)
    if len(report) > MAX_REPORT_CHARS:
        report = report[: MAX_REPORT_CHARS - 3].rstrip() + "..."
    return report


def load_cursor(path: Path) -> dict | None:
    """The stored cursor, or None when there is no USABLE one.

    Fails safe toward first-run semantics (window-guarded and silent, then the
    cursor advances past everything). Unreadable JSON, a non-dict payload, or a
    `processedLines` that is not a non-negative int all return None — do NOT
    regress this into trusting the raw field: `int(cursor["processedLines"])`
    on a corrupt state file raised ValueError/TypeError and killed the hourly
    skill outright, and a negative value silently replayed the tail of the log
    as if it were new.
    """
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    processed = data.get("processedLines")
    if isinstance(processed, bool) or not isinstance(processed, int) or processed < 0:
        return None
    return data


def save_cursor(path: Path, processed: int, now: datetime) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = {"processedLines": processed, "updatedAt": now.isoformat()}
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", help="Override the unparseable log path (tests).")
    parser.add_argument("--cursor", help="Override the cursor file path (tests).")
    parser.add_argument("--now", help="Override 'now' as an ISO timestamp (tests).")
    parser.add_argument("--no-advance", action="store_true",
                        help="Report without advancing the cursor (tests / manual).")
    parser.add_argument("--first-run-window-hours", type=int,
                        default=DEFAULT_FIRST_RUN_WINDOW_HOURS)
    args = parser.parse_args(argv)

    home = pa_home()
    log_path = Path(args.file) if args.file else home / "rate-limit-unparseable.jsonl"
    cursor_path = (Path(args.cursor) if args.cursor
                   else home / "rate-limit-retrospective-cursor.json")
    now = parse_ts(args.now) or datetime.now(timezone.utc)

    lines = read_lines(log_path)
    cursor = load_cursor(cursor_path)
    first_run = cursor is None  # also covers an unusable/corrupt state file
    processed = cursor["processedLines"] if cursor else 0

    new_lines, _effective, rotated = select_new_lines(lines, processed)
    entries, malformed = parse_entries(new_lines)
    if first_run:
        entries = within_window(entries, now, args.first_run_window_hours)
        malformed = 0  # historical noise, not something to page about on adoption

    if not args.no_advance:
        try:
            save_cursor(cursor_path, len(lines), now)
        except OSError as e:
            # Never let a cursor-write failure suppress the report itself.
            print(f"[rate-limit-digest] cursor write failed: {e}", file=sys.stderr)

    if not entries and not malformed:
        print("NO_OUTPUT")
        return 0

    print(render_report(group_entries(entries), malformed, rotated))
    return 0


if __name__ == "__main__":
    sys.exit(main())
