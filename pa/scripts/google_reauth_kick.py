#!/usr/bin/env python3
"""Kick off (or rate-limit) delivery of a fresh Google OAuth reauth link.

Why this exists (AI-147, WP-G, the 2026-08-23 alerts-wave spec)
----------------------------------------------------------------------
Before this file, a skill that hit an expired-Google-token failure could only
mint a reauth session and print the URL to its own log — nobody ever saw the
link (review §2.1). `start_google_telegram_reauth.py` now DELIVERS the link
itself via Telegram, but several skills can independently hit the same
expired token within minutes of each other; sending one link per skill would
flood the operator with duplicate links for the same underlying block.

This module is the single choke point every caller (daily-mail-brief's
preflight, the bot's `/reauth` command indirectly via the start script,
future skills) goes through: it keeps an additive marker
(`~/.pa/google-auth-blocked.json`) tracking how long the block has existed
and which skills it is blocking, rate-limits actual Telegram sends to once
per 6 hours, and always delegates the real minting/sending work to
`start_google_telegram_reauth.py --reuse-pending` so a still-valid session is
reused rather than duplicated.

`human_gated_blocker_watch.py`'s `scan_google_auth()` reads the SAME marker
to escalate a standing block after 3/7 days; `finish_google_telegram_reauth.py`
deletes it on a successful token exchange. This file only ever CREATES or
UPDATES the marker — never deletes it.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

RATE_LIMIT_SECONDS = 6 * 3600  # AI-147: four skills failing on the same
# expired token within minutes is normal — one link is enough.

_SECRETS_CACHE: dict | None = None


# ---------------------------------------------------------------------------
# secrets — Task Scheduler / skill dispatch gives this process neither the
# bot's environment nor its cwd, so secrets are read straight from
# ~/.pa/secrets.env. Never hardcode a token or a chat id. (Same pattern as
# projects/pa-maintenance/scripts/human_gated_blocker_watch.py.)
# ---------------------------------------------------------------------------

def _pa_home() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa"))


def _load_secrets() -> dict:
    path = _pa_home() / "secrets.env"
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                out[key.strip()] = val.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return out


def _secret(key: str, default=None):
    """os.environ wins, then ~/.pa/secrets.env, then the default — mirrors
    the per-key env-then-secrets precedence `pa/src/lib/notify.ts:115` uses."""
    global _SECRETS_CACHE
    if key in os.environ and os.environ[key]:
        return os.environ[key]
    if _SECRETS_CACHE is None:
        _SECRETS_CACHE = _load_secrets()
    return _SECRETS_CACHE.get(key, default)


def _resolve_chat_id(explicit: str | None) -> str | None:
    """argument -> PA_REAUTH_CHAT_ID (env-then-secrets) -> TELEGRAM_CHAT_ID
    first comma-separated entry (env-then-secrets). Deliberately the
    OPERATOR's general topic, not pa-alerts (decision (e))."""
    if explicit:
        return str(explicit)
    v = _secret("PA_REAUTH_CHAT_ID")
    if v:
        return v
    raw = _secret("TELEGRAM_CHAT_ID") or ""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return parts[0] if parts else None


def _resolve_thread_id(explicit: int | None) -> int:
    """argument -> PA_REAUTH_THREAD_ID (env-then-secrets) -> 0."""
    if explicit is not None:
        return int(explicit)
    v = _secret("PA_REAUTH_THREAD_ID")
    if v:
        try:
            return int(v)
        except ValueError:
            pass
    return 0


# ---------------------------------------------------------------------------
# marker I/O — additive, atomic. This module CREATES/UPDATES it; only
# finish_google_telegram_reauth.py deletes it, on a successful token exchange.
# ---------------------------------------------------------------------------

def _marker_path() -> Path:
    return _pa_home() / "google-auth-blocked.json"


def _load_marker(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_marker(path: Path, data: dict) -> None:
    """Atomic (tmp + os.replace), same pattern as
    human_gated_blocker_watch.save_ledger."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _kick_log_path() -> Path:
    """Append-only sidecar for reauth kick history (AI-168 WP-E, §2.6)."""
    return _pa_home() / "reauth-kicks.jsonl"


def _append_kick_log(entry: dict) -> None:
    """Best-effort append of a kick log entry to ~/.pa/reauth-kicks.jsonl.
    Logs a stderr note on failure; never raises or changes the returned dict.
    Entry shape: {"ts": ISO Z, "skill": str, "status": "sent|rate-limited|failed", "reason": str[:200]}."""
    path = _kick_log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        print(f"[WARN] Failed to append kick log: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def kick_google_reauth(resume_skill: str, reason: str,
                       chat_id: str | None = None,
                       thread_id: int | None = None) -> dict:
    """Ensure a reauth link has been (recently) sent for this block; never raises.

    Always updates the marker (first_seen/last_seen/reason/skills) regardless
    of outcome. Returns one of:
      {"status": "rate-limited", "reused": False}                — < 6h since last send, no spawn
      {"status": "sent", "auth_url": str, "reused": bool}          — start script succeeded
      {"status": "failed", "error": str}                           — spawn/parse/start-script failure
    """
    marker_path = _marker_path()
    now = datetime.now(timezone.utc)
    # Z-suffix ms precision (AI-164 C9e convention; the kick-log test's regex
    # and any future lexicographic ts compares depend on it).
    now_iso = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    marker = _load_marker(marker_path)
    if not marker.get("first_seen"):
        marker["first_seen"] = now_iso
    marker["last_seen"] = now_iso
    marker["reason"] = reason
    skills = marker.get("skills")
    if not isinstance(skills, list):
        skills = []
    if resume_skill not in skills:
        skills.append(resume_skill)
    marker["skills"] = skills
    marker.setdefault("last_sent", None)

    last_sent = marker.get("last_sent")
    if last_sent:
        try:
            last_sent_dt = datetime.fromisoformat(last_sent)
            if last_sent_dt.tzinfo is None:
                last_sent_dt = last_sent_dt.replace(tzinfo=timezone.utc)
            if (now - last_sent_dt).total_seconds() < RATE_LIMIT_SECONDS:
                _save_marker(marker_path, marker)
                _append_kick_log({"ts": now_iso, "skill": resume_skill, "status": "rate-limited", "reason": reason[:200]})
                return {"status": "rate-limited", "reused": False}
        except (ValueError, TypeError):
            pass  # unparseable last_sent -> treat as never sent, fall through

    resolved_chat = _resolve_chat_id(chat_id)
    resolved_thread = _resolve_thread_id(thread_id)
    redirect_uri = _secret("GOOGLE_AUTH_REDIRECT_URI") or ""

    script = str(Path(__file__).resolve().parent / "start_google_telegram_reauth.py")
    cmd = [sys.executable, script, "--reuse-pending",
           "--chat-id", str(resolved_chat), "--thread-id", str(resolved_thread),
           "--resume-skill", resume_skill, "--redirect-uri", redirect_uri]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        # Do NOT set last_sent — a spawn failure means nothing was delivered,
        # so the next skill hitting this block should be allowed to retry.
        _save_marker(marker_path, marker)
        _append_kick_log({"ts": now_iso, "skill": resume_skill, "status": "failed", "reason": reason[:200]})
        return {"status": "failed", "error": str(e)}

    if proc.returncode != 0:
        _save_marker(marker_path, marker)
        err = proc.stdout.strip() or proc.stderr.strip() or f"exit {proc.returncode}"
        _append_kick_log({"ts": now_iso, "skill": resume_skill, "status": "failed", "reason": reason[:200]})
        return {"status": "failed", "error": err}

    # The start script's JSON is its LAST stdout line: telegram_notify.send_text prints
    # a "[Telegram] <chat> Part 1/1 sent OK (ref=…)" progress line before it (found on
    # the first live kick, 2026-08-23 — the link was delivered but this parse failed
    # and last_sent never armed, so the 6 h rate-limit would not have held).
    try:
        stdout_lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
        result = json.loads(stdout_lines[-1]) if stdout_lines else {}
        if not isinstance(result, dict):
            raise ValueError("not a JSON object")
    except (json.JSONDecodeError, ValueError, IndexError):
        _save_marker(marker_path, marker)
        _append_kick_log({"ts": now_iso, "skill": resume_skill, "status": "failed", "reason": reason[:200]})
        return {"status": "failed", "error": f"unparseable start-script output: {proc.stdout[:200]}"}

    marker["last_sent"] = now_iso
    _save_marker(marker_path, marker)
    _append_kick_log({"ts": now_iso, "skill": resume_skill, "status": "sent", "reason": reason[:200]})
    return {"status": "sent", "auth_url": result.get("auth_url"), "reused": bool(result.get("reused"))}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Kick off (or rate-limit) delivery of a Google reauth link via Telegram.")
    parser.add_argument("--skill", required=True,
                        help="Name of the skill blocked on Google auth; passed through as --resume-skill.")
    parser.add_argument("--reason", required=True, help="Human-readable reason recorded in the marker.")
    parser.add_argument("--chat-id", help="Override the resolved chat id (default: route resolver).")
    parser.add_argument("--thread-id", type=int, help="Override the resolved thread id (default: route resolver).")
    args = parser.parse_args(argv)

    result = kick_google_reauth(args.skill, args.reason, chat_id=args.chat_id, thread_id=args.thread_id)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
