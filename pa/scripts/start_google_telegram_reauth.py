import argparse
import json
import os
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
]

def main():
    parser = argparse.ArgumentParser(description="Start Google OAuth flow for Telegram")
    parser.add_argument("--secrets-file", help="Path to Google client secrets JSON file")
    parser.add_argument("--state-file", help="Path to store pending authentication state")
    parser.add_argument("--redirect-uri", required=True, help="Registered redirect URI (bridge page)")
    parser.add_argument("--chat-id", required=True, help="Telegram chat ID for response")
    parser.add_argument("--thread-id", type=int, help="Telegram thread ID")
    parser.add_argument("--resume-action-json", help="Opaque JSON payload returned after successful auth")
    parser.add_argument("--scopes-json", help="Optional JSON array of OAuth scopes")
    
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

        flow = Flow.from_client_secrets_file(
            str(secrets_file),
            scopes=scopes,
            redirect_uri=args.redirect_uri
        )

        auth_url, state = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true'
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
            "expires_at": int(time.time()) + 3600  # 60 minutes
        }

        # Load existing
        all_pending = []
        if state_file.exists():
            try:
                all_pending = json.loads(state_file.read_text())
            except:
                pass

        # Clean up expired and add new
        now = time.time()
        all_pending = [p for p in all_pending if p.get('expires_at', 0) > now]
        all_pending.append(pending)

        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(all_pending, indent=2))

        print(json.dumps({
            "status": "ok",
            "auth_url": auth_url,
            "auth_id": pending["auth_id"]
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
