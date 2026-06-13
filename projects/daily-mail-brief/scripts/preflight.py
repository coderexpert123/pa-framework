"""
Pre-flight auth check for daily-mail-brief.

Runs before skill.md to verify Gmail OAuth is valid.
On success: deletes any stale .fetch-failed.json and exits 0.
On failure: writes .fetch-failed.json with status/reason, alerts pa-support,
and exits 2.
"""

import json
import os
import sys
import traceback
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
FETCH_FAILED_FILE = os.path.join(PROJECT_ROOT, ".fetch-failed.json")

sys.path.insert(0, SCRIPT_DIR)
from notify import send as notify_send


def _write_fetch_failed(status: str, reason: str):
    with open(FETCH_FAILED_FILE, "w", encoding="utf-8") as f:
        json.dump({"status": status, "reason": reason, "timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}, f, indent=2)


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
                pa_home = os.environ.get("PA_HOME", os.path.join(os.path.expanduser("~"), ".pa"))
                # Path to start_google_telegram_reauth.py relative to projects/daily-mail-brief/scripts/preflight.py
                # D:\Personal Assistant\projects\daily-mail-brief\scripts\preflight.py
                # -> D:\Personal Assistant\pa\scripts\start_google_telegram_reauth.py
                start_script = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR))), "pa", "scripts", "start_google_telegram_reauth.py")
                
                chat_id = os.environ.get("TELEGRAM_BRIEFING_CHAT_ID", "").split(",")[0].strip() or os.environ.get("TELEGRAM_CHAT_ID", "").split(",")[0].strip()
                thread_id = os.environ.get("TELEGRAM_DAILY_BRIEFING_THREAD_ID")
                
                redirect_uri = os.environ.get("GOOGLE_AUTH_REDIRECT_URI", "").strip()
                if not redirect_uri:
                    raise RuntimeError("GOOGLE_AUTH_REDIRECT_URI is not configured in ~/.pa/secrets.env")

                resume_action = {
                    "type": "run_pa_skill",
                    "skill": "daily-mail-brief",
                    "description": "Retry the daily mail brief",
                }

                if os.path.exists(start_script) and chat_id:
                    cmd = [sys.executable, start_script, "--redirect-uri", redirect_uri, "--chat-id", chat_id]
                    if thread_id:
                        cmd.extend(["--thread-id", thread_id])
                    cmd.extend(["--resume-action-json", json.dumps(resume_action)])
                    
                    res = subprocess.run(cmd, capture_output=True, text=True)
                    if res.returncode == 0:
                        auth_data = json.loads(res.stdout)
                        auth_url = auth_data["auth_url"]
                        reason = (
                            "Google authentication expired.\n\n"
                            f"1. [Tap here to authorize]({auth_url}) on your phone.\n"
                            "2. Copy the full `/auth ...` command from the page.\n"
                            "3. Return here and paste that command into Telegram.\n\n"
                            "PA will automatically retry the mail brief after success."
                        )
            except Exception as auth_err:
                print(f"[preflight] Failed to start reauth flow: {auth_err}", file=sys.stderr)

        _write_fetch_failed(status, reason)

        dedup_key = _dedup_key_for_status(status)
        notify_send(
            subject=f"daily-mail-brief: {status} failure",
            body=reason,
            dedup_key=dedup_key,
        )

        print(f"[preflight] {status} failure: {reason}", file=sys.stderr)
        sys.exit(2)

    # Success — clean up any stale marker
    if os.path.exists(FETCH_FAILED_FILE):
        try:
            os.remove(FETCH_FAILED_FILE)
        except OSError:
            pass


if __name__ == "__main__":
    main()
