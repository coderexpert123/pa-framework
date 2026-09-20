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
    '"{session}"{bus} (note: "{note}") until {expiresAt}. If that reservation is yours, continue. '
    'If it is not, stop and coordinate before editing: run `pa claims`, message the holding '
    'session{bus_hint}, and use `pa claim --force` only after you agree who yields. This guard warns '
    'once per reservation per session and never blocks.'
)

# AI-255: planned rows are declared intent, not locks — a different warning,
# not silence: an editor about to start overlapping work deserves the heads-up
# but must not be told to "yield" to a row that doesn't block anything.
PLANNED_TEMPLATE = (
    '[pa reservation-guard] {rel} overlaps PLANNED work: {id} declared by session '
    '"{session}"{bus} (note: "{note}") until {expiresAt}. Planned reservations do not '
    'block — but if you are starting work here, check `pa claims` and coordinate{bus_hint} '
    'first so two sessions do not do the same work twice. Warns once per reservation '
    'per session and never blocks.'
)

# AI-255 B5: shared surfaces are the collision-prone paths — an edit here with
# NO reservation covering it at all is how two sessions silently write the same
# file (the evangelism incident). Advisory like everything else, once per
# session per path. `projects/*/CLAUDE.md`/`AGENTS.md` = exactly three segments.
SHARED_SURFACE_FILES = {'CLAUDE.md', 'AGENTS.md', 'BACKLOG.md', 'FILE_INVENTORY.md'}
SHARED_SURFACE_PREFIXES = ('docs/', 'inventory/', 'plans/')

UNCLAIMED_TEMPLATE = (
    '[pa reservation-guard] {rel} is a shared surface with NO active reservation '
    'covering it — claim it first (`pa claim {rel} --session <you> --note "<what>"`) '
    'or expect a rebase from whoever edits it concurrently. Warns once per session '
    'per path and never blocks.'
)


def _is_shared_surface(rel: str) -> bool:
    if rel in SHARED_SURFACE_FILES:
        return True
    if rel.startswith(SHARED_SURFACE_PREFIXES):
        return True
    parts = rel.split('/')
    return len(parts) == 3 and parts[0] == 'projects' and parts[2] in SHARED_SURFACE_FILES


def _append_unclaimed_log(pa_home: Path, rel: str, hook_session_id: str) -> None:
    """Worker-context telemetry (AI-255 B5): a dispatch that writes a shared
    surface unclaimed gets a log line, not a context emit — a worker cannot
    claim mid-flight usefully. Same top-level spread so coordinationStats()
    parses it without changes."""
    try:
        entry = {
            'timestamp': _iso_now(),
            'level': 'warn',
            'module': 'reservations',
            'message': 'unclaimed write',
            'refId': 's-' + secrets.token_hex(6),
            'path': rel,
            'dispatchId': os.environ.get('PA_WORKER_DISPATCH_ID'),
            'hookSessionId': hook_session_id,
        }
        pa_home.mkdir(parents=True, exist_ok=True)
        with open(pa_home / 'app.log.jsonl', 'a', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(entry) + '\n')
    except Exception:
        pass


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
            'holderBus': reservation.get('bus'),
            'kind': reservation.get('kind') or 'active',
            'path': rel,
            'toolName': tool_name,
            'hookSessionId': hook_session_id,
        }
        pa_home.mkdir(parents=True, exist_ok=True)
        with open(pa_home / 'app.log.jsonl', 'a', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(entry) + '\n')
    except Exception:
        pass


def _build_context(matches: list, rel: str, template: str, more_label: str) -> str:
    rows = []
    for r in matches[:MAX_ROWS]:
        bus_addr = r.get('bus')
        rows.append(template.format(
            rel=rel,
            id=r.get('id'),
            session=r.get('session'),
            bus=f' (bus {bus_addr})' if bus_addr else '',
            bus_hint=f' via `pa bus send {bus_addr}`' if bus_addr else '',
            note=r.get('note'),
            expiresAt=r.get('expiresAt'),
        ))
    text = '\n'.join(rows)
    remaining = len(matches) - MAX_ROWS
    if remaining > 0:
        text += f'\n(+{remaining} more {more_label} reservations overlap this path — run `pa claims`.)'
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
    # WB-208: membership and the slice length agree on the normcased strings,
    # so a case-variant root can never raise ValueError out of a case-sensitive
    # relative_to (main()'s unconditional except would swallow that into
    # silence). The rel itself is sliced from the ORIGINAL-cased strings —
    # normcase is length-preserving — because everything below (the shared
    # surface set, the once-per-path suppression caches) is case-SENSITIVE on
    # the rel value.
    rel = (str(p)[len(str(REPO_ROOT)):].lstrip('/\\') or '.').replace('\\', '/')

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
    live = []
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
            live.append(r)

    # Overlap, mirroring pa/src/lib/reservations.ts's pathsOverlap exactly:
    # equal, or a path-prefix at a '/' boundary in either direction. Logical
    # `@`-prefixed resources (e.g. "@build") never match a file path.
    def _overlapping(rows: list) -> list:
        out = []
        for r in rows:
            paths = r.get('paths')
            if not isinstance(paths, list):
                continue
            for rp in paths:
                if not isinstance(rp, str) or rp.startswith('@'):
                    continue
                if rel == rp or rel.startswith(rp + '/') or rp.startswith(rel + '/'):
                    out.append(r)
                    break
        return out

    # AI-255: planned rows (kind == 'planned') are advisory intent — they get
    # the softer PLANNED_TEMPLATE, and only when no ACTIVE row already matches
    # (an active claim is the stronger signal and subsumes a planned overlap).
    active_rows = [r for r in live if r.get('kind') != 'planned']
    matches = _overlapping(active_rows)
    template, more_label = WARNING_TEMPLATE, 'active'
    if not matches:
        matches = _overlapping([r for r in live if r.get('kind') == 'planned'])
        template, more_label = PLANNED_TEMPLATE, 'planned'

    # AI-255 B5: nothing covers this path at all — if it is a shared surface,
    # that absence IS the finding. Worker context (PA_WORKER_DISPATCH_ID): the
    # writer cannot claim mid-flight usefully, so emit only a telemetry line
    # for the post-hoc audit. Headed sessions get the advisory context, once
    # per session per path (the cache key carries no reservation id).
    if not matches:
        if not _is_shared_surface(rel):
            return
        session_id = str(payload.get('session_id') or '')
        dispatch_id = os.environ.get('PA_WORKER_DISPATCH_ID')
        # Once per (writer, path) either way — a dispatch's multi-edit pass on
        # one file would otherwise append identical telemetry lines.
        warned_path = pa_home / 'hook-warned.json'
        try:
            with open(warned_path, encoding='utf-8') as f:
                warned = json.load(f)
            if not isinstance(warned, dict):
                warned = {}
        except Exception:
            warned = {}
        writer_key = dispatch_id or session_id
        cache_key = f"{writer_key}|unclaimed|{rel}"
        if cache_key in warned:
            return
        now_epoch = now.timestamp()
        pruned = {
            k: v for k, v in warned.items()
            if isinstance(v, (int, float)) and (now_epoch - v) < WARN_TTL_SECONDS
        }
        pruned[cache_key] = now_epoch
        _write_cache_atomic(warned_path, pruned)
        if dispatch_id:
            _append_unclaimed_log(pa_home, rel, session_id)
            return
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'additionalContext': UNCLAIMED_TEMPLATE.format(rel=rel)[:MAX_CONTEXT_CHARS],
            }
        }))
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

    text = _build_context(new_matches, rel, template, more_label)
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
