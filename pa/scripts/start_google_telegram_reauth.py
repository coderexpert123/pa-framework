import argparse
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path
from google_auth_oauthlib.flow import Flow

DEFAULT_SCOPES = [
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/photoslibrary.readonly",
]


def _ensure_telegram_env() -> list:
    """telegram_notify.send_text reads TELEGRAM_BOT_TOKEN (and the chat/proxy keys)
    from os.environ ONLY. This script is reached from callers whose environment
    does not carry them: google_reauth_kick.py invoked by a `cmd:` skill that
    declared other secrets, the bot's /reauth spawn, an operator shell. The first
    live integration kick on 2026-08-23 failed exactly here ("Failed to deliver
    reauth link via Telegram") while the link-minting half succeeded — the same
    class as the 2026-08-19 weekly-ops-digest TELEGRAM_BOT_TOKEN failure. Fill the
    gaps from ~/.pa/secrets.env; never overwrite a value the caller already set.
    Returns the keys it injected so the caller can remove them again afterwards —
    the injection must not outlive the send (an earlier version left them in
    os.environ and leaked the real TELEGRAM_CHAT_ID into a later test in the same
    pytest process)."""
    keys = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_PROXY_URLS")
    injected: list = []
    if all(os.environ.get(k) for k in keys):
        return injected
    secrets_path = Path(os.environ.get("PA_HOME") or (Path.home() / ".pa")) / "secrets.env"
    try:
        with open(secrets_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                if key in keys and not os.environ.get(key):
                    os.environ[key] = val.strip().strip("\"'")
                    injected.append(key)
    except FileNotFoundError:
        pass
    return injected


def _send_reauth_message(auth_url: str, resume_skill_name, chat_id, thread_id) -> bool:
    """Deliver the reauth link via Telegram, PLAIN TEXT (parse_mode=None) —
    a Google consent URL's underscores/parentheses are exactly what
    Telegram's legacy Markdown parser mangles (memory 2026-08-15; correction
    13 of plans/2026-08-23-alerts-wave-SPEC.md). Returns True on success,
    False on any failure or exception — never raises (a raise here must not
    prevent the caller from cleaning up a just-written session)."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from telegram_notify import send_text  # noqa: E402  (lazy: only needed when sending)
    injected = _ensure_telegram_env()

    lines = [
        "Google authentication expired.",
        "",
        "1. Open this link on your phone:",
        auth_url,
        "",
        "2. Copy the full /auth ... command from the page.",
        "3. Paste it back here.",
        "",
        "This link is valid for 12 hours.",
    ]
    if resume_skill_name:
        lines.append(f"Skill blocked: {resume_skill_name}")
    lines.append("Or tap the button below later for a fresh link.")
    message = "\n".join(lines)

    # Callback data contract (plans/2026-08-24-buttons-program-SPEC.md §3.2):
    # "reauth:google" or "reauth:google:<skill>" where <skill> matches
    # [a-z0-9-]{1,50}. The whole callback_data is capped at 64 bytes by
    # Telegram; "reauth:google:" alone is already 14 of those bytes, leaving
    # 50 for the skill name. An invalid or over-length skill name is dropped
    # from the callback rather than sent through unvalidated — the bot's
    # parser would reject the whole callback otherwise.
    skill_suffix = ""
    if resume_skill_name and re.fullmatch(r"[a-z0-9-]{1,50}", resume_skill_name):
        skill_suffix = f":{resume_skill_name}"
    reply_markup = {
        "inline_keyboard": [[
            {"text": "\U0001F510 Re-authorize Google (fresh link)", "callback_data": f"reauth:google{skill_suffix}"}
        ]]
    }

    try:
        result = send_text(message, chat_id=chat_id, thread_id=thread_id, parse_mode=None,
                            reply_markup=reply_markup)
        return bool(result)
    except SystemExit:
        return False
    except Exception:
        return False
    finally:
        for key in injected:
            os.environ.pop(key, None)


def main():
    parser = argparse.ArgumentParser(description="Start Google OAuth flow for Telegram")
    parser.add_argument("--secrets-file", help="Path to Google client secrets JSON file")
    parser.add_argument("--state-file", help="Path to store pending authentication state")
    parser.add_argument("--redirect-uri", required=True, help="Registered redirect URI (bridge page)")
    parser.add_argument("--chat-id", required=True, help="Telegram chat ID for response")
    parser.add_argument("--thread-id", type=int, help="Telegram thread ID")
    parser.add_argument("--resume-action-json", help="Opaque JSON payload returned after successful auth")
    parser.add_argument("--scopes-json", help="Optional JSON array of OAuth scopes")
    parser.add_argument("--resume-skill",
                        help="Sugar for --resume-action-json {\"type\":\"run_pa_skill\",\"skill\":NAME,...}; "
                             "ignored if --resume-action-json is also given")
    parser.add_argument("--no-send", action="store_true",
                        help="Do not deliver the link via Telegram (default: send)")
    parser.add_argument("--reuse-pending", action="store_true",
                        help="Re-send an existing unexpired session with matching scopes instead of minting a new one")

    # Legacy arguments for backward compatibility with PA setup
    parser.add_argument("--retry-action", help="[Legacy] PA command to run after success")

    args = parser.parse_args()

    # Resolution logic for paths
    pa_home = Path(os.environ.get("PA_HOME", Path.home() / ".pa"))
    secrets_file = Path(args.secrets_file) if args.secrets_file else pa_home / "google-credentials-telegram.json"
    state_file = Path(args.state_file) if args.state_file else pa_home / "google-telegram-auth.json"

    if not secrets_file.exists():
        print(json.dumps({"error": f"Missing secrets file: {secrets_file}"}))
        sys.exit(1)

    try:
        scopes = DEFAULT_SCOPES
        if args.scopes_json:
            parsed_scopes = json.loads(args.scopes_json)
            if not isinstance(parsed_scopes, list) or not all(isinstance(scope, str) for scope in parsed_scopes):
                raise ValueError("--scopes-json must be a JSON array of strings")
            scopes = parsed_scopes

        resume_action = None
        if args.resume_action_json:
            resume_action = json.loads(args.resume_action_json)
            if not isinstance(resume_action, dict):
                raise ValueError("--resume-action-json must decode to a JSON object")
        elif args.resume_skill:
            # Sugar for the shape preflight.py builds and
            # projects/telegram-bot/src/oauth.ts:41 consumes (correction 17).
            resume_action = {
                "type": "run_pa_skill",
                "skill": args.resume_skill,
                "description": f"Retry {args.resume_skill}",
            }

        resume_skill_name = resume_action.get("skill") if isinstance(resume_action, dict) else None

        # Load existing + prune expired, for both the reuse and mint paths.
        all_pending = []
        if state_file.exists():
            try:
                all_pending = json.loads(state_file.read_text())
            except Exception:
                pass
        now = time.time()
        all_pending = [p for p in all_pending if p.get('expires_at', 0) > now]

        if args.reuse_pending:
            reusable = next((p for p in all_pending if p.get('scopes') == scopes), None)
            if reusable is not None:
                sent = False
                if not args.no_send:
                    sent = _send_reauth_message(reusable["auth_url"], resume_skill_name, args.chat_id, args.thread_id)
                    if not sent:
                        print(json.dumps({"error": "Failed to deliver reauth link via Telegram"}))
                        sys.exit(1)

                print(json.dumps({
                    "status": "ok",
                    "auth_url": reusable["auth_url"],
                    "auth_id": reusable["auth_id"],
                    "reused": True,
                    "sent": sent,
                }))
                return

        flow = Flow.from_client_secrets_file(
            str(secrets_file),
            scopes=scopes,
            redirect_uri=args.redirect_uri
        )

        # prompt='consent' is LOAD-BEARING, not cosmetic (2026-08-25 incident).
        # Google issues a refresh token only on the FIRST authorization for a given
        # client+user; every later re-auth returns an ACCESS TOKEN ONLY unless consent
        # is forced. Without this, `access_type='offline'` alone silently yields
        # credentials that cannot refresh, and finish_google_telegram_reauth.py then
        # overwrote the good token with them — which is exactly how google-token.json
        # ended up with no refresh_token at all and every Gmail/Drive/Docs skill died.
        auth_url, state = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='consent'
        )

        pending = {
            "auth_id": secrets.token_hex(8),
            "state": state,
            "code_verifier": flow.code_verifier,
            "redirect_uri": args.redirect_uri,
            "scopes": scopes,
            "chat_id": args.chat_id,
            "thread_id": args.thread_id,
            "resume_action": resume_action,
            "retry_action": args.retry_action,
            "created_at": int(time.time()),
            # 12 hours (was 60 minutes): a 60-minute link minted by an
            # off-hours cron and dropped into a low-visibility topic was
            # never acted on before it expired (AI-147, review §2.1).
            "expires_at": int(time.time()) + 43200,
            # Persisted so --reuse-pending can re-send this session without
            # re-minting (correction 16 / step 2 of the WP-G spec).
            "auth_url": auth_url,
        }

        all_pending.append(pending)

        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(all_pending, indent=2))

        sent = False
        if not args.no_send:
            sent = _send_reauth_message(auth_url, resume_skill_name, args.chat_id, args.thread_id)
            if not sent:
                # An un-delivered session is a stale resume_action waiting to
                # fire with no way for the operator to ever open the link
                # (BACKLOG AI-147) — remove it rather than leave it pending.
                all_pending = [p for p in all_pending if p.get("auth_id") != pending["auth_id"]]
                state_file.write_text(json.dumps(all_pending, indent=2))
                print(json.dumps({"error": "Failed to deliver reauth link via Telegram"}))
                sys.exit(1)

        print(json.dumps({
            "status": "ok",
            "auth_url": auth_url,
            "auth_id": pending["auth_id"],
            "reused": False,
            "sent": sent,
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
