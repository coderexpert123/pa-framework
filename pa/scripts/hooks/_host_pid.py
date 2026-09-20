"""Resolve the session's true host pid — the provider CLI process the hook
runs under.

`os.getppid()` on a hook subprocess returns the hook-runner — a powershell or
cmd shim on Windows — which dies with the hook. Registry entries keyed on it
are born dead (AI-261, observed 2026-09-17: every registered pid read DEAD —
a0's entry recorded 30588 under a live claude.exe 31580), which breaks
ancestor-matching, dead-owner GC, and `pa bus whoami` alike. This helper
walks the ancestor chain to the nearest process whose image basename is the
provider's CLI host.

One OS-level enumeration — Toolhelp32 snapshot on win32, /proc on POSIX —
then an in-memory parent walk (the process-tree snapshot invariant). ctypes
only, no subprocesses — the hook latency budget forbids a powershell call
per fire. Fails open to os.getppid(): a wrong-but-present pid is the same
baseline as before, never a crash.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Provider CLI host image basenames (lowercase, compared against the exe
# basename only — an arg mentioning 'devin' never matches). agy.exe is a real
# console host (verified 1.2.4 — hooks spawn under it directly). Node-launched
# providers (gemini) have no recognizable host image and keep getppid.
HOST_IMAGES: dict[str, frozenset[str]] = {
    'claude': frozenset({'claude', 'claude.exe'}),
    # kgclaude is a wrapper around the same claude.exe — the host image is
    # identical; the KGCLAUDE_SESSION env marker carries the distinction.
    'kgclaude': frozenset({'claude', 'claude.exe'}),
    'agy': frozenset({'agy', 'agy.exe'}),
    'devin': frozenset({'devin', 'devin.exe'}),
    'codex': frozenset({'codex', 'codex.exe'}),
    'opencode': frozenset({'opencode', 'opencode.exe'}),
}

_MAX_HOPS = 32


def _process_table_win32() -> dict[int, tuple[int, str]]:
    """pid -> (ppid, exe basename) via one Toolhelp32 process snapshot."""
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ('dwSize', wintypes.DWORD),
            ('cntUsage', wintypes.DWORD),
            ('th32ProcessID', wintypes.DWORD),
            ('th32DefaultHeapID', ctypes.c_void_p),
            ('th32ModuleID', wintypes.DWORD),
            ('cntThreads', wintypes.DWORD),
            ('th32ParentProcessID', wintypes.DWORD),
            ('pcPriClassBase', ctypes.c_long),
            ('dwFlags', wintypes.DWORD),
            ('szExeFile', wintypes.WCHAR * 260),
        ]

    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snap == wintypes.HANDLE(-1).value:
        return {}
    try:
        pe = PROCESSENTRY32W()
        pe.dwSize = ctypes.sizeof(pe)
        table: dict[int, tuple[int, str]] = {}
        ok = k32.Process32FirstW(snap, ctypes.byref(pe))
        while ok:
            table[int(pe.th32ProcessID)] = (int(pe.th32ParentProcessID), pe.szExeFile)
            ok = k32.Process32NextW(snap, ctypes.byref(pe))
        return table
    finally:
        k32.CloseHandle(snap)


def _process_table_posix() -> dict[int, tuple[int, str]]:
    """pid -> (ppid, comm) via /proc."""
    table: dict[int, tuple[int, str]] = {}
    proc = Path('/proc')
    if not proc.is_dir():
        return table
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text()
            comm = stat[stat.index('(') + 1:stat.rindex(')')]
            ppid = int(stat[stat.rindex(')') + 2:].split()[1])
            table[int(entry.name)] = (ppid, comm)
        except Exception:
            continue
    return table


def _process_table() -> dict[int, tuple[int, str]]:
    if sys.platform == 'win32':
        return _process_table_win32()
    return _process_table_posix()


def resolve_host_pid(
    provider: str = '',
    *,
    _start: int | None = None,
    _table: dict[int, tuple[int, str]] | None = None,
) -> int:
    """Nearest ancestor (inclusive of the hook's own parent) whose image
    basename is the provider's CLI host, else the hook's parent pid.
    `_start`/`_table` are test seams — production callers pass neither."""
    targets = HOST_IMAGES.get(provider)
    start = _start if _start is not None else os.getppid()
    if not targets:
        return start
    table = _table if _table is not None else _process_table()
    cur = start
    seen = {cur}
    for _ in range(_MAX_HOPS):
        ppid, name = table.get(cur, (0, ''))
        if name.lower() in targets:
            return cur
        if ppid <= 0 or ppid in seen:
            break
        seen.add(ppid)
        cur = ppid
    return start
