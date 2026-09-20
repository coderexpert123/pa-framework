"""Shared SessionStart hook — registers the session's bus identity and reports
roster + pending count as additionalContext.

Fires at session start for Claude-family, Antigravity CLI (agy), and
Gemini-family CLIs (all use the hookEventName 'SessionStart' and the same
hookSpecificOutput.additionalContext field). Family detection: CLAUDECODE env
(set by Claude Code; verified against 2.1.272) → provider 'claude';
ANTIGRAVITY_AGENT env (set by agy; verified against 1.2.3) → provider 'agy';
PA_WORKER overrides both.

AI-255 (2026-09-16): the session registers a DISCRIMINATED address
`provider@repo#<sha256(session_key)[0:8]>` — session key precedence:
PA_BUS_SESSION env → payload session_id → parent pid. The pending count
reports both the discriminated queue and the base `provider@repo` mailbox
(where messages land when no live session existed at send time).

Behavior: PA-worker no-op; ensure-registration with nativeSessionId + the
session's pid; cursor touch ('hook'); emits identity + registry roster size +
pending count. Does NOT consume messages.

Always exits 0. Python stdlib only. <50ms budget.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from _host_pid import resolve_host_pid
except ImportError:  # pragma: no cover — script run from an odd cwd
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _host_pid import resolve_host_pid

SCRIPT_ROOT = Path(__file__).resolve().parents[3]
MAX_CONTEXT_CHARS = 1200
CURSOR_TOUCH_THROTTLE_S = 60
# Mirror of TERM_KEY_VARS in pa/src/lib/bus-queue.ts (sessionTermKey) — the
# terminal-window identity survives the MSYS exec that severs Win32 ancestry.
# ORDER is the contract between both sides.
TERM_KEY_VARS = ('WT_SESSION', 'WEZTERM_PANE', 'TERM_SESSION_ID', 'KONSOLE_DBUS_SESSION', 'TMUX')


def _pa_home() -> Path:
    return Path(os.environ.get('PA_HOME') or (Path.home() / '.pa'))


def _iso_now() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def _is_pa_worker() -> bool:
    return bool(os.environ.get('PA_WORKER_DISPATCH_ID') or os.environ.get('PA_WORKER_RESOURCE'))


def _provider() -> str:
    if os.environ.get('PA_WORKER'):
        return os.environ['PA_WORKER']
    if os.environ.get('OPENCODE'):
        return 'opencode'
    # kgclaude sessions set BOTH markers (same claude.exe under the wrapper);
    # KGCLAUDE_SESSION must be checked first or they register as 'claude'.
    if os.environ.get('KGCLAUDE_SESSION'):
        return 'kgclaude'
    if os.environ.get('CLAUDECODE'):
        return 'claude'
    if os.environ.get('ANTIGRAVITY_AGENT'):
        return 'agy'
    if os.environ.get('CHISEL_SESSION_DB'):
        return 'devin'
    if os.environ.get('CODEX_CLI_PATH'):
        return 'codex'
    if os.environ.get('GEMINI_SESSION_ID') or os.environ.get('GEMINI_CLI_PATH'):
        return 'gemini'
    return 'cli'


def _repo_slug(data: dict) -> str:
    start = (os.environ.get('CLAUDE_PROJECT_DIR') or os.environ.get('GEMINI_PROJECT_DIR')
             or data.get('cwd') or str(SCRIPT_ROOT))
    cur = Path(start).resolve()
    for _ in range(10):
        if (cur / '.git').exists():
            break
        if cur.parent == cur:
            cur = SCRIPT_ROOT
            break
        cur = cur.parent
    return re.sub(r'[^a-z0-9]+', '-', cur.name.lower()).strip('-')[:64]


def _address_for_pid(base: str, host_pid: int) -> str:
    """When a payload carries no session key, the session registered under
    this host pid IS this session — return its address rather than minting
    a pid-derived sibling (AI-261). Freshest createdAt wins."""
    try:
        reg = _registry_file()
        if not reg.is_file():
            return ''
        data_reg = json.loads(reg.read_text(encoding='utf-8'))
        if not isinstance(data_reg, dict):
            return ''
        best = ('', '')
        for other, e in data_reg.items():
            if not isinstance(e, dict) or not str(other).startswith(base + '#'):
                continue
            if e.get('pid') == host_pid:
                ca = str(e.get('createdAt') or '')
                if ca >= best[0]:
                    best = (ca, str(other))
        return best[1]
    except Exception:
        return ''


def _self_address(data: dict) -> str:
    if addr := os.environ.get('PA_BUS_ADDRESS'):
        return addr
    base = f'{_provider()}@{_repo_slug(data)}'
    key = os.environ.get('PA_BUS_SESSION') or data.get('session_id')
    if not key:
        host_pid = resolve_host_pid(_provider())
        existing = _address_for_pid(base, host_pid)
        if existing:
            return existing
        key = host_pid
    n = int(hashlib.sha256(str(key).encode('utf-8')).hexdigest()[:8], 16)
    return f'{base}#{n}'


def _sanitize_for_path(addr: str) -> str:
    return addr.replace(':', '+')


def _registry_file() -> Path:
    return _pa_home() / 'queues' / 'registry.json'


def _cursor_file(addr: str) -> Path:
    return _pa_home() / 'queues' / f'{_sanitize_for_path(addr)}.cursor.json'


def _term_key() -> str:
    """Terminal-window identity (`VAR=value`), '' when none is set. Env
    survives the MSYS `exec` in the npm `pa` sh-shim where the Win32 parent
    chain does not (AI-272) — descendants of this session resolve the
    registration through it. Mirrors sessionTermKey() in bus-queue.ts."""
    for k in TERM_KEY_VARS:
        v = os.environ.get(k)
        if v:
            return f'{k}={v}'
    return ''


def _pending_count(addr: str, reader: str) -> int:
    """Unread-for-this-reader count (AI-272): an envelope whose readBy carries
    `reader` is read — it stays queued for other readers and re-reads, but it
    is not pending here."""
    try:
        path = _pa_home() / 'queues' / f'{_sanitize_for_path(addr)}.jsonl'
        if not path.is_file():
            return 0
        n = 0
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                env = json.loads(line)
            except Exception:
                n += 1  # an unparseable line is still pending evidence
                continue
            read_by = env.get('readBy') if isinstance(env, dict) else None
            if not (isinstance(read_by, list) and reader in read_by):
                n += 1
        return n
    except Exception:
        return 0


def _ensure_registered(addr: str, data: dict) -> None:
    try:
        reg = _registry_file()
        data_reg = {}
        if reg.is_file():
            try:
                data_reg = json.loads(reg.read_text(encoding='utf-8'))
            except Exception:
                data_reg = {}
        if not isinstance(data_reg, dict):
            data_reg = {}
        existing = data_reg.get(addr)
        host_pid = resolve_host_pid(_provider())
        tkey = _term_key()
        if isinstance(existing, dict) and existing.get('pid') == host_pid:
            # Row predating termKey gains it here — same upgrade path as
            # WP-A's nativeSessionId/pid backfill (AI-272).
            if tkey and existing.get('termKey') != tkey:
                existing['termKey'] = tkey
                tmp = reg.with_name(reg.name + '.tmp')
                tmp.write_text(json.dumps(data_reg, indent=2), encoding='utf-8')
                os.replace(tmp, reg)
            return
        entry = {
            'capabilities': ['hooks'],
            'worker': _provider(),
            'pid': host_pid,
            'createdAt': (existing or {}).get('createdAt') or _iso_now(),
        }
        if tkey:
            entry['termKey'] = tkey
        sid = data.get('session_id')
        if sid:
            entry['nativeSessionId'] = str(sid)
        # Phantom dedupe (AI-261): one host pid = one session; a duplicate
        # nativeSessionId is the same session re-keyed. Drop stale rows so
        # pid→address resolution can't pick a dead one.
        for other, e in list(data_reg.items()):
            if other == addr or not isinstance(e, dict):
                continue
            if sid and (e.get('pid') == host_pid or e.get('nativeSessionId') == str(sid)):
                del data_reg[other]
        data_reg[addr] = entry
        reg.parent.mkdir(parents=True, exist_ok=True)
        tmp = reg.with_name(reg.name + '.tmp')
        tmp.write_text(json.dumps(data_reg, indent=2), encoding='utf-8')
        os.replace(tmp, reg)
    except Exception:
        pass


def _touch_cursor(addr: str, event: str) -> None:
    try:
        cur = _cursor_file(addr)
        if cur.is_file() and (time.time() - cur.stat().st_mtime) < CURSOR_TOUCH_THROTTLE_S:
            return
        payload = {'last_event': event, 'last_event_at': _iso_now(), 'pid': resolve_host_pid(_provider())}
        cur.parent.mkdir(parents=True, exist_ok=True)
        tmp = cur.with_name(cur.name + '.tmp')
        tmp.write_text(json.dumps(payload), encoding='utf-8')
        os.replace(tmp, cur)
    except Exception:
        pass


def _roster_count() -> int:
    try:
        path = _registry_file()
        if not path.is_file():
            return 0
        data = json.loads(path.read_text(encoding='utf-8'))
        return len(data) if isinstance(data, dict) else 0
    except Exception:
        return 0


def main() -> None:
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        return
    if _is_pa_worker():
        return

    self_addr = _self_address(data)
    _ensure_registered(self_addr, data)
    _touch_cursor(self_addr, 'hook')

    roster = _roster_count()
    pending = _pending_count(self_addr, self_addr)
    base = f'{_provider()}@{_repo_slug(data)}'
    base_pending = _pending_count(base, self_addr) if self_addr != base else 0

    context = (
        f'[pa bus] You are {self_addr}. Roster: {roster} agents. '
        f'{pending} pending message(s). '
        f'Use bus_inbox (MCP) or `pa bus inbox {self_addr}` (CLI) to read. See bus.md for protocol.'
    )
    if base_pending:
        context += (f' {base_pending} message(s) also sit on the shared base mailbox {base} '
                    f'(sent while no session was live) — `pa bus inbox {base}` or let bus-drain deliver them.')
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'SessionStart',
            'additionalContext': context[:MAX_CONTEXT_CHARS],
        }
    }))


if __name__ == '__main__':
    main()
