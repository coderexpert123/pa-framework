import argparse
import json
import os
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
    parser = argparse.ArgumentParser(description="Finish Google OAuth flow for Telegram")
    parser.add_argument("--code", required=True, help="Authorization code from Google")
    parser.add_argument("--state", help="OAuth state for CSRF protection")
    parser.add_argument("--secrets-file", help="Path to Google client secrets JSON file")
    parser.add_argument("--state-file", help="Path to store pending authentication state")
    parser.add_argument("--token-file", help="Path to save the resulting Google token JSON")
    args = parser.parse_args()

    # Resolution logic for paths
    pa_home = Path(os.environ.get("PA_HOME", Path.home() / ".pa"))
    secrets_file = Path(args.secrets_file) if args.secrets_file else pa_home / "google-credentials-telegram.json"
    state_file = Path(args.state_file) if args.state_file else pa_home / "google-telegram-auth.json"
    token_file = Path(args.token_file) if args.token_file else pa_home / "google-token.json"

    if not state_file.exists():
        print(json.dumps({"error": f"No pending authentication found (state file missing: {state_file})."}))
        sys.exit(1)

    try:
        all_pending = json.loads(state_file.read_text())
    except Exception as e:
        print(json.dumps({"error": f"Failed to read state file: {e}"}))
        sys.exit(1)

    # Filter for valid states
    now = time.time()
    valid_pending = [p for p in all_pending if p.get('expires_at', 0) > now]

    if not valid_pending:
        print(json.dumps({"error": "Authentication request expired or not found."}))
        sys.exit(1)

    # If state is provided, match it. Otherwise pick the latest (most likely the current one).
    match = None
    if args.state:
        match = next((p for p in valid_pending if p['state'] == args.state), None)
    else:
        # Pick the latest pending request
        match = sorted(valid_pending, key=lambda x: x['created_at'])[-1]

    if not match:
        print(json.dumps({"error": "Matching authentication request not found."}))
        sys.exit(1)

    if not secrets_file.exists():
        print(json.dumps({"error": f"Missing secrets file: {secrets_file}"}))
        sys.exit(1)

    try:
        flow = Flow.from_client_secrets_file(
            str(secrets_file),
            scopes=match.get('scopes', DEFAULT_SCOPES),
            redirect_uri=match['redirect_uri']
        )
        flow.code_verifier = match['code_verifier']

        flow.fetch_token(code=args.code)
        creds = flow.credentials

        # Save token
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(creds.to_json())

        # Remove used state
        remaining = [p for p in all_pending if p['auth_id'] != match['auth_id']]
        state_file.write_text(json.dumps(remaining, indent=2))

        print(json.dumps({
            "status": "success",
            "expiry": str(creds.expiry),
            "resume_action": match.get("resume_action"),
            "retry_action": match.get("retry_action"),
            "chat_id": match.get("chat_id"),
            "thread_id": match.get("thread_id")
        }))
    except Exception as e:
        print(json.dumps({"error": f"Token exchange failed: {e}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
