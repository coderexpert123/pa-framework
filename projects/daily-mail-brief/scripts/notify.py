"""
Thin helper for sending alerts via `pa notify` from Python scripts.

Does NOT re-implement dedup or Telegram posting — shells out to the
TypeScript `pa notify` CLI (Phase 1) so dedup state is shared across
both TS and Python callers.

Windows .cmd shim handling: if the resolved binary ends with .cmd/.bat,
rewrites argv to use `cmd.exe /c` for reliable execution. This keeps
shell=False while working around CreateProcessW limitations.

Argument safety: subject and dedup_key values are constructed from
skill-internal identifiers (literals or regex-validated skill names).
They must NOT contain cmd.exe metacharacters (^ | > < & ( ) %).
Body is passed via stdin and is never subject to cmd.exe interpretation.
"""

import os
import shutil
import subprocess
import sys

# `pa notify` boots a Node CLI off the D: HDD; under I/O contention it exceeded
# a 10s timeout twice (2026-08-21, 2026-08-24), silently dropping the very alert
# that reports a brief failure. Bound it generously and retry once on timeout.
NOTIFY_TIMEOUT_S = float(os.environ.get("DAILY_MAIL_BRIEF_NOTIFY_TIMEOUT", "60"))


def _resolve_pa_bin() -> str:
    """Resolve the `pa` binary path."""
    env_bin = os.environ.get("DAILY_MAIL_BRIEF_PA_BIN")
    if env_bin:
        return env_bin
    found = shutil.which("pa")
    if found:
        return found
    return "pa"


def send(subject: str, body: str, dedup_key: str) -> None:
    """
    Send an alert via `pa notify`. Fail-soft — never raises.
    Logs failure reason to stderr and returns None.
    """
    pa_bin = _resolve_pa_bin()

    argv = [pa_bin, "notify",
            "--subject", subject,
            "--body-stdin",
            "--dedup-key", dedup_key]

    # Windows .cmd/.bat shim: rewrite argv for cmd.exe
    if sys.platform == "win32":
        lower = pa_bin.lower()
        if lower.endswith(".cmd") or lower.endswith(".bat"):
            comspec = os.environ.get("COMSPEC", "cmd.exe")
            argv = [comspec, "/c", pa_bin, "notify",
                    "--subject", subject,
                    "--body-stdin",
                    "--dedup-key", dedup_key]

    # One retry on timeout only: a slow pa boot is the recorded failure mode,
    # while a missing binary or OS error cannot succeed on a second attempt.
    for attempt in (1, 2):
        try:
            subprocess.run(
                argv,
                input=body.encode("utf-8"),
                timeout=NOTIFY_TIMEOUT_S,
                check=False,  # don't raise on non-zero exit
            )
            return
        except subprocess.TimeoutExpired:
            if attempt == 1:
                print(
                    f"[notify.py] timeout ({NOTIFY_TIMEOUT_S:g}s) — retrying once",
                    file=sys.stderr,
                )
            else:
                print(f"[notify.py] failed: timeout ({NOTIFY_TIMEOUT_S:g}s)", file=sys.stderr)
        except FileNotFoundError:
            print(f"[notify.py] failed: pa binary not found at '{pa_bin}'", file=sys.stderr)
            return
        except subprocess.CalledProcessError as e:
            print(f"[notify.py] failed: exit {e.returncode}", file=sys.stderr)
            return
        except OSError as e:
            print(f"[notify.py] failed: OS error: {e}", file=sys.stderr)
            return
        except Exception as e:
            print(f"[notify.py] failed: {e}", file=sys.stderr)
            return
