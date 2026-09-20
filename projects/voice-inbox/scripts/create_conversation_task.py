#!/usr/bin/env python3
"""Create a new voice-inbox task inside an EXISTING conversation, then route it.

Invoked BY the telegram-bot's reminder-resume-drain (AI-conversation-context
reminder fix, 2026-09-12) when a fired reminder's resume_action is a
voice_inbox_resume rather than a topic_resume: the pending decision the
reminder is about lives in a voice-inbox UI conversation, so resuming it must
land as a new task in THAT SAME conversation_id — not a raw Telegram message
injected into whatever topic the conversation last happened to be routed to
(topic_resume's mechanism, which has no concept of a voice-inbox
conversation id at all).

    python create_conversation_task.py --conversation-id vi-x --text "<prompt>"

The INSERT shape mirrors createTask (projects/voice-inbox/src/ledger.ts) —
never hand-built beyond that mirror — reusing route_task.py's own shared
ledger helper (open_ledger/now_iso/make_ref_id) rather than re-implementing
it. The new task is routed immediately to the conversation's last-known topic
via route_task.py itself (a subprocess call, same script the deterministic
fallback's handleReceived shells out to for a stuck 'received' task), so the
resumed turn does not sit waiting for the next inbox-topic worker sweep.

Prints one line of JSON:
    {"ok": true, "task_id": "vi-...", "routed_to": "<chatId>_<threadId>"|null}
    {"ok": false, "error": "..."}
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from route_task import open_ledger, now_iso, make_ref_id  # noqa: E402

CONVERSATION_ID_RE = re.compile(r"^vi-[0-9a-f]{12}$")
TOPIC_KEY_RE = re.compile(r"^-?\d+_\d+$")


def mint_task_id() -> str:
    """`vi-<12 hex>` — same shape as ledger.ts's mintTaskId, minted by this writer."""
    return "vi-" + secrets.token_hex(6)


def create_conversation_task(conversation_id: str, text: str) -> dict:
    if not CONVERSATION_ID_RE.match(conversation_id):
        return {"ok": False, "error": "conversation_id must match vi-<12 hex>"}
    # No upper bound (vi-39ab14f84f14, 2026-09-13): mirrors POST /tasks's
    # default-unlimited text semantics — caps are opt-in config, and this
    # direct-to-ledger writer has no config plumbing, so only emptiness rejects.
    if not isinstance(text, str) or len(text) < 1:
        return {"ok": False, "error": "text must be a non-empty string"}

    conn = open_ledger()
    try:
        anchor = conn.execute(
            "SELECT tenant_id, routed_to FROM tasks WHERE conversation_id = ?"
            " ORDER BY created_at DESC, task_id DESC LIMIT 1",
            (conversation_id,),
        ).fetchone()
        if anchor is None:
            return {"ok": False, "error": f"no task found for conversation_id={conversation_id}"}
        tenant_id = anchor["tenant_id"]
        routed_to = anchor["routed_to"]

        task_id = mint_task_id()
        ts = now_iso()
        with conn:
            # Mirrors createTask (src/ledger.ts): source='text', state='received',
            # conversation_id explicit (joins the EXISTING conversation, never
            # self-rooted) — the two fields this writer diverges on from that
            # function's defaults.
            conn.execute(
                "INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text,"
                " state, created_at, updated_at, conversation_id, steer_mode)"
                " VALUES (?, ?, 'text', NULL, ?, 'received', ?, ?, ?, NULL)",
                (task_id, tenant_id, text, ts, ts, conversation_id),
            )
            conn.execute(
                "INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)"
                " VALUES (?, ?, ?, 'task.received', NULL, ?, ?)",
                (tenant_id, task_id, make_ref_id(),
                 json.dumps({"source": "text", "chars": len(text)}), ts),
            )
    finally:
        conn.close()

    if routed_to and TOPIC_KEY_RE.match(routed_to):
        reason = "Resumed by a reminder into the conversation it was created from"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "route_task.py"),
             "--task", task_id, "--topic", routed_to, "--reason", reason],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            # The task row is real and visible in the conversation either way
            # (fail-open, same convention as the deterministic fallback's
            # reroute-append-failed path) — routing can retry later via the
            # normal stale-routed sweep.
            return {"ok": True, "task_id": task_id, "routed_to": None,
                    "route_error": (result.stderr or result.stdout).strip()[-500:]}
        return {"ok": True, "task_id": task_id, "routed_to": routed_to}

    return {"ok": True, "task_id": task_id, "routed_to": None}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--conversation-id", required=True)
    parser.add_argument("--text", required=True)
    args = parser.parse_args(argv)

    result = create_conversation_task(args.conversation_id, args.text)
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
