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

    try:
        subprocess.run(
            argv,
            input=body.encode("utf-8"),
            timeout=10,
            check=False,  # don't raise on non-zero exit
        )
    except FileNotFoundError:
        print(f"[notify.py] failed: pa binary not found at '{pa_bin}'", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print("[notify.py] failed: timeout (10s)", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"[notify.py] failed: exit {e.returncode}", file=sys.stderr)
    except OSError as e:
        print(f"[notify.py] failed: OS error: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[notify.py] failed: {e}", file=sys.stderr)
