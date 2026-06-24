"""Shared runtime-state helpers for daily-mail-brief."""

import json
import os
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
