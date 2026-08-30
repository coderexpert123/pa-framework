"""Shared runtime-state helpers for daily-mail-brief."""

import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
LEGACY_STATE_FILE = os.path.join(PROJECT_ROOT, "state.json")
LEGACY_FETCH_FAILED_FILE = os.path.join(PROJECT_ROOT, ".fetch-failed.json")


def pa_home() -> str:
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def state_file() -> str:
    return os.path.join(pa_home(), "daily-mail-brief-state.json")


def fetch_failed_file() -> str:
    return os.path.join(pa_home(), "daily-mail-brief-fetch-failed.json")


def slo_misses_file() -> str:
    """Path to ~/.pa/daily-mail-brief/latest.json (SLO feed)."""
    return os.path.join(pa_home(), "daily-mail-brief", "latest.json")


def _parse_utc_datetime(raw: str) -> datetime:
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def load_last_window_end() -> Optional[datetime]:
    for path in (state_file(), LEGACY_STATE_FILE):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            return _parse_utc_datetime(data["last_window_end_utc"])
        except Exception:
            continue
    return None


def write_last_window_end(window_end: datetime) -> None:
    os.makedirs(pa_home(), exist_ok=True)
    with open(state_file(), "w", encoding="utf-8") as f:
        json.dump(
            {"last_window_end_utc": window_end.astimezone(timezone.utc).isoformat()},
            f,
            indent=2,
        )


def write_failure_marker(status: str, reason: str) -> None:
    os.makedirs(pa_home(), exist_ok=True)
    with open(fetch_failed_file(), "w", encoding="utf-8") as f:
        json.dump(
            {
                "status": status,
                "reason": reason[:4000],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            f,
            indent=2,
        )


def read_failure_marker() -> Optional[dict[str, Any]]:
    for path in (fetch_failed_file(), LEGACY_FETCH_FAILED_FILE):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            continue
    return None


def clear_failure_marker() -> None:
    for path in (fetch_failed_file(), LEGACY_FETCH_FAILED_FILE):
        if not os.path.exists(path):
            continue
        try:
            os.remove(path)
        except OSError:
            pass


def append_window_misses(new_misses: list[dict]) -> None:
    """Append missed windows to the SLO misses file (§2.4).

    Reads the existing file, merges new misses by timestamp (dedup),
    keeps the 200 most recent, and writes atomically.

    Raises on failure — the caller (fetch_headers.py) wraps in try/except.
    """
    misses_path = slo_misses_file()
    os.makedirs(os.path.dirname(misses_path), exist_ok=True)

    # Read existing misses
    existing = []
    if os.path.exists(misses_path):
        with open(misses_path, encoding="utf-8") as f:
            try:
                data = json.load(f)
                existing = data.get("misses", [])
            except json.JSONDecodeError:
                existing = []

    # Merge by timestamp (dedup)
    merged = {m["timestamp"]: m for m in existing + new_misses}
    all_misses = list(merged.values())

    # Sort by timestamp descending and cap at 200
    all_misses.sort(key=lambda m: m["timestamp"], reverse=True)
    all_misses = all_misses[:200]

    # Write atomically (tmp + os.replace)
    output = {
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "misses": all_misses,
    }
    fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(misses_path), prefix=".tmp_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, misses_path)
    except Exception:
        os.unlink(tmp_path)
        raise
