#!/usr/bin/env python3
"""review_digest_action.py — single writer for a conflict resolution driven from a
Telegram button press (D10, buttons program, AI-158).

The bot's `mc:` callback handler spawns this script for exactly one action:

    python pa/scripts/review_digest_action.py --conflict-id <id> --action accept|reject|ignore [--pending-path <path>]

It finds the entry in review-digest-pending.jsonl whose `id` matches --conflict-id
and whose `resolved` is not already true, marks it resolved with the mapped
resolution, and rewrites the file atomically (tmp + os.replace — the same shape as
projects/reminders/add_reminder.py:41-44). Every other line — including one that
fails to parse as JSON — is preserved verbatim in the rewrite; no line is ever
dropped.

This file has two writers in production: memory_consolidation.py runs nightly at
21:00 IST, and this script runs on a button press (a few-millisecond window). Both
use tmp+os.replace, so a collision produces two sequential atomic writes, not a
torn file.

Exit codes:
    0 — resolution applied
    2 — no entry with the given id
    3 — the matching entry is already resolved
    4 — the pending file does not exist

No Telegram calls. No imports beyond the stdlib.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

ACTION_TO_RESOLUTION = {
    'accept': 'accepted',
    'reject': 'rejected',
    'ignore': 'ignored',
}


def default_pending_path() -> str:
    """Resolve ~/.pa/review-digest-pending.jsonl, honoring PA_HOME."""
    pa_home = os.environ.get('PA_HOME') or os.path.join(os.path.expanduser('~'), '.pa')
    return os.path.join(pa_home, 'review-digest-pending.jsonl')


def apply_action(pending_path: str, conflict_id: str, action: str) -> int:
    """Apply one resolution to the matching entry in pending_path.

    Prints exactly one line to stdout describing the outcome and returns the
    process exit code (0/2/3/4 — see module docstring). Rewrites the file only on
    the success path (0); every error path leaves the file byte-for-byte
    untouched.
    """
    resolution = ACTION_TO_RESOLUTION[action]

    if not os.path.exists(pending_path):
        print(f"ERROR: pending file not found: {pending_path}")
        return 4

    with open(pending_path, 'r', encoding='utf-8', newline='') as f:
        raw_lines = f.readlines()

    target_index = None
    target_entry = None
    already_resolved = False

    for i, raw_line in enumerate(raw_lines):
        stripped = raw_line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        if parsed.get('id') != conflict_id:
            continue
        target_index = i
        target_entry = parsed
        if parsed.get('resolved') is True:
            already_resolved = True
        break

    if target_index is None:
        print(f"ERROR: no entry with id={conflict_id!r} in {pending_path}")
        return 2

    if already_resolved:
        print(f"ERROR: entry {conflict_id!r} is already resolved")
        return 3

    target_entry['resolved'] = True
    target_entry['resolution'] = resolution
    target_entry['resolved_at'] = datetime.now(timezone.utc).isoformat()

    out_lines = list(raw_lines)
    rewritten = json.dumps(target_entry)
    if not rewritten.endswith('\n'):
        rewritten += '\n'
    out_lines[target_index] = rewritten

    tmp_path = pending_path + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8', newline='\n') as f:
        for line in out_lines:
            # Normalize CRLF -> LF; everything else (including unparseable
            # content) is written back exactly as read.
            f.write(line.replace('\r\n', '\n').replace('\r', '\n'))
    os.replace(tmp_path, pending_path)

    print(f"OK: {conflict_id!r} resolved as {resolution!r}")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Apply a Telegram-button-driven resolution to one review-digest conflict entry.'
    )
    parser.add_argument('--conflict-id', required=True, help='id of the conflict entry to resolve')
    parser.add_argument('--action', required=True, choices=sorted(ACTION_TO_RESOLUTION.keys()),
                         help='accept, reject, or ignore')
    parser.add_argument('--pending-path', default=None,
                         help='override path to review-digest-pending.jsonl (default: $PA_HOME or ~/.pa)')

    args = parser.parse_args()
    pending_path = args.pending_path or default_pending_path()

    sys.exit(apply_action(pending_path, args.conflict_id, args.action))


if __name__ == '__main__':
    main()
