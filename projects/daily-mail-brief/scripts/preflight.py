"""
Pre-flight auth check for daily-mail-brief.

Runs before skill.md to verify Gmail OAuth is valid.
On success: deletes any stale .fetch-failed.json and exits 0.
On failure: writes .fetch-failed.json with status/reason, alerts pa-support,
and exits 2.
"""

import os
import sys
import traceback
import subprocess

from runtime_state import clear_failure_marker, write_failure_marker

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

sys.path.insert(0, SCRIPT_DIR)
from notify import send as notify_send


def _dedup_key_for_status(status: str) -> str:
    return "daily-mail-brief-auth" if status == "auth" else "daily-mail-brief-fetch"


def main():
    sys.path.insert(0, SCRIPT_DIR)

    try:
        from auth import get_gmail_service
        service = get_gmail_service()
        # Dry-run: verify the token actually works
        service.users().getProfile(userId="me").execute()
    except Exception as e:
        error_str = str(e)
        error_lower = error_str.lower()

        # Classify failure type
        if any(t in type(e).__name__ for t in ("RefreshError", "InvalidGrantError")):
            status = "auth"
        elif "runtimeerror" in type(e).__name__.lower() and ("token" in error_lower or "auth" in error_lower or "credential" in error_lower):
            status = "auth"
        elif "HttpError" in type(e).__name__:
            status = "api"
        elif any(t in type(e).__name__ for t in ("ConnectionError", "TimeoutError")):
            status = "network"
        else:
            # Check for network-related module names in traceback
            tb = traceback.format_exc().lower()
            if any(k in tb for k in ("socket", "ssl", "urllib3", "requests", "connection", "timeout", "gaierror")):
                status = "network"
            elif "auth" in error_lower or "token" in error_lower or "credential" in error_lower:
                status = "auth"
            else:
                status = "unknown"

        reason = error_str[:500]
        
        if status == "auth":
            try:
                # Path to start_google_telegram_reauth.py relative to projects/daily-mail-brief/scripts/preflight.py
                # D:\Personal Assistant\projects\daily-mail-brief\scripts\preflight.py
                # -> D:\Personal Assistant\pa\scripts\start_google_telegram_reauth.py
                repo_root = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
                pa_scripts_dir = os.path.join(repo_root, "pa", "scripts")
                start_script = os.path.join(pa_scripts_dir, "start_google_telegram_reauth.py")

                # WP-G (AI-147): resolve chat/thread via google_reauth_kick's
                # resolver — this deliberately targets the OPERATOR's general
                # topic (PA_REAUTH_CHAT_ID -> TELEGRAM_CHAT_ID), not the
                # daily-briefing-specific chat/thread (decision (e) of the
                # 2026-08-23 alerts-wave design, internal: NOT pa-alerts, and not
                # buried in a low-visibility topic either). Falls back to the
                # pre-WP-G expression only if the import itself fails.
                try:
                    sys.path.insert(0, pa_scripts_dir)
                    from google_reauth_kick import _resolve_chat_id, _resolve_thread_id
                    chat_id = _resolve_chat_id(None)
                    thread_id = _resolve_thread_id(None)
                except ImportError:
                    chat_id = (os.environ.get("TELEGRAM_BRIEFING_CHAT_ID", "").split(",")[0].strip()
                              or os.environ.get("TELEGRAM_CHAT_ID", "").split(",")[0].strip())
                    thread_id = os.environ.get("TELEGRAM_DAILY_BRIEFING_THREAD_ID") or 0

                redirect_uri = os.environ.get("GOOGLE_AUTH_REDIRECT_URI", "").strip()
                if not redirect_uri:
                    raise RuntimeError("GOOGLE_AUTH_REDIRECT_URI is not configured in ~/.pa/secrets.env")

                if os.path.exists(start_script) and chat_id:
                    cmd = [sys.executable, start_script, "--reuse-pending",
                          "--chat-id", str(chat_id), "--thread-id", str(thread_id),
                          "--resume-skill", "daily-mail-brief", "--redirect-uri", redirect_uri]

                    res = subprocess.run(cmd, capture_output=True, text=True)
                    if res.returncode == 0:
                        # The start script now delivers the link itself (WP-G) —
                        # no markdown link needed here, and none of send_text's
                        # underscore/parenthesis mangling risk (memory 2026-08-15).
                        reason = ("Google authentication expired. A reauth link was "
                                 "sent to your Telegram. Tap it, then paste the "
                                 "/auth ... command back.")
            except Exception as auth_err:
                print(f"[preflight] Failed to start reauth flow: {auth_err}", file=sys.stderr)

        write_failure_marker(status, reason)

        dedup_key = _dedup_key_for_status(status)
        notify_send(
            subject=f"daily-mail-brief: {status} failure",
            body=reason,
            dedup_key=dedup_key,
        )

        print(f"[preflight] {status} failure: {reason}", file=sys.stderr)
        sys.exit(2)

    # Success — clean up any stale marker
    clear_failure_marker()


if __name__ == "__main__":
    main()
