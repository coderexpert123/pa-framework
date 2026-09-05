"""Claude Code PreToolUse hook — warns (never blocks) on edits under an
active `pa claim` reservation held by a different session.

Wave C, W-C4 (AI-156). Registered PROJECT-scoped in this repo's tracked
`.claude/settings.json` (matcher `Edit|Write|MultiEdit|NotebookEdit`), which
means it fires only for sessions started in this checkout and its worktrees
— never in an unrelated repo.

Contract notes (see the 2026-08-23 coordination Wave-C spec, V1-V9b):
  * ALWAYS exits 0. Exit 2 blocks a PreToolUse hook; this guard must never
    block an edit, so `main()` swallows every exception unconditionally and
    never raises past its own boundary.
  * The warning is delivered via `hookSpecificOutput.additionalContext`,
    WITH NO `permissionDecision` key. Plain stdout is invisible to the model
    on PreToolUse (only UserPromptSubmit/UserPromptExpansion/SessionStart
    surface raw stdout) — `additionalContext` is the only way a PreToolUse
    hook can put text in front of the model without touching the permission
    decision. The CLI's own "unrecognized key" hint text is stale and omits
    `additionalContext` from its PreToolUse field list; do not "fix" this
    script on the strength of that message — the field is real and honored.
  * No `git` subprocess and no `$CLAUDE_PROJECT_DIR` read at runtime: repo
    containment is a pure string comparison against `REPO_ROOT`, computed
    once from `__file__` so a worktree checkout carries its own correct copy
    of this script and checks worktree-relative paths against the same
    shared `~/.pa/reservations.json` store.
  * Python stdlib only. No third-party imports, no subprocess, <50ms budget
    inside the hook's 5-second timeout.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

# pa/scripts/hooks/reservation-guard.py -> parents[0]=hooks, [1]=scripts,
# [2]=pa, [3]=repo root. This is the checkout the script itself lives in —
# NOT a project-config value read at runtime (V9b).
REPO_ROOT = Path(__file__).resolve().parents[3]

EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'}
MAX_ROWS = 3
MAX_CONTEXT_CHARS = 1200
WARN_TTL_SECONDS = 86400

WARNING_TEMPLATE = (
    '[pa reservation-guard] {rel} is inside an ACTIVE reservation: {id} held by session '
    '"{session}" (note: "{note}") until {expiresAt}. If that reservation is yours, continue. '
    'If it is not, stop and coordinate before editing: run `pa claims`, message the holding '
    'session, and use `pa claim --force` only after you agree who yields. This guard warns '
    'once per reservation per session and never blocks.'
)


def _pa_home() -> Path:
    return Path(os.environ.get('PA_HOME') or (Path.home() / '.pa'))


def _iso_now() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def _write_cache_atomic(path: Path, data: dict) -> None:
    """Tmp-then-os.replace (atomic on Windows). A write failure here is
    swallowed — W-C9 explicitly accepts one duplicate warning under a lost
    update rather than taking a lock in a 5-second-timeout hook."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_name(path.name + '.tmp')
        with open(tmp_path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(data, f)
        os.replace(tmp_path, path)
    except Exception:
        pass


def _append_log(pa_home: Path, reservation: dict, rel: str, tool_name: str, hook_session_id: str) -> None:
    """W-C7 log-line shape — top-level spread, matching log.ts exactly so
    coordinationStats() needs no new parsing. One line per NEWLY emitted
    warning; a suppressed repeat appends nothing (caller only invokes this
    for matches that survived the warn-once filter)."""
    try:
        entry = {
            'timestamp': _iso_now(),
            'level': 'warn',
            'module': 'reservations',
            'message': 'hook warning',
            'refId': 's-' + secrets.token_hex(6),
            'reservationId': reservation.get('id'),
            'holder': reservation.get('session'),
            'path': rel,
            'toolName': tool_name,
            'hookSessionId': hook_session_id,
        }
        pa_home.mkdir(parents=True, exist_ok=True)
        with open(pa_home / 'app.log.jsonl', 'a', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(entry) + '\n')
    except Exception:
        pass


def _build_context(matches: list, rel: str) -> str:
    rows = []
    for r in matches[:MAX_ROWS]:
        rows.append(WARNING_TEMPLATE.format(
            rel=rel,
            id=r.get('id'),
            session=r.get('session'),
            note=r.get('note'),
            expiresAt=r.get('expiresAt'),
        ))
    text = '\n'.join(rows)
    remaining = len(matches) - MAX_ROWS
    if remaining > 0:
        text += f'\n(+{remaining} more active reservations overlap this path — run `pa claims`.)'
    return text[:MAX_CONTEXT_CHARS]


def _run() -> None:
    payload = json.loads(sys.stdin.read())
    if not isinstance(payload, dict):
        return

    tool = payload.get('tool_name')
    if tool not in EDIT_TOOLS:
        return

    tool_input = payload.get('tool_input') or {}
    raw_path = tool_input.get('file_path') or tool_input.get('path') or tool_input.get('notebook_path')
    if not raw_path:
        return

    p = Path(raw_path)
    if not p.is_absolute():
        p = Path(payload.get('cwd') or os.getcwd()) / raw_path
    p = p.resolve()

    # Repo membership, case-insensitive (Windows), pure string comparison —
    # no git subprocess (V9b). A separator boundary keeps a sibling
    # directory whose name happens to share a prefix from matching.
    p_str = os.path.normcase(str(p))
    root_str = os.path.normcase(str(REPO_ROOT))
    if not (p_str == root_str or p_str.startswith(root_str + os.sep)):
        return
    rel = p.relative_to(REPO_ROOT).as_posix()

    pa_home = _pa_home()

    try:
        with open(pa_home / 'reservations.json', encoding='utf-8') as f:
            store = json.load(f)
    except Exception:
        return

    reservations = store.get('reservations') if isinstance(store, dict) else None
    if not isinstance(reservations, list):
        return

    now = datetime.now(timezone.utc)
    active = []
    for r in reservations:
        if not isinstance(r, dict):
            continue
        expires_raw = r.get('expiresAt')
        if not isinstance(expires_raw, str):
            continue
        try:
            expires = datetime.fromisoformat(expires_raw.replace('Z', '+00:00'))
        except Exception:
            continue
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires > now:
            active.append(r)

    # Overlap, mirroring pa/src/lib/reservations.ts's pathsOverlap exactly:
    # equal, or a path-prefix at a '/' boundary in either direction. Logical
    # `@`-prefixed resources (e.g. "@build") never match a file path.
    matches = []
    for r in active:
        paths = r.get('paths')
        if not isinstance(paths, list):
            continue
        for rp in paths:
            if not isinstance(rp, str) or rp.startswith('@'):
                continue
            if rel == rp or rel.startswith(rp + '/') or rp.startswith(rel + '/'):
                matches.append(r)
                break

    if not matches:
        return

    # Warn-once per (session_id, reservation_id) — W-C9.
    session_id = str(payload.get('session_id') or '')
    warned_path = pa_home / 'hook-warned.json'
    try:
        with open(warned_path, encoding='utf-8') as f:
            warned = json.load(f)
        if not isinstance(warned, dict):
            warned = {}
    except Exception:
        warned = {}

    new_matches = [r for r in matches if f"{session_id}|{r.get('id')}" not in warned]
    if not new_matches:
        return

    now_epoch = now.timestamp()
    pruned = {
        k: v for k, v in warned.items()
        if isinstance(v, (int, float)) and (now_epoch - v) < WARN_TTL_SECONDS
    }
    for r in new_matches:
        pruned[f"{session_id}|{r.get('id')}"] = now_epoch
    _write_cache_atomic(warned_path, pruned)

    for r in new_matches:
        _append_log(pa_home, r, rel, tool, session_id)

    text = _build_context(new_matches, rel)
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'additionalContext': text,
        }
    }))


def main() -> int:
    try:
        _run()
    except Exception:
        pass          # never block, never print a traceback (V4)
    return 0


if __name__ == '__main__':
    sys.exit(main())
