#!/usr/bin/env python3
"""Blocker escalation for voice-inbox tasks (the worker-side screenshot ask).

Invoked BY the worker that owns the task when the page it is driving hits
something it cannot control (captcha, login wall, consent dialog):

    python "<repo>/projects/voice-inbox/scripts/task_blocker_ask.py" \\
        --task vi-x --screenshot /path/page.png \\
        --prompt "The page is asking me to sign in — which account should I use?" \\
        [--options "Retry|Skip|Use another account"]

One call does the two halves of the escalation:

1. Copies the screenshot into the task's attachment directory
   (``PA_HOME/voice-inbox/files/<task_id>/``) under the attachments backend's
   exact rules (src/routes.ts): sanitized basename, a ``blocker-`` prefix so
   the name can never collide with the reserved ``audio.*`` recording or the
   invisible ``tmp-*`` staging prefix, ``-2``/``-3`` de-conflict on a name
   collision, staged as ``tmp-*`` first so a partial copy never registers.
   The app lists attachments straight from that directory — the copy IS the
   registration; nothing else to call.
2. Creates the input request (the question card) by invoking
   ``task_input.py create`` as a subprocess, so that script stays the ONLY
   creator of input requests (widget contract, state gate, attention page and
   event vocabulary are pinned by tests/test_worker_scripts.py). This script
   deliberately never opens the ledger itself and therefore carries no shared
   helper block. ``--options`` renders a choice widget (pipe-separated, 1..6
   choices of at most 60 chars — task_input.py's validator remains the
   authority); without it the operator gets a free-text answer field.

On success the worker ENDs its turn: the task sits awaiting_input, the
operator answers in the inbox, and the answer-and-resume core
(src/answer-resume.ts) re-dispatches the worker with the answer pointer.
On a create refusal the screenshot copy deliberately stays — it is the
evidence of the blocked page, visible on the task, and a corrected re-run
de-conflicts its name. The script never chats.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from typing import NoReturn

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Choice-side limits (task_input.py's INPUT_LIMITS remain the authority; these
# exist only so an ill-formed --options fails BEFORE the screenshot copy
# lands, keeping the refusal side-effect-free).
OPTIONS_MAX = 6
OPTION_MAX = 60

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass


def pa_home() -> str:
    """PA_HOME from env or ~/.pa (same resolution as the other pa python helpers)."""
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def emit(result: dict) -> None:
    """One JSON line on stdout (ascii-escaped; zero console-encoding risk)."""
    print(json.dumps({"ok": True, **result}))


def fail(message: str, code: int = 1) -> NoReturn:
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(code)


# Flags that take a value; a value starting with a single dash (a negative
# number, a topic-style key) would otherwise be eaten by argparse — same
# normalize_argv join as task_input.py, scoped to this script's flags.
VALUE_FLAGS = ("--task", "--screenshot", "--prompt", "--options",
               "--summary", "--title", "--recap", "--next")


def normalize_argv(argv: list[str] | None) -> list[str]:
    if argv is None:
        argv = sys.argv[1:]
    normalized: list[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if (token in VALUE_FLAGS and index + 1 < len(argv)
                and argv[index + 1].startswith("-")
                and not argv[index + 1].startswith("--")):
            normalized.append(f"{token}={argv[index + 1]}")
            index += 2
        else:
            normalized.append(token)
            index += 1
    return normalized


def sanitize_name(filename: str) -> str:
    """The attachments backend's sanitizeUploadName (src/routes.ts), same rules:
    keep [A-Za-z0-9._-], strip leading dots, fall back to upload.bin."""
    base = (filename or "").replace("\\", "/").split("/").pop()
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", base).lstrip(".")
    return cleaned or "upload.bin"


def stored_blocker_name(task_dir: str, screenshot_path: str) -> str:
    """`blocker-<sanitized basename>`, de-conflicted with -2, -3, … before the
    extension (storedAttachmentName's loop). The prefix is the registration
    guarantee: the listing excludes `^audio\\.` and `^tmp-`, and a `blocker-`
    name can match neither."""
    candidate = "blocker-" + sanitize_name(os.path.basename(screenshot_path))
    stem, dot, ext = candidate.rpartition(".")
    n = 2
    while os.path.exists(os.path.join(task_dir, candidate)):
        candidate = f"{stem}-{n}{dot}{ext}" if dot else f"{candidate}-{n}"
        n += 1
    return candidate


def parse_options(raw: str | None) -> list[str] | None:
    """`--options "a|b|c"` -> ["a", "b", "c"]; None when the flag is absent."""
    if raw is None:
        return None
    options = [part.strip() for part in raw.split("|")]
    options = [part for part in options if part]
    if not (1 <= len(options) <= OPTIONS_MAX) or any(len(o) > OPTION_MAX for o in options):
        fail(f"--options must be 1..{OPTIONS_MAX} pipe-separated non-empty choices "
             f"of at most {OPTION_MAX} chars each")
    return options


def copy_screenshot(task_id: str, screenshot_path: str, files_dir: str) -> tuple[str, str]:
    """Copy the screenshot into files/<task_id>/ and return (stored name,
    absolute forward-slashed path). Fails side-effect-free on a missing file."""
    if not os.path.isfile(screenshot_path):
        fail(f"screenshot not found: {screenshot_path}")
    task_dir = os.path.join(files_dir, task_id)
    os.makedirs(task_dir, exist_ok=True)
    stored = stored_blocker_name(task_dir, screenshot_path)
    staging = os.path.join(task_dir, "tmp-" + stored)
    shutil.copyfile(screenshot_path, staging)
    final = os.path.join(task_dir, stored)
    os.replace(staging, final)
    return stored, final.replace("\\", "/")


def run_create(args: argparse.Namespace, options: list[str] | None) -> dict:
    """Invoke the real `task_input.py create` as a subprocess and return its
    JSON payload. The child inherits this process's environment (PA_HOME, the
    suites' PA_NOTIFY_DISABLED gate), so isolation needs no extra plumbing."""
    create_argv = [
        sys.executable, os.path.join(SCRIPT_DIR, "task_input.py"), "create",
        "--task", args.task,
        "--kind", "choice" if options is not None else "text",
        "--prompt", args.prompt,
    ]
    if options is not None:
        create_argv += ["--param",
                        "options=" + json.dumps(options, ensure_ascii=False)]
    for flag in ("--summary", "--title", "--recap", "--next"):
        value = getattr(args, flag.lstrip("-"))
        if value is not None:
            create_argv += [flag, value]
    proc = subprocess.run(create_argv, capture_output=True, encoding="utf-8",
                          errors="replace")
    try:
        lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]
        payload = json.loads(lines[-1]) if lines else {}
    except json.JSONDecodeError:
        payload = {}
    if proc.returncode != 0 or payload.get("ok") is not True:
        detail = payload.get("error")
        if not detail and proc.stderr.strip():
            detail = proc.stderr.strip().splitlines()[-1]
        fail(f"task_input.py create refused: {detail or 'no output'}")
    return payload


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Escalate an un-controllable page (captcha, login, consent) to the "
                    "operator: attach a screenshot to the task and ask the question")
    parser.add_argument("--task", required=True, help="task id (vi-...)")
    parser.add_argument("--screenshot", required=True,
                        help="path to the blocker screenshot on disk")
    parser.add_argument("--prompt", required=True,
                        help="plain-language question for the operator, 1..500 chars")
    parser.add_argument("--options", help='optional pipe-separated choices, e.g. '
                        '"Retry|Skip" — renders buttons instead of a text field')
    parser.add_argument("--summary", help="model-phrased event summary, truncated to 200 chars")
    parser.add_argument("--title", help="short noun phrase naming what this conversation is "
                                        "about (<=60 chars); overwrites any stored title")
    parser.add_argument("--recap", help="one or two plain sentences saying what is happening "
                                        "and where it stands (<=400 chars)")
    parser.add_argument("--next", help="one line naming what the operator has to do next; "
                                       "omitted leaves any stored action item untouched, "
                                       "empty clears it")
    args = parser.parse_args(normalize_argv(argv))

    # Validate the flag this script owns BEFORE any side effect; the create
    # flags are validated by task_input.py itself (the authority).
    options = parse_options(args.options)

    files_dir = os.path.join(pa_home(), "voice-inbox", "files")
    stored, stored_path = copy_screenshot(args.task, args.screenshot, files_dir)
    payload = run_create(args, options)

    emit({"task_id": payload["task_id"], "request_id": payload["request_id"],
          "kind": payload["kind"], "task_state": payload["task_state"],
          "ref_id": payload.get("ref_id"),
          "attachment": stored, "attachment_path": stored_path})


if __name__ == "__main__":
    main()
